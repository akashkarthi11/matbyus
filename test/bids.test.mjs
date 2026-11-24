// Bids: a customer asks an owner for a better price. FSD Phase 2 FR-24.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as bids } from '../api/bids.js';
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
const as = (db, cookie, opts) => run(bids, db, { url: '/api/bids' + (opts.query || ''), ...opts, cookie });

async function fixture(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());
  const admin = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const ravi = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  const cat = await makeCategory(db, { kind: 'material' });
  const product = await makeProduct(db, {
    sku: 'A1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: alpha.id,
    price_retail: '420.00', min_order_qty: 10,
  });
  const house = await makeProduct(db, { sku: 'H1', slug: 'house-cement', name: 'House Cement', category_id: cat.id });
  const quote = await makeProduct(db, {
    sku: 'Q1', slug: 'quote-service', name: 'Custom job', category_id: cat.id, owner_id: alpha.id,
    kind: 'service', unit: 'lumpsum', pricing_mode: 'quote', price_retail: null, price_business: null,
    pack_size: null, stock_qty: null, min_order_qty: 1,
  });
  return { db, admin, alpha, ravi, product, house, quote };
}

const place = (db, who, body) => as(db, cookieFor(who), { method: 'POST', query: '?action=place', body });
const move = (db, who, action, body) => as(db, cookieFor(who), { method: 'POST', query: `?action=${action}`, body });

test('a customer bids, and the owner is notified', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const r = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '390.00' });
  assert.equal(r.statusCode, 201, r.bodyText);
  assert.equal(r.json.bid.status, 'open');
  assert.equal(r.json.bid.turn, 'owner', 'the customer just asked; the owner moves first');
  assert.equal(r.json.bid.unitPriceLabel, '₹390.00');

  const [n] = await db.query("SELECT * FROM mb_notifications WHERE user_id = $1 AND kind = 'bid'", [alpha.id]);
  assert.ok(n);
  assert.match(n.title, /Ravi Kumar/);
});

test('a fixed-price listing needs a starting price; a quote-priced one does not', async t => {
  const { db, ravi, product, quote } = await fixture(t);
  const noPrice = await place(db, ravi, { slug: product.slug, qty: 10 });
  assert.equal(noPrice.statusCode, 400);
  assert.match(noPrice.json.error, /Name the price/);

  const ask = await place(db, ravi, { slug: quote.slug, qty: 1 });
  assert.equal(ask.statusCode, 201);
  assert.equal(ask.json.bid.unitPrice, null);
});

test('a house listing cannot be bid on — there is nobody to negotiate with', async t => {
  const { db, ravi, house } = await fixture(t);
  const r = await place(db, ravi, { slug: house.slug, qty: 10, unitPrice: '10.00' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /nobody to negotiate with/);
});

test('the owner counters, the turn passes to the customer, and back-and-forth continues', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });

  const tooEarly = await move(db, ravi, 'accept', { id: bid.id });
  assert.equal(tooEarly.statusCode, 409, 'it is the owner\'s turn, not the customer\'s');
  assert.match(tooEarly.json.error, /not your turn/);

  const countered = await move(db, alpha, 'counter', { id: bid.id, unitPrice: '405.00' });
  assert.equal(countered.statusCode, 200);
  assert.equal(countered.json.bid.status, 'countered');
  assert.equal(countered.json.bid.turn, 'customer');
  assert.equal(countered.json.bid.unitPriceLabel, '₹405.00');

  // the customer counters back — still 'countered', turn flips again (FR-24.4: not one round)
  const again = await move(db, ravi, 'counter', { id: bid.id, unitPrice: '395.00' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json.bid.status, 'countered');
  assert.equal(again.json.bid.turn, 'owner');

  const history = await as(db, cookieFor(ravi), { query: '?id=' + bid.id });
  assert.deepEqual(history.json.moves.map(m => m.action), ['open', 'counter', 'counter']);
});

test('accepting produces an order at the agreed price, and the bid cannot be reused', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });
  await move(db, alpha, 'counter', { id: bid.id, unitPrice: '400.00' });

  const accepted = await move(db, ravi, 'accept', {
    id: bid.id, line1: '1 Anna Salai', city: 'Chennai', pincode: '600002', stateCode: '33',
  });
  assert.equal(accepted.statusCode, 200, accepted.bodyText);
  assert.equal(accepted.json.bid.status, 'ordered');
  assert.equal(accepted.json.order.subtotalExcl, '8000.00');   // 400 * 20
  assert.equal(accepted.json.order.soldBy, 'Alpha Traders');

  const [row] = await db.query('SELECT status, order_id FROM mb_bids WHERE id = $1', [bid.id]);
  assert.equal(row.status, 'ordered');
  assert.ok(row.order_id);

  const [order] = await db.query('SELECT bid_id FROM mb_orders WHERE id = $1', [row.order_id]);
  assert.equal(order.bid_id, bid.id, 'FR-25.3: the order records the bid it came from');

  const again = await move(db, alpha, 'accept', { id: bid.id });
  assert.equal(again.statusCode, 409);
});

test('the owner rejects, and the customer cannot revive it', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });
  const r = await move(db, alpha, 'reject', { id: bid.id, note: 'Too low for this volume' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.bid.status, 'rejected');

  const retry = await move(db, ravi, 'accept', { id: bid.id });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json.status, 'rejected');
});

test('the customer withdraws their own open bid, whoever\'s turn it is', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });
  // it is the owner's turn, but withdraw is the customer's prerogative regardless (FR-24.9)
  const r = await move(db, ravi, 'withdraw', { id: bid.id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.bid.status, 'withdrawn');

  const ownerTries = await move(db, alpha, 'withdraw', { id: bid.id });
  assert.equal(ownerTries.statusCode, 403, 'withdrawal is the customer\'s alone');
});

test('an expired bid cannot be accepted, and the expiry is recorded', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });
  await db.query("UPDATE mb_bids SET expires_at = now() - interval '1 minute' WHERE id = $1", [bid.id]);

  const r = await move(db, alpha, 'accept', { id: bid.id });
  assert.equal(r.statusCode, 409);
  assert.match(r.json.error, /expired/);

  const [row] = await db.query('SELECT status FROM mb_bids WHERE id = $1', [bid.id]);
  assert.equal(row.status, 'expired');
  const [log] = await db.query("SELECT action FROM mb_bid_moves WHERE bid_id = $1 AND action = 'expire'", [bid.id]);
  assert.ok(log);
});

test('one owner cannot act on another owner\'s bid; a customer cannot see another\'s', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  const beta = await makeUser(db, { email: 'beta@x.com', role: 'owner', fullName: 'Beta' });
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });

  assert.equal((await move(db, beta, 'counter', { id: bid.id, unitPrice: '1.00' })).statusCode, 404);

  const other = await makeUser(db, { email: 'other@x.com', fullName: 'Other' });
  assert.equal((await as(db, cookieFor(other), { query: '?id=' + bid.id })).statusCode, 404);
});

test('an admin has no access to bids at all', async t => {
  const { db, admin, product } = await fixture(t);
  assert.equal((await as(db, cookieFor(admin), { query: '' })).statusCode, 403);
  assert.equal((await place(db, admin, { slug: product.slug, qty: 10, unitPrice: '1' })).statusCode, 403);
});

test('a bad price is refused on placing and on countering', async t => {
  const { db, ravi, alpha, product } = await fixture(t);
  assert.equal((await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '-5' })).statusCode, 400);
  const { json: { bid } } = await place(db, ravi, { slug: product.slug, qty: 20, unitPrice: '380.00' });
  assert.equal((await move(db, alpha, 'counter', { id: bid.id, unitPrice: 'free' })).statusCode, 400);
  assert.equal((await move(db, alpha, 'counter', { id: bid.id })).statusCode, 400);
});
