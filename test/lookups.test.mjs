// Every lookup comes from the database (migration 0005). These tests are what makes that claim
// checkable rather than a comment.
//
// The one that matters most is "a unit added as a row works with no code change": if that ever
// fails, a list has crept back into the source and the two will drift apart again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as admin } from '../api/admin.js';
import { handle as meta } from '../api/meta.js';
import { handle as catalog } from '../api/catalog.js';
import { lookups, forgetLookups } from '../api/_lookups.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;
const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try { await fn(mkReq({ method, url, body, cookie }), res, db); }
  catch (e) { if (!e?.status) throw e; res.statusCode = e.status; res.bodyText = JSON.stringify({ error: e.message }); }
  return res;
};

// --- units ------------------------------------------------------------------

test('units, their labels and the kind they belong to all come from mb_units', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);

  assert.equal(lk.unitAllowedFor('bag', 'material'), true);
  assert.equal(lk.unitAllowedFor('bag', 'service'), false);
  assert.equal(lk.unitAllowedFor('per_day', 'service'), true);
  assert.equal(lk.unitAllowedFor('per_day', 'material'), false);
  assert.equal(lk.unitAllowedFor('sqft', 'material'), true, "'both' means both");
  assert.equal(lk.unitAllowedFor('sqft', 'service'), true);
  assert.equal(lk.unitAllowedFor('furlong', 'material'), false);

  assert.equal(lk.formatQuantity(10, 'bag'), '10 bags');
  assert.equal(lk.formatQuantity(1, 'bag'), '1 bag');
  assert.equal(lk.formatQuantity(2, 'brass'), '2 brass');
  assert.equal(lk.formatQuantity(500, 'number'), '500 nos');

  // the form's list and the server's list are the same rows
  assert.deepEqual(lk.unitList('service').map(u => u.code),
    lk.units.filter(u => u.applies_to === 'service' || u.applies_to === 'both').map(u => u.code));
});

test('a unit added as a row is usable immediately, with no deploy', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const cat = await makeCategory(db, { kind: 'material' });

  const create = () => run(admin, db, {
    method: 'POST', url: '/api/admin?resource=products&action=create', cookie: cookieFor(a),
    body: { sku: 'SAND-TIP-1', slug: 'river-sand-tipper', name: 'River sand, tipper load',
            kind: 'material', unit: 'tipper', category_id: cat.id,
            price_retail: '18000.00', gst_rate: '5', hsn_sac: '2505' },
  });

  const before = await create();
  assert.equal(before.statusCode, 400);
  assert.match(before.json.error, /Unknown unit/);

  await db.query(
    `INSERT INTO mb_units (code, label, plural, applies_to, sort_order)
     VALUES ('tipper', 'tipper load', 'tipper loads', 'material', 20)`);
  forgetLookups(db);                       // the cache is a minute long; the test does not wait

  const after = await create();
  assert.equal(after.statusCode, 201, after.bodyText);
  assert.equal(after.json.product.unit, 'tipper');

  // and the browser is offered it on the same read the API validates against
  const m = await run(meta, db, { url: '/api/meta' });
  assert.ok(m.json.units.some(u => u.key === 'tipper' && u.label === 'tipper load'));

  // the catalogue labels it from the same row, not from a constant
  await db.query('UPDATE mb_products SET is_active = true WHERE slug = $1', ['river-sand-tipper']);
  const c = await run(catalog, db, { url: '/api/catalog?slug=river-sand-tipper' });
  assert.equal(c.json.product.unitLabel, 'tipper load');
});

test('the unit rule is enforced by the database, not only by the handler', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const svc = await makeCategory(db, { slug: 'svc', name: 'Services', kind: 'service' });
  const ins = `INSERT INTO mb_products (sku, slug, name, kind, category_id, unit, price_retail, hsn_sac)
               VALUES ($1,$2,'P',$3,$4,$5,'10.00','1234')`;

  // the trigger reads mb_units.applies_to — no application code involved
  await assert.rejects(() => db.query(ins, ['S1', 's1', 'service', svc.id, 'bag']),
    e => { assert.match(String(e.message), /violates the unit rule/); return true; });
  // and an unknown unit is a foreign key violation
  await assert.rejects(() => db.query(ins, ['S2', 's2', 'service', svc.id, 'furlong']),
    e => { assert.match(String(e.message), /violates|constraint/i); return true; });
  // deactivating a unit stops new listings using it, without touching the ones already on it
  await db.query("UPDATE mb_units SET is_active = false WHERE code = 'per_visit'");
  await assert.rejects(() => db.query(ins, ['S3', 's3', 'service', svc.id, 'per_visit']),
    e => { assert.match(String(e.message), /not an active unit/); return true; });
});

// --- states -------------------------------------------------------------------

test('GST state codes come from mb_states', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);
  assert.equal(lk.stateName('33'), 'Tamil Nadu');
  assert.equal(lk.stateName('27'), 'Maharashtra');
  assert.equal(lk.stateName('99'), null);
  assert.equal(lk.validStateCode('07'), true);
  assert.equal(lk.validStateCode('97'), true);
  assert.equal(lk.validStateCode('7'), false, 'codes are two characters');

  // the address the browser can pick and the address the order will accept are one list
  const m = await run(meta, db, { url: '/api/meta' });
  assert.deepEqual(m.json.states.map(s => s.code), lk.states.map(s => s.code));
  assert.equal(m.json.states.length, 39, 'state codes 01-38 plus 97, Other Territory');
});

test('an order cannot name a state that is not in the table', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const c = await makeUser(db, { email: 'c@x.com' });
  await assert.rejects(() => db.query(
    `INSERT INTO mb_orders (reference, customer_id, place_of_supply_state, ship_name, ship_phone,
       ship_line1, ship_city, ship_pincode, subtotal_excl, tax_total, total)
     VALUES ('MB-TEST-0001', $1, '99', 'R', '+919876543210', '1 Rd', 'Pune', '411001', 100, 18, 118)`,
    [c.id]),
    e => { assert.match(String(e.message), /violates|constraint/i); return true; });
});

// --- the order status machine ------------------------------------------------------

test('the moves an order can make are rows, and both sides read the same rows', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);

  assert.deepEqual(lk.statusCodes, ['placed', 'confirmed', 'dispatched', 'collected', 'cancelled']);
  assert.deepEqual(lk.move('seller', 'collect').from.slice().sort(), ['confirmed', 'dispatched']);
  assert.equal(lk.move('seller', 'collect').to, 'collected');
  assert.equal(lk.move('seller', 'teleport'), null);
  assert.equal(lk.move('customer', 'confirm'), null, 'a customer cannot accept their own order');
  assert.deepEqual(lk.move('customer', 'cancel').from, ['placed']);

  // what the seller's screen draws for a row comes from the same place the API checks
  const m = await run(meta, db, { url: '/api/meta' });
  assert.deepEqual(m.json.orderFlow.placed.map(x => x.action), ['confirm', 'cancel']);
  assert.equal(m.json.orderFlow.placed[0].label, 'Accept');
  assert.equal(m.json.orderFlow.placed[0].primary, true);
  assert.deepEqual(m.json.orderFlow.collected, [], 'a collected order is finished');
  assert.deepEqual(m.json.customerFlow.placed.map(x => x.action), ['cancel']);
  // Since migration 0006 a customer can also close an order out, by scanning the seller's code.
  // Which of their moves needs that code is a column, so the screen knows to open a camera rather
  // than post a button press — see test/handover.test.mjs.
  assert.deepEqual(m.json.customerFlow.confirmed.map(x => x.action), ['collect']);
  assert.equal(m.json.customerFlow.confirmed[0].needsToken, true);
  assert.equal(m.json.customerFlow.placed[0].needsToken, false);
  assert.deepEqual(m.json.customerFlow.collected, [], 'a collected order is finished for them too');
});

test('a move the table does not hold is refused, and removing one takes effect', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const c = await makeUser(db, { email: 'c@x.com' });
  await makeProduct(db);

  const { handle: orders } = await import('../api/orders.js');
  const placed = await run(orders, db, {
    method: 'POST', url: '/api/orders?action=place', cookie: cookieFor(c),
    body: { slug: 'opc-53-cement-50kg', qty: 10, name: 'R', phone: '9876543210',
            line1: '1 Road', city: 'Chennai', pincode: '600028', stateCode: '33' },
  });
  assert.equal(placed.statusCode, 201);
  const reference = placed.json.order.reference;

  const move = action => run(admin, db, {
    method: 'POST', url: '/api/admin?resource=orders&action=' + action,
    cookie: cookieFor(a), body: { reference },
  });

  assert.equal((await move('teleport')).statusCode, 400);

  // delete the "accept" row and the API stops accepting orders, with no code change
  await db.query("DELETE FROM mb_order_transitions WHERE actor = 'seller' AND action = 'confirm'");
  forgetLookups(db);
  const gone = await move('confirm');
  assert.equal(gone.statusCode, 400);
  assert.match(gone.json.error, /Unknown action/);
  const [row] = await db.query('SELECT status FROM mb_orders WHERE reference = $1', [reference]);
  assert.equal(row.status, 'placed');
});

// --- the small enums and the failure mode ---------------------------------------------

test('labels for the small enums come from mb_lookups', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);
  assert.equal(lk.label('stock_status', 'out_of_stock'), 'Out of stock');
  assert.equal(lk.label('business_status', 'pending'), 'Being verified');
  assert.equal(lk.label('owner_status', 'requested'), 'Asked to sell here');
  assert.equal(lk.label('tax_split', 'unsplit'), 'GST (seller state not set)');
  assert.equal(lk.label('stock_status', 'invented'), null);
  assert.deepEqual(lk.meta('stock_status', 'out_of_stock'), { tone: 'out' });

  const m = await run(meta, db, { url: '/api/meta' });
  assert.deepEqual(m.json.lookups.gst_rate.map(x => x.code), ['0', '5', '12', '18', '28']);
  assert.equal(m.json.lookups.gst_rate[4].label, '28%');
});

test('a deployment without the lookup tables says so instead of inventing them', async t => {
  setEnv(); const db = await freshDb({ upto: '0004' }); t.after(() => db.close());
  // 0005 has not run, so mb_roles, mb_units, mb_states and the rest do not exist. There is no
  // fallback list: a half-migrated deployment is reported, not papered over with constants that
  // the database does not share.
  await assert.rejects(() => lookups(db), e => {
    assert.equal(e.code, 'CONFIG', 'CONFIG is what every handler turns into a 503');
    assert.match(e.message, /Run the migrations/);
    return true;
  });
  // and the endpoint that serves the browser its reference data fails the same way
  await assert.rejects(() => meta(mkReq({ url: '/api/meta' }), mkRes(), db),
    e => { assert.equal(e.code, 'CONFIG'); return true; });
});

test('an empty lookup table is treated as a missing one', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await db.query('DELETE FROM mb_menus');
  await db.query('DELETE FROM mb_role_menus');
  await db.query('DELETE FROM mb_units WHERE true');
  forgetLookups(db);
  await assert.rejects(() => lookups(db), e => {
    assert.equal(e.code, 'CONFIG');
    assert.match(e.message, /lookup table is empty/);
    return true;
  });
});

// --- the bid rulebook (migration 0011) ----------------------------------------

test('bid statuses and actions come from mb_bid_statuses and mb_bid_actions, not code', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);

  assert.deepEqual(lk.bidStatusCodes,
    ['open', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired', 'ordered']);
  assert.equal(lk.bidStatus('countered').label, 'Countered');
  assert.equal(lk.bidStatus('countered').is_open, true);
  assert.equal(lk.bidStatus('accepted').is_open, false);

  const counter = lk.bidAction('counter');
  assert.equal(counter.to, 'countered');
  assert.equal(counter.needsPrice, true);
  assert.equal(counter.restrictSide, null);

  const withdraw = lk.bidAction('withdraw');
  assert.equal(withdraw.to, 'withdrawn');
  assert.equal(withdraw.restrictSide, 'customer');
  assert.equal(withdraw.anyTurn, true);

  // the browser is offered the same list the server validates against
  const m = await run(meta, db, { url: '/api/meta' });
  assert.deepEqual(m.json.bidStatuses.map(s => s.code), lk.bidStatusCodes);
  assert.deepEqual(m.json.bidActions.map(a => a.action).sort(),
    ['accept', 'counter', 'reject', 'withdraw']);
});

test('removing a bid action disables it, with no code change', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha' });
  const c = await makeUser(db, { email: 'c@x.com' });
  const cat = await makeCategory(db, { kind: 'material' });
  const product = await makeProduct(db, {
    sku: 'A1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: a.id,
  });

  const { handle: bids } = await import('../api/bids.js');
  const placed = await run(bids, db, {
    method: 'POST', url: '/api/bids?action=place', cookie: cookieFor(c),
    body: { slug: product.slug, qty: 10, unitPrice: '10.00' },
  });
  assert.equal(placed.statusCode, 201, placed.bodyText);

  await db.query("DELETE FROM mb_bid_actions WHERE action = 'counter'");
  forgetLookups(db);

  const r = await run(bids, db, {
    method: 'POST', url: '/api/bids?action=counter', cookie: cookieFor(a),
    body: { id: placed.json.bid.id, unitPrice: '12.00' },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /Unknown action/);
});
