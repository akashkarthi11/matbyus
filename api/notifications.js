// matbyus — in-app notifications. FSD Phase 2 FR-28.
//
//   GET  /api/notifications               -> { notifications: [...], unread }
//   POST /api/notifications?action=read   -> 200 { ok: true }   body { id } or { all: true }
//
// FR-28.4: "opening the item clears it. A count never persists after the thing has been seen." The
// front end calls ?action=read with the notification's id when it is opened, and with { all: true }
// when the notification list itself is opened — whichever happens first clears it.

import { json, body, sessionAccount } from './_lib.js';
import { db as defaultDb } from './_db.js';
import { formatDateTimeIst } from './_india.js';

export async function handle(req, res, db) {
  const account = await sessionAccount(req, db);
  if (!account) return json(res, 401, { error: 'Please sign in first.' });

  if (req.method === 'GET') {
    // Scoped to the caller (NFR-20, FR-28.5): nothing here can list another account's notifications.
    const rows = await db.query(
      `SELECT * FROM mb_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [account.id]);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM mb_notifications WHERE user_id = $1 AND read_at IS NULL`,
      [account.id]);
    return json(res, 200, {
      unread: n,
      notifications: rows.map(r => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link,
        read: !!r.read_at, at: r.created_at, atLabel: formatDateTimeIst(r.created_at),
      })),
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const d = await body(req);
  const action = new URL(req.url, 'https://local').searchParams.get('action');

  if (action === 'read') {
    if (d.all) {
      await db.query(
        `UPDATE mb_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [account.id]);
      return json(res, 200, { ok: true });
    }
    const id = String(d.id || '');
    if (!id) return json(res, 400, { error: 'id is required.' });
    // Scoped by user_id in the WHERE clause, so marking someone else's notification read is simply
    // a no-op rather than a 403 that would confirm it exists.
    await db.query(
      `UPDATE mb_notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [id, account.id]);
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: 'Unknown action.' });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus notifications failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
