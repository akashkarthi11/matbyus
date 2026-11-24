// matbyus — in-app notifications. FSD Phase 2 FR-28.
//
// One function, called from the four places FR-28.1 names: an order is placed, an order's status
// changes, a message is sent, a bid moves. Every other handler imports this rather than writing
// `INSERT INTO mb_notifications` itself, so "a notification is addressed to exactly one account"
// (FR-28.5) and the row shape stay in one place.
//
// Deliberately fire-and-forget in the sense that a notification failing to write never fails the
// action it is about: an order placed with no notification is a worse bug than one that logs loudly,
// but a placed order rejected because notifying the owner failed is worse still. Every call site
// awaits this and the caller's own try/catch covers it — there is nothing here to swallow silently.

export async function notify(db, userId, kind, title, { body = null, link = null } = {}) {
  if (!userId) return;   // a house listing has no owner to tell; "nobody" is not an error (FR-28.5)
  await db.query(
    `INSERT INTO mb_notifications (user_id, kind, title, body, link)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, kind, title, body, link]);
}
