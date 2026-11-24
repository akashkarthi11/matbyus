// FR-9, FR-10, FR-12. TSD sections 5, 6.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/catalog.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const browse = async (db, query = '', cookie = '') => {
  const res = mkRes();
  await handle(mkReq({ url: '/api/catalog' + query, cookie }), res, db);
  return res;
};
const cookieFor = u => `mb_session=${token(u.id, 1)}`;

test('a visitor browses active products and sees GST-inclusive retail prices', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);                                        // cement, 420.00 retail, 28% GST
  const res = await browse(db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.total, 1);
  const p = res.json.items[0];
  assert.equal(p.price.mode, 'inclusive');
  assert.equal(p.price.headlineLabel, '₹537.60');              // 420 + 28%
  assert.equal(p.price.taxLine, 'incl. 28% GST');
  assert.equal(p.unitLabel, 'bag');
  assert.equal(p.stockStatus, 'in_stock');
  assert.equal(res.json.viewer.businessPricing, false);
});

test('the business price never reaches a browser that is not entitled to it', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);                                        // business price 395.00

  const visitor = await browse(db);
  assert.doesNotMatch(visitor.bodyText, /395/, 'no trace of the trade price for a visitor');

  const individual = await makeUser(db, { email: 'home@example.com' });
  const asIndividual = await browse(db, '', cookieFor(individual));
  assert.doesNotMatch(asIndividual.bodyText, /395/);

  const pending = await makeUser(db, { email: 'pending@example.com', accountType: 'business' });
  const asPending = await browse(db, '', cookieFor(pending));
  assert.doesNotMatch(asPending.bodyText, /395/, 'a pending business is still retail (FR-10.1)');
  assert.equal(asPending.json.items[0].price.headlineLabel, '₹537.60');

  const rejected = await makeUser(db, { email: 'no@example.com', accountType: 'business', businessStatus: 'rejected' });
  assert.doesNotMatch((await browse(db, '', cookieFor(rejected))).bodyText, /395/);
});

test('an approved business sees the business price, GST-exclusive, with the retail comparison', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });
  const res = await browse(db, '?trade=1', cookieFor(biz));
  const p = res.json.items[0];
  assert.equal(res.json.viewer.businessPricing, true);
  assert.equal(p.price.mode, 'exclusive');
  assert.equal(p.price.headlineLabel, '₹395.00');
  assert.equal(p.price.taxLine, '+ 28% GST ₹110.60');
  assert.equal(p.price.totalLabel, '₹505.60');
  assert.equal(p.price.compareAtLabel, '₹420.00');
});

test('an approved business with no business price set sees the retail price', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db, { price_business: null });
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });
  const p = (await browse(db, '?trade=1', cookieFor(biz))).json.items[0];
  assert.equal(p.price.headlineLabel, '₹420.00');
  assert.equal(p.price.mode, 'exclusive');
  assert.equal(p.price.compareAtLabel, undefined);
});

test('inactive products are invisible, and their slug is a 404 not an empty shell', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db, { is_active: false });
  assert.equal((await browse(db)).json.total, 0);
  const one = await browse(db, '?slug=opc-53-cement-50kg');
  assert.equal(one.statusCode, 404);
  assert.equal(one.json.product, undefined);
});

test('filters by kind, category and free text', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const materials = await makeCategory(db, { slug: 'cement', name: 'Cement', kind: 'material' });
  const steel = await makeCategory(db, { slug: 'steel', name: 'Steel', kind: 'material' });
  const svc = await makeCategory(db, { slug: 'plastering', name: 'Plastering', kind: 'service' });
  await makeProduct(db, { category_id: materials.id });
  await makeProduct(db, { category_id: steel.id, sku: 'TMT-12', slug: 'tmt-12mm',
    name: 'TMT Bar 12mm', summary: 'Fe500D reinforcement bar', unit: 'tonne', pack_size: null,
    price_retail: '62000.00', price_business: '60500.00', gst_rate: '18.00', hsn_sac: '7214' });
  await makeProduct(db, { category_id: svc.id, kind: 'service', sku: 'SVC-PLAS', slug: 'wall-plastering',
    name: 'Wall Plastering', summary: 'Internal wall plastering with finish', unit: 'per_sqft',
    pack_size: null, stock_qty: null, price_retail: '28.00', price_business: '25.00',
    gst_rate: '18.00', hsn_sac: '995465' });

  assert.equal((await browse(db, '?kind=material')).json.total, 2);
  assert.equal((await browse(db, '?kind=service')).json.total, 1);
  assert.equal((await browse(db, '?category=steel')).json.total, 1);
  assert.equal((await browse(db, '?q=plastering')).json.total, 1);
  assert.equal((await browse(db, '?q=cement')).json.total, 1);
  assert.equal((await browse(db, '?q=nothinglikethis')).json.total, 0);
  assert.equal((await browse(db, '?kind=rental')).statusCode, 400);

  const svcItem = (await browse(db, '?kind=service')).json.items[0];
  assert.equal(svcItem.unitLabel, 'per sq ft');
  assert.equal(svcItem.stockStatus, undefined, 'services carry no stock');
  assert.equal(svcItem.packSize, undefined);
});

test('a quote-priced service shows the quote label and no figures', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const svc = await makeCategory(db, { slug: 'contracting', name: 'Contracting', kind: 'service' });
  await makeProduct(db, { category_id: svc.id, kind: 'service', sku: 'SVC-TURNKEY',
    slug: 'turnkey-contracting', name: 'Turnkey Contracting', unit: 'lumpsum',
    pack_size: null, stock_qty: null, pricing_mode: 'quote',
    price_retail: null, price_business: null, gst_rate: '18.00', hsn_sac: '995411' });
  const p = (await browse(db)).json.items[0];
  assert.equal(p.price.mode, 'quote');
  assert.equal(p.price.headlineLabel, 'Request a quote');
  assert.equal(p.price.headline, null);
});

test('paging is bounded and reports the true total', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const cat = await makeCategory(db);
  for (let i = 0; i < 30; i++) {
    await makeProduct(db, { category_id: cat.id, sku: 'SKU-' + i, slug: 'product-' + i, name: 'Product ' + String(i).padStart(2, '0') });
  }
  const first = await browse(db, '?pageSize=10');
  assert.equal(first.json.items.length, 10);
  assert.equal(first.json.total, 30);
  const second = await browse(db, '?pageSize=10&page=2');
  assert.notEqual(first.json.items[0].slug, second.json.items[0].slug);
  assert.equal((await browse(db, '?pageSize=9999')).json.items.length, 30, 'page size is capped at 100');
  assert.equal((await browse(db, '?page=0')).json.page, 1);
});

test('a product detail carries its description, HSN and GST rate', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db, { description: 'Conforms to IS 12269.' });
  const res = await browse(db, '?slug=opc-53-cement-50kg');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.product.description, 'Conforms to IS 12269.');
  assert.equal(res.json.product.hsnSac, '2523');
  assert.equal(res.json.product.gstRate, 28);
});

// --- caching (D-8 again: a cache is another way to hand a response to the wrong viewer) ---------

test('the public URL is edge-cacheable and cannot produce a business price at all', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);                                   // trade price 395.00
  const approved = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });

  for (const [who, cookie] of [['visitor', ''], ['approved business', cookieFor(approved)]]) {
    const res = await browse(db, '', cookie);
    assert.match(res.getHeader('cache-control'), /^public, s-maxage=\d+/, who);
    assert.equal(res.getHeader('vary'), undefined,
      'nothing varies by cookie: Vercel will not edge-cache a response that does');
    assert.equal(res.json.viewer.businessPricing, false, who);
    assert.doesNotMatch(res.bodyText, /395/,
      'the public URL is the one a CDN hands to everyone, so it must never carry the trade price');
  }
});

test('the trade URL is private, and only entitled viewers get trade prices from it', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);

  const approved = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });
  const yes = await browse(db, '?trade=1', cookieFor(approved));
  assert.equal(yes.getHeader('cache-control'), 'private, no-store');
  assert.equal(yes.json.viewer.businessPricing, true);
  assert.equal(yes.json.items[0].price.headlineLabel, '₹395.00');

  // asking for the trade view without being entitled to it gets retail, not an error and not a price
  const pending = await makeUser(db, { email: 'pending@example.com', accountType: 'business' });
  for (const [who, cookie] of [['visitor', ''], ['pending business', cookieFor(pending)]]) {
    const no = await browse(db, '?trade=1', cookie);
    assert.equal(no.json.viewer.businessPricing, false, who);
    assert.doesNotMatch(no.bodyText, /395/, who);
    assert.equal(no.getHeader('cache-control'), 'private, no-store',
      'the header must not differ by entitlement, or it would report whose session this is');
  }
});

test('the product detail follows the same split', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);
  const approved = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });

  const pub = await browse(db, '?slug=opc-53-cement-50kg');
  assert.match(pub.getHeader('cache-control'), /^public/);
  assert.doesNotMatch(pub.bodyText, /395/);

  const trade = await browse(db, '?slug=opc-53-cement-50kg&trade=1', cookieFor(approved));
  assert.equal(trade.getHeader('cache-control'), 'private, no-store');
  assert.equal(trade.json.product.price.headlineLabel, '₹395.00');
});

test('the public path does not even look up the session', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);
  const approved = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });

  const seen = [];
  const watching = { query: (sql, ...a) => { seen.push(sql); return db.query(sql, ...a); } };
  const res = mkRes();
  await handle(mkReq({ url: '/api/catalog?kind=material', cookie: cookieFor(approved) }), res, watching);

  // Nothing on the cacheable path asks who is calling. That is the guarantee: the public URL
  // cannot produce a business price because it never learns whose session it holds. mb_users does
  // appear once now — joined for the seller's name on each listing (FSD Phase 2 §4) — so the real
  // assertion is narrower than "mb_users never appears": no query selects a session by id, which is
  // the one shape that would let the public path learn who is asking.
  assert.equal(seen.filter(q => /WHERE id = \$1/.test(q) && /mb_users/.test(q)).length, 0,
    'no session lookup');
  assert.equal(seen.filter(q => /FROM mb_products/.test(q)).length, 1, 'one query for the products');
  // Two in total: the lookup tables, then the products. The lookup read is one round trip and is
  // held for a minute per database handle, so a warm invocation makes only the product query.
  assert.equal(seen.length, 2, seen.join(' | '));
  assert.match(seen[0], /FROM mb_roles/);
});

test('the list is answered in one database round trip', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const cat = await makeCategory(db);
  for (let i = 0; i < 5; i++) await makeProduct(db, { category_id: cat.id, sku: 'S' + i, slug: 'p-' + i, name: 'P' + i });

  let queries = 0;
  const counting = { query: (...a) => { queries++; return db.query(...a); } };
  const res = mkRes();
  await handle(mkReq({ url: '/api/catalog?kind=material' }), res, counting);
  assert.equal(res.json.total, 5, 'the unpaged total still comes back');
  // One for the lookup tables and one for the list. count(*) OVER () is what keeps the list at
  // one: without it the unpaged total would cost a second query on every page of every browse.
  assert.equal(queries, 2, 'count(*) OVER () removed the separate COUNT query');

  // ...and the lookup read is cached per handle, so the second browse is the list alone.
  queries = 0;
  await handle(mkReq({ url: '/api/catalog?kind=material' }), mkRes(), counting);
  assert.equal(queries, 1, 'a warm invocation queries only the products');
});

test('a stale session browses as a visitor rather than erroring', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);
  const biz = await makeUser(db, { email: 'build@example.com', accountType: 'business', businessStatus: 'approved' });
  const stale = cookieFor(biz);
  await db.query('UPDATE mb_users SET session_version = session_version + 1 WHERE id = $1', [biz.id]);
  const res = await browse(db, '', stale);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.viewer.businessPricing, false);
  assert.doesNotMatch(res.bodyText, /395/);
});
