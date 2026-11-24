// In-app notifications. FSD Phase 2 FR-28.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as notifications } from '../api/notifications.js';
import { handle as messages } from '../api/messages.js';
import { token } from '../api/_lib.js';
import { freshDb, setEnv, mkReq, mkRes, makeUser, makeCategory, makeProduct } from './helpers.mjs';

const cookieFor = u => `mb_session=${token(u.id, 1)}`;
const run = async (fn, db, { method = 'GET', url, body = null, cookie = '' }) => {
  const res = mkRes();
  try { await fn(mkReq({ method, url, body, cookie }), res, db); }
  catch (e) { if (!e?.status) throw e; res.statusCode = e.status; res.bodyText = JSON.stringify({ error: e.message }); }
  return res;
};
const as = (db, who, opts) => run(notifications, db, {
  url: '/api/notifications' + (opts.query || ''), cookie: cookieFor(who), ...opts,
});

async function fixture(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const ravi = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  const cat = await makeCategory(db, { kind: 'material' });
  const product = await makeProduct(db, { sku: 'A1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: alpha.id });
  return { db, alpha, ravi, product };
}

async function sendMessage(db, who, conversationId, text) {
  return run(messages, db, {
    method: 'POST', url: '/api/messages?action=send', cookie: cookieFor(who),
    body: { conversationId, body: text },
  });
}

test('a notification is addressed to one account, and lists newest first', async t => {
  const { db, alpha, ravi, product } = await fixture(t);
  const started = await run(messages, db, {
    method: 'POST', url: '/api/messages?action=start', cookie: cookieFor(ravi),
    body: { slug: product.slug },
  });
  const conversationId = started.json.conversation.id;
  await sendMessage(db, ravi, conversationId, 'one');
  await sendMessage(db, ravi, conversationId, 'two');

  const forAlpha = await as(db, alpha, { query: '' });
  assert.equal(forAlpha.json.unread, 2);
  assert.equal(forAlpha.json.notifications.length, 2);
  assert.match(forAlpha.json.notifications[0].title, /Ravi Kumar/);

  const forRavi = await as(db, ravi, { query: '' });
  assert.equal(forRavi.json.unread, 0, 'ravi sent these; nothing notifies the sender');
});

test('opening one clears it, and it never comes back', async t => {
  const { db, alpha, ravi, product } = await fixture(t);
  const started = await run(messages, db, {
    method: 'POST', url: '/api/messages?action=start', cookie: cookieFor(ravi),
    body: { slug: product.slug },
  });
  await sendMessage(db, ravi, started.json.conversation.id, 'hi');

  const before = await as(db, alpha, { query: '' });
  const id = before.json.notifications[0].id;
  const read = await as(db, alpha, { method: 'POST', query: '?action=read', body: { id } });
  assert.equal(read.statusCode, 200);

  const after = await as(db, alpha, { query: '' });
  assert.equal(after.json.unread, 0);
  assert.equal(after.json.notifications[0].read, true);
});

test('mark-all-read clears every unread notification for that account only', async t => {
  const { db, alpha, ravi, product } = await fixture(t);
  const started = await run(messages, db, {
    method: 'POST', url: '/api/messages?action=start', cookie: cookieFor(ravi),
    body: { slug: product.slug },
  });
  await sendMessage(db, ravi, started.json.conversation.id, 'one');
  await sendMessage(db, ravi, started.json.conversation.id, 'two');
  await sendMessage(db, ravi, started.json.conversation.id, 'three');

  assert.equal((await as(db, alpha, { query: '' })).json.unread, 3);
  const r = await as(db, alpha, { method: 'POST', query: '?action=read', body: { all: true } });
  assert.equal(r.statusCode, 200);
  assert.equal((await as(db, alpha, { query: '' })).json.unread, 0);
});

test('marking someone else\'s notification read is a silent no-op, not an error', async t => {
  const { db, alpha, ravi, product } = await fixture(t);
  const started = await run(messages, db, {
    method: 'POST', url: '/api/messages?action=start', cookie: cookieFor(ravi),
    body: { slug: product.slug },
  });
  await sendMessage(db, ravi, started.json.conversation.id, 'hi');
  const theirs = (await as(db, alpha, { query: '' })).json.notifications[0].id;

  const other = await makeUser(db, { email: 'other@x.com' });
  const r = await as(db, other, { method: 'POST', query: '?action=read', body: { id: theirs } });
  assert.equal(r.statusCode, 200, 'no information is revealed about whether the id exists');

  const stillUnread = await as(db, alpha, { query: '' });
  assert.equal(stillUnread.json.unread, 1, 'alpha\'s notification is untouched');
});

test('nobody reaches this without a session', async t => {
  setEnv(); const db = await freshDb(); t.after(() => db.close());
  const res = mkRes();
  await notifications(mkReq({ url: '/api/notifications' }), res, db);
  assert.equal(res.statusCode, 401);
});
