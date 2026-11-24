// /api/categories — the small, edge-cached list that replaced fetching 100 products to find out
// which categories exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/categories.js';
import { freshDb, setEnv, mkReq, mkRes, makeCategory, makeProduct } from './helpers.mjs';

const get = async (db, query = '') => {
  const res = mkRes();
  await handle(mkReq({ url: '/api/categories' + query }), res, db);
  return res;
};

test('returns only categories that have something live in them, with counts', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const cement = await makeCategory(db, { slug: 'cement', name: 'Cement', kind: 'material' });
  const steel = await makeCategory(db, { slug: 'steel', name: 'Steel', kind: 'material' });
  await makeCategory(db, { slug: 'empty', name: 'Empty', kind: 'material' });
  const svc = await makeCategory(db, { slug: 'plastering', name: 'Plastering', kind: 'service' });

  await makeProduct(db, { category_id: cement.id });
  await makeProduct(db, { category_id: cement.id, sku: 'C2', slug: 'c2', name: 'Cement two' });
  await makeProduct(db, { category_id: steel.id, sku: 'S1', slug: 's1', name: 'Steel one', is_active: false });
  await makeProduct(db, { category_id: svc.id, kind: 'service', sku: 'V1', slug: 'v1', name: 'Plaster',
    unit: 'per_sqft', pack_size: null, stock_qty: null, hsn_sac: '9954' });

  const all = await get(db);
  assert.equal(all.statusCode, 200);
  const slugs = all.json.categories.map(c => c.slug);
  assert.deepEqual(slugs.sort(), ['cement', 'plastering']);
  assert.ok(!slugs.includes('empty'), 'a category with nothing in it is not offered as a filter');
  assert.ok(!slugs.includes('steel'), 'a category whose only product is a draft is not offered either');
  assert.equal(all.json.categories.find(c => c.slug === 'cement').products, 2);
});

test('filters by kind', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const cement = await makeCategory(db, { slug: 'cement', name: 'Cement', kind: 'material' });
  const svc = await makeCategory(db, { slug: 'plastering', name: 'Plastering', kind: 'service' });
  await makeProduct(db, { category_id: cement.id });
  await makeProduct(db, { category_id: svc.id, kind: 'service', sku: 'V1', slug: 'v1', name: 'Plaster',
    unit: 'per_sqft', pack_size: null, stock_qty: null, hsn_sac: '9954' });

  assert.deepEqual((await get(db, '?kind=material')).json.categories.map(c => c.slug), ['cement']);
  assert.deepEqual((await get(db, '?kind=service')).json.categories.map(c => c.slug), ['plastering']);
  assert.equal((await get(db, '?kind=rental')).statusCode, 400);
});

test('it is cacheable for everyone, because a category name is the same for every viewer', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = await get(db);
  assert.match(res.getHeader('cache-control'), /^public, s-maxage=\d+/);
  assert.equal(res.getHeader('vary'), undefined, 'no price is involved, so nothing to vary on');
});

test('only GET', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = mkRes();
  await handle(mkReq({ method: 'POST', url: '/api/categories' }), res, db);
  assert.equal(res.statusCode, 405);
});
