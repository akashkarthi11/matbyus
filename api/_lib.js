// matbyus — shared server helpers. TSD sections 4, 5.
// The hashing, session and rate-limit shapes are ported from the Wealth application, which runs
// them in production. Where matbyus differs, the difference is a policy decision recorded in
// FSD section 11, not an improvement to the mechanism.

import {
  randomBytes, scryptSync, timingSafeEqual, createHmac, createHash, randomInt,
} from 'node:crypto';

// There is no minimum password length. Removed on the owner's instruction, 2026-11-23
// (FSD L9). The maximum stays: it is not a strength rule but a guard against someone pinning a
// serverless function by making it scrypt a megabyte. An empty password is still refused, because
// that is not a weak password, it is no password.
export const PASSWORD_MIN = 1;
export const PASSWORD_MAX = 200;
export const SESSION_DAYS = 7;
export const COOKIE_NAME = 'mb_session';

// D-30: read-aloud safe. B, I, L, O, S and Z are dropped along with 0, 1 and 5, so no character
// left in the set has a look-alike that is also in the set — 8 is unambiguous once B is gone, and 2
// is unambiguous once Z is. Order references are read down phone lines, and a handover code has to
// be typeable when a camera will not focus.
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY2346789';

export function randomCode(length) {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

// For secrets that are compared, never reproduced. scrypt is for passwords, where slowness is the
// point; a handover code is high-entropy and short-lived, so a plain digest is the right tool.
export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const configError = m => Object.assign(new Error(m), { code: 'CONFIG' });

// --- responses --------------------------------------------------------------

export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Private and uncacheable unless the handler has already decided otherwise. The default is the
  // safe one, so a handler that says nothing can never leak a per-viewer response into a cache.
  if (!res.getHeader?.('Cache-Control')) res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(data));
}

export async function body(req, max = 1_000_000) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > max) throw fail(413, 'Request too large.');
  }
  try { return s ? JSON.parse(s) : {}; } catch { throw fail(400, 'Malformed request.'); }
}

export const clientIp = req =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

// --- passwords (FR-1.4, NFR-1) ---------------------------------------------

export function hash(p) {
  const s = randomBytes(16);
  return 's1$' + s.toString('base64url') + '$' + scryptSync(p, s, 64).toString('base64url');
}

export function check(p, h) {
  try {
    const [v, s, x] = String(h).split('$');
    if (v !== 's1') return false;
    const a = Buffer.from(x, 'base64url');
    const b = scryptSync(p, Buffer.from(s, 'base64url'), a.length);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

export function passwordProblem(p) {
  const s = String(p ?? '');
  if (s.length < PASSWORD_MIN) return 'Password is required.';
  if (s.length > PASSWORD_MAX) return 'Password is too long.';
  return null;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- session (FR-3) ---------------------------------------------------------

const secret = () => process.env.MB_SESSION_SECRET || '';

function requireSecret() {
  const s = secret().trim();
  if (s.length < 32 || /^\[.*\]$/.test(s)) {
    throw configError('MB_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret();
}

// base64url({uid, exp, sv}) + '.' + HMAC-SHA256. `sv` is the user's session_version: raising it in
// the database invalidates every cookie issued before (FR-3.2).
export function token(uid, sv = 1) {
  const key = requireSecret();
  const payload = Buffer.from(JSON.stringify({
    uid, exp: Date.now() + SESSION_DAYS * 864e5, sv: Number(sv) || 1,
  })).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}

export function sessionFrom(req) {
  try {
    const raw = String(req.headers.cookie || '').split(';').map(x => x.trim())
      .find(x => x.startsWith(COOKIE_NAME + '='));
    if (!raw) return null;
    const [b, s] = raw.slice(COOKIE_NAME.length + 1).split('.');
    if (!b || !s) return null;
    const want = createHmac('sha256', secret()).update(b).digest();
    const got = Buffer.from(s, 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() && p.uid ? { uid: p.uid, sv: Number(p.sv) || 1 } : null;
  } catch { return null; }
}

export function cookie(res, value) {
  const base = `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=`;
  res.setHeader('Set-Cookie', base + (value ? SESSION_DAYS * 86400 : 0));
}

// Signature and expiry, then the session_version check against the database. Any failure is
// indistinguishable to the caller from "signed out" (FR-3).
export async function sessionUser(req, db) {
  const s = sessionFrom(req);
  if (!s) return null;
  const rows = await db.query(
    'SELECT id, session_version FROM mb_users WHERE id = $1', [s.uid]);
  const u = rows[0];
  if (!u || Number(u.session_version) !== s.sv) return null;
  return s.uid;
}

export async function sessionAccount(req, db) {
  const s = sessionFrom(req);
  if (!s) return null;
  const rows = await db.query(
    `SELECT id, email, full_name, phone, role, account_type, business_status,
              owner_status, session_version
         FROM mb_users WHERE id = $1`, [s.uid]);
  const u = rows[0];
  if (!u || Number(u.session_version) !== s.sv) return null;
  return u;
}

// --- rate limiting (FR-2.3, FR-2.4, NFR-5) ----------------------------------
// Fails open: if the store is unreachable every check reports "not limited" and the storefront
// keeps serving. Deliberate, and only defensible because passwords are scrypt-hashed and sign-in
// errors are uniform. Both are pinned by tests.

const memory = new Map();   // fallback when no Redis is configured (local and test)

function store() {
  return {
    async incr(key, windowSec) {
      const now = Date.now();
      const e = memory.get(key);
      if (!e || e.resetAt <= now) {
        const resetAt = now + windowSec * 1000;
        memory.set(key, { n: 1, resetAt });
        return { n: 1, resetAt };
      }
      e.n += 1;
      return { n: e.n, resetAt: e.resetAt };
    },
    async count(key) {
      const e = memory.get(key);
      return !e || e.resetAt <= Date.now() ? 0 : e.n;
    },
    async reset(key) { memory.delete(key); },
  };
}

export async function rateCount(key) {
  try { return await store().count(key); } catch { return 0; }
}

export async function rateLimit(key, limit, windowSec) {
  try {
    const { n, resetAt } = await store().incr(key, windowSec);
    return { allowed: n <= limit, retryAfter: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
  } catch {
    return { allowed: true, retryAfter: windowSec };   // fail open
  }
}

export async function rateReset(key) {
  try { await store().reset(key); } catch { /* fail open */ }
}

export function resetAllLimits() { memory.clear(); }   // tests only

// --- validation -------------------------------------------------------------

export const validEmail = e =>
  typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export const normaliseEmail = e => String(e ?? '').trim().toLowerCase();

export function requireFields(obj, names) {
  for (const n of names) {
    if (obj[n] == null || String(obj[n]).trim() === '') return `${n} is required.`;
  }
  return null;
}
