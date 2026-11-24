// Conversations between a customer and an owner. FSD Phase 2 FR-23.

import test from 'node:test';
import assert from 'node:assert/strict';
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
const as = (db, cookie, opts) => run(messages, db, { url: '/api/messages' + (opts.query || ''), ...opts, cookie });

async function fixture(t) {
  setEnv();
  const db = await freshDb();
  t.after(() => db.close());
  const admin = await makeUser(db, { email: 'admin@x.com', role: 'admin' });
  const alpha = await makeUser(db, { email: 'alpha@x.com', role: 'owner', fullName: 'Alpha Traders' });
  const beta = await makeUser(db, { email: 'beta@x.com', role: 'owner', fullName: 'Beta Suppliers' });
  const ravi = await makeUser(db, { email: 'ravi@x.com', fullName: 'Ravi Kumar' });
  const cat = await makeCategory(db, { kind: 'material' });
  const alphaProduct = await makeProduct(db, { sku: 'A1', slug: 'alpha-cement', name: 'Alpha Cement', category_id: cat.id, owner_id: alpha.id });
  const houseProduct = await makeProduct(db, { sku: 'H1', slug: 'house-cement', name: 'House Cement', category_id: cat.id });
  return { db, admin, alpha, beta, ravi, alphaProduct, houseProduct };
}

test('a customer opens a conversation about a listing, and re-opening returns the same thread', async t => {
  const { db, ravi, alpha, alphaProduct } = await fixture(t);
  const first = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  assert.equal(first.statusCode, 201);

  const again = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json.conversation.id, first.json.conversation.id, 'FR-23.2: one thread per listing');

  const [{ n }] = await db.query('SELECT count(*)::int AS n FROM mb_conversations');
  assert.equal(n, 1);
});

test('a house listing has no owner to message', async t => {
  const { db, ravi, houseProduct } = await fixture(t);
  const r = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: houseProduct.slug },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /no owner to message/);
});

test('both sides can send, see the whole history, and unread counts are tracked per side', async t => {
  const { db, ravi, alpha, alphaProduct } = await fixture(t);
  const { json: { conversation: { id } } } = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });

  const send = (who, text) => as(db, cookieFor(who), {
    method: 'POST', query: '?action=send', body: { conversationId: id, body: text },
  });
  assert.equal((await send(ravi, 'Can you do 390 a bag?')).statusCode, 201);
  assert.equal((await send(alpha, 'For 50 bags, yes.')).statusCode, 201);
  assert.equal((await send(ravi, 'Deal.')).statusCode, 201);

  const raviThread = await as(db, cookieFor(ravi), { query: '?conversation=' + id });
  assert.equal(raviThread.json.messages.length, 3);
  assert.deepEqual(raviThread.json.messages.map(m => m.mine), [true, false, true]);

  // alpha has never opened this thread, so every message ravi sent counts as unread — both of
  // them, including the one before alpha's own reply.
  const list = await as(db, cookieFor(alpha), { query: '' });
  const row = list.json.conversations.find(c => c.id === id);
  assert.equal(row.unread, 2, "both of ravi's messages are unread until alpha opens the thread");

  await as(db, cookieFor(alpha), { query: '?conversation=' + id });   // opening clears it
  const after = await as(db, cookieFor(alpha), { query: '' });
  assert.equal(after.json.conversations.find(c => c.id === id).unread, 0);
});

test('neither side can read or send into a conversation that is not theirs', async t => {
  const { db, ravi, alpha, beta, alphaProduct } = await fixture(t);
  const { json: { conversation: { id } } } = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  const intruder = await as(db, cookieFor(beta), { query: '?conversation=' + id });
  assert.equal(intruder.statusCode, 404);
  const sneak = await as(db, cookieFor(beta), {
    method: 'POST', query: '?action=send', body: { conversationId: id, body: 'hi' },
  });
  assert.equal(sneak.statusCode, 404);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mb_messages'))[0].n, 0);
});

test('an admin reads no conversation and no message, ever', async t => {
  const { db, admin, ravi, alpha, alphaProduct } = await fixture(t);
  const { json: { conversation: { id } } } = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  await as(db, cookieFor(ravi), { method: 'POST', query: '?action=send', body: { conversationId: id, body: 'hi' } });

  assert.equal((await as(db, cookieFor(admin), { query: '' })).statusCode, 403);
  assert.equal((await as(db, cookieFor(admin), { query: '?conversation=' + id })).statusCode, 403);
  assert.equal((await as(db, cookieFor(admin), {
    method: 'POST', query: '?action=start', body: { ownerId: alpha.id },
  })).statusCode, 403);
});

test('sending notifies the other side', async t => {
  const { db, ravi, alpha, alphaProduct } = await fixture(t);
  const { json: { conversation: { id } } } = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  await as(db, cookieFor(ravi), { method: 'POST', query: '?action=send', body: { conversationId: id, body: 'hello' } });

  const [n] = await db.query(
    "SELECT * FROM mb_notifications WHERE user_id = $1 AND kind = 'message'", [alpha.id]);
  assert.ok(n, 'the owner was notified');
  assert.match(n.title, /Ravi Kumar/);
  assert.equal(n.link, `#/messages/${id}`);
});

test('a blank or too-long message is refused', async t => {
  const { db, ravi, alphaProduct } = await fixture(t);
  const { json: { conversation: { id } } } = await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=start', body: { slug: alphaProduct.slug },
  });
  assert.equal((await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=send', body: { conversationId: id, body: '   ' },
  })).statusCode, 400);
  assert.equal((await as(db, cookieFor(ravi), {
    method: 'POST', query: '?action=send', body: { conversationId: id, body: 'x'.repeat(4001) },
  })).statusCode, 400);
});
