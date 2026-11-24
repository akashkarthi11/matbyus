// Ordering — FSD Phase 2 FR-25/FR-26, first slice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, splitTax, priceLine } from '../api/orders.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

async function dbWithOrders() {
  const db = await freshDb();
  await db._pg.exec(readFileSync(join(here, '..', 'scripts', 'migrations', '0001_orders.sql'), 'utf8'));
  return db;
}

const cookieFor = u => `mb_session=${token(u.id, 1)}`;
// Mirrors what the real default export does with a thrown status error, so the tests see the same
// status and message a caller would.
const call = async (db, { method = 'GET', query = '', body = null, cookie = '' } = {}) => {
  const res = mkRes();
  try {
    await handle(mkReq({ method, url: '/api/orders' + query, body, cookie }), res, db);
  } catch (e) {
    if (!e?.status) throw e;
    res.statusCode = e.status;
    res.bodyText = JSON.stringify({ error: e.message });
  }
  return res;
};

const ADDRESS = {
  name: 'Ravi Kumar', phone: '9876543210', line1: '12 MG Road', city: 'Pune',
  pincode: '411001', stateCode: '27',
};

// --- pure pricing -----------------------------------------------------------

test('tax splits into equal halves intra-state, IGST inter-state, and the odd paisa goes to SGST', () => {
  assert.deepEqual(splitTax(11760, '27', '27'), { split: 'cgst_sgst', cgst: 5880, sgst: 5880, igst: 0 });
  assert.deepEqual(splitTax(11760, '27', '33'), { split: 'igst', cgst: 0, sgst: 0, igst: 11760 });
  // 101 paise cannot halve evenly: the parts must still sum to the whole
  const odd = splitTax(101, '27', '27');
  assert.equal(odd.cgst + odd.sgst, 101);
  assert.equal(odd.sgst, 50);
  assert.equal(odd.cgst, 51, 'half rounds up, so the remainder lands on SGST');
  // with no seller state configured, nothing is claimed about the regime
  assert.deepEqual(splitTax(11760, null, '27'), { split: 'unsplit', cgst: 0, sgst: 0, igst: 0 });
});

test('a line is priced from the listing, and trade pricing only for an entitled viewer', () => {
  const p = { price_retail: '420.00', price_business: '395.00', gst_rate: '28.00' };
  assert.equal(priceLine(p, 10, false).lineExcl, 420000);
  assert.equal(priceLine(p, 10, false).lineTax, 117600);
  assert.equal(priceLine(p, 10, true).lineExcl, 395000);
  assert.equal(priceLine({ ...p, price_business: null }, 1, true).lineExcl, 42000);
});

// --- quoting ----------------------------------------------------------------

test('anyone can price an item before signing in', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);                                     // 420.00 retail, 28% GST, min 10
  const res = await call(db, { query: '?quote=opc-53-cement-50kg&qty=10' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.quote.subtotalExclLabel, '₹4,200.00');
  assert.equal(res.json.quote.taxTotalLabel, '₹1,176.00');
  assert.equal(res.json.quote.totalLabel, '₹5,376.00');
  assert.equal(res.json.quote.businessPricing, false);
});

test('an approved business is quoted the trade price', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const biz = await makeUser(db, { email: 'b@x.com', accountType: 'business', businessStatus: 'approved' });
  const res = await call(db, { query: '?quote=opc-53-cement-50kg&qty=10', cookie: cookieFor(biz) });
  assert.equal(res.json.quote.subtotalExclLabel, '₹3,950.00');
  assert.equal(res.json.quote.businessPricing, true);
});

test('the minimum order is enforced when quoting', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const res = await call(db, { query: '?quote=opc-53-cement-50kg&qty=2' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /minimum order/);
});

// --- placing ----------------------------------------------------------------

test('signing in is required to place, and the order records the agreed figures', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);

  const anon = await call(db, { method: 'POST', query: '?action=place', body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS } });
  assert.equal(anon.statusCode, 401);

  const u = await makeUser(db, { email: 'ravi@x.com' });
  const res = await call(db, {
    method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS },
  });
  assert.equal(res.statusCode, 201);
  const o = res.json.order;
  assert.match(o.reference, /^MB-[ACDEFGHJKMNPQRTUVWXY2346789]{4}-[ACDEFGHJKMNPQRTUVWXY2346789]{4}$/);
  assert.equal(o.status, 'placed');
  assert.equal(o.subtotalExcl, '4200.00');
  assert.equal(o.taxTotal, '1176.00');
  assert.equal(o.total, '5376.00');
  assert.equal(o.totalLabel, '₹5,376.00');
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].qty, 10);
  assert.equal(o.items[0].hsnSac, '2523', 'the HSN is copied onto the order, not joined');
  assert.equal(o.shipTo.phone, '+919876543210', 'the mobile is normalised');
});

test('an order code contains none of the characters people mishear', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const r = await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(u),
      body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS } });
    assert.equal(r.statusCode, 201);
    const code = r.json.order.reference;
    // The alphabet excludes B, I, L, O, S, Z and 0, 1, 5 — so no character left in it has a
    // look-alike that is also in it. 8 stays because B is gone; 9 stays because g is not used.
    assert.doesNotMatch(code.slice(3), /[01OILSZB]/, code);
    assert.ok(!seen.has(code), 'references are unique');
    seen.add(code);
  }
});

test('a price that moved since the page was drawn stops the order', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  const p = await makeProduct(db);
  const u = await makeUser(db, { email: 'ravi@x.com' });

  // the browser claims the old total; the listing has since gone up
  await db.query('UPDATE mb_products SET price_retail = $1 WHERE id = $2', ['460.00', p.id]);
  const res = await call(db, {
    method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'opc-53-cement-50kg', qty: 10, expectTotal: '5376.00', ...ADDRESS },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json.error, /price changed/i);
  assert.equal(res.json.totalLabel, '₹5,888.00');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_orders'))[0].n, 0, 'nothing was placed');
});

test('the client cannot dictate the price', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const res = await call(db, {
    method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS,
            price_retail: '1.00', unit_price_excl: '1.00', total: '1.00', subtotal_excl: '1.00' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.order.total, '5376.00', 'priced from the database, whatever the body says');
});

test('the address is validated, and an out-of-stock item cannot be ordered', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const bad = async over => {
    const r = await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(u),
      body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS, ...over } });
    assert.equal(r.statusCode, 400, JSON.stringify(over));
    return r.json.error;
  };
  assert.match(await bad({ pincode: '41100' }), /PIN code/);
  assert.match(await bad({ pincode: '911001' }), /PIN code/);
  assert.match(await bad({ stateCode: '99' }), /delivery state/);
  assert.match(await bad({ phone: '12345' }), /mobile/);
  assert.match(await bad({ line1: '' }), /address/i);
  assert.match(await bad({ city: '' }), /City/);
  assert.match(await bad({ qty: 0 }), /how many/);

  await db.query("UPDATE mb_products SET stock_status = 'out_of_stock'");
  const oos = await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS } });
  assert.equal(oos.statusCode, 409);
  assert.match(oos.json.error, /out of stock/);
});

test('a quote-only listing cannot be bought outright', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  const svc = await makeCategory(db, { slug: 'contracting', name: 'Contracting', kind: 'service' });
  await makeProduct(db, { category_id: svc.id, kind: 'service', sku: 'Q1', slug: 'turnkey',
    name: 'Turnkey', unit: 'lumpsum', pack_size: null, stock_qty: null, pricing_mode: 'quote',
    price_retail: null, price_business: null, hsn_sac: '9954', min_order_qty: 1 });
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const res = await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'turnkey', qty: 1, ...ADDRESS } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /quote-only/);
});

// --- reading and cancelling -------------------------------------------------

test('a customer sees only their own orders, and someone else\'s is a 404', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const mine = await makeUser(db, { email: 'mine@x.com' });
  const theirs = await makeUser(db, { email: 'theirs@x.com' });

  const placed = await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(mine),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS } });
  const ref = placed.json.order.reference;

  assert.equal((await call(db, { query: '?reference=' + ref, cookie: cookieFor(mine) })).statusCode, 200);
  const other = await call(db, { query: '?reference=' + ref, cookie: cookieFor(theirs) });
  assert.equal(other.statusCode, 404, 'a 403 would confirm the order exists');

  assert.equal((await call(db, { cookie: cookieFor(mine) })).json.orders.length, 1);
  assert.equal((await call(db, { cookie: cookieFor(theirs) })).json.orders.length, 0);
  assert.equal((await call(db, {})).statusCode, 401);
});

test('a placed order can be cancelled once, and not after', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  await makeProduct(db);
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const ref = (await call(db, { method: 'POST', query: '?action=place', cookie: cookieFor(u),
    body: { slug: 'opc-53-cement-50kg', qty: 10, ...ADDRESS } })).json.order.reference;

  const first = await call(db, { method: 'POST', query: '?action=cancel', cookie: cookieFor(u),
    body: { reference: ref, reason: 'Changed my mind' } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.order.status, 'cancelled');

  const second = await call(db, { method: 'POST', query: '?action=cancel', cookie: cookieFor(u), body: { reference: ref } });
  assert.equal(second.statusCode, 409);
  assert.match(second.json.error, /already cancelled/);

  const notMine = await call(db, { method: 'POST', query: '?action=cancel', cookie: cookieFor(u), body: { reference: 'MB-AAAA-AAAA' } });
  assert.equal(notMine.statusCode, 404);
});

test('orders are never cached', async t => {
  setEnv(); const db = await dbWithOrders(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const res = await call(db, { cookie: cookieFor(u) });
  assert.equal(res.getHeader('cache-control'), 'private, no-store');
});

// --- the database refuses an incoherent order -------------------------------

test('the schema rejects an order whose arithmetic does not add up', async t => {
  const db = await dbWithOrders(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'ravi@x.com' });
  const ins = (over = {}) => {
    const row = {
      reference: 'MB-TEST-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      customer_id: u.id, place_of_supply_state: '27',
      ship_name: 'R', ship_phone: '+919876543210', ship_line1: 'a', ship_city: 'Pune', ship_pincode: '411001',
      subtotal_excl: '100.00', cgst: '9.00', sgst: '9.00', igst: '0.00',
      tax_total: '18.00', total: '118.00', tax_split: 'cgst_sgst', ...over,
    };
    const cols = Object.keys(row);
    return db.query(`INSERT INTO mb_orders (${cols.join(',')})
      VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map(c => row[c]));
  };
  await ins();                                                        // the coherent row inserts
  await assert.rejects(() => ins({ total: '999.00' }), 'total must equal subtotal + tax');
  await assert.rejects(() => ins({ cgst: '1.00' }), 'the halves must sum to the tax');
  await assert.rejects(() => ins({ tax_split: 'igst' }), 'IGST regime cannot carry CGST/SGST');
  await assert.rejects(() => ins({ tax_split: 'unsplit' }), 'unsplit cannot carry a split');
  await assert.rejects(() => ins({ ship_pincode: '000000' }), 'PIN shape');
  await assert.rejects(() => ins({ ship_phone: '9876543210' }), 'phone must be stored normalised');
  await assert.rejects(() => ins({ status: 'invented' }), 'status is a closed set');
});
