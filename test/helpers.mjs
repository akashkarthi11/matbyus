// Test harness: a real Postgres (PGlite, in memory) with every migration applied in order, plus
// minimal req/res doubles. Running the actual migrations rather than a hand-written test schema is
// the point — every CHECK constraint, foreign key and trigger is under test, and so is the lookup
// data those migrations seed, which the server now reads instead of holding constants.

import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hash, resetAllLimits } from '../api/_lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'scripts', 'migrations');

export const TEST_SECRET = 'test-secret-that-is-definitely-long-enough-32';

export const migrationFiles = () =>
  readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

export const migration = name => readFileSync(join(MIGRATIONS, name), 'utf8');

// `upto` stops after the named file, for the cases that need to prove the server copes with a
// part-migrated deployment. Everything else gets the whole schema.
export async function freshDb({ upto = null } = {}) {
  const pg = new PGlite();
  for (const f of migrationFiles()) {
    await pg.exec(migration(f));
    if (upto && f.startsWith(upto)) break;
  }
  return {
    async query(text, params = []) {
      const r = await pg.query(text, params);
      return r.rows;
    },
    _pg: pg,
    close: () => pg.close(),
  };
}

export function setEnv() {
  process.env.MB_SESSION_SECRET = TEST_SECRET;
  resetAllLimits();
}

// --- request / response doubles --------------------------------------------

export function mkReq({ method = 'GET', url = '/api/auth', body = null, cookie = '', headers = {} } = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  return {
    method,
    url,
    headers: { cookie, 'x-forwarded-for': '203.0.113.9', ...headers },
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() { if (payload) yield payload; },
  };
}

export function mkRes() {
  return {
    statusCode: 200,
    headers: {},
    bodyText: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(s) { this.bodyText = s ?? ''; },
    get json() { try { return JSON.parse(this.bodyText || '{}'); } catch { return {}; } },
    // the session cookie this response issued, ready to send back on the next request
    get cookie() {
      const sc = this.headers['set-cookie'];
      return sc ? String(sc).split(';')[0] : '';
    },
  };
}

// --- fixtures ---------------------------------------------------------------

export async function makeUser(db, {
  email = 'buyer@example.com', password = 'correct-horse-battery',
  role = 'customer', accountType = 'individual', businessStatus = null,
  phone = '+919876543210', fullName = 'Test Buyer', ownerStatus = null,
} = {}) {
  const status = businessStatus ?? (accountType === 'business' ? 'pending' : 'none');
  // mb_users_owner_role_check: an owner row is only legal with owner_status 'approved', so the
  // fixture follows the database rather than letting a test construct a row production cannot.
  const owner = ownerStatus ?? (role === 'owner' ? 'approved' : 'none');
  const [u] = await db.query(
    `INSERT INTO mb_users (email, password_hash, full_name, phone, role, account_type,
                           business_status, owner_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [email, hash(password), fullName, phone, role, accountType, status, owner]);
  return u;
}

export async function makeCategory(db, { slug = 'cement', name = 'Cement', kind = 'material' } = {}) {
  const [c] = await db.query(
    'INSERT INTO mb_categories (slug, name, kind) VALUES ($1,$2,$3) RETURNING *',
    [slug, name, kind]);
  return c;
}

export async function makeProduct(db, over = {}) {
  const p = {
    sku: 'CEM-OPC53-50', slug: 'opc-53-cement-50kg', name: 'OPC 53 Grade Cement 50kg',
    kind: 'material', summary: 'Ordinary Portland Cement, 53 grade',
    unit: 'bag', pack_size: 50, pricing_mode: 'fixed',
    price_retail: '420.00', price_business: '395.00', min_order_qty: 10,
    stock_qty: 500, stock_status: 'in_stock', hsn_sac: '2523', gst_rate: '28.00',
    is_active: true, ...over,
  };
  if (!p.category_id) p.category_id = (await makeCategory(db, { kind: p.kind })).id;
  const cols = Object.keys(p);
  const [row] = await db.query(
    `INSERT INTO mb_products (${cols.join(',')})
     VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
    cols.map(c => p[c]));
  return row;
}
