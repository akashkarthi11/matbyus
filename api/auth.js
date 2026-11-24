// matbyus — authentication. TSD sections 4, 5. Implements FR-1 to FR-6.
//
//   GET  /api/auth                      -> { user: null } or { user: {...} }
//   POST /api/auth?action=register      -> 201 { user } + cookie
//   POST /api/auth?action=login         -> 200 { user } + cookie
//   POST /api/auth?action=logout        -> 200 { ok: true }, cookie cleared
//   POST /api/auth?action=reset         -> 200 { ok: true }   (signed-in admin only, FR-4)
//   POST /api/auth?action=request-owner  -> 200 { ownerStatus: 'requested' }  (a customer asks to sell)
//
// Ported from Wealth, with the four policy divergences in FSD section 11: open registration,
// customer/admin roles beside an independent account type, fixed menus, and reset as a temporary
// admin-only measure.

import {
  json, body, fail, clientIp, hash, check, passwordProblem, PASSWORD_MAX,
  token, cookie, sessionAccount, rateLimit, rateCount, rateReset,
  validEmail, normaliseEmail,
} from './_lib.js';
import { db as defaultDb } from './_db.js';
import { menusForRole } from './_roles.js';
import { checkGstin, normalisePan, normalisePincode, normaliseMobile } from './_india.js';
import { lookups } from './_lookups.js';

const WINDOW = 15 * 60;          // seconds
const EMAIL_LIMIT = 5, IP_LIMIT = 20;

const enforceChecksum = () => process.env.MB_GSTIN_ENFORCE_CHECKSUM !== 'no';

const publicUser = (u, menus) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  phone: u.phone,
  role: u.role,
  accountType: u.account_type,
  businessStatus: u.business_status,
  // Whether they have asked to sell here, and how far that got: none|requested|approved|rejected.
  ownerStatus: u.owner_status || "none",
  // Which menus this role sees can be tailored by an admin, so it is read from the database.
  // It decides what the app draws and nothing else — every endpoint checks the role itself.
  menus,
});

const withMenus = async (u, db) => publicUser(u, await menusForRole(u.role, db));

function tooMany(res, retryAfter) {
  res.setHeader('Retry-After', String(retryAfter || WINDOW));
  return json(res, 429, { error: 'Too many attempts. Please wait and try again.' });
}

// FR-6.1, FR-6.2, FR-6.4: validate the business block before anything is written.
// Returns { error } or { value } — never a half-checked object.
function readBusiness(input, { enforce, lk }) {
  const b = input || {};
  const legalName = String(b.legalName || '').trim();
  if (!legalName) return { error: 'Business name is required.' };

  // The state list is mb_states, so the dropdown the browser drew and the check here are one list.
  const stateCode = String(b.stateCode || '').trim();
  if (!lk.validStateCode(stateCode)) return { error: 'Choose a valid state.' };

  const addressLine1 = String(b.addressLine1 || '').trim();
  if (!addressLine1) return { error: 'Address is required.' };
  const city = String(b.city || '').trim();
  if (!city) return { error: 'City is required.' };

  const pincode = normalisePincode(b.pincode);
  if (!pincode) return { error: 'Enter a valid 6-digit PIN code.' };

  // FSD A6: a GSTIN is optional. An unregistered contractor may hold a business account.
  let gstin = null;
  const rawGstin = String(b.gstin || '').trim();
  if (rawGstin) {
    const r = checkGstin(rawGstin, stateCode, {
      enforceChecksum: enforce, isKnownState: lk.validStateCode,
    });
    if (!r.ok) {
      if (r.reason === 'state_mismatch') {
        return { error: `That GSTIN belongs to state ${r.gstinState}, but you selected state ${stateCode}.` };
      }
      return { error: 'That GSTIN is not valid.' };
    }
    gstin = r.value;
  }

  let pan = null;
  const rawPan = String(b.pan || '').trim();
  if (rawPan) {
    pan = normalisePan(rawPan);
    if (!pan) return { error: 'That PAN is not valid.' };
  }

  return {
    value: {
      legalName, gstin, pan, stateCode,
      contactPerson: String(b.contactPerson || '').trim() || null,
      addressLine1,
      addressLine2: String(b.addressLine2 || '').trim() || null,
      city, pincode,
    },
  };
}

export async function handle(req, res, db) {
  const action = new URL(req.url, 'https://local').searchParams.get('action');

  if (req.method === 'GET') {
    const u = await sessionAccount(req, db);
    return json(res, 200, { user: u ? await withMenus(u, db) : null });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  if (action === 'logout') {                 // must work even with a dead session (FR-3.3)
    cookie(res, '');
    return json(res, 200, { ok: true });
  }

  // --- asking to sell here (FSD Phase 2 FR-31) ------------------------------
  // Open to any signed-in customer, and it grants nothing at all: it records that they asked, and
  // an admin decides. The role is never set from here — the same rule as FR-1.5, one rung up.
  if (action === 'request-owner') {
    const caller = await sessionAccount(req, db);
    if (!caller) return json(res, 401, { error: 'Please sign in first.' });
    if (caller.role === 'owner') return json(res, 409, { error: 'You already sell on matbyus.' });
    if (caller.role === 'admin') {
      return json(res, 400, { error: 'An administrator already has every owner screen.' });
    }
    if (caller.owner_status === 'requested') {
      return json(res, 200, {
        ok: true, ownerStatus: 'requested',
        message: 'Your request is already with the matbyus team.',
      });
    }
    const note = String((await body(req))?.note || '').slice(0, 300) || null;
    const [moved] = await db.query(
      `UPDATE mb_users SET owner_status = 'requested', updated_at = now()
        WHERE id = $1 AND role = 'customer' RETURNING owner_status`, [caller.id]);
    if (!moved) return json(res, 409, { error: 'That account cannot ask for an owner account.' });
    await db.query(
      `INSERT INTO mb_owner_status_log
         (user_id, from_status, to_status, from_role, to_role, note, actor_id)
       VALUES ($1, $2, 'requested', 'customer', 'customer', $3, $1)`,
      [caller.id, caller.owner_status || 'none', note]);
    return json(res, 200, {
      ok: true, ownerStatus: 'requested',
      message: 'Request sent. The matbyus team will review it and come back to you.',
    });
  }

  const ip = clientIp(req);
  const data = await body(req);
  const email = normaliseEmail(data.email);
  const password = String(data.password ?? '');

  if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (password.length > PASSWORD_MAX) return json(res, 400, { error: 'Password is too long.' });

  // --- sign in (FR-2) -------------------------------------------------------
  if (action === 'login') {
    const [ipCount, emailCount] = await Promise.all([
      rateCount('login:ip:' + ip), rateCount('login:email:' + email),
    ]);
    if (ipCount >= IP_LIMIT || emailCount >= EMAIL_LIMIT) return tooMany(res, WINDOW);

    const [user] = await db.query(
      `SELECT id, email, full_name, phone, password_hash, role, account_type, business_status,
                   owner_status, session_version FROM mb_users WHERE email = $1`, [email]);

    // FR-2.2: an unknown email and a wrong password are indistinguishable.
    if (!user || !check(password, user.password_hash)) {
      await Promise.all([
        rateLimit('login:ip:' + ip, IP_LIMIT, WINDOW),
        rateLimit('login:email:' + email, EMAIL_LIMIT, WINDOW),
      ]);
      return json(res, 401, { error: 'Email or password is incorrect.' });
    }
    await rateReset('login:email:' + email);
    cookie(res, token(user.id, user.session_version));
    return json(res, 200, { user: await withMenus(user, db) });
  }

  // Registration and reset share the IP limit so neither becomes a way around the sign-in limit.
  const limited = await rateLimit('auth:ip:' + ip, IP_LIMIT, WINDOW);
  if (!limited.allowed) return tooMany(res, limited.retryAfter);

  // --- registration (FR-1) --------------------------------------------------
  if (action === 'register') {
    const problem = passwordProblem(password);
    if (problem) return json(res, 400, { error: problem });

    const fullName = String(data.fullName || '').trim();
    if (!fullName) return json(res, 400, { error: 'Your name is required.' });

    const phone = normaliseMobile(data.phone);
    if (!phone) return json(res, 400, { error: 'Enter a valid 10-digit Indian mobile number.' });

    const accountType = data.accountType === 'business' ? 'business' : 'individual';

    // FR-1.5: registration can never create an admin. The role is not read from the request.
    const businessStatus = accountType === 'business' ? 'pending' : 'none';

    let business = null;
    if (accountType === 'business') {
      const r = readBusiness(data.business, { enforce: enforceChecksum(), lk: await lookups(db) });
      if (r.error) return json(res, 400, { error: r.error });
      business = r.value;
    }

    const rows = await db.query(
      `INSERT INTO mb_users (email, password_hash, full_name, phone, role, account_type, business_status)
       VALUES ($1, $2, $3, $4, 'customer', $5, $6)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, full_name, phone, role, account_type, business_status,
                 owner_status, session_version`,
      [email, hash(password), fullName, phone, accountType, businessStatus]);

    if (!rows.length) return json(res, 409, { error: 'An account with this email already exists.' });
    const user = rows[0];

    if (business) {
      await db.query(
        `INSERT INTO mb_business_profiles
           (user_id, legal_name, gstin, pan, state_code, contact_person,
            address_line1, address_line2, city, pincode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [user.id, business.legalName, business.gstin, business.pan, business.stateCode,
         business.contactPerson, business.addressLine1, business.addressLine2,
         business.city, business.pincode]);
      await db.query(
        `INSERT INTO mb_business_status_log (user_id, from_status, to_status, note, actor_id)
         VALUES ($1, NULL, 'pending', 'Submitted at registration', $1)`, [user.id]);
    }

    cookie(res, token(user.id, user.session_version));
    return json(res, 201, { user: await withMenus(user, db) });
  }

  // --- password reset (FR-4) ------------------------------------------------
  // Admin-only while signed in. Anonymous resets are refused; a locked-out admin uses
  // scripts/admin/reset-password.mjs. FSD L1 records why this is temporary.
  if (action === 'reset' || action === 'forgot') {
    const caller = await sessionAccount(req, db);
    if (!caller || caller.role !== 'admin') {
      return json(res, 403, {
        error: 'Passwords are reset by the store team. Contact support to have yours reset.',
      });
    }
    const problem = passwordProblem(password);
    if (problem) return json(res, 400, { error: problem });

    const [updated] = await db.query(
      `UPDATE mb_users SET password_hash = $1, session_version = session_version + 1,
              updated_at = now()
       WHERE email = $2
       RETURNING id, email, full_name, phone, role, account_type, business_status,
                 owner_status, session_version`,
      [hash(password), email]);

    if (!updated) return json(res, 404, { error: 'No account was found for that email.' });

    // Resetting your own password revokes your old sessions too; re-issue this one (FR-4.3).
    if (updated.id === caller.id) cookie(res, token(updated.id, updated.session_version));
    return json(res, 200, {
      ok: true,
      message: 'Password reset. Existing sessions for that account were signed out.',
    });
  }

  return json(res, 400, { error: 'Unknown action.' });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    // Never log the body, the password or the session. Code and message only (NFR-2, NFR-10).
    console.error('matbyus auth failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') {
      return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    }
    return json(res, 500, { error: 'Server error.' });
  }
}
