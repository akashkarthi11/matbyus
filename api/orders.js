// matbyus — orders. First slice of FSD Phase 2 FR-25/FR-26.
//
//   GET  /api/orders                 -> { orders: [...] }    the caller's own orders
//   GET  /api/orders?reference=ABC   -> { order: {...} }      one of their own
//   GET  /api/orders?quote=<slug>&qty=2 -> { quote }          what it would cost, priced by the server
//   POST /api/orders?action=place    -> 201 { order }
//   POST /api/orders?action=cancel   -> 200 { order }         only while 'placed'
//   POST /api/orders?action=collect  -> 200 { order }         by scanning the seller's QR
//   POST /api/orders?action=checkout -> 201 { orders, errors } the basket, split one order per owner
//
// The price is never taken from the request. The client may say what it last displayed and gets a
// 409 with the real figures if that has moved, but the number written to the order always comes
// from the database (TSD Phase 2 D-26).

import { json, body, fail, sessionAccount, randomCode, sha256 } from './_lib.js';
import { notify } from './_notify.js';
import { db as defaultDb } from './_db.js';
import { isApprovedBusiness } from './_roles.js';
import { toPaise, fromPaise, gstOn, normalisePincode, normaliseMobile, formatInr } from './_india.js';
import { lookups } from './_lookups.js';

// D-30: the alphabet lives in _lib.js, because the handover code needs the same property —
// read-aloud safe, no look-alikes — and two alphabets would eventually differ.
export function orderCode() {
  const s = randomCode(8);
  return 'MB-' + s.slice(0, 4) + '-' + s.slice(4);
}

// What a scanned QR carries: MB1:<order reference>:<handover code>. The reference is in it so a
// scan can be matched to an order even when the scanner was opened from somewhere else; the code is
// the part that proves anything.
const SCAN = /^MB1:([A-Za-z0-9-]+):([A-Za-z0-9]+)$/;

// FR-26. Returns paise. The halves come from the already-rounded total so CGST + SGST is exactly
// the tax and the database constraint can hold; the odd paisa lands on SGST, which is arbitrary but
// fixed, and pinned by a test.
export function splitTax(taxPaise, sellerState, placeOfSupply) {
  if (!sellerState) return { split: 'unsplit', cgst: 0, sgst: 0, igst: 0 };
  if (sellerState === placeOfSupply) {
    const cgst = Math.round(taxPaise / 2);
    return { split: 'cgst_sgst', cgst, sgst: taxPaise - cgst, igst: 0 };
  }
  return { split: 'igst', cgst: 0, sgst: 0, igst: taxPaise };
}

// The one place a line is priced. Used by the quote and by placement, so the two cannot disagree.
export function priceLine(product, qty, businessView) {
  const unit = businessView && product.price_business != null
    ? toPaise(product.price_business)
    : toPaise(product.price_retail);
  if (unit == null) throw fail(400, 'That item is quote-only. Ask the seller for a price first.');
  const lineExcl = Math.round(unit * qty);
  const lineTax = gstOn(lineExcl, product.gst_rate) || 0;
  return {
    unitExcl: unit, lineExcl, lineTax, lineTotal: lineExcl + lineTax,
    gstRate: Number(product.gst_rate) || 0,
  };
}

// One order, for one owner, for one customer: the atomic unit both the single-item 'place' path
// and the multi-owner 'checkout' path build on (FSD Phase 2 FR-25.2: a basket splits into one
// order per owner). `lines` is [{ product, qty, line }], already priced by priceLine() — never
// re-priced here, so there is exactly one place in the codebase that turns a product and a
// quantity into money.
export async function insertOrder(db, { account, ownerId, lines, stateCode, address, bidId = null }) {
  const sellerState = sellerStateFor(lines[0].product);
  const taxTotal = lines.reduce((n, l) => n + l.line.lineTax, 0);
  const subtotal = lines.reduce((n, l) => n + l.line.lineExcl, 0);
  const total = lines.reduce((n, l) => n + l.line.lineTotal, 0);
  const tax = splitTax(taxTotal, sellerState, stateCode);

  let order = null;
  for (let attempt = 0; attempt < 5 && !order; attempt++) {
    try {
      [order] = await db.query(
        `INSERT INTO mb_orders (
           reference, customer_id, owner_id, bid_id, seller_state_code, place_of_supply_state,
           ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_pincode, ship_note,
           subtotal_excl, cgst, sgst, igst, tax_total, total, tax_split)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [orderCode(), account.id, ownerId, bidId, sellerState, stateCode,
         address.name, address.phone, address.line1, address.line2, address.city, address.pincode,
         address.note,
         fromPaise(subtotal), fromPaise(tax.cgst), fromPaise(tax.sgst), fromPaise(tax.igst),
         fromPaise(taxTotal), fromPaise(total), tax.split]);
    } catch (e) {
      if (!/mb_orders_reference_key/.test(String(e?.message || ''))) throw e;
    }
  }
  if (!order) throw fail(500, 'Could not allocate an order number. Please try again.');

  for (const { product, qty, line } of lines) {
    await db.query(
      `INSERT INTO mb_order_items (
         order_id, product_id, name, sku, unit, hsn_sac, qty,
         unit_price_excl, gst_rate, line_excl, line_tax, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [order.id, product.id, product.name, product.sku, product.unit, product.hsn_sac, String(qty),
       fromPaise(line.unitExcl), String(line.gstRate),
       fromPaise(line.lineExcl), fromPaise(line.lineTax), fromPaise(line.lineTotal)]);
  }

  // FR-28.1: placing an order notifies the owner. A house listing has no owner — notify() treats
  // that as "nobody to tell" rather than an error (api/_notify.js).
  await notify(db, ownerId, 'order_placed',
    `New order ${order.reference}`,
    { body: formatInr(toPaise(order.total)), link: `#/storeorders` });

  // publicOrder() reads owner_name off the row; a plain INSERT...RETURNING * does not have it
  // joined, so this order would otherwise report "Sold by" as nothing on the response to the very
  // call that created it (every other read of an order already joins it — see 'orders' GET below).
  if (ownerId) {
    const [owner] = await db.query('SELECT full_name FROM mb_users WHERE id = $1', [ownerId]);
    order.owner_name = owner?.full_name || null;
  }
  const items = await db.query('SELECT * FROM mb_order_items WHERE order_id = $1', [order.id]);
  return publicOrder(order, items);
}

const publicOrder = (o, items) => ({
  reference: o.reference,
  status: o.status,
  placedAt: o.placed_at,
  shipTo: {
    name: o.ship_name, phone: o.ship_phone, line1: o.ship_line1, line2: o.ship_line2,
    city: o.ship_city, pincode: o.ship_pincode, state: o.place_of_supply_state, note: o.ship_note,
  },
  soldBy: o.owner_name || null,
  collection: o.collected_at
    ? { at: o.collected_at, method: o.collection_method }
    : null,
  subtotalExcl: o.subtotal_excl, taxTotal: o.tax_total, total: o.total,
  taxSplit: o.tax_split, cgst: o.cgst, sgst: o.sgst, igst: o.igst,
  totalLabel: formatInr(toPaise(o.total)),
  cancelReason: o.cancel_reason,
  items: (items || []).map(i => ({
    name: i.name, sku: i.sku, unit: i.unit, hsnSac: i.hsn_sac, qty: Number(i.qty),
    unitPriceExcl: i.unit_price_excl, gstRate: Number(i.gst_rate),
    lineExcl: i.line_excl, lineTax: i.line_tax, lineTotal: i.line_total,
    lineTotalLabel: formatInr(toPaise(i.line_total)),
  })),
});

export async function loadProduct(db, slug) {
  const [p] = await db.query(
    `SELECT p.*, c.name AS category_name,
            ow.full_name AS owner_name, ob.state_code AS owner_state
       FROM mb_products p
       JOIN mb_categories c ON c.id = p.category_id
       LEFT JOIN mb_users ow ON ow.id = p.owner_id
       LEFT JOIN mb_business_profiles ob ON ob.user_id = p.owner_id
      WHERE p.slug = $1 AND p.is_active`, [slug]);
  if (!p) throw fail(404, 'That product was not found.');
  return p;
}

// Whose state decides CGST+SGST against IGST. With owners, that is the owner's own registered
// state, not one setting for the whole platform — two owners in different states selling the same
// cement to the same customer are two different places of supply. MB_SELLER_STATE_CODE remains the
// answer for a house listing, which has no owner. When neither is known the tax is still charged
// and still correct; it is recorded as 'unsplit' rather than guessed at (migration 0001).
export function sellerStateFor(product) {
  return product.owner_state || process.env.MB_SELLER_STATE_CODE || null;
}

function readQty(raw, product) {
  const qty = Number(raw);
  if (!Number.isFinite(qty) || qty <= 0) throw fail(400, 'Enter how many you want.');
  const min = Number(product.min_order_qty) || 1;
  if (qty < min) throw fail(400, `The minimum order for this item is ${min} ${product.unit}.`);
  if (qty > 1_000_000) throw fail(400, 'That quantity is too large. Contact the store directly.');
  return qty;
}

// The delivery address, read once and shared by both 'place' and 'checkout' — a basket spanning
// owners still ships to one address, chosen once at checkout (FSD Phase 2 FR-25.2 reads "one
// checkout"). Returns { error } or { value, stateCode }.
export function readAddress(d, account, lk) {
  const name = String(d.name || '').trim() || account.full_name;
  if (!name) return { error: 'A delivery name is required.' };
  const phone = normaliseMobile(d.phone || account.phone);
  if (!phone) return { error: 'Enter a valid 10-digit Indian mobile number.' };
  const line1 = String(d.line1 || '').trim();
  if (!line1) return { error: 'A delivery address is required.' };
  const city = String(d.city || '').trim();
  if (!city) return { error: 'City is required.' };
  const pincode = normalisePincode(d.pincode);
  if (!pincode) return { error: 'Enter a valid 6-digit PIN code.' };
  const stateCode = String(d.stateCode || '').trim();
  if (!lk.validStateCode(stateCode)) return { error: 'Choose a delivery state.' };
  return {
    stateCode,
    value: {
      name, phone, line1, city, pincode,
      line2: String(d.line2 || '').trim() || null,
      note: String(d.note || '').slice(0, 500) || null,
    },
  };
}

export async function handle(req, res, db) {
  const q = new URL(req.url, 'https://local').searchParams;
  const lk = await lookups(db);
  const account = await sessionAccount(req, db);
  const businessView = isApprovedBusiness(account);

  // --- a quote: what would this cost? Open to anyone, so the price is visible before signing in.
  if (req.method === 'GET' && q.get('quote')) {
    const product = await loadProduct(db, q.get('quote'));
    const qty = readQty(q.get('qty') || product.min_order_qty, product);
    const line = priceLine(product, qty, businessView);
    const sellerState = sellerStateFor(product);
    return json(res, 200, {
      quote: {
        slug: product.slug, name: product.name, unit: product.unit,
        categoryName: product.category_name, minOrderQty: Number(product.min_order_qty),
        qty, businessPricing: businessView,
        soldBy: product.owner_name || null,
        unitExcl: fromPaise(line.unitExcl), unitExclLabel: formatInr(line.unitExcl),
        gstRate: line.gstRate,
        subtotalExcl: fromPaise(line.lineExcl), subtotalExclLabel: formatInr(line.lineExcl),
        taxTotal: fromPaise(line.lineTax), taxTotalLabel: formatInr(line.lineTax),
        total: fromPaise(line.lineTotal), totalLabel: formatInr(line.lineTotal),
        sellerStateKnown: !!sellerState,
      },
    });
  }

  if (!account) {
    return json(res, 401, {
      error: req.method === 'POST'
        ? 'Please sign in to place this order.'
        : 'Please sign in to see your orders.',
    });
  }

  // --- the caller's own orders. Scoped in the query, never filtered afterwards (NFR-20).
  if (req.method === 'GET') {
    const reference = q.get('reference');
    if (reference) {
      const [o] = await db.query(
        `SELECT o.*, ow.full_name AS owner_name
           FROM mb_orders o LEFT JOIN mb_users ow ON ow.id = o.owner_id
          WHERE o.reference = $1 AND o.customer_id = $2`, [reference, account.id]);
      // 404 rather than 403: a 403 would confirm the order exists (NFR-21).
      if (!o) return json(res, 404, { error: 'That order was not found.' });
      const items = await db.query('SELECT * FROM mb_order_items WHERE order_id = $1', [o.id]);
      return json(res, 200, { order: publicOrder(o, items) });
    }
    const rows = await db.query(
      `SELECT o.*, ow.full_name AS owner_name,
              (SELECT count(*)::int FROM mb_order_items i WHERE i.order_id = o.id) AS n
         FROM mb_orders o LEFT JOIN mb_users ow ON ow.id = o.owner_id
        WHERE o.customer_id = $1 ORDER BY o.placed_at DESC LIMIT 100`, [account.id]);
    return json(res, 200, {
      orders: rows.map(o => ({
        reference: o.reference, status: o.status, placedAt: o.placed_at, soldBy: o.owner_name || null,
        total: o.total, totalLabel: formatInr(toPaise(o.total)), lines: o.n,
      })),
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const d = await body(req);
  const action = q.get('action');

  // --- cancel, only while nobody has acted on it (FR-25.5)
  if (action === 'cancel') {
    // Which states a customer may withdraw from is a row in mb_order_transitions, not a literal
    // here: the seller's moves and the customer's come from the same table (migration 0005).
    const move = lk.move('customer', 'cancel');
    if (!move) return json(res, 400, { error: 'Orders cannot be cancelled here.' });
    const froms = move.from.map((_, i) => '$' + (i + 4)).join(',');
    const to = '$' + (move.from.length + 4);
    const [o] = await db.query(
      `UPDATE mb_orders SET status = ${to}, cancelled_at = now(), updated_at = now(),
              cancel_reason = $3
         WHERE reference = $1 AND customer_id = $2 AND status IN (${froms})
       RETURNING *`,
      [String(d.reference || ''), account.id, String(d.reason || '').slice(0, 300) || null,
       ...move.from, move.to]);
    if (!o) {
      const [exists] = await db.query(
        'SELECT status FROM mb_orders WHERE reference = $1 AND customer_id = $2',
        [String(d.reference || ''), account.id]);
      if (!exists) return json(res, 404, { error: 'That order was not found.' });
      const label = (lk.status(exists.status)?.label || exists.status).toLowerCase();
      return json(res, 409, { error: `That order is already ${label} and cannot be cancelled here.` });
    }
    return json(res, 200, { order: publicOrder(o, []) });
  }

  // --- confirming a collection by scanning the seller's code (FR-29.9) -----
  //
  // This is the half of the handover that proves something. A seller marking an order collected is
  // the seller's word, recorded as 'manual'; a customer scanning the code on the seller's screen is
  // evidence the customer was standing there, and is recorded as 'scan'. Keeping them apart is the
  // whole point of having the second path at all.
  if (action === 'collect') {
    const move = lk.move('customer', 'collect');
    if (!move) return json(res, 503, { error: 'Scanning to confirm is not enabled.' });

    const raw = String(d.token || '').trim();
    const scanned = SCAN.exec(raw);
    const token = (scanned ? scanned[2] : raw).toUpperCase();
    const scannedRef = scanned ? scanned[1].toUpperCase() : null;
    const asked = String(d.reference || '').trim().toUpperCase();
    if (scannedRef && asked && scannedRef !== asked) {
      return json(res, 409, {
        error: `That code belongs to order ${scannedRef}, not ${asked}.`,
      });
    }
    const reference = asked || scannedRef || '';
    if (!reference || !token) {
      return json(res, 400, { error: 'Scan the code on the seller\'s screen, or type it in.' });
    }

    // One statement, so claiming the code and moving the order cannot come apart. A second scan of
    // the same code — a double tap, a replay, a second phone — finds nothing left to claim.
    const froms = move.from.map((_, i) => '$' + (i + 4)).join(',');
    const to = '$' + (move.from.length + 4);
    const [order] = await db.query(
      `WITH claimed AS (
         UPDATE mb_order_handover_tokens t
            SET used_at = now(), used_by = $2
           FROM mb_orders ord
          WHERE t.order_id = ord.id
            AND ord.reference = $1 AND ord.customer_id = $2
            AND t.token_hash = $3 AND t.used_at IS NULL AND t.expires_at > now()
          RETURNING t.order_id
       )
       UPDATE mb_orders o
          SET status = ${to}, collected_at = now(), collection_method = 'scan',
              collected_by = $2, updated_at = now()
         FROM claimed
        WHERE o.id = claimed.order_id AND o.status IN (${froms})
       RETURNING o.*`,
      [reference, account.id, sha256(token), ...move.from, move.to]);

    if (!order) {
      const [exists] = await db.query(
        'SELECT status FROM mb_orders WHERE reference = $1 AND customer_id = $2',
        [reference, account.id]);
      // 404 rather than 403: somebody else's order does not exist as far as this caller is told.
      if (!exists) return json(res, 404, { error: 'That order was not found.' });
      if (!move.from.includes(exists.status)) {
        const now = (lk.status(exists.status)?.label || exists.status).toLowerCase();
        return json(res, 409, {
          error: `That order is ${now}. There is nothing to confirm.`, status: exists.status,
        });
      }
      return json(res, 409, {
        error: 'That code has expired or has already been used. Ask the seller to show a new one.',
      });
    }

    const items = await db.query('SELECT * FROM mb_order_items WHERE order_id = $1', [order.id]);
    return json(res, 200, {
      order: publicOrder(order, items),
      message: 'Collection confirmed. Thank you.',
    });
  }

  // --- a basket spanning owners, split one order per owner (FR-25.1, FR-25.2) --
  //
  // Each owner's lines become one order, priced and inserted independently. If one owner's lines
  // are refused — out of stock, a suspended account, a stale price — that owner's lines are named
  // in `errors` and every other owner's order still goes through (FSD Phase 2 §8: "That owner's
  // lines are refused by name; the rest proceed"). There is no cross-owner transaction: the per-
  // order write is the atomic unit, matching the single-item path above, which was never wrapped
  // in one either.
  if (action === 'checkout') {
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) return json(res, 400, { error: 'Your basket is empty.' });

    const address = readAddress(d, account, lk);
    if (address.error) return json(res, 400, { error: address.error });

    const grouped = new Map();     // owner_id, or '' for the house -> [{ product, qty, line }]
    const errors = [];
    for (const it of items) {
      if (!it?.slug) continue;
      try {
        const product = await loadProduct(db, String(it.slug || ''));
        if (product.stock_status === 'out_of_stock') {
          errors.push({ slug: it.slug, error: 'That item is out of stock.' });
          continue;
        }
        const qty = readQty(it.qty, product);
        const line = priceLine(product, qty, businessView);
        if (it.expectTotal != null && toPaise(it.expectTotal) !== line.lineTotal) {
          errors.push({
            slug: it.slug,
            error: 'The price changed since this was added. Remove and re-add it to confirm.',
            total: fromPaise(line.lineTotal), totalLabel: formatInr(line.lineTotal),
          });
          continue;
        }
        const ownerKey = product.owner_id || '';
        if (!grouped.has(ownerKey)) grouped.set(ownerKey, []);
        grouped.get(ownerKey).push({ product, qty, line });
      } catch (e) {
        if (e?.status) { errors.push({ slug: it.slug, error: e.message }); continue; }
        throw e;
      }
    }

    const orders = [];
    for (const [ownerKey, lines] of grouped) {
      try {
        const order = await insertOrder(db, {
          account, ownerId: ownerKey || null, lines, stateCode: address.stateCode, address: address.value,
        });
        orders.push(order);
      } catch (e) {
        if (!e?.status) throw e;
        for (const l of lines) errors.push({ slug: l.product.slug, error: e.message });
      }
    }

    if (!orders.length) return json(res, 409, { error: 'Nothing could be ordered.', errors });
    return json(res, 201, { orders, errors });
  }

  if (action !== 'place') return json(res, 400, { error: 'Unknown action.' });

  // --- place: one item, one owner (the original, single-item path) ---------
  const product = await loadProduct(db, String(d.slug || ''));
  if (product.stock_status === 'out_of_stock') {
    return json(res, 409, { error: 'That item is out of stock.' });
  }
  const qty = readQty(d.qty, product);

  const address = readAddress(d, account, lk);
  if (address.error) return json(res, 400, { error: address.error });

  const line = priceLine(product, qty, businessView);

  // D-26: the client may tell us what it displayed; it may not tell us what to charge. If the
  // figure has moved since the page was drawn, nothing is placed and the customer re-confirms.
  if (d.expectTotal != null && toPaise(d.expectTotal) !== line.lineTotal) {
    return json(res, 409, {
      error: 'The price changed while you were ordering. Please check the new total and confirm.',
      total: fromPaise(line.lineTotal), totalLabel: formatInr(line.lineTotal),
    });
  }

  const order = await insertOrder(db, {
    account, ownerId: product.owner_id || null, lines: [{ product, qty, line }],
    stateCode: address.stateCode, address: address.value,
  });
  return json(res, 201, { order });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus orders failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
