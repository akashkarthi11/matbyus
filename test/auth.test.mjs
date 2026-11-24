// FR-1 to FR-6. TSD sections 4, 5, 11.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/auth.js';
import { token } from '../api/_lib.js';
import { lookups } from '../api/_lookups.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser } from './helpers.mjs';

const post = async (db, action, body, cookie = '') => {
  const res = mkRes();
  await handle(mkReq({ method: 'POST', url: `/api/auth?action=${action}`, body, cookie }), res, db);
  return res;
};
const get = async (db, cookie = '') => {
  const res = mkRes();
  await handle(mkReq({ method: 'GET', url: '/api/auth', cookie }), res, db);
  return res;
};

const GOOD = { email: 'ravi@example.com', password: 'correct-horse-battery', fullName: 'Ravi Kumar', phone: '9876543210' };
const BUSINESS = {
  legalName: 'Kumar Constructions', gstin: '27AAPFU0939F1ZV', stateCode: '27',
  addressLine1: '12 MG Road', city: 'Pune', pincode: '411001', contactPerson: 'Ravi Kumar',
};

// --- registration (FR-1) ----------------------------------------------------

test('an individual registers, is signed in, and lands as a customer', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = await post(db, 'register', GOOD);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.user.role, 'customer');
  assert.equal(res.json.user.accountType, 'individual');
  assert.equal(res.json.user.businessStatus, 'none');
  assert.equal(res.json.user.phone, '+919876543210', 'mobile is normalised on the way in');
  assert.match(res.getHeader('set-cookie'), /^mb_session=.+HttpOnly.+Secure.+SameSite=Lax/);
  assert.deepEqual(res.json.user.menus.map(m => m.key),
    (await lookups(db)).menus.customer.map(m => m.key),
    'a new customer sees the whole customer menu until an admin tailors it');
});

test('registration can never create an admin, however the request asks', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  for (const attempt of [{ role: 'admin' }, { Role: 'admin' }, { role: ['admin'] }]) {
    const res = await post(db, 'register', { ...GOOD, email: `a${Math.random()}@example.com`, ...attempt });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json.user.role, 'customer', JSON.stringify(attempt));
  }
  const rows = await db.query("SELECT count(*)::int AS n FROM mb_users WHERE role = 'admin'");
  assert.equal(rows[0].n, 0);
});

test('registration enforces the password, email, name and mobile rules', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const bad = async (over, expect) => {
    const r = await post(db, 'register', { ...GOOD, ...over });
    assert.equal(r.statusCode, 400, JSON.stringify(over));
    if (expect) assert.match(r.json.error, expect);
  };
  await bad({ password: '' }, /required/);
  await bad({ password: 'x'.repeat(201) }, /too long/);
  await bad({ email: 'not-an-email' }, /valid email/);
  await bad({ fullName: '  ' }, /name is required/);
  await bad({ phone: '12345' }, /mobile/);
  await bad({ phone: '5876543210' }, /mobile/, 'Indian mobiles start 6-9');
});

test('a short password is accepted: there is no minimum length (FSD L9)', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = await post(db, 'register', { ...GOOD, password: '110299' });
  assert.equal(res.statusCode, 201, 'six characters is allowed on the owner\'s instruction');
  assert.equal((await post(db, 'login', { email: GOOD.email, password: '110299' })).statusCode, 200);
  assert.equal((await post(db, 'login', { email: GOOD.email, password: '110298' })).statusCode, 401);
});

test('rate limiting is what stands between a short password and a guess (FSD L9 mitigation)', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: 'short@example.com', password: '110299' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(db, 'login', { email: 'short@example.com', password: String(100000 + i) })).statusCode, 401);
  }
  const sixth = await post(db, 'login', { email: 'short@example.com', password: '110299' });
  assert.equal(sixth.statusCode, 429, 'five wrong guesses per 15 minutes, correct password or not');
});

test('a duplicate email is refused without revealing anything about the existing account', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: GOOD.email, role: 'admin' });
  const res = await post(db, 'register', GOOD);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.error, 'An account with this email already exists.');
  assert.doesNotMatch(res.json.error, /admin/i);
});

// --- business registration (FR-6) -------------------------------------------

test('a business registration is pending, writes its profile and logs the status', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = await post(db, 'register', { ...GOOD, accountType: 'business', business: BUSINESS });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.user.accountType, 'business');
  assert.equal(res.json.user.businessStatus, 'pending');

  const [profile] = await db.query('SELECT * FROM mb_business_profiles WHERE user_id = $1', [res.json.user.id]);
  assert.equal(profile.gstin, '27AAPFU0939F1ZV');
  assert.equal(profile.state_code, '27');
  assert.equal(profile.pincode, '411001');

  const log = await db.query('SELECT * FROM mb_business_status_log WHERE user_id = $1', [res.json.user.id]);
  assert.equal(log.length, 1);
  assert.equal(log[0].to_status, 'pending');
});

test('a business registration without a GSTIN is accepted (FSD A6)', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const { gstin, ...noGstin } = BUSINESS;
  const res = await post(db, 'register', { ...GOOD, accountType: 'business', business: noGstin });
  assert.equal(res.statusCode, 201);
  const [p] = await db.query('SELECT gstin FROM mb_business_profiles WHERE user_id = $1', [res.json.user.id]);
  assert.equal(p.gstin, null);
});

test('a bad GSTIN, or one from the wrong state, is refused and nothing is written', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const bad = async (business, expect) => {
    const r = await post(db, 'register', { ...GOOD, accountType: 'business', business });
    assert.equal(r.statusCode, 400);
    assert.match(r.json.error, expect);
  };
  await bad({ ...BUSINESS, gstin: '27AAPFU0939F1ZQ' }, /not valid/);
  await bad({ ...BUSINESS, gstin: 'RUBBISH' }, /not valid/);
  await bad({ ...BUSINESS, stateCode: '29' }, /state 27.*state 29|state 29.*state 27/);
  await bad({ ...BUSINESS, pincode: '41100' }, /PIN code/);
  await bad({ ...BUSINESS, stateCode: '99' }, /valid state/);
  await bad({ ...BUSINESS, legalName: '' }, /Business name/);
  await bad({ ...BUSINESS, pan: 'NOPE' }, /PAN/);

  const rows = await db.query('SELECT count(*)::int AS n FROM mb_users');
  assert.equal(rows[0].n, 0, 'no account is created when the business block is rejected');
});

// --- sign in (FR-2) ---------------------------------------------------------

test('an unknown email and a wrong password are indistinguishable', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: 'known@example.com', password: 'correct-horse-battery' });

  const unknown = await post(db, 'login', { email: 'nobody@example.com', password: 'correct-horse-battery' });
  const wrong = await post(db, 'login', { email: 'known@example.com', password: 'wrong-horse-battery' });

  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.bodyText, wrong.bodyText, 'byte-identical bodies');
  assert.equal(unknown.json.error, 'Email or password is incorrect.');
});

test('a correct password signs in and issues a cookie', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: 'known@example.com', password: 'correct-horse-battery' });
  const res = await post(db, 'login', { email: 'KNOWN@Example.com ', password: 'correct-horse-battery' });
  assert.equal(res.statusCode, 200, 'email is lower-cased and trimmed');
  assert.equal(res.json.user.email, 'known@example.com');
  assert.ok(res.cookie.startsWith('mb_session='));
});

test('the sixth failed sign-in for one email is refused with Retry-After', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: 'known@example.com', password: 'correct-horse-battery' });
  for (let i = 0; i < 5; i++) {
    const r = await post(db, 'login', { email: 'known@example.com', password: 'nope-nope-nope' });
    assert.equal(r.statusCode, 401, 'attempt ' + (i + 1));
  }
  const sixth = await post(db, 'login', { email: 'known@example.com', password: 'nope-nope-nope' });
  assert.equal(sixth.statusCode, 429);
  assert.ok(Number(sixth.getHeader('retry-after')) > 0);

  // even the right password is refused while the window is open
  const correct = await post(db, 'login', { email: 'known@example.com', password: 'correct-horse-battery' });
  assert.equal(correct.statusCode, 429);
});

test('a successful sign-in clears that email counter', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  await makeUser(db, { email: 'known@example.com', password: 'correct-horse-battery' });
  for (let i = 0; i < 4; i++) await post(db, 'login', { email: 'known@example.com', password: 'nope-nope-nope' });
  assert.equal((await post(db, 'login', { email: 'known@example.com', password: 'correct-horse-battery' })).statusCode, 200);
  for (let i = 0; i < 4; i++) {
    const r = await post(db, 'login', { email: 'known@example.com', password: 'nope-nope-nope' });
    assert.equal(r.statusCode, 401, 'the counter restarted, so attempt ' + (i + 1) + ' is still 401');
  }
});

// --- session (FR-3) ---------------------------------------------------------

test('a valid cookie resolves; tampering, expiry and a stale version do not', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'known@example.com' });

  const good = `mb_session=${token(u.id, 1)}`;
  assert.equal((await get(db, good)).json.user.email, 'known@example.com');

  const [b, s] = token(u.id, 1).split('.');
  assert.equal((await get(db, `mb_session=${b}.${'A'.repeat(s.length)}`)).json.user, null, 'bad signature');
  assert.equal((await get(db, 'mb_session=rubbish')).json.user, null);
  assert.equal((await get(db, '')).json.user, null);

  // a stale session_version is signed out (FR-3.2)
  await db.query('UPDATE mb_users SET session_version = session_version + 1 WHERE id = $1', [u.id]);
  assert.equal((await get(db, good)).json.user, null);
});

test('sign out clears the cookie and works even when already signed out', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = await post(db, 'logout', {});
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader('set-cookie'), /mb_session=; .*Max-Age=0/);
});

// --- password reset (FR-4) --------------------------------------------------

test('an anonymous reset is refused with guidance, and changes nothing', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'known@example.com', password: 'correct-horse-battery' });
  const res = await post(db, 'reset', { email: 'known@example.com', password: 'new-password-here' });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /contact support/i);
  const [after] = await db.query('SELECT password_hash FROM mb_users WHERE id = $1', [u.id]);
  assert.equal((await post(db, 'login', { email: 'known@example.com', password: 'correct-horse-battery' })).statusCode, 200);
  assert.ok(after.password_hash);
});

test('a customer cannot reset anyone, including themselves', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const u = await makeUser(db, { email: 'cust@example.com' });
  const res = await post(db, 'reset', { email: 'cust@example.com', password: 'new-password-here' },
    `mb_session=${token(u.id, 1)}`);
  assert.equal(res.statusCode, 403);
});

test('an admin resets a customer, and the customer is signed out at once', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const admin = await makeUser(db, { email: 'admin@example.com', role: 'admin' });
  const cust = await makeUser(db, { email: 'cust@example.com', password: 'old-password-here' });
  const custCookie = `mb_session=${token(cust.id, 1)}`;
  assert.equal((await get(db, custCookie)).json.user.email, 'cust@example.com');

  const res = await post(db, 'reset', { email: 'cust@example.com', password: 'brand-new-password' },
    `mb_session=${token(admin.id, 1)}`);
  assert.equal(res.statusCode, 200);

  assert.equal((await get(db, custCookie)).json.user, null, 'the old session is dead');
  assert.equal((await post(db, 'login', { email: 'cust@example.com', password: 'old-password-here' })).statusCode, 401);
  assert.equal((await post(db, 'login', { email: 'cust@example.com', password: 'brand-new-password' })).statusCode, 200);
});

test('an admin resetting their own password keeps their current session', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const admin = await makeUser(db, { email: 'admin@example.com', role: 'admin', password: 'old-password-here' });
  const res = await post(db, 'reset', { email: 'admin@example.com', password: 'brand-new-password' },
    `mb_session=${token(admin.id, 1)}`);
  assert.equal(res.statusCode, 200);
  const reissued = res.cookie;
  assert.ok(reissued.startsWith('mb_session='), 'a fresh cookie is issued');
  assert.equal((await get(db, reissued)).json.user.email, 'admin@example.com');
});

test('resetting an unknown email reports not found, not success', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const admin = await makeUser(db, { email: 'admin@example.com', role: 'admin' });
  const res = await post(db, 'reset', { email: 'ghost@example.com', password: 'brand-new-password' },
    `mb_session=${token(admin.id, 1)}`);
  assert.equal(res.statusCode, 404);
});

test('an unknown action and a wrong method are refused', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  assert.equal((await post(db, 'elevate', GOOD)).statusCode, 400);
  const res = mkRes();
  await handle(mkReq({ method: 'DELETE', url: '/api/auth' }), res, db);
  assert.equal(res.statusCode, 405);
});
