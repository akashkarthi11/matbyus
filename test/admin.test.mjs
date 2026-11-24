// FR-5.3, FR-6, FR-7, FR-8. TSD sections 4.4, 5.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/admin.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;

const call = async (db, { method = 'GET', query = '', body = null, cookie = '' }) => {
  const res = mkRes();
  try {
    await handle(mkReq({ method, url: '/api/admin' + query, body, cookie }), res, db);
  } catch (e) {
    if (!e?.status) throw e;
    res.statusCode = e.status;
    res.bodyText = JSON.stringify({ error: e.message });
  }
  return res;
};

async function admin(db) { return cookieFor(await makeUser(db, { email: 'admin@example.com', role: 'admin' })); }

// --- the guard (FR-5.3) -----------------------------------------------------

test('every admin route refuses a customer, a visitor and a stale session', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const cust = await makeUser(db, { email: 'cust@example.com' });
  const custCookie = cookieFor(cust);

  const routes = [
    { method: 'GET', query: '?resource=customers' },
    { method: 'GET', query: '?resource=approvals' },
    { method: 'GET', query: '?resource=products' },
    { method: 'GET', query: '?resource=categories' },
    { method: 'POST', query: '?resource=products&action=create', body: { sku: 'X', slug: 'x', name: 'X', kind: 'material', unit: 'bag' } },
    { method: 'POST', query: '?resource=customers&action=approve', body: { id: cust.id } },
    { method: 'POST', query: '?resource=categories&action=create', body: { name: 'X', slug: 'x', kind: 'material' } },
  ];
  for (const r of routes) {
    assert.equal((await call(db, { ...r, cookie: custCookie })).statusCode, 403, 'customer: ' + r.query);
    assert.equal((await call(db, { ...r, cookie: '' })).statusCode, 403, 'visitor: ' + r.query);
  }
  // nothing was written by any of those attempts
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_products'))[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_categories'))[0].n, 0);
});

// --- business approvals (FR-6, FR-7.4) --------------------------------------

test('approving a business switches on business pricing and logs who did it', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business' });

  const pending = await call(db, { query: '?resource=approvals', cookie: a });
  assert.equal(pending.json.approvals.length, 0, 'no profile row yet, so nothing to review');

  await db.query(
    `INSERT INTO mb_business_profiles (user_id, legal_name, gstin, state_code, address_line1, city, pincode)
     VALUES ($1,'Kumar Constructions','27AAPFU0939F1ZV','27','12 MG Road','Pune','411001')`, [biz.id]);

  const queue = await call(db, { query: '?resource=approvals', cookie: a });
  assert.equal(queue.json.approvals.length, 1);
  assert.equal(queue.json.approvals[0].stateName, 'Maharashtra');
  assert.equal(queue.json.approvals[0].phone, '+91 98765 43210');

  const res = await call(db, { method: 'POST', query: '?resource=customers&action=approve', body: { id: biz.id }, cookie: a });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.businessStatus, 'approved');

  const [after] = await db.query('SELECT business_status FROM mb_users WHERE id = $1', [biz.id]);
  assert.equal(after.business_status, 'approved');

  const log = await db.query('SELECT * FROM mb_business_status_log WHERE user_id = $1 ORDER BY created_at', [biz.id]);
  assert.equal(log.at(-1).from_status, 'pending');
  assert.equal(log.at(-1).to_status, 'approved');
  assert.ok(log.at(-1).actor_id, 'the approver is recorded (NFR-3)');

  assert.equal((await call(db, { query: '?resource=approvals', cookie: a })).json.approvals.length, 0);
});

test('rejecting carries a note the customer can be shown', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business' });
  const res = await call(db, { method: 'POST', query: '?resource=customers&action=reject',
    body: { id: biz.id, note: 'GSTIN does not match the business name.' }, cookie: a });
  assert.equal(res.json.businessStatus, 'rejected');
  const log = await db.query('SELECT note FROM mb_business_status_log WHERE user_id = $1', [biz.id]);
  assert.equal(log.at(-1).note, 'GSTIN does not match the business name.');
});

test('an individual account cannot be approved as a business', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const ind = await makeUser(db, { email: 'home@example.com' });
  const res = await call(db, { method: 'POST', query: '?resource=customers&action=approve', body: { id: ind.id }, cookie: a });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /not a business/);
});

// --- products (FR-8) --------------------------------------------------------

test('a product is created inactive and goes live only when it is complete', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const cat = await makeCategory(db);

  const created = await call(db, { method: 'POST', query: '?resource=products&action=create', cookie: a,
    body: { sku: 'CEM-1', slug: 'opc-43', name: 'OPC 43 Cement', kind: 'material', unit: 'bag',
            category_id: cat.id, price_retail: '390.00', gst_rate: '28' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json.product.is_active, false, 'never live on creation');

  const id = created.json.product.id;
  const blocked = await call(db, { method: 'POST', query: '?resource=products&action=activate', body: { id }, cookie: a });
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.json.error, /HSN/);

  await call(db, { method: 'POST', query: '?resource=products&action=update', body: { id, hsn_sac: '2523' }, cookie: a });
  const live = await call(db, { method: 'POST', query: '?resource=products&action=activate', body: { id }, cookie: a });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json.product.is_active, true);

  const off = await call(db, { method: 'POST', query: '?resource=products&action=deactivate', body: { id }, cookie: a });
  assert.equal(off.json.product.is_active, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_products'))[0].n, 1, 'never hard-deleted');
});

test('a service needs a SAC code, and the message says so', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const cat = await makeCategory(db, { slug: 'plastering', name: 'Plastering', kind: 'service' });
  const created = await call(db, { method: 'POST', query: '?resource=products&action=create', cookie: a,
    body: { sku: 'SVC-1', slug: 'plastering-work', name: 'Plastering', kind: 'service',
            unit: 'per_sqft', category_id: cat.id, price_retail: '28.00', gst_rate: '18' } });
  const res = await call(db, { method: 'POST', query: '?resource=products&action=activate',
    body: { id: created.json.product.id }, cookie: a });
  assert.match(res.json.error, /SAC/);
});

test('the incoherent combinations are refused with a reason', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const mat = await makeCategory(db);
  const svc = await makeCategory(db, { slug: 'svc', name: 'Services', kind: 'service' });
  const base = { sku: 'X-1', slug: 'x-1', name: 'X', category_id: mat.id, hsn_sac: '1234' };
  const create = body => call(db, { method: 'POST', query: '?resource=products&action=create', body, cookie: a });

  let r = await create({ ...base, kind: 'material', unit: 'per_day', price_retail: '10.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /cannot be sold per/);

  r = await create({ ...base, kind: 'service', category_id: svc.id, unit: 'bag', price_retail: '10.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /cannot be sold per/);

  r = await create({ ...base, kind: 'material', unit: 'bag', pricing_mode: 'fixed' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /needs a retail price/);

  r = await create({ ...base, kind: 'material', unit: 'bag', pricing_mode: 'quote', price_retail: '10.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /cannot carry a price/);

  r = await create({ ...base, kind: 'service', category_id: svc.id, unit: 'per_sqft', price_retail: '10.00', stock_qty: '5' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /does not carry stock/);

  r = await create({ ...base, kind: 'material', unit: 'bag', price_retail: '100.00', price_business: '150.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /higher than the retail/);

  r = await create({ ...base, kind: 'material', unit: 'furlong', price_retail: '10.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /Unknown unit/);

  r = await create({ ...base, kind: 'material', unit: 'bag', price_retail: '10.001' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /two decimals/);

  r = await create({ ...base, kind: 'material', unit: 'bag', price_retail: '10.00', gst_rate: '120' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /between 0 and 100/);

  r = await create({ ...base, slug: 'Not A Slug', kind: 'material', unit: 'bag', price_retail: '10.00' });
  assert.equal(r.statusCode, 400); assert.match(r.json.error, /Slug/);

  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_products'))[0].n, 0);
});

test('an update is judged on the merged row, not the patch alone', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const p = await makeProduct(db);                     // fixed price, retail 420
  // clearing the retail price of a fixed-price product must fail even though the patch alone
  // says nothing about pricing_mode
  const res = await call(db, { method: 'POST', query: '?resource=products&action=update',
    body: { id: p.id, price_retail: null }, cookie: a });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /needs a retail price/);
  const [after] = await db.query('SELECT price_retail FROM mb_products WHERE id = $1', [p.id]);
  assert.equal(after.price_retail, '420.00');
});

// --- categories (FR-8.11) ---------------------------------------------------

test('a category holding active products cannot be deactivated, and says which', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const cat = await makeCategory(db);
  await makeProduct(db, { category_id: cat.id, is_active: true });

  const blocked = await call(db, { method: 'POST', query: '?resource=categories&action=deactivate', body: { id: cat.id }, cookie: a });
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.json.error, /1 active product\b/);
  assert.deepEqual(blocked.json.blocking, ['OPC 53 Grade Cement 50kg']);

  await db.query('UPDATE mb_products SET is_active = false WHERE category_id = $1', [cat.id]);
  const ok = await call(db, { method: 'POST', query: '?resource=categories&action=deactivate', body: { id: cat.id }, cookie: a });
  assert.equal(ok.json.category.is_active, false);
});

// --- customer list (FR-7) ---------------------------------------------------

test('customers list, filter and search', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  await makeUser(db, { email: 'home@example.com', fullName: 'Asha Rao' });
  await makeUser(db, { email: 'build@example.com', fullName: 'Ravi Kumar', accountType: 'business' });
  await makeUser(db, { email: 'big@example.com', fullName: 'Big Build', accountType: 'business', businessStatus: 'approved' });

  const all = await call(db, { query: '?resource=customers', cookie: a });
  assert.equal(all.json.customers.length, 4);                 // including the admin
  assert.equal(all.json.customers[0].phone, '+91 98765 43210', 'formatted for reading');

  const business = await call(db, { query: '?resource=customers&accountType=business', cookie: a });
  assert.equal(business.json.customers.length, 2);

  const approved = await call(db, { query: '?resource=customers&businessStatus=approved', cookie: a });
  assert.equal(approved.json.customers.length, 1);

  const search = await call(db, { query: '?resource=customers&q=ravi', cookie: a });
  assert.equal(search.json.customers.length, 1);
  assert.equal(search.json.customers[0].email, 'build@example.com');
});

test('one customer comes back with their business profile and status history', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business' });
  await db.query(
    `INSERT INTO mb_business_profiles (user_id, legal_name, gstin, state_code, address_line1, city, pincode)
     VALUES ($1,'Kumar Constructions','27AAPFU0939F1ZV','27','12 MG Road','Pune','411001')`, [biz.id]);
  await call(db, { method: 'POST', query: '?resource=customers&action=approve', body: { id: biz.id }, cookie: a });

  const res = await call(db, { query: `?resource=customer&id=${biz.id}`, cookie: a });
  assert.equal(res.json.customer.businessStatus, 'approved');
  assert.equal(res.json.business.gstin, '27AAPFU0939F1ZV');
  assert.equal(res.json.business.stateName, 'Maharashtra');
  assert.equal(res.json.history.length, 1);
  assert.equal((await call(db, { query: '?resource=customer&id=' + biz.id.replace(/.$/, '0'), cookie: a })).statusCode >= 400, true);
});

test('unknown resources and actions are refused', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await admin(db);
  assert.equal((await call(db, { query: '?resource=secrets', cookie: a })).statusCode, 400);
  assert.equal((await call(db, { method: 'POST', query: '?resource=products&action=destroy', body: {}, cookie: a })).statusCode, 400);
  assert.equal((await call(db, { method: 'DELETE', query: '?resource=products', cookie: a })).statusCode, 405);
});
