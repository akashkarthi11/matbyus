// A basket spanning owners splits into one order per owner at checkout. FSD Phase 2 FR-25.1-2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as orders } from '../api/orders.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;
const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try { await fn(mkReq({ method, url, body, cookie }), res, db); }
  catch (e) { if (!e?.status) throw e; res.statusCode = e.status; res.bodyText = JSON.stringify({ error: e.message }); }
  return res;
};
const checkout = (db, who, items, extra = {}) => run(orders, db, {
  method: 'POST', url: '/api/orders?action=checkout', cookie: cookieFor(who),
  body: {
    items,
    name: 'Ravi Kumar', phone: '9876543210', line1: '12 MG Road', city: 'Chennai',
    pincode: '600028', stateCode: '33', ...extra,
  },
});

async function fixture(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const beta = await makeUser(db, { email: 'beta@x.com', role: 'owner', fullName: 'Beta Suppliers' });
  const ravi = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  const cat = await makeCategory(db, { kind: 'material' });
  const alphaCement = await makeProduct(db, { sku: 'A1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: alpha.id });
  const betaCement = await makeProduct(db, { sku: 'B1', slug: 'beta-cement', name: 'Beta Cement', category_id: cat.id, owner_id: beta.id });
  const house = await makeProduct(db, { sku: 'H1', slug: 'house-cement', name: 'House Cement', category_id: cat.id });
  return { db, alpha, beta, ravi, alphaCement, betaCement, house };
}

test('a basket across two owners becomes two orders in one checkout', async t => {
  const { db, ravi, alphaCement, betaCement } = await fixture(t);
  const r = await checkout(db, ravi, [
    { slug: alphaCement.slug, qty: 10 },
    { slug: betaCement.slug, qty: 10 },
  ]);
  assert.equal(r.statusCode, 201, r.bodyText);
  assert.equal(r.json.orders.length, 2);
  assert.deepEqual(r.json.errors, []);
  const owners = r.json.orders.map(o => o.soldBy).sort();
  assert.deepEqual(owners, ['Alpha Traders', 'Beta Suppliers']);

  const [{ n }] = await db.query('SELECT count(distinct owner_id)::int AS n FROM mb_orders');
  assert.equal(n, 2);
});

test('two items from the same owner land on one order, as two lines', async t => {
  const { db, ravi, alpha, alphaCement } = await fixture(t);
  const cat2 = await makeCategory(db, { slug: 'steel', name: 'Steel', kind: 'material' });
  const alphaSteel = await makeProduct(db, {
    sku: 'A2', slug: 'alpha-steel', name: 'Alpha Steel', category_id: cat2.id, owner_id: alpha.id,
    unit: 'tonne', price_retail: '60000.00', min_order_qty: 1,
  });
  const r = await checkout(db, ravi, [
    { slug: alphaCement.slug, qty: 10 },
    { slug: alphaSteel.slug, qty: 1 },
  ]);
  assert.equal(r.statusCode, 201, r.bodyText);
  assert.equal(r.json.orders.length, 1);
  assert.equal(r.json.orders[0].items.length, 2);
});

test('a suspended or broken line is named, and the rest still proceeds', async t => {
  const { db, ravi, alphaCement, betaCement } = await fixture(t);
  await db.query("UPDATE mb_products SET stock_status = 'out_of_stock' WHERE slug = $1", [betaCement.slug]);

  const r = await checkout(db, ravi, [
    { slug: alphaCement.slug, qty: 10 },
    { slug: betaCement.slug, qty: 10 },
  ]);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json.orders.length, 1);
  assert.equal(r.json.orders[0].soldBy, 'Alpha Traders');
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].slug, betaCement.slug);
  assert.match(r.json.errors[0].error, /out of stock/);
});

test('an empty basket, and a basket that is entirely refused, are both refused cleanly', async t => {
  const { db, ravi, alphaCement } = await fixture(t);
  assert.equal((await checkout(db, ravi, [])).statusCode, 400);

  await db.query("UPDATE mb_products SET stock_status = 'out_of_stock' WHERE slug = $1", [alphaCement.slug]);
  const r = await checkout(db, ravi, [{ slug: alphaCement.slug, qty: 10 }]);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json.errors.length, 1);
});

test('a stale price on one line is refused by name; an unaffected line still orders', async t => {
  const { db, ravi, alphaCement, betaCement } = await fixture(t);
  const r = await checkout(db, ravi, [
    { slug: alphaCement.slug, qty: 10, expectTotal: '1.00' },   // wrong on purpose
    { slug: betaCement.slug, qty: 10 },
  ]);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json.orders.length, 1);
  assert.equal(r.json.orders[0].soldBy, 'Beta Suppliers');
  assert.match(r.json.errors[0].error, /price changed/);
});

test('both owners are notified of their own order, and only their own', async t => {
  const { db, ravi, alpha, beta, alphaCement, betaCement } = await fixture(t);
  await checkout(db, ravi, [{ slug: alphaCement.slug, qty: 10 }, { slug: betaCement.slug, qty: 10 }]);

  const [a] = await db.query("SELECT count(*)::int AS n FROM mb_notifications WHERE user_id = $1 AND kind = 'order_placed'", [alpha.id]);
  const [b] = await db.query("SELECT count(*)::int AS n FROM mb_notifications WHERE user_id = $1 AND kind = 'order_placed'", [beta.id]);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
});

test('a house listing in the basket orders fine with no owner to notify', async t => {
  const { db, ravi, house, alphaCement } = await fixture(t);
  const r = await checkout(db, ravi, [{ slug: house.slug, qty: 10 }, { slug: alphaCement.slug, qty: 10 }]);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json.orders.length, 2);
  assert.ok(r.json.orders.some(o => o.soldBy == null));
});
