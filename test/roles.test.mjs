// Three roles: customer, owner, admin.
//
// The whole value of the owner role is that one owner cannot see or touch another's, so most of
// this file is that single claim pressed from several directions. The admin role is the opposite
// claim: it sees across every owner, and it is the only way into either privileged role.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as admin } from '../api/admin.js';
import { handle as auth } from '../api/auth.js';
import { handle as orders } from '../api/orders.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = (u, sv = 1) => `mb_session=${token(u.id, sv)}`;

const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try { await fn(mkReq({ method, url, body, cookie }), res, db); }
  catch (e) { if (!e?.status) throw e; res.statusCode = e.status; res.bodyText = JSON.stringify({ error: e.message }); }
  return res;
};
const seller = (db, cookie, query, body = null) => run(admin, db, {
  method: body ? 'POST' : 'GET', url: '/api/admin' + query, cookie, body,
});
const buyer = (db, cookie, query, body = null) => run(orders, db, {
  method: body ? 'POST' : 'GET', url: '/api/orders' + query, cookie, body,
});

const ADDRESS = {
  name: 'Ravi Kumar', phone: '9876543210', line1: '12 MG Road', city: 'Chennai',
  pincode: '600028', stateCode: '33',
};

// Two owners with a listing each, one admin, one customer. The shape most of these tests need.
async function market(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());

  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin', fullName: 'Karthi' });
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const beta = await makeUser(db, { email: 'beta@x.com', role: 'owner', fullName: 'Beta Suppliers' });
  const c = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });

  const cat = await makeCategory(db, { kind: 'material' });
  const alphaBag = await makeProduct(db, {
    sku: 'ALP-CEM-1', slug: 'alpha-cement', name: 'Alpha OPC 53 Cement',
    category_id: cat.id, owner_id: alpha.id,
  });
  const betaBag = await makeProduct(db, {
    sku: 'BET-CEM-1', slug: 'beta-cement', name: 'Beta OPC 53 Cement',
    category_id: cat.id, owner_id: beta.id,
  });
  const house = await makeProduct(db, {
    sku: 'HOU-CEM-1', slug: 'house-cement', name: 'House OPC 53 Cement',
    category_id: cat.id,                       // no owner: a listing from before owners existed
  });
  return { db, a, alpha, beta, c, alphaBag, betaBag, house, cat };
}

const place = async (db, customer, slug) => {
  const r = await buyer(db, cookieFor(customer), '?action=place', { slug, qty: 10, ...ADDRESS });
  assert.equal(r.statusCode, 201, r.bodyText);
  return r.json.order.reference;
};

// --- listings ----------------------------------------------------------------

test('an owner sees their own listings and nobody else\'s; an admin sees them all', async t => {
  const { db, a, alpha, beta } = await market(t);

  const mine = await seller(db, cookieFor(alpha), '?resource=products');
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.json.products.map(p => p.slug), ['alpha-cement']);
  assert.equal(mine.json.scope, 'own');

  const theirs = await seller(db, cookieFor(beta), '?resource=products');
  assert.deepEqual(theirs.json.products.map(p => p.slug), ['beta-cement']);

  const all = await seller(db, cookieFor(a), '?resource=products');
  assert.equal(all.json.scope, 'all');
  assert.deepEqual(all.json.products.map(p => p.slug).sort(),
    ['alpha-cement', 'beta-cement', 'house-cement']);
  // and the admin can tell whose is whose
  const byOwner = Object.fromEntries(all.json.products.map(p => [p.slug, p.owner_email]));
  assert.equal(byOwner['alpha-cement'], 'alpha@x.com');
  assert.equal(byOwner['house-cement'], null, 'a listing with no owner is the house');
});

test('an owner cannot read, edit, hide or publish another owner\'s listing', async t => {
  const { db, alpha, betaBag } = await market(t);
  const as = (action, body) => seller(db, cookieFor(alpha), `?resource=products&action=${action}`, body);

  for (const [action, body] of [
    ['update', { id: betaBag.id, name: 'Mine now' }],
    ['deactivate', { id: betaBag.id }],
    ['activate', { id: betaBag.id }],
  ]) {
    const r = await as(action, body);
    // 404, not 403: a 403 would confirm the listing exists (NFR-21).
    assert.equal(r.statusCode, 404, action);
    assert.match(r.json.error, /not found/);
  }

  const [row] = await db.query('SELECT name, is_active FROM mb_products WHERE id = $1', [betaBag.id]);
  assert.equal(row.name, 'Beta OPC 53 Cement', 'nothing was written');
  assert.equal(row.is_active, true);
});

test('a listing an owner creates is theirs, whatever the request body says', async t => {
  const { db, alpha, beta, cat } = await market(t);
  const r = await seller(db, cookieFor(alpha), '?resource=products&action=create', {
    sku: 'ALP-TMT-1', slug: 'alpha-tmt', name: 'Alpha TMT Fe500D 12mm', kind: 'material',
    unit: 'tonne', category_id: cat.id, price_retail: '62000.00', gst_rate: '18', hsn_sac: '7214',
    ownerId: beta.id,                      // an attempt to file it under another owner
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json.product.owner_id, alpha.id);
});

test('an admin may attribute a listing to an owner, but not to someone who is not one', async t => {
  const { db, a, beta, c, cat } = await market(t);
  const make = ownerId => seller(db, cookieFor(a), '?resource=products&action=create', {
    sku: 'X-' + Math.random().toString(36).slice(2, 8), slug: 'x-' + Math.random().toString(36).slice(2, 8),
    name: 'Something', kind: 'material', unit: 'bag', category_id: cat.id,
    price_retail: '100.00', gst_rate: '18', hsn_sac: '2523', ownerId,
  });

  const ok = await make(beta.id);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json.product.owner_id, beta.id);

  const no = await make(c.id);              // a customer is not an owner
  assert.equal(no.statusCode, 400);
  assert.match(no.json.error, /owner was not found/);
});

// --- orders --------------------------------------------------------------------

test('an order records which owner it was placed with, and only that owner sees it', async t => {
  const { db, a, alpha, beta, c } = await market(t);
  const refAlpha = await place(db, c, 'alpha-cement');
  const refBeta = await place(db, c, 'beta-cement');

  const mine = await seller(db, cookieFor(alpha), '?resource=orders');
  assert.deepEqual(mine.json.orders.map(o => o.reference), [refAlpha]);
  assert.equal(mine.json.counts.placed, 1, 'the counts are scoped too, not just the list');

  const theirs = await seller(db, cookieFor(beta), '?resource=orders');
  assert.deepEqual(theirs.json.orders.map(o => o.reference), [refBeta]);

  const all = await seller(db, cookieFor(a), '?resource=orders');
  assert.equal(all.json.counts.placed, 2);
  assert.deepEqual(all.json.orders.map(o => o.seller.email).sort(), ['alpha@x.com', 'beta@x.com']);

  // the customer is told who it is from, in both the list and the order itself
  const list = await buyer(db, cookieFor(c), '');
  assert.deepEqual(list.json.orders.map(o => o.soldBy).sort(), ['Alpha Traders', 'Beta Suppliers']);
  const one = await buyer(db, cookieFor(c), '?reference=' + refAlpha);
  assert.equal(one.json.order.soldBy, 'Alpha Traders');
});

test('an owner cannot move another owner\'s order, and is not told its state', async t => {
  const { db, alpha, beta, c } = await market(t);
  const ref = await place(db, c, 'beta-cement');

  const r = await seller(db, cookieFor(alpha), '?resource=orders&action=confirm', { reference: ref });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json.status, undefined, 'a refusal does not leak the status');

  const [row] = await db.query('SELECT status FROM mb_orders WHERE reference = $1', [ref]);
  assert.equal(row.status, 'placed', 'nothing moved');

  // the owner it belongs to can move it
  const ok = await seller(db, cookieFor(beta), '?resource=orders&action=confirm', { reference: ref });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.order.status, 'confirmed');
});

test('GST splits on the owner\'s own registered state, not one setting for the platform', async t => {
  const { db, alpha, c } = await market(t);
  delete process.env.MB_SELLER_STATE_CODE;

  // Alpha is registered in Tamil Nadu; the delivery is to Tamil Nadu, so it is CGST + SGST.
  await db.query('UPDATE mb_users SET account_type = $1, business_status = $2 WHERE id = $3',
    ['business', 'approved', alpha.id]);
  await db.query(
    `INSERT INTO mb_business_profiles (user_id, legal_name, state_code, address_line1, city, pincode)
     VALUES ($1, 'Alpha Traders', '33', '1 Anna Salai', 'Chennai', '600002')`, [alpha.id]);

  const ref = await place(db, c, 'alpha-cement');
  const [o] = await db.query(
    'SELECT seller_state_code, tax_split, cgst, sgst, igst FROM mb_orders WHERE reference = $1', [ref]);
  assert.equal(o.seller_state_code, '33');
  assert.equal(o.tax_split, 'cgst_sgst');
  assert.equal(Number(o.igst), 0);
  assert.ok(Number(o.cgst) > 0 && Number(o.sgst) > 0);

  // The house listing has no owner and no configured state, so its tax is recorded honestly as
  // unsplit rather than attributed to a regime matbyus has not been told about.
  const houseRef = await place(db, c, 'house-cement');
  const [h] = await db.query('SELECT tax_split, seller_state_code FROM mb_orders WHERE reference = $1', [houseRef]);
  assert.equal(h.seller_state_code, null);
  assert.equal(h.tax_split, 'unsplit');
});

// --- the boundary ----------------------------------------------------------------

test('a customer reaches no seller route at all, and a visitor reaches none either', async t => {
  const { db, c } = await market(t);
  const routes = ['?resource=products', '?resource=orders', '?resource=categories',
                  '?resource=customers', '?resource=approvals', '?resource=owners',
                  '?resource=permissions'];
  for (const q of routes) {
    assert.equal((await seller(db, cookieFor(c), q)).statusCode, 403, 'customer ' + q);
    assert.equal((await seller(db, '', q)).statusCode, 403, 'visitor ' + q);
  }
});

test('an owner reads the category list but cannot change it', async t => {
  const { db, alpha } = await market(t);
  const read = await seller(db, cookieFor(alpha), '?resource=categories');
  assert.equal(read.statusCode, 200);
  assert.ok(read.json.categories.length, 'an owner needs the list to file a listing under one');

  const write = await seller(db, cookieFor(alpha), '?resource=categories&action=create',
    { name: 'Mine', slug: 'mine', kind: 'material' });
  assert.equal(write.statusCode, 403);
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mb_categories WHERE slug = 'mine'");
  assert.equal(n, 0);
});

// --- becoming an owner -------------------------------------------------------------

test('registration cannot produce an owner; only an admin approving one can', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  for (const body of [{ role: 'owner' }, { role: 'admin' }, { ownerStatus: 'approved' }]) {
    const res = await run(auth, db, {
      method: 'POST', url: '/api/auth?action=register',
      body: { email: `r${Math.random().toString(36).slice(2, 8)}@x.com`, password: 'a-long-enough-one',
              fullName: 'R', phone: '9876543210', ...body },
    });
    assert.equal(res.statusCode, 201, res.bodyText);
    assert.equal(res.json.user.role, 'customer');
    assert.equal(res.json.user.ownerStatus, 'none');
  }
});

test('a customer asks to sell, an admin approves, and the role changes', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const c = await makeUser(db, { email: 'wants@x.com', fullName: 'Wants To Sell' });

  const asked = await run(auth, db, {
    method: 'POST', url: '/api/auth?action=request-owner', cookie: cookieFor(c), body: { note: 'I run a yard' },
  });
  assert.equal(asked.statusCode, 200);
  assert.equal(asked.json.ownerStatus, 'requested');

  // asking again is not an error, and does not queue a second request
  const again = await run(auth, db, {
    method: 'POST', url: '/api/auth?action=request-owner', cookie: cookieFor(c), body: {},
  });
  assert.equal(again.statusCode, 200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_owner_status_log'))[0].n, 1);

  // the request shows up for the admin, who can see what they have sold (nothing, yet)
  const queue = await seller(db, cookieFor(a), '?resource=owners');
  assert.equal(queue.json.pending, 1);
  const row = queue.json.owners.find(o => o.email === 'wants@x.com');
  assert.equal(row.ownerStatus, 'requested');
  assert.equal(row.soldLabel, '₹0.00');

  const ok = await seller(db, cookieFor(a), '?resource=owners&action=approve', { id: c.id });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.role, 'owner');

  const [u] = await db.query('SELECT role, owner_status, session_version FROM mb_users WHERE id = $1', [c.id]);
  assert.equal(u.role, 'owner');
  assert.equal(u.owner_status, 'approved');
  assert.equal(Number(u.session_version), 2, 'approval signs their old sessions out');

  // the old cookie is dead; a session minted after the change carries the owner menus
  assert.equal((await run(auth, db, { url: '/api/auth', cookie: cookieFor(c, 1) })).json.user, null);
  const now = await run(auth, db, { url: '/api/auth', cookie: cookieFor(c, 2) });
  assert.equal(now.json.user.role, 'owner');
  assert.ok(now.json.user.menus.some(m => m.key === 'storeorders'));
});

test('rejecting an owner moves the role and the status together', async t => {
  const { db, a, alpha } = await market(t);
  const r = await seller(db, cookieFor(a), '?resource=owners&action=reject',
    { id: alpha.id, note: 'Paperwork did not check out' });
  assert.equal(r.statusCode, 200);

  // mb_users_owner_role_check: there is no row where role is owner and the status is not approved,
  // so these two must change in one statement or not at all.
  const [u] = await db.query('SELECT role, owner_status FROM mb_users WHERE id = $1', [alpha.id]);
  assert.equal(u.role, 'customer');
  assert.equal(u.owner_status, 'rejected');

  const [log] = await db.query(
    'SELECT from_role, to_role, to_status, note, actor_id FROM mb_owner_status_log WHERE user_id = $1', [alpha.id]);
  assert.equal(log.from_role, 'owner');
  assert.equal(log.to_role, 'customer');
  assert.equal(log.to_status, 'rejected');
  assert.equal(log.actor_id, a.id);
  assert.match(log.note, /Paperwork/);
});

test('the database itself refuses an owner who was never approved', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await assert.rejects(() => db.query(
    `INSERT INTO mb_users (email, password_hash, phone, role, owner_status)
     VALUES ('sneak@x.com', 's1$x$y', '+919876543210', 'owner', 'requested')`),
    e => { assert.match(String(e.message), /owner_role_check|constraint|violates/i); return true; });
});

// --- becoming an admin ---------------------------------------------------------------

test('only an admin can make an admin, and matbyus cannot be left without one', async t => {
  const { db, a, alpha, c } = await market(t);

  // the last administrator cannot be removed, by anyone
  const lastOne = await seller(db, cookieFor(a), '?resource=owners&action=revoke-admin', { id: a.id });
  assert.equal(lastOne.statusCode, 400);
  assert.match(lastOne.json.error, /your own administrator role/);

  // promote the owner, which signs them out
  const up = await seller(db, cookieFor(a), '?resource=owners&action=grant-admin', { id: alpha.id });
  assert.equal(up.statusCode, 200);
  const [now] = await db.query('SELECT role, owner_status, session_version FROM mb_users WHERE id = $1', [alpha.id]);
  assert.equal(now.role, 'admin');
  assert.equal(Number(now.session_version), 2);

  // the new admin can demote the old one; the demotion returns them to what they were
  const down = await seller(db, cookieFor(alpha, 2), '?resource=owners&action=revoke-admin', { id: a.id });
  assert.equal(down.statusCode, 200);
  assert.equal(down.json.role, 'customer', 'the first admin was never an approved owner');

  // alpha kept owner_status 'approved' from before, so revoking their admin returns them to owner
  const back = await seller(db, cookieFor(alpha, 2), '?resource=owners&action=revoke-admin', { id: alpha.id });
  assert.equal(back.statusCode, 400, 'still cannot revoke your own');
  assert.equal(now.owner_status, 'approved');

  // and a customer never could
  assert.equal((await seller(db, cookieFor(c), '?resource=owners&action=grant-admin', { id: c.id })).statusCode, 403);
});
