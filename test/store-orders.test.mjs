// The store side of orders — FSD Phase 2 FR-25.5, FR-25.6, FR-29.9.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as admin } from '../api/admin.js';
import { handle as orders } from '../api/orders.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeProduct } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = n => readFileSync(join(here, '..', 'scripts', 'migrations', n), 'utf8');

async function dbWithOrders() {
  const db = await freshDb();
  await db._pg.exec(migration('0001_orders.sql'));
  await db._pg.exec(migration('0002_order_handover.sql'));
  return db;
}

const cookieFor = u => `mb_session=${token(u.id, 1)}`;

const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try {
    await fn(mkReq({ method, url, body, cookie }), res, db);
  } catch (e) {
    if (!e?.status) throw e;
    res.statusCode = e.status;
    res.bodyText = JSON.stringify({ error: e.message });
  }
  return res;
};
const asAdmin = (db, opts) => run(admin, db, { url: '/api/admin' + (opts.query || ''), ...opts });
const asCustomer = (db, opts) => run(orders, db, { url: '/api/orders' + (opts.query || ''), ...opts });

const ADDRESS = {
  name: 'Ravi Kumar', phone: '9876543210', line1: '12 MG Road', city: 'Chennai',
  pincode: '600028', stateCode: '33',
};

async function placeOne(db, customer) {
  const r = await asCustomer(db, {
    method: 'POST', query: '?action=place', cookie: cookieFor(customer),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS },
  });
  assert.equal(r.statusCode, 201);
  return r.json.order.reference;
}

async function setup(t) {
  setEnv();
  const db = await dbWithOrders();
  t.after(() => db.close());
  await makeProduct(db);
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const c = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  return { db, adminCookie: cookieFor(a), customer: c };
}

// --- who may look ------------------------------------------------------------

test('only the store can see orders received', async t => {
  const { db, customer } = await setup(t);
  await placeOne(db, customer);
  assert.equal((await asAdmin(db, { query: '?resource=orders', cookie: '' })).statusCode, 403);
  assert.equal((await asAdmin(db, { query: '?resource=orders', cookie: cookieFor(customer) })).statusCode, 403);
});

test('the store sees a placed order with the customer and the delivery details', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);

  const res = await asAdmin(db, { query: '?resource=orders', cookie: adminCookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.orders.length, 1);
  const o = res.json.orders[0];
  assert.equal(o.reference, ref);
  assert.equal(o.status, 'placed');
  assert.equal(o.totalLabel, '₹5,376.00');
  assert.equal(o.customer.email, 'ravi@x.com');
  assert.equal(o.shipTo.phone, '+91 98765 43210', 'formatted for reading');
  assert.equal(o.shipTo.state, 'Tamil Nadu');
  assert.match(o.summary, /OPC 53 Grade Cement/);
  assert.match(o.summary, /× 10$/, 'the trailing zeros of numeric(12,3) are trimmed');
  assert.equal(res.json.counts.placed, 1);
});

test('orders can be filtered by status and searched', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  await asAdmin(db, { method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie, body: { reference: ref } });
  await placeOne(db, customer);

  assert.equal((await asAdmin(db, { query: '?resource=orders&status=placed', cookie: adminCookie })).json.orders.length, 1);
  assert.equal((await asAdmin(db, { query: '?resource=orders&status=confirmed', cookie: adminCookie })).json.orders.length, 1);
  assert.equal((await asAdmin(db, { query: '?resource=orders', cookie: adminCookie })).json.orders.length, 2);
  assert.equal((await asAdmin(db, { query: '?resource=orders&status=invented', cookie: adminCookie })).statusCode, 400);

  const found = await asAdmin(db, { query: '?resource=orders&q=' + ref, cookie: adminCookie });
  assert.equal(found.json.orders.length, 1);
  assert.equal((await asAdmin(db, { query: '?resource=orders&q=ravi@x.com', cookie: adminCookie })).json.orders.length, 2);
});

// --- moving it along ----------------------------------------------------------

test('the normal path: accept, dispatch, collected', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  const move = action => asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=' + action, cookie: adminCookie, body: { reference: ref },
  });

  assert.equal((await move('confirm')).json.order.status, 'confirmed');
  assert.equal((await move('dispatch')).json.order.status, 'dispatched');
  const done = await move('collect');
  assert.equal(done.json.order.status, 'collected');
  assert.equal(done.json.order.collection_method, 'manual',
    'FR-29.9: the store marking it is recorded as manual, not as a customer scan');

  const [row] = await db.query('SELECT collected_at, collected_by, collection_method FROM mb_orders WHERE reference = $1', [ref]);
  assert.ok(row.collected_at);
  assert.ok(row.collected_by, 'who marked it is recorded');
});

test('a move out of turn is refused and names the state the order is really in', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  const move = action => asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=' + action, cookie: adminCookie, body: { reference: ref },
  });

  const early = await move('dispatch');                 // still 'placed'
  assert.equal(early.statusCode, 409);
  assert.match(early.json.error, /is placed/);
  assert.equal(early.json.status, 'placed');

  await move('confirm');
  const twice = await move('confirm');                  // a double tap
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json.status, 'confirmed');

  assert.equal((await asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie,
    body: { reference: 'MB-ZZZZ-ZZZZ' } })).statusCode, 404);

  assert.equal((await move('teleport')).statusCode, 400);
  assert.equal((await asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie, body: {} })).statusCode, 400);
});

test('rejecting a new order cancels it with a reason the customer can read', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);

  const res = await asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=cancel', cookie: adminCookie,
    body: { reference: ref, reason: 'No stock until Friday' },
  });
  assert.equal(res.json.order.status, 'cancelled');

  const seen = await asCustomer(db, { query: '?reference=' + ref, cookie: cookieFor(customer) });
  assert.equal(seen.json.order.status, 'cancelled');
  assert.equal(seen.json.order.cancelReason, 'No stock until Friday');

  // and a cancelled order goes nowhere else
  assert.equal((await asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie,
    body: { reference: ref } })).statusCode, 409);
});

test('a collected order is finished: nothing moves it again', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  const move = action => asAdmin(db, {
    method: 'POST', query: '?resource=orders&action=' + action, cookie: adminCookie, body: { reference: ref },
  });
  await move('confirm');
  await move('collect');                                 // straight from confirmed is allowed
  for (const a of ['confirm', 'dispatch', 'collect', 'cancel']) {
    assert.equal((await move(a)).statusCode, 409, a);
  }
});

test('the customer can no longer cancel once the store has accepted', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  await asAdmin(db, { method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie, body: { reference: ref } });

  const res = await asCustomer(db, {
    method: 'POST', query: '?action=cancel', cookie: cookieFor(customer), body: { reference: ref },
  });
  assert.equal(res.statusCode, 409);
  // 'accepted' is mb_order_statuses.label for 'confirmed' — the message reads from the table.
  assert.match(res.json.error, /already accepted/);
});

test('the schema refuses a half-recorded collection', async t => {
  const { db, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  await assert.rejects(
    () => db.query('UPDATE mb_orders SET collected_at = now() WHERE reference = $1', [ref]),
    'collected_at without a method is not a record of anything');
  await assert.rejects(
    () => db.query("UPDATE mb_orders SET collection_method = 'carrier pigeon', collected_at = now() WHERE reference = $1", [ref]),
    'the method is a closed set');
});

test('moving an order notifies the customer, naming the new status', async t => {
  const { db, adminCookie, customer } = await setup(t);
  const ref = await placeOne(db, customer);
  await asAdmin(db, { method: 'POST', query: '?resource=orders&action=confirm', cookie: adminCookie, body: { reference: ref } });

  const [n] = await db.query(
    "SELECT * FROM mb_notifications WHERE user_id = $1 AND kind = 'order_status'", [customer.id]);
  assert.ok(n, 'the customer was notified');
  assert.match(n.title, new RegExp(`${ref} is now accepted`));
  assert.equal(n.link, `#/order/${ref}`);
});
