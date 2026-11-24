// Menu visibility per role — and, more importantly, that it is only visibility.
// docs/permissions.md states the rule; these tests are what keep it true.
//
// Since migration 0005 the roles and their menus are rows in mb_roles and mb_menus, so nothing
// here compares against a list in the source. The expectations are read from the database the
// server reads, which is the only way a test of lookup data can mean anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as admin } from '../api/admin.js';
import { handle as auth } from '../api/auth.js';
import { handle as orders } from '../api/orders.js';
import { menusForRole } from '../api/_roles.js';
import { lookups } from '../api/_lookups.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;
const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try { await fn(mkReq({ method, url, body, cookie }), res, db); }
  catch (e) { if (!e?.status) throw e; res.statusCode = e.status; res.bodyText = JSON.stringify({ error: e.message }); }
  return res;
};
const save = (db, cookie, body) => run(admin, db, {
  method: 'POST', url: '/api/admin?resource=permissions&action=save', cookie, body,
});

test('with nothing saved, every role sees the whole menu the database gives it', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const lk = await lookups(db);
  for (const role of lk.roleCodes) {
    assert.deepEqual((await menusForRole(role, db)).map(m => m.key),
      lk.menus[role].map(m => m.key), role);
  }
  // and the three roles the brief asked for are the three roles that exist
  assert.deepEqual(lk.roleCodes.slice().sort(), ['admin', 'customer', 'owner']);
});

test('an admin can hide a customer menu, and the customer sees the change on their next load', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const c = await makeUser(db, { email: 'cust@x.com' });

  assert.equal((await save(db, cookieFor(a), { role: 'customer', menus: ['materials', 'orders'] })).statusCode, 200);

  const me = await run(auth, db, { url: '/api/auth', cookie: cookieFor(c) });
  const keys = me.json.user.menus.map(m => m.key);
  assert.ok(!keys.includes('services'), 'Services was switched off');
  assert.ok(keys.includes('materials'));
  assert.ok(keys.includes('account'), 'My account is always on, whatever was saved');
});

test('an owner can be tailored too, but never loses the orders they must fulfil', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const o = await makeUser(db, { email: 'owner@x.com', role: 'owner' });

  const r = await save(db, cookieFor(a), { role: 'owner', menus: ['products'] });
  assert.equal(r.statusCode, 200);
  // mb_menus.always_on decides this, not a constant: an owner keeps Orders received and My account.
  assert.deepEqual(r.json.menus.slice().sort(), ['account', 'products', 'storeorders']);

  const me = await run(auth, db, { url: '/api/auth', cookie: cookieFor(o) });
  const keys = me.json.user.menus.map(m => m.key);
  assert.ok(keys.includes('storeorders'), 'an owner cannot be left unable to see their orders');
  assert.ok(!keys.includes('dashboard'), 'My sales was switched off');
});

// --- the part that matters --------------------------------------------------

test('hiding a menu removes no access, and showing one grants none', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeProduct(db);
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const c = await makeUser(db, { email: 'cust@x.com' });

  // hide everything a customer could possibly need
  await save(db, cookieFor(a), { role: 'customer', menus: ['materials'] });

  // ...they can still browse and still order. The menu is not the gate.
  const placed = await run(orders, db, {
    method: 'POST', url: '/api/orders?action=place', cookie: cookieFor(c),
    body: { slug: 'opc-53-cement-50kg', qty: 10, name: 'R', phone: '9876543210',
            line1: '1 Road', city: 'Pune', pincode: '411001', stateCode: '27' },
  });
  assert.equal(placed.statusCode, 201, 'hiding "My orders" does not stop ordering');
  assert.equal((await run(orders, db, { url: '/api/orders', cookie: cookieFor(c) })).statusCode, 200,
    'nor does it stop reading their own orders');

  // ...and no amount of menu switching lets a customer into a seller or platform route
  for (const q of ['?resource=orders', '?resource=customers', '?resource=products',
                   '?resource=owners', '?resource=permissions', '?resource=invented']) {
    assert.equal((await run(admin, db, { url: '/api/admin' + q, cookie: cookieFor(c) })).statusCode, 403, q);
  }
});

test('an owner given every menu they have still reaches no admin route', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const o = await makeUser(db, { email: 'owner@x.com', role: 'owner' });

  // An owner has no Owners or Permissions menu to switch on, which is the first answer; the second
  // is that switching on everything they do have changes nothing about the API.
  await save(db, cookieFor(a), { role: 'owner', menus: ['storeorders', 'products', 'dashboard', 'account'] });

  for (const q of ['?resource=owners', '?resource=customers', '?resource=approvals', '?resource=permissions']) {
    assert.equal((await run(admin, db, { url: '/api/admin' + q, cookie: cookieFor(o) })).statusCode, 403, q);
  }
  // and they cannot grant themselves anything
  const grant = await run(admin, db, {
    method: 'POST', url: '/api/admin?resource=owners&action=grant-admin',
    cookie: cookieFor(o), body: { id: o.id },
  });
  assert.equal(grant.statusCode, 403);
  const [{ role }] = await db.query('SELECT role FROM mb_users WHERE id = $1', [o.id]);
  assert.equal(role, 'owner');
});

test('neither a customer nor an owner can change menus for any role', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const c = await makeUser(db, { email: 'cust@x.com' });
  const o = await makeUser(db, { email: 'owner@x.com', role: 'owner' });
  for (const u of [c, o]) {
    const res = await save(db, cookieFor(u), { role: 'customer', menus: ['materials'] });
    assert.equal(res.statusCode, 403, u.role);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_role_menus'))[0].n, 0);
});

test('the admin role cannot be tailored, and nonsense is refused', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const as = body => save(db, cookieFor(a), body);

  let r = await as({ role: 'admin', menus: ['dashboard'] });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /always sees every menu/);

  r = await as({ role: 'superadmin', menus: ['dashboard'] });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /no superadmin role/);

  r = await as({ role: 'customer', menus: ['materials', 'teleporter'] });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /no "teleporter" menu/);

  r = await as({ role: 'customer', menus: 'materials' });
  assert.equal(r.statusCode, 400);

  // an empty choice still leaves the always-on menus rather than a blank app
  r = await as({ role: 'customer', menus: [] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json.menus, ['account']);
});

test('the overview reports what is locked, what is always on, and who is affected', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const a = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  await makeUser(db, { email: 'o1@x.com', role: 'owner' });
  await makeUser(db, { email: 'c1@x.com' });
  await makeUser(db, { email: 'c2@x.com' });

  const res = await run(admin, db, { url: '/api/admin?resource=permissions', cookie: cookieFor(a) });
  const byRole = Object.fromEntries(res.json.roles.map(r => [r.role, r]));
  assert.deepEqual(Object.keys(byRole).sort(), ['admin', 'customer', 'owner']);
  assert.equal(byRole.admin.locked, true);
  assert.equal(byRole.owner.locked, false);
  assert.equal(byRole.customer.locked, false);
  assert.deepEqual(byRole.customer.alwaysOn, ['account']);
  assert.deepEqual(byRole.owner.alwaysOn.slice().sort(), ['account', 'storeorders']);
  assert.equal(byRole.customer.users, 2);
  assert.equal(byRole.owner.users, 1);
  assert.equal(byRole.admin.users, 1);
  // the label and the explanation come from mb_roles, not from the screen
  assert.equal(byRole.owner.label, 'Owners');
  assert.match(byRole.owner.description, /Sells on matbyus/);
});

test('a missing role_menus table does not break sign-in', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await db.query('DROP TABLE mb_role_menus');      // the override store, not the catalogue
  const c = await makeUser(db, { email: 'cust@x.com' });
  const lk = await lookups(db);
  const me = await run(auth, db, { url: '/api/auth', cookie: cookieFor(c) });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json.user.menus.map(m => m.key), lk.menus.customer.map(m => m.key),
    'the full menu is the safe failure: the APIs still refuse whatever the caller may not do');
});
