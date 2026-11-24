// matbyus — conversations between a customer and an owner. FSD Phase 2 FR-23.
//
//   GET  /api/messages                        -> { conversations: [...] }   the caller's own
//   GET  /api/messages?conversation=<id>       -> { conversation, messages: [...] }
//   POST /api/messages?action=start            -> 201 { conversation }   customer only
//   POST /api/messages?action=send             -> 201 { message }
//
// FR-23.5: a customer sees only their own conversations, an owner only those addressed to them, and
// a superadmin reads none of it — only a count (api/admin.js ?resource=owners already reports that).
// There is no admin-reachable query against mb_messages in this file or any other.

import { json, body, fail, sessionAccount } from './_lib.js';
import { db as defaultDb } from './_db.js';
import { isAdmin } from './_roles.js';
import { formatDateTimeIst } from './_india.js';
import { notify } from './_notify.js';

const str = v => String(v ?? '').trim();

// Scoped in the query, never filtered afterwards (NFR-20). Returns the conversation and which side
// the caller is on, or null if it is not theirs — a null here is always a 404, never a 403
// (NFR-21): another person's conversation does not exist as far as the caller is told.
async function myConversation(db, account, id) {
  const [c] = await db.query(
    `SELECT co.*, p.name AS product_name, p.slug AS product_slug,
            cu.full_name AS customer_name, cu.email AS customer_email,
            ow.full_name AS owner_name, ow.email AS owner_email
       FROM mb_conversations co
       JOIN mb_users cu ON cu.id = co.customer_id
       JOIN mb_users ow ON ow.id = co.owner_id
       LEFT JOIN mb_products p ON p.id = co.product_id
      WHERE co.id = $1 AND (co.customer_id = $2 OR co.owner_id = $2)`,
    [id, account.id]);
  if (!c) return null;
  return { ...c, mySide: c.customer_id === account.id ? 'customer' : 'owner' };
}

const summarise = (c, account) => {
  const mySide = c.customer_id === account.id ? 'customer' : 'owner';
  const theirName = mySide === 'customer' ? c.owner_name : c.customer_name;
  const myLastRead = mySide === 'customer' ? c.customer_last_read_at : c.owner_last_read_at;
  return {
    id: c.id,
    with: theirName,
    product: c.product_id ? { slug: c.product_slug, name: c.product_name } : null,
    lastMessage: c.last_body,
    lastMessageAt: c.last_at,
    unread: c.unread,
    myLastReadAt: myLastRead,
  };
};

export async function handle(req, res, db) {
  const account = await sessionAccount(req, db);
  if (!account) return json(res, 401, { error: 'Please sign in first.' });
  // A superadmin can see that a conversation exists (counted in ?resource=owners) but never reads
  // one — this whole module is customer/owner only (FSD L1).
  if (isAdmin(account)) return json(res, 403, { error: 'You do not have access to this.' });

  const q = new URL(req.url, 'https://local').searchParams;

  if (req.method === 'GET') {
    const conversationId = q.get('conversation');

    if (conversationId) {
      const convo = await myConversation(db, account, conversationId);
      if (!convo) return json(res, 404, { error: 'That conversation was not found.' });

      const col = convo.mySide === 'customer' ? 'customer_last_read_at' : 'owner_last_read_at';
      await db.query(
        `UPDATE mb_conversations SET ${col} = now() WHERE id = $1`, [convo.id]);

      const rows = await db.query(
        `SELECT m.id, m.sender_id, m.body, m.created_at,
                (m.sender_id = $2) AS mine
           FROM mb_messages m WHERE m.conversation_id = $1 ORDER BY m.created_at`,
        [convo.id, account.id]);

      return json(res, 200, {
        conversation: {
          id: convo.id, mySide: convo.mySide,
          with: convo.mySide === 'customer' ? convo.owner_name : convo.customer_name,
          product: convo.product_id ? { slug: convo.product_slug, name: convo.product_name } : null,
        },
        messages: rows.map(m => ({
          id: m.id, mine: m.mine, body: m.body,
          at: m.created_at, atLabel: formatDateTimeIst(m.created_at),
        })),
      });
    }

    // The list: every conversation this account is a side of, with the last message and an unread
    // count computed from the read-tracking columns — one query, no per-conversation N+1 (NFR-23).
    const rows = await db.query(
      `SELECT co.*, p.name AS product_name, p.slug AS product_slug,
              cu.full_name AS customer_name, ow.full_name AS owner_name,
              (SELECT m.body FROM mb_messages m WHERE m.conversation_id = co.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT m.created_at FROM mb_messages m WHERE m.conversation_id = co.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT count(*)::int FROM mb_messages m WHERE m.conversation_id = co.id
                 AND m.sender_id <> $1
                 AND m.created_at > COALESCE(
                   CASE WHEN co.customer_id = $1 THEN co.customer_last_read_at
                        ELSE co.owner_last_read_at END, 'epoch')
              ) AS unread
         FROM mb_conversations co
         JOIN mb_users cu ON cu.id = co.customer_id
         JOIN mb_users ow ON ow.id = co.owner_id
         LEFT JOIN mb_products p ON p.id = co.product_id
        WHERE co.customer_id = $1 OR co.owner_id = $1
        ORDER BY COALESCE(
          (SELECT max(m.created_at) FROM mb_messages m WHERE m.conversation_id = co.id), co.created_at
        ) DESC`,
      [account.id]);

    return json(res, 200, { conversations: rows.map(c => summarise(c, account)) });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const d = await body(req);
  const action = q.get('action');

  // --- opening a conversation (FR-23.1, FR-23.2) ----------------------------
  if (action === 'start') {
    if (isAdmin(account)) return json(res, 403, { error: 'You do not have access to this.' });
    const productSlug = str(d.slug);
    let ownerId = d.ownerId ? String(d.ownerId) : null;
    let productId = null;

    if (productSlug) {
      const [p] = await db.query(
        'SELECT id, owner_id FROM mb_products WHERE slug = $1 AND is_active', [productSlug]);
      if (!p) return json(res, 404, { error: 'That product was not found.' });
      if (!p.owner_id) {
        return json(res, 400, {
          error: 'This listing is sold directly by matbyus; there is no owner to message.',
        });
      }
      productId = p.id;
      ownerId = p.owner_id;
    }
    if (!ownerId) return json(res, 400, { error: 'ownerId or slug is required.' });

    const [owner] = await db.query("SELECT id FROM mb_users WHERE id = $1 AND role = 'owner'", [ownerId]);
    if (!owner) return json(res, 404, { error: 'That owner was not found.' });
    if (ownerId === account.id) return json(res, 400, { error: 'You cannot message yourself.' });

    // Find-or-create against the partial unique indexes, so re-opening "ask about this listing"
    // twice returns the same thread rather than a second empty one (FR-23.2).
    const existing = productId
      ? await db.query(
          'SELECT id FROM mb_conversations WHERE customer_id = $1 AND owner_id = $2 AND product_id = $3',
          [account.id, ownerId, productId])
      : await db.query(
          'SELECT id FROM mb_conversations WHERE customer_id = $1 AND owner_id = $2 AND product_id IS NULL',
          [account.id, ownerId]);
    if (existing.length) return json(res, 200, { conversation: { id: existing[0].id } });

    const [created] = await db.query(
      `INSERT INTO mb_conversations (customer_id, owner_id, product_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [account.id, ownerId, productId]);
    return json(res, 201, { conversation: { id: created.id } });
  }

  // --- sending a message (FR-23.3, FR-23.7) ---------------------------------
  if (action === 'send') {
    const convo = await myConversation(db, account, str(d.conversationId));
    if (!convo) return json(res, 404, { error: 'That conversation was not found.' });

    const text = str(d.body);
    if (!text) return json(res, 400, { error: 'Write something to send.' });
    if (text.length > 4000) return json(res, 400, { error: 'That message is too long.' });

    const [msg] = await db.query(
      `INSERT INTO mb_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [convo.id, account.id, text]);
    await db.query('UPDATE mb_conversations SET updated_at = now() WHERE id = $1', [convo.id]);

    const recipient = convo.mySide === 'customer' ? convo.owner_id : convo.customer_id;
    const fromWhom = convo.mySide === 'customer' ? convo.customer_name : convo.owner_name;
    await notify(db, recipient, 'message', `New message from ${fromWhom}`, {
      body: text.slice(0, 140),
      link: `#/messages/${convo.id}`,
    });

    return json(res, 201, {
      message: { id: msg.id, mine: true, body: text, at: msg.created_at, atLabel: formatDateTimeIst(msg.created_at) },
    });
  }

  return json(res, 400, { error: 'Unknown action.' });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus messages failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
