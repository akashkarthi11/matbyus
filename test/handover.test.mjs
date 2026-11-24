// The QR handover — FSD Phase 2 FR-29.9.
//
// The claim being tested is narrow and important: a customer scanning the seller's screen is
// evidence the customer was there. Everything here exists to stop that claim being made falsely —
// by someone who overheard the order reference, by a photograph of an earlier screen, by a second
// tap, or by a different customer entirely.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as admin } from '../api/admin.js';
import { handle as orders } from '../api/orders.js';
import { token, sha256 } from '../api/_lib.js';
import { lookups } from '../api/_lookups.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;

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

async function yard(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());

  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const beta = await makeUser(db, { email: 'beta@x.com', role: 'owner', fullName: 'Beta Suppliers' });
  const ravi = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  const other = await makeUser(db, { email: 'other@x.com', fullName: 'Someone Else' });

  const cat = await makeCategory(db, { kind: 'material' });
  await makeProduct(db, { sku: 'ALP-1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: alpha.id });
  await makeProduct(db, { sku: 'BET-1', slug: 'beta-cement', name: 'Beta Cement', category_id: cat.id, owner_id: beta.id });

  return { db, a, alpha, beta, ravi, other };
}

// Place an order with alpha and walk it to `status`.
async function orderAt(db, { alpha, ravi }, status, slug = 'alpha-cement') {
  const placed = await buyer(db, cookieFor(ravi), '?action=place', { slug, qty: 10, ...ADDRESS });
  assert.equal(placed.statusCode, 201, placed.bodyText);
  const reference = placed.json.order.reference;
  const steps = { placed: [], confirmed: ['confirm'], dispatched: ['confirm', 'dispatch'] };
  for (const action of steps[status]) {
    const r = await seller(db, cookieFor(alpha), `?resource=orders&action=${action}`, { reference });
    assert.equal(r.statusCode, 200, `${action}: ${r.bodyText}`);
  }
  return reference;
}

const showCode = (db, who, reference) =>
  seller(db, cookieFor(who), '?resource=orders&action=handover-token', { reference });

// --- issuing the code ---------------------------------------------------------

test('the seller gets a code once the order is accepted, and not before', async t => {
  const ctx = await yard(t);
  const { db, alpha } = ctx;

  const early = await orderAt(db, ctx, 'placed');
  const no = await showCode(db, alpha, early);
  assert.equal(no.statusCode, 409);
  assert.match(no.json.error, /can only be shown once the order is/);
  assert.match(no.json.error, /This one is placed/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_order_handover_tokens'))[0].n, 0);

  const ready = await orderAt(db, ctx, 'confirmed');
  const yes = await showCode(db, alpha, ready);
  assert.equal(yes.statusCode, 200);
  assert.match(yes.json.handover.token, /^[ACDEFGHJKMNPQRTUVWXY2346789]{10}$/);
  assert.equal(yes.json.handover.payload, `MB1:${ready}:${yes.json.handover.token}`);
  assert.ok(new Date(yes.json.handover.expiresAt) > new Date());
});

test('the code is stored only as a hash, so this table cannot be replayed', async t => {
  const ctx = await yard(t);
  const { db, alpha } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  const { token: code } = (await showCode(db, alpha, reference)).json.handover;

  const [row] = await db.query('SELECT token_hash FROM mb_order_handover_tokens');
  assert.equal(row.token_hash, sha256(code));
  assert.notEqual(row.token_hash, code);
  assert.equal(row.token_hash.length, 64);
});

test('asking again replaces the code, so a photograph of an earlier screen is worthless', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');

  const first = (await showCode(db, alpha, reference)).json.handover.token;
  const second = (await showCode(db, alpha, reference)).json.handover.token;
  assert.notEqual(first, second);
  // D-32: the unique index allows exactly one unspent token per order
  assert.equal((await db.query(
    'SELECT count(*)::int AS n FROM mb_order_handover_tokens WHERE used_at IS NULL'))[0].n, 1);

  const stale = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: first });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json.error, /expired or has already been used/);

  const fresh = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: second });
  assert.equal(fresh.statusCode, 200);
});

test('an owner cannot show a code for another owner\'s order, and a customer cannot show one at all', async t => {
  const ctx = await yard(t);
  const { db, beta, ravi, a } = ctx;
  const reference = await orderAt(db, ctx, 'confirmed');

  const wrongOwner = await showCode(db, beta, reference);
  assert.equal(wrongOwner.statusCode, 404, 'another owner is told it does not exist');

  const asCustomer = await showCode(db, ravi, reference);
  assert.equal(asCustomer.statusCode, 403);

  // the admin sells on behalf of the platform and sees across owners, so they may
  assert.equal((await showCode(db, a, reference)).statusCode, 200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_order_handover_tokens'))[0].n, 1);
});

// --- spending it ----------------------------------------------------------------

test('a scan closes the order, recorded as a scan and naming the customer', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  const { payload } = (await showCode(db, alpha, reference)).json.handover;

  // the customer posts what the camera read, payload and all
  const done = await buyer(db, cookieFor(ravi), '?action=collect', { token: payload });
  assert.equal(done.statusCode, 200, done.bodyText);
  assert.equal(done.json.order.status, 'collected');
  assert.equal(done.json.order.collection.method, 'scan');

  const [o] = await db.query(
    'SELECT status, collection_method, collected_by, collected_at FROM mb_orders WHERE reference = $1',
    [reference]);
  assert.equal(o.status, 'collected');
  assert.equal(o.collection_method, 'scan', 'not "manual" — the distinction is the point');
  assert.equal(o.collected_by, ravi.id);
  assert.ok(o.collected_at);

  const [tk] = await db.query('SELECT used_at, used_by FROM mb_order_handover_tokens');
  assert.ok(tk.used_at, 'the code is spent');
  assert.equal(tk.used_by, ravi.id);
});

test('the same code cannot be spent twice', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  const { token: code } = (await showCode(db, alpha, reference)).json.handover;

  assert.equal((await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: code })).statusCode, 200);

  const again = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: code });
  assert.equal(again.statusCode, 409);
  assert.match(again.json.error, /nothing to confirm/);

  const [o] = await db.query('SELECT collected_at FROM mb_orders WHERE reference = $1', [reference]);
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mb_orders WHERE status = 'collected'");
  assert.equal(n, 1);
  assert.ok(o.collected_at);
});

test('overhearing the order reference is not enough; the code is a separate secret', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  await showCode(db, alpha, reference);                  // a live code exists, unseen by the caller

  for (const guess of ['', 'ACDEFGHJKM', reference, `MB1:${reference}:ACDEFGHJKM`]) {
    const r = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: guess });
    assert.ok([400, 409].includes(r.statusCode), `${JSON.stringify(guess)} -> ${r.statusCode}`);
  }
  const [o] = await db.query('SELECT status FROM mb_orders WHERE reference = $1', [reference]);
  assert.equal(o.status, 'dispatched', 'nothing moved');
});

test('another customer cannot spend a code, even holding it', async t => {
  const ctx = await yard(t);
  const { db, alpha, other } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  const { token: code, payload } = (await showCode(db, alpha, reference)).json.handover;

  for (const body of [{ reference, token: code }, { token: payload }]) {
    const r = await buyer(db, cookieFor(other), '?action=collect', body);
    assert.equal(r.statusCode, 404, 'not 403 — they are not told the order exists');
  }
  const [tk] = await db.query('SELECT used_at FROM mb_order_handover_tokens');
  assert.equal(tk.used_at, null, 'and the real customer can still use it');
});

test('an expired code is refused', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');
  const { token: code } = (await showCode(db, alpha, reference)).json.handover;

  // Both timestamps move: mb_handover_window_check refuses a row that expired before it was
  // issued, so an "expired" token still has to look like one that was once valid.
  await db.query(`UPDATE mb_order_handover_tokens
                     SET issued_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 second'`);
  const r = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: code });
  assert.equal(r.statusCode, 409);
  assert.match(r.json.error, /expired/);
  const [o] = await db.query('SELECT status FROM mb_orders WHERE reference = $1', [reference]);
  assert.equal(o.status, 'dispatched');
});

test('a code for one order does not close another', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const first = await orderAt(db, ctx, 'dispatched');
  const second = await orderAt(db, ctx, 'dispatched');
  const { token: code } = (await showCode(db, alpha, first)).json.handover;

  const crossed = await buyer(db, cookieFor(ravi), '?action=collect', { reference: second, token: code });
  assert.equal(crossed.statusCode, 409);

  // and a scanned payload that names a different order says so plainly
  const { payload } = (await showCode(db, alpha, first)).json.handover;
  const mismatch = await buyer(db, cookieFor(ravi), '?action=collect', { reference: second, token: payload });
  assert.equal(mismatch.statusCode, 409);
  assert.match(mismatch.json.error, new RegExp(`belongs to order ${first}`));

  const [o] = await db.query('SELECT status FROM mb_orders WHERE reference = $1', [second]);
  assert.equal(o.status, 'dispatched');
});

// --- the two paths stay distinguishable ---------------------------------------------

test('the manual path still works and is recorded as the seller\'s word, not the customer\'s', async t => {
  const ctx = await yard(t);
  const { db, alpha } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');

  const r = await seller(db, cookieFor(alpha), '?resource=orders&action=collect', { reference });
  assert.equal(r.statusCode, 200);

  const [o] = await db.query(
    'SELECT collection_method, collected_by FROM mb_orders WHERE reference = $1', [reference]);
  assert.equal(o.collection_method, 'manual');
  assert.equal(o.collected_by, alpha.id, 'the seller, not the customer');

  const lk = await lookups(db);
  assert.equal(lk.label('collection_method', 'manual'), 'Marked by the store');
  assert.match(lk.label('collection_method', 'scan'), /customer's scan/);
});

test('the move needing a code is a row, and both sides are told which', async t => {
  const ctx = await yard(t);
  const { db } = ctx;
  const lk = await lookups(db);

  assert.equal(lk.move('customer', 'collect').needsToken, true);
  assert.equal(lk.move('seller', 'collect').needsToken, false, 'the manual path needs no code');
  assert.deepEqual(lk.move('customer', 'collect').from.slice().sort(), ['confirmed', 'dispatched']);
  assert.equal(lk.flowFor('customer', 'dispatched')[0].needsToken, true);
  assert.equal(lk.flowFor('customer', 'placed')[0].needsToken, false, 'cancelling needs no code');
});

test('taking the customer collect rows out disables scanning, with no code change', async t => {
  const ctx = await yard(t);
  const { db, alpha, ravi } = ctx;
  const reference = await orderAt(db, ctx, 'dispatched');

  await db.query("DELETE FROM mb_order_transitions WHERE actor = 'customer' AND action = 'collect'");
  const { forgetLookups } = await import('../api/_lookups.js');
  forgetLookups(db);

  const show = await showCode(db, alpha, reference);
  assert.equal(show.statusCode, 503);
  const scan = await buyer(db, cookieFor(ravi), '?action=collect', { reference, token: 'ACDEFGHJKM' });
  assert.equal(scan.statusCode, 503);
});
