// The database refuses the illegal row even when no application code is involved.
// D-2, D-4: the point of these constraints is that an illegal state is unrepresentable, not merely
// discouraged. Each case below would be a real bug if the application layer alone were trusted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeCategory, makeUser } from './helpers.mjs';

const rejects = async (db, sql, params, name) => {
  await assert.rejects(() => db.query(sql, params), e => {
    assert.match(String(e.message), /constraint|violates|check/i, name);
    return true;
  }, name);
};

const USER = `INSERT INTO mb_users (email, password_hash, phone, role, account_type, business_status)
              VALUES ($1,'s1$x$y',$2,$3,$4,$5)`;

test('an account cannot hold a role outside customer and admin', async t => {
  const db = await freshDb(); t.after(() => db.close());
  await rejects(db, USER, ['a@x.com', '+919876543210', 'superuser', 'individual', 'none'], 'role');
  await rejects(db, USER, ['a@x.com', '+919876543210', 'customer', 'reseller', 'none'], 'account_type');
});

test('an individual cannot carry a business status, and a business cannot carry none', async t => {
  const db = await freshDb(); t.after(() => db.close());
  await rejects(db, USER, ['a@x.com', '+919876543210', 'customer', 'individual', 'pending'], 'individual + pending');
  await rejects(db, USER, ['b@x.com', '+919876543210', 'customer', 'business', 'none'], 'business + none');
  // the legal pairs do insert
  await db.query(USER, ['c@x.com', '+919876543210', 'customer', 'individual', 'none']);
  await db.query(USER, ['d@x.com', '+919876543210', 'customer', 'business', 'pending']);
});

test('a phone number is stored normalised or not at all', async t => {
  const db = await freshDb(); t.after(() => db.close());
  for (const bad of ['9876543210', '+91 98765 43210', '+915876543210', '+9198765432100', '']) {
    await rejects(db, USER, ['a@x.com', bad, 'customer', 'individual', 'none'], bad || '(empty)');
  }
});

test('GSTIN, PAN, PIN and state code are held to shape, and a GSTIN cannot contradict its state', async t => {
  const db = await freshDb(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'biz@x.com', accountType: 'business' });
  const insert = `INSERT INTO mb_business_profiles
    (user_id, legal_name, gstin, pan, state_code, address_line1, city, pincode)
    VALUES ($1,'Co',$2,$3,$4,'1 Road','Pune',$5)`;

  await rejects(db, insert, [u.id, 'RUBBISH', null, '27', '411001'], 'gstin shape');
  await rejects(db, insert, [u.id, null, 'NOPE', '27', '411001'], 'pan shape');
  await rejects(db, insert, [u.id, null, null, '99', '411001'], 'state code');
  await rejects(db, insert, [u.id, null, null, '27', '41100'], 'pin length');
  await rejects(db, insert, [u.id, null, null, '27', '911001'], 'pin first digit');
  // FR-6.2 at the database level
  await rejects(db, insert, [u.id, '27AAPFU0939F1ZV', null, '29', '411001'], 'gstin state mismatch');
  // the consistent row inserts
  await db.query(insert, [u.id, '27AAPFU0939F1ZV', 'AAPFU0939F', '27', '411001']);
});

test('a service cannot carry stock or a pack size, and units belong to their kind', async t => {
  const db = await freshDb(); t.after(() => db.close());
  const svc = await makeCategory(db, { slug: 'svc', name: 'Services', kind: 'service' });
  const mat = await makeCategory(db, { slug: 'cement', name: 'Cement', kind: 'material' });
  const ins = `INSERT INTO mb_products (sku, slug, name, kind, category_id, unit, pricing_mode,
                 price_retail, stock_qty, pack_size, hsn_sac)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'1234')`;

  await rejects(db, ins, ['S1', 's1', 'S', 'service', svc.id, 'per_sqft', 'fixed', '10.00', 5, null], 'service stock');
  await rejects(db, ins, ['S2', 's2', 'S', 'service', svc.id, 'per_sqft', 'fixed', '10.00', null, 5], 'service pack size');
  await rejects(db, ins, ['S3', 's3', 'S', 'service', svc.id, 'bag', 'fixed', '10.00', null, null], 'service sold per bag');
  await rejects(db, ins, ['M1', 'm1', 'M', 'material', mat.id, 'per_day', 'fixed', '10.00', null, null], 'material sold per day');
  await rejects(db, ins, ['M2', 'm2', 'M', 'material', mat.id, 'furlong', 'fixed', '10.00', null, null], 'invented unit');
  await db.query(ins, ['M3', 'm3', 'M', 'material', mat.id, 'bag', 'fixed', '10.00', 5, 50]);
});

test('pricing mode and price agree, and prices are never negative', async t => {
  const db = await freshDb(); t.after(() => db.close());
  const mat = await makeCategory(db);
  const ins = `INSERT INTO mb_products (sku, slug, name, kind, category_id, unit, pricing_mode,
                 price_retail, price_business, gst_rate, hsn_sac)
               VALUES ($1,$2,'P','material',$3,'bag',$4,$5,$6,$7,'1234')`;

  await rejects(db, ins, ['P1', 'p1', mat.id, 'fixed', null, null, '18'], 'fixed with no price');
  await rejects(db, ins, ['P2', 'p2', mat.id, 'quote', '10.00', null, '18'], 'quote with a price');
  await rejects(db, ins, ['P3', 'p3', mat.id, 'fixed', '-1.00', null, '18'], 'negative price');
  await rejects(db, ins, ['P4', 'p4', mat.id, 'fixed', '10.00', null, '120'], 'gst over 100');
  await db.query(ins, ['P5', 'p5', mat.id, 'quote', null, null, '18']);
  await db.query(ins, ['P6', 'p6', mat.id, 'fixed', '10.00', '9.00', '18']);
});

test('an active product must carry its HSN or SAC code', async t => {
  const db = await freshDb(); t.after(() => db.close());
  const mat = await makeCategory(db);
  const ins = `INSERT INTO mb_products (sku, slug, name, kind, category_id, unit, price_retail, hsn_sac, is_active)
               VALUES ($1,$2,'P','material',$3,'bag','10.00',$4,$5)`;
  await rejects(db, ins, ['A1', 'a1', mat.id, null, true], 'active with no code');
  await db.query(ins, ['A2', 'a2', mat.id, null, false]);     // a draft may be incomplete
  await db.query(ins, ['A3', 'a3', mat.id, '2523', true]);
});

test('SKU and slug are unique, and a product needs a category', async t => {
  const db = await freshDb(); t.after(() => db.close());
  const mat = await makeCategory(db);
  const ins = `INSERT INTO mb_products (sku, slug, name, kind, category_id, unit, price_retail, hsn_sac)
               VALUES ($1,$2,'P','material',$3,'bag','10.00','2523')`;
  await db.query(ins, ['U1', 'u1', mat.id]);
  await rejects(db, ins, ['U1', 'u2', mat.id], 'duplicate sku');
  await rejects(db, ins, ['U2', 'u1', mat.id], 'duplicate slug');
  await assert.rejects(() => db.query(ins, ['U3', 'u3', null]), 'null category');
});
