// matbyus — bids. FSD Phase 2 FR-24.
//
//   GET  /api/bids                     -> { bids: [...] }    the caller's own, either side
//   GET  /api/bids?id=<uuid>           -> { bid }            one of theirs, with its move history
//   POST /api/bids?action=place        -> 201 { bid }        customer only
//   POST /api/bids?action=counter      -> 200 { bid }        whoever's turn it is
//   POST /api/bids?action=accept       -> 200 { bid, order } accepting creates the order (FR-24.8)
//   POST /api/bids?action=reject       -> 200 { bid }
//   POST /api/bids?action=withdraw     -> 200 { bid }        customer only, their own bid
//
// FR-24.4: "back-and-forth is the normal case and is not limited to one round." A bid's `status`
// is therefore not the only state — `turn` says whose move it is. What each action needs, who may
// make it, and whether it waits its turn are all rows in mb_bid_statuses / mb_bid_actions
// (migration 0011), read through api/_lookups.js — the same table-not-code pattern as every other
// list in this project. What genuinely stays in code is turn-taking itself: that 'countered' is
// reached by both sides, and which side "mine" resolves to for this request. That is a fact about
// the request in front of the handler, not a fact two different bids could disagree about, and no
// (from_status, to_status) pair can express it without inventing a status per turn.

import { json, body, sessionAccount } from './_lib.js';
import { db as defaultDb } from './_db.js';
import { isAdmin } from './_roles.js';
import { toPaise, gstOn, formatInr, formatDateTimeIst } from './_india.js';
import { insertOrder, readAddress } from './orders.js';
import { lookups } from './_lookups.js';
import { notify } from './_notify.js';

const BID_TTL_HOURS = Math.min(168, Math.max(1, Number(process.env.MB_BID_TTL_HOURS) || 48));

const str = v => String(v ?? '').trim();

// A bid past its expiry is 'expired' the moment anyone looks at it or acts on it, not on some timer
// nothing here runs. The move is still recorded, so the history (FR-24.5) says when, not just that
// it eventually happened. `openCodes` comes from mb_bid_statuses.is_open — not a literal list here.
async function expireIfDue(db, lk, bid) {
  const openCodes = lk.bidStatuses.filter(s => s.is_open).map(s => s.code);
  if (!openCodes.includes(bid.status)) return bid;
  if (new Date(bid.expires_at) > new Date()) return bid;
  await db.query(
    `UPDATE mb_bids SET status = 'expired', updated_at = now() WHERE id = $1 AND status = $2`,
    [bid.id, bid.status]);
  await db.query(
    `INSERT INTO mb_bid_moves (bid_id, actor_id, action, from_status, to_status, from_price, to_price)
     VALUES ($1, NULL, 'expire', $2, 'expired', $3, $3)`,
    [bid.id, bid.status, bid.unit_price]);
  return { ...bid, status: 'expired' };
}

// Scoped in the query, never filtered afterwards (NFR-20). Another person's bid is a 404, not a
// 403 (NFR-21) — it simply is not found. Admin reaches nothing here; negotiation is customer/owner.
async function myBid(db, lk, account, id) {
  const [row] = await db.query(
    `SELECT b.*, p.name AS product_name, p.slug AS product_slug, p.unit, p.min_order_qty,
            cu.full_name AS customer_name, ow.full_name AS owner_name
       FROM mb_bids b
       JOIN mb_products p ON p.id = b.product_id
       JOIN mb_users cu ON cu.id = b.customer_id
       JOIN mb_users ow ON ow.id = b.owner_id
      WHERE b.id = $1 AND (b.customer_id = $2 OR b.owner_id = $2)`,
    [id, account.id]);
  if (!row) return null;
  const bid = await expireIfDue(db, lk, row);
  return { ...bid, mySide: bid.customer_id === account.id ? 'customer' : 'owner' };
}

const publicBid = (b, lk) => ({
  id: b.id,
  conversationId: b.conversation_id,
  product: { slug: b.product_slug, name: b.product_name },
  mySide: b.mySide,
  with: b.mySide === 'customer' ? b.owner_name : b.customer_name,
  status: b.status,
  statusLabel: lk.bidStatus(b.status)?.label || b.status,
  turn: b.turn,
  qty: Number(b.qty),
  unit: b.unit,
  unitPrice: b.unit_price,
  unitPriceLabel: b.unit_price != null ? formatInr(toPaise(b.unit_price)) : null,
  totalLabel: b.unit_price != null ? formatInr(toPaise(b.unit_price) * Number(b.qty)) : null,
  expiresAt: b.expires_at,
  orderId: b.order_id,
  createdAt: b.created_at,
  updatedAt: b.updated_at,
});

export async function handle(req, res, db) {
  const lk = await lookups(db);
  const account = await sessionAccount(req, db);
  if (!account) return json(res, 401, { error: 'Please sign in first.' });
  if (isAdmin(account)) return json(res, 403, { error: 'You do not have access to this.' });

  const q = new URL(req.url, 'https://local').searchParams;

  if (req.method === 'GET') {
    const id = q.get('id');
    if (id) {
      const bid = await myBid(db, lk, account, id);
      if (!bid) return json(res, 404, { error: 'That offer was not found.' });
      const moves = await db.query(
        `SELECT m.*, u.full_name AS actor_name
           FROM mb_bid_moves m LEFT JOIN mb_users u ON u.id = m.actor_id
          WHERE m.bid_id = $1 ORDER BY m.created_at`, [bid.id]);
      return json(res, 200, {
        bid: publicBid(bid, lk),
        moves: moves.map(m => ({
          action: m.action, by: m.actor_name || 'matbyus',
          fromStatus: m.from_status, toStatus: m.to_status,
          toStatusLabel: lk.bidStatus(m.to_status)?.label || m.to_status,
          fromPriceLabel: m.from_price != null ? formatInr(toPaise(m.from_price)) : null,
          toPriceLabel: m.to_price != null ? formatInr(toPaise(m.to_price)) : null,
          note: m.note, at: m.created_at, atLabel: formatDateTimeIst(m.created_at),
        })),
      });
    }

    const rows = await db.query(
      `SELECT b.*, p.name AS product_name, p.slug AS product_slug, p.unit,
              cu.full_name AS customer_name, ow.full_name AS owner_name
         FROM mb_bids b
         JOIN mb_products p ON p.id = b.product_id
         JOIN mb_users cu ON cu.id = b.customer_id
         JOIN mb_users ow ON ow.id = b.owner_id
        WHERE b.customer_id = $1 OR b.owner_id = $1
        ORDER BY b.updated_at DESC LIMIT 200`, [account.id]);
    const live = [];
    for (const r of rows) {
      live.push(await expireIfDue(db, lk, { ...r, mySide: r.customer_id === account.id ? 'customer' : 'owner' }));
    }
    return json(res, 200, { bids: live.map(b => publicBid(b, lk)) });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const d = await body(req);
  const action = q.get('action');

  // --- placing a bid (FR-24.1, FR-24.10) ------------------------------------
  if (action === 'place') {
    const slug = str(d.slug);
    const [product] = await db.query(
      `SELECT p.*, c.name AS category_name FROM mb_products p
         JOIN mb_categories c ON c.id = p.category_id
        WHERE p.slug = $1 AND p.is_active`, [slug]);
    if (!product) return json(res, 404, { error: 'That product was not found.' });
    if (!product.owner_id) {
      return json(res, 400, {
        error: 'This listing is sold directly by matbyus; there is nobody to negotiate with.',
      });
    }

    const qty = Number(d.qty);
    if (!Number.isFinite(qty) || qty <= 0) return json(res, 400, { error: 'Enter how many you want.' });
    const min = Number(product.min_order_qty) || 1;
    if (qty < min) return json(res, 400, { error: `The minimum order for this item is ${min} ${product.unit}.` });

    // FR-24.10: a quote-priced listing takes a bid with no starting price — that is what "request a
    // quote" means. A fixed-price listing's bid must name one, so the owner has a figure to answer.
    let unitPrice = null;
    if (d.unitPrice != null && String(d.unitPrice).trim() !== '') {
      const n = Number(d.unitPrice);
      if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: 'Enter a valid price.' });
      unitPrice = String(d.unitPrice);
    } else if (product.pricing_mode === 'fixed') {
      return json(res, 400, { error: 'Name the price you are offering.' });
    }

    // One conversation per (customer, owner, listing) (FR-23.2) — find or create it, the same rule
    // messages.js uses, so a bid and a chat about the same listing always share one thread.
    const [existing] = await db.query(
      'SELECT id FROM mb_conversations WHERE customer_id = $1 AND owner_id = $2 AND product_id = $3',
      [account.id, product.owner_id, product.id]);
    const conversationId = existing
      ? existing.id
      : (await db.query(
          `INSERT INTO mb_conversations (customer_id, owner_id, product_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [account.id, product.owner_id, product.id]))[0].id;

    const [bid] = await db.query(
      `INSERT INTO mb_bids (conversation_id, product_id, customer_id, owner_id, qty, unit_price, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7))
       RETURNING *, (SELECT name FROM mb_products WHERE id = $2) AS product_name,
                     (SELECT slug FROM mb_products WHERE id = $2) AS product_slug,
                     (SELECT unit FROM mb_products WHERE id = $2) AS unit`,
      [conversationId, product.id, account.id, product.owner_id, String(qty), unitPrice, BID_TTL_HOURS]);
    await db.query(
      `INSERT INTO mb_bid_moves (bid_id, actor_id, action, from_status, to_status, from_price, to_price, note)
       VALUES ($1,$2,'open',NULL,'open',NULL,$3,$4)`,
      [bid.id, account.id, unitPrice, str(d.note).slice(0, 300) || null]);

    await notify(db, product.owner_id, 'bid',
      `${account.full_name || account.email} made an offer on ${product.name}`,
      { body: unitPrice ? formatInr(toPaise(unitPrice)) + ` × ${qty} ${product.unit}` : 'Requesting a quote',
        link: `#/bids/${bid.id}` });

    return json(res, 201, { bid: publicBid({ ...bid, mySide: 'customer' }, lk) });
  }

  // --- counter / accept / reject / withdraw (FR-24.4, FR-24.9) --------------
  // mb_bid_actions is the whole rulebook: what this action needs, who may make it, and whether it
  // waits its turn. Only the facts a generic row cannot hold — whose turn this request's caller is
  // on, and which side "mine" resolves to — are decided here.
  const rule = lk.bidAction(action);
  if (!rule) return json(res, 400, { error: 'Unknown action.' });

  const bid = await myBid(db, lk, account, str(d.id));
  if (!bid) return json(res, 404, { error: 'That offer was not found.' });

  if (rule.restrictSide && bid.mySide !== rule.restrictSide) {
    return json(res, 403, { error: 'You do not have access to this.' });
  }
  if (!rule.anyTurn && bid.turn !== bid.mySide) {
    return json(res, 409, { error: 'It is not your turn on this offer.', status: bid.status });
  }
  const openCodes = lk.bidStatuses.filter(s => s.is_open).map(s => s.code);
  if (!openCodes.includes(bid.status)) {
    const label = bid.status === 'expired' ? 'That offer has expired.'
      : `That offer is ${(lk.bidStatus(bid.status)?.label || bid.status).toLowerCase()} and cannot be changed.`;
    return json(res, 409, { error: label, status: bid.status });
  }

  let toPrice = bid.unit_price;
  if (rule.needsPrice) {
    if (d.unitPrice == null || String(d.unitPrice).trim() === '') {
      return json(res, 400, { error: 'Name the price you are countering with.' });
    }
    const n = Number(d.unitPrice);
    if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: 'Enter a valid price.' });
    toPrice = String(d.unitPrice);
  }

  const toStatus = rule.to;
  const nextTurn = bid.mySide === 'customer' ? 'owner' : 'customer';

  const [updated] = await db.query(
    `UPDATE mb_bids SET status = $1, unit_price = $2, turn = $3, updated_at = now()
      WHERE id = $4 AND status = $5 RETURNING *`,
    [toStatus, toPrice, action === 'counter' ? nextTurn : bid.turn, bid.id, bid.status]);
  if (!updated) {
    return json(res, 409, { error: 'That offer just changed. Reload and try again.', status: bid.status });
  }
  await db.query(
    `INSERT INTO mb_bid_moves (bid_id, actor_id, action, from_status, to_status, from_price, to_price, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [bid.id, account.id, action, bid.status, toStatus, bid.unit_price, toPrice,
     str(d.note).slice(0, 300) || null]);

  const recipient = bid.mySide === 'customer' ? bid.owner_id : bid.customer_id;
  await notify(db, recipient, 'bid', `Your offer on ${bid.product_name} was ${rule.label}`,
    { body: toPrice != null ? formatInr(toPaise(toPrice)) : null, link: `#/bids/${bid.id}` });

  // --- accepting produces an order, at the agreed price (FR-24.8) -----------
  //
  // The order is priced from the bid's agreed figure, not the listing's current price — a bid is a
  // promise about a specific number, and the listing may have moved since (D-26, extended to bids).
  // Whoever accepts, the order still ships to the customer, so the delivery address is read from
  // this request exactly as a direct 'place' order's is — readAddress() is the one place that
  // validates an address, used by both paths.
  if (action === 'accept') {
    if (bid.unit_price == null) {
      return json(res, 409, { error: 'There is no price on this offer yet to accept.' });
    }
    const [product] = await db.query('SELECT * FROM mb_products WHERE id = $1', [bid.product_id]);
    const [customerRow] = await db.query(
      'SELECT full_name, phone FROM mb_users WHERE id = $1', [bid.customer_id]);

    const address = readAddress(d, { full_name: customerRow?.full_name, phone: customerRow?.phone }, lk);
    if (address.error) return json(res, 400, { error: address.error });

    const unitExcl = toPaise(bid.unit_price);
    const lineExcl = Math.round(unitExcl * Number(bid.qty));
    const gstRate = Number(product.gst_rate) || 0;
    const lineTax = gstOn(lineExcl, gstRate) || 0;
    const line = { unitExcl, lineExcl, gstRate, lineTax, lineTotal: lineExcl + lineTax };

    const order = await insertOrder(db, {
      account: { id: bid.customer_id },
      ownerId: bid.owner_id, lines: [{ product, qty: Number(bid.qty), line }],
      stateCode: address.stateCode, address: address.value, bidId: bid.id,
    });
    await db.query(
      `UPDATE mb_bids SET status = 'ordered', order_id = (SELECT id FROM mb_orders WHERE reference = $2)
        WHERE id = $1`, [bid.id, order.reference]);
    return json(res, 200, { bid: publicBid({ ...updated, mySide: bid.mySide, status: 'ordered' }, lk), order });
  }

  return json(res, 200, { bid: publicBid({ ...updated, mySide: bid.mySide }, lk) });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus bids failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
