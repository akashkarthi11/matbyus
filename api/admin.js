// matbyus — the seller and platform module. TSD section 5. Implements FR-7, FR-8, FR-25, FR-31.
//
// Two roles come through here and they are not the same caller:
//
//   owner  — a seller. Sees their own listings and the orders placed with them, and nothing else.
//   admin  — the platform. Sees across every owner, approves them, and runs the catalogue.
//
//   GET  /api/admin?resource=orders|products                 owner: own rows · admin: all rows
//   GET  /api/admin?resource=categories                      owner: read only
//   GET  /api/admin?resource=customers|customer|approvals    admin only
//   GET  /api/admin?resource=owners|permissions              admin only
//   POST /api/admin?resource=products&action=create|update|activate|deactivate
//   POST /api/admin?resource=orders&action=confirm|dispatch|collect|cancel
//   POST /api/admin?resource=orders&action=handover-token         the code behind the QR
//   POST /api/admin?resource=categories&action=create|activate|deactivate          admin only
//   POST /api/admin?resource=customers&action=approve|reject                       admin only
//   POST /api/admin?resource=owners&action=approve|reject|grant-admin|revoke-admin admin only
//
// FR-5.4: every path below is behind requireSeller() and then the READ/WRITE table, both of which
// run before a body is read. An owner's narrowing is `mine`, and it goes into the SQL rather than
// being applied to the results — there is no unscoped query for an owner to fall into. Menu
// visibility is presentation; this is the control.

import { json, body, fail, sessionAccount, randomCode, sha256 } from './_lib.js';
import { db as defaultDb } from './_db.js';
import {
  requireSeller, requireRole, ownerScope, roleMenuOverview, setRoleMenus,
} from './_roles.js';
import { toPaise, formatInr, formatMobile } from './_india.js';
import { lookups } from './_lookups.js';
import { notify } from './_notify.js';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const str = v => (v == null ? null : String(v).trim() || null);

// --- product validation (FR-8) ---------------------------------------------

function readProduct(d, { partial = false, lk }) {
  const out = {};
  const need = k => { if (!partial && (d[k] == null || String(d[k]).trim() === '')) throw fail(400, `${k} is required.`); };

  for (const k of ['sku', 'slug', 'name', 'kind', 'unit']) need(k);

  if (d.kind != null) {
    const kinds = (lk.lookup.product_kind || []).map(x => x.code);
    if (!kinds.includes(d.kind)) throw fail(400, `Kind must be ${kinds.join(' or ')}.`);
    out.kind = d.kind;
  }
  if (d.slug != null) {
    if (!SLUG.test(String(d.slug))) throw fail(400, 'Slug may use lower-case letters, numbers and hyphens only.');
    out.slug = String(d.slug);
  }
  for (const k of ['sku', 'name', 'summary', 'description', 'hsn_sac']) {
    if (d[k] != null) out[k] = str(d[k]);
  }
  if (d.unit != null) {
    if (!lk.unit(d.unit)) {
      throw fail(400, `Unknown unit. Use one of: ${lk.unitCodes.join(', ')}.`);
    }
    out.unit = d.unit;
  }
  if (d.pricing_mode != null) {
    if (d.pricing_mode !== 'fixed' && d.pricing_mode !== 'quote') throw fail(400, 'Pricing mode must be fixed or quote.');
    out.pricing_mode = d.pricing_mode;
  }
  for (const k of ['price_retail', 'price_business']) {
    if (d[k] === null || d[k] === '') { out[k] = null; continue; }
    if (d[k] != null) {
      if (!MONEY.test(String(d[k]))) throw fail(400, `${k} must be an amount with at most two decimals.`);
      out[k] = String(d[k]);
    }
  }
  if (d.gst_rate != null) {
    const r = Number(d.gst_rate);
    if (!Number.isFinite(r) || r < 0 || r > 100) throw fail(400, 'GST rate must be between 0 and 100.');
    out.gst_rate = String(d.gst_rate);
  }
  for (const k of ['pack_size', 'stock_qty', 'min_order_qty']) {
    if (d[k] === null || d[k] === '') { out[k] = null; continue; }
    if (d[k] != null) {
      const n = Number(d[k]);
      if (!Number.isFinite(n) || n < 0) throw fail(400, `${k} must be a number of zero or more.`);
      out[k] = String(d[k]);
    }
  }
  if (d.stock_status != null) {
    const ok = (lk.lookup.stock_status || []).map(x => x.code);
    if (!ok.includes(d.stock_status)) throw fail(400, `Stock status must be one of: ${ok.join(', ')}.`);
    out.stock_status = d.stock_status;
  }
  if (d.category_id != null) out.category_id = String(d.category_id);
  return out;
}

// The checks the database cannot express across a partial update: a field being absent from the
// patch means "leave it", so validity has to be judged on the merged row.
function assertCoherent(p, lk) {
  if (p.kind && p.unit && !lk.unitAllowedFor(p.unit, p.kind)) {
    throw fail(400, `A ${p.kind} cannot be sold per ${lk.unit(p.unit)?.label || p.unit}.`);
  }
  if (p.pricing_mode === 'fixed' && p.price_retail == null) {
    throw fail(400, 'A fixed-price product needs a retail price.');
  }
  if (p.pricing_mode === 'quote' && (p.price_retail != null || p.price_business != null)) {
    throw fail(400, 'A quote-priced product cannot carry a price.');
  }
  if (p.kind === 'service' && (p.stock_qty != null || p.pack_size != null)) {
    throw fail(400, 'A service does not carry stock or a pack size.');
  }
  if (p.price_retail != null && p.price_business != null &&
      toPaise(p.price_business) > toPaise(p.price_retail)) {
    throw fail(400, 'The business price is higher than the retail price. Check the figures.');
  }
}

// `mine` is null for an admin and the owner's id for an owner, so one query serves both. Another
// owner's listing is a 404 and not a 403: a 403 would confirm it exists (NFR-21).
async function mergedProduct(db, id, patch, mine) {
  const [current] = await db.query(
    'SELECT * FROM mb_products WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2)', [id, mine]);
  if (!current) throw fail(404, 'That product was not found.');
  return { ...current, ...patch };
}

// --- handler ----------------------------------------------------------------

// Which roles may read a resource, and separately which may change it. An owner reaches the seller
// screens; `mine` narrows what comes back. Keeping reads and writes apart is what lets an owner
// file a listing under a category without being able to rename it.
const READ = {
  orders: ['admin', 'owner'],
  products: ['admin', 'owner'],
  categories: ['admin', 'owner'],
  customers: ['admin'],
  customer: ['admin'],
  approvals: ['admin'],
  owners: ['admin'],
  permissions: ['admin'],
};
const WRITE = { ...READ, categories: ['admin'] };

export async function handle(req, res, db) {
  const lk = await lookups(db);
  const account = await sessionAccount(req, db);
  // FR-5.3, before any body or query is acted on. A visitor or a customer is refused here and
  // learns nothing about which resources exist.
  requireSeller(account);

  const q = new URL(req.url, 'https://local').searchParams;
  const resource = q.get('resource');
  const action = q.get('action');

  const allowed = (req.method === 'GET' ? READ : WRITE)[resource];
  if (!allowed) return json(res, 400, { error: 'Unknown resource.' });
  requireRole(account, allowed);

  // The whole difference between the two seller roles: an owner is narrowed to their own id, an
  // admin is not narrowed at all.
  const mine = ownerScope(account);

  if (req.method === 'GET') {
    if (resource === 'customers') {
      const where = [], params = [];
      const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
      if (q.get('accountType')) add('account_type = ?', q.get('accountType'));
      if (q.get('businessStatus')) add('business_status = ?', q.get('businessStatus'));
      if (q.get('q')) {
        params.push('%' + q.get('q') + '%');
        where.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length})`);
      }
      const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const rows = await db.query(
        `SELECT id, email, full_name, phone, role, account_type, business_status, created_at
           FROM mb_users${filter} ORDER BY created_at DESC LIMIT 200`, params);
      return json(res, 200, {
        customers: rows.map(r => ({
          id: r.id, email: r.email, fullName: r.full_name, phone: formatMobile(r.phone),
          role: r.role, accountType: r.account_type, businessStatus: r.business_status,
          createdAt: r.created_at,
        })),
      });
    }

    if (resource === 'approvals') {
      const rows = await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, b.legal_name, b.gstin, b.pan, b.state_code,
                b.city, b.pincode, b.submitted_at
           FROM mb_users u JOIN mb_business_profiles b ON b.user_id = u.id
          WHERE u.business_status = 'pending' ORDER BY b.submitted_at`);
      return json(res, 200, {
        approvals: rows.map(r => ({
          id: r.id, email: r.email, fullName: r.full_name, phone: formatMobile(r.phone),
          legalName: r.legal_name, gstin: r.gstin, pan: r.pan,
          stateCode: r.state_code, stateName: lk.stateName(r.state_code),
          city: r.city, pincode: r.pincode, submittedAt: r.submitted_at,
        })),
      });
    }

    if (resource === 'customer') {
      const id = q.get('id');
      const [u] = await db.query(
        `SELECT id, email, full_name, phone, role, account_type, business_status, created_at
           FROM mb_users WHERE id = $1`, [id]);
      if (!u) return json(res, 404, { error: 'That customer was not found.' });
      const [profile] = await db.query('SELECT * FROM mb_business_profiles WHERE user_id = $1', [id]);
      const history = await db.query(
        `SELECT from_status, to_status, note, actor_id, created_at
           FROM mb_business_status_log WHERE user_id = $1 ORDER BY created_at DESC`, [id]);
      return json(res, 200, {
        customer: {
          id: u.id, email: u.email, fullName: u.full_name, phone: formatMobile(u.phone),
          role: u.role, accountType: u.account_type, businessStatus: u.business_status,
          createdAt: u.created_at,
        },
        business: profile ? { ...profile, stateName: lk.stateName(profile.state_code) } : null,
        history,
      });
    }

    if (resource === 'products') {
      const rows = await db.query(
        `SELECT p.*, c.slug AS category_slug, c.name AS category_name,
                ow.full_name AS owner_name, ow.email AS owner_email
           FROM mb_products p
           JOIN mb_categories c ON c.id = p.category_id
           LEFT JOIN mb_users ow ON ow.id = p.owner_id
          WHERE ($1::uuid IS NULL OR p.owner_id = $1)
          ORDER BY p.name LIMIT 500`, [mine]);
      return json(res, 200, { products: rows, scope: mine ? 'own' : 'all' });
    }

    if (resource === 'categories') {
      const rows = await db.query('SELECT * FROM mb_categories ORDER BY kind, sort_order, name');
      return json(res, 200, { categories: rows });
    }

    // --- orders received (FR-25.6) ------------------------------------------
    // Today the store is the only seller, so an admin sees every order. When owners arrive this
    // same screen gains `AND o.owner_id = $n` and the query is the only thing that changes.
    if (resource === 'orders') {
      const where = [], params = [];
      // The narrowing goes in first so it cannot be dropped by a later filter being absent.
      if (mine) { params.push(mine); where.push('o.owner_id = $' + params.length); }
      const status = q.get('status');
      if (status) {
        if (!lk.statusCodes.includes(status)) return json(res, 400, { error: 'Unknown status.' });
        params.push(status);
        where.push('o.status = $' + params.length);
      }
      if (q.get('q')) {
        params.push('%' + q.get('q').trim() + '%');
        where.push(`(o.reference ILIKE $${params.length} OR u.email ILIKE $${params.length}
                     OR o.ship_name ILIKE $${params.length} OR o.ship_phone ILIKE $${params.length})`);
      }
      const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const rows = await db.query(
        `SELECT o.*, u.email AS customer_email, u.full_name AS customer_name,
                u.account_type, u.business_status,
                ow.full_name AS owner_name, ow.email AS owner_email,
                (SELECT count(*)::int FROM mb_order_items i WHERE i.order_id = o.id) AS lines,
                (SELECT string_agg(i.name || ' × ' || trim(trailing '.' from trim(trailing '0' from i.qty::text)), ', ')
                   FROM mb_order_items i WHERE i.order_id = o.id) AS summary
           FROM mb_orders o
           JOIN mb_users u ON u.id = o.customer_id
           LEFT JOIN mb_users ow ON ow.id = o.owner_id
           ${filter}
          ORDER BY o.placed_at DESC LIMIT 200`, params);

      // One count per status in mb_order_statuses, built from the table rather than listed here,
      // so a new status appears on the filter chips without touching this file. The status values
      // are bound as parameters, not interpolated, even though they are our own rows.
      const codes = lk.statusCodes;
      const [tally] = await db.query(
        `SELECT ${codes.map((_, i) => `count(*) FILTER (WHERE status = $${i + 2})::int AS c${i}`).join(',\n                ')}
           FROM mb_orders WHERE ($1::uuid IS NULL OR owner_id = $1)`, [mine, ...codes]);
      const counts = Object.fromEntries(codes.map((code, i) => [code, tally[`c${i}`]]));

      return json(res, 200, {
        counts,
        scope: mine ? 'own' : 'all',
        orders: rows.map(o => ({
          reference: o.reference, status: o.status, placedAt: o.placed_at,
          total: o.total, totalLabel: formatInr(toPaise(o.total)),
          taxTotal: o.tax_total, taxSplit: o.tax_split,
          lines: o.lines, summary: o.summary,
          customer: {
            email: o.customer_email, name: o.customer_name,
            accountType: o.account_type, businessStatus: o.business_status,
          },
          shipTo: {
            name: o.ship_name, phone: formatMobile(o.ship_phone),
            line1: o.ship_line1, line2: o.ship_line2, city: o.ship_city,
            pincode: o.ship_pincode, state: lk.stateName(o.place_of_supply_state), note: o.ship_note,
          },
          // Who is selling it. Null is the house: a listing made before owners existed, or one an
          // admin lists directly. An owner only ever sees their own rows, so this is for the admin.
          seller: o.owner_id ? { name: o.owner_name, email: o.owner_email } : null,
          collection: o.collected_at
            ? { at: o.collected_at, method: o.collection_method }
            : null,
          cancelReason: o.cancel_reason,
        })),
      });
    }

    // --- the owners on the platform, and who is asking to join (FR-31) ------
    // Admin only, and it is the one screen that reads across owners. An owner asking for this gets
    // a 403 from the READ table above, not a filtered version of it.
    if (resource === 'owners') {
      const rows = await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.owner_status, u.created_at,
                b.legal_name, b.gstin, b.state_code, b.city,
                (SELECT count(*)::int FROM mb_products p WHERE p.owner_id = u.id) AS listings,
                (SELECT count(*)::int FROM mb_products p
                  WHERE p.owner_id = u.id AND p.is_active) AS live,
                (SELECT count(*)::int FROM mb_orders o
                  WHERE o.owner_id = u.id AND o.status <> 'cancelled') AS orders,
                (SELECT COALESCE(sum(o.total), 0) FROM mb_orders o
                  WHERE o.owner_id = u.id AND o.status <> 'cancelled') AS sold
           FROM mb_users u
           LEFT JOIN mb_business_profiles b ON b.user_id = u.id
          WHERE u.role = 'owner' OR u.owner_status <> 'none'
          ORDER BY (u.owner_status = 'requested') DESC, sold DESC, u.created_at`);

      const admins = await db.query(
        `SELECT id, email, full_name, owner_status, created_at
           FROM mb_users WHERE role = 'admin' ORDER BY created_at`);

      // "How much they sold" is the cancelled-excluded total of what customers agreed to pay,
      // which is what the brief asked for. It is not revenue to matbyus: nothing writes commission
      // yet (FSD C4), so the platform's own cut is deliberately absent rather than guessed at.
      return json(res, 200, {
        you: account.id,
        pending: rows.filter(r => r.owner_status === 'requested').length,
        owners: rows.map(r => ({
          id: r.id, email: r.email, fullName: r.full_name, phone: formatMobile(r.phone),
          role: r.role, ownerStatus: r.owner_status, joinedAt: r.created_at,
          legalName: r.legal_name, gstin: r.gstin,
          stateCode: r.state_code, stateName: r.state_code ? lk.stateName(r.state_code) : null,
          city: r.city,
          listings: r.listings, live: r.live, orders: r.orders,
          sold: r.sold, soldLabel: formatInr(toPaise(r.sold)),
        })),
        admins: admins.map(a => ({
          id: a.id, email: a.email, fullName: a.full_name, since: a.created_at,
          isYou: a.id === account.id,
        })),
      });
    }

    // --- which menus each role sees (FR-5.2, FR-5.4) ------------------------
    if (resource === 'permissions') {
      return json(res, 200, await roleMenuOverview(db));
    }

    return json(res, 400, { error: 'Unknown resource.' });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const d = await body(req);

  // --- business approvals (FR-6, FR-7.4) -----------------------------------
  if (resource === 'customers' && (action === 'approve' || action === 'reject')) {
    const to = action === 'approve' ? 'approved' : 'rejected';
    const [u] = await db.query(
      'SELECT id, account_type, business_status FROM mb_users WHERE id = $1', [d.id]);
    if (!u) return json(res, 404, { error: 'That customer was not found.' });
    if (u.account_type !== 'business') {
      return json(res, 400, { error: 'That account is not a business account.' });
    }
    const note = str(d.note);
    await db.query(
      'UPDATE mb_users SET business_status = $1, updated_at = now() WHERE id = $2', [to, u.id]);
    await db.query(
      `INSERT INTO mb_business_status_log (user_id, from_status, to_status, note, actor_id)
       VALUES ($1, $2, $3, $4, $5)`, [u.id, u.business_status, to, note, account.id]);
    return json(res, 200, { ok: true, businessStatus: to });
  }

  // --- menu visibility per role ---------------------------------------------
  if (resource === 'permissions' && action === 'save') {
    const saved = await setRoleMenus(db, account.id, String(d.role || ''), d.menus);
    return json(res, 200, {
      ok: true, role: d.role, menus: saved,
      note: 'Menus decide what the app shows. Every endpoint still checks the role itself, so this grants and removes no access.',
    });
  }

  // --- moving an order along (FR-25.5) --------------------------------------
  // Each move names the state it expects in the WHERE clause. If it matches nothing the move is
  // refused with the state the order is actually in, so a double tap or a stale screen cannot
  // advance an order twice (TSD Phase 2 D-24).
  if (resource === 'orders') {
    const reference = String(d.reference || '');
    if (!reference) return json(res, 400, { error: 'reference is required.' });

    // --- the handover code (FR-29.9) ----------------------------------------
    //
    // What the QR must NOT carry is the order reference. References are built to be read aloud
    // down a phone line, so anyone who overheard one could close the order from their sofa. This
    // issues a separate secret: short-lived, single-use, stored only as a hash, and replaced
    // outright every time the seller's screen asks for one — so a photograph of an earlier screen
    // is worth nothing (migration 0006, D-32).
    if (action === 'handover-token') {
      const [o] = await db.query(
        `SELECT id, status FROM mb_orders
          WHERE reference = $1 AND ($2::uuid IS NULL OR owner_id = $2)`, [reference, mine]);
      if (!o) return json(res, 404, { error: 'That order was not found.' });

      // The states a customer may collect from are the customer's own transition rows, so the
      // seller cannot show a code for a moment at which the scan would be refused anyway.
      const collect = lk.move('customer', 'collect');
      if (!collect) return json(res, 503, { error: 'Scanning to confirm is not enabled.' });
      if (!collect.from.includes(o.status)) {
        const now = (lk.status(o.status)?.label || o.status).toLowerCase();
        const when = collect.from.map(s => (lk.status(s)?.label || s).toLowerCase()).join(' or ');
        return json(res, 409, {
          error: `A collection code can only be shown once the order is ${when}. This one is ${now}.`,
          status: o.status,
        });
      }

      const ttl = Math.min(600, Math.max(30, Number(process.env.MB_HANDOVER_TTL_SECONDS) || 120));
      const token = randomCode(10);
      await db.query(
        'DELETE FROM mb_order_handover_tokens WHERE order_id = $1 AND used_at IS NULL', [o.id]);
      const [issued] = await db.query(
        `INSERT INTO mb_order_handover_tokens (order_id, token_hash, issued_by, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         RETURNING expires_at`, [o.id, sha256(token), account.id, ttl]);

      return json(res, 200, {
        handover: {
          reference,
          token,
          // What the QR encodes. The reference is in it so a scan can be matched to the right order
          // even if the customer opened the scanner from somewhere else; the token is what counts.
          payload: `MB1:${reference}:${token}`,
          expiresAt: issued.expires_at,
          ttlSeconds: ttl,
        },
      });
    }

    // The state machine is mb_order_transitions (migration 0005), not an object in this file. A
    // move that is not a row there cannot be made by anyone, and the seller's screen draws its
    // buttons from the same rows — so what the screen offers and what the API accepts are one list.
    const move = lk.move('seller', action);
    if (!move) return json(res, 400, { error: 'Unknown action.' });

    const params = [reference, move.to, ...move.from, mine];
    const froms = move.from.map((_, i) => '$' + (i + 3)).join(',');
    const n = move.from.length + 3;
    const scope = `AND ($${n}::uuid IS NULL OR owner_id = $${n})`;
    let extra = '';
    if (move.to === 'cancelled') {
      params.push(String(d.reason || '').slice(0, 300) || null);
      extra = `, cancelled_at = now(), cancel_reason = $${params.length}`;
    }
    if (move.to === 'collected') {
      // FR-29.9: the store marking an order collected is a manual confirmation, recorded as such
      // and deliberately distinguishable from a customer scanning the QR.
      params.push(account.id);
      extra = `, collected_at = now(), collection_method = 'manual', collected_by = $${params.length}`;
    }

    const [updated] = await db.query(
      `UPDATE mb_orders SET status = $2, updated_at = now()${extra}
        WHERE reference = $1 AND status IN (${froms}) ${scope}
       RETURNING reference, status, collection_method, customer_id`, params);

    if (!updated) {
      // Scoped the same way, so another owner's reference says "not found" rather than its state.
      const [exists] = await db.query(
        'SELECT status FROM mb_orders WHERE reference = $1 AND ($2::uuid IS NULL OR owner_id = $2)',
        [reference, mine]);
      if (!exists) return json(res, 404, { error: 'That order was not found.' });
      const is = (lk.status(exists.status)?.label || exists.status).toLowerCase();
      const want = (lk.status(move.to)?.label || move.to).toLowerCase();
      return json(res, 409, {
        error: `That order is ${is}. It cannot be ${want} from there.`,
        status: exists.status,
      });
    }

    // FR-28.1: when the seller moves an order along, the customer is notified. Collection by scan
    // notifies nobody here — the customer is the one who just scanned, so they already know.
    if (move.to !== 'collected' || updated.collection_method !== 'scan') {
      const label = (lk.status(updated.status)?.label || updated.status).toLowerCase();
      await notify(db, updated.customer_id, 'order_status', `${reference} is now ${label}`,
        { link: `#/order/${reference}` });
    }
    return json(res, 200, { order: updated });
  }

  // --- who sells here, and who runs the place (FR-31) ------------------------
  // Admin only. Approving is what creates an owner: there is no other route into the role, and the
  // database will not hold `role = 'owner'` without `owner_status = 'approved'` (migration D-31).
  //
  // Every change here raises session_version, which signs that account out everywhere. That is the
  // point rather than a side effect: a session minted as a customer carries the customer role, and
  // the new menus and scoping only take effect on a session minted after the change.
  if (resource === 'owners') {
    const id = String(d.id || '');
    if (!id) return json(res, 400, { error: 'id is required.' });
    const [u] = await db.query(
      'SELECT id, email, full_name, role, owner_status FROM mb_users WHERE id = $1', [id]);
    if (!u) return json(res, 404, { error: 'That account was not found.' });
    const note = str(d.note);
    const who = u.full_name || u.email;

    const record = (toStatus, toRole) => db.query(
      `INSERT INTO mb_owner_status_log
         (user_id, from_status, to_status, from_role, to_role, note, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id, u.owner_status, toStatus, u.role, toRole, note, account.id]);

    if (action === 'approve') {
      if (u.role === 'admin') {
        return json(res, 400, { error: 'An administrator already reaches every owner screen.' });
      }
      if (u.role === 'owner') return json(res, 409, { error: `${who} already sells on matbyus.` });
      const [moved] = await db.query(
        `UPDATE mb_users
            SET owner_status = 'approved', role = 'owner',
                session_version = session_version + 1, updated_at = now()
          WHERE id = $1 AND role = 'customer' RETURNING id`, [u.id]);
      if (!moved) return json(res, 409, { error: 'That account cannot be made an owner.' });
      await record('approved', 'owner');
      return json(res, 200, {
        ok: true, role: 'owner', ownerStatus: 'approved',
        message: `${who} can now sell on matbyus. They were signed out, and their next sign-in has the owner screens.`,
      });
    }

    if (action === 'reject') {
      if (u.role === 'admin') {
        return json(res, 400, { error: 'An administrator cannot be rejected as an owner.' });
      }
      // The role and the status move together, in one statement. Doing it in two would leave a
      // moment where the row breaks mb_users_owner_role_check, and the database would refuse it.
      await db.query(
        `UPDATE mb_users
            SET owner_status = 'rejected', role = 'customer',
                session_version = session_version + 1, updated_at = now()
          WHERE id = $1 AND role <> 'admin'`, [u.id]);
      await record('rejected', 'customer');
      return json(res, 200, {
        ok: true, role: 'customer', ownerStatus: 'rejected',
        message: u.role === 'owner'
          ? `${who} no longer sells on matbyus. Their listings stay on file and are no longer theirs to edit.`
          : `${who} was not approved as an owner.`,
      });
    }

    // Only an admin can make another admin — the brief's "only OG admin can add OG admin".
    if (action === 'grant-admin') {
      if (u.role === 'admin') return json(res, 409, { error: `${who} is already an administrator.` });
      await db.query(
        `UPDATE mb_users SET role = 'admin', session_version = session_version + 1,
                updated_at = now() WHERE id = $1`, [u.id]);
      await record(u.owner_status, 'admin');
      return json(res, 200, {
        ok: true, role: 'admin',
        message: `${who} is now an administrator. They were signed out; the admin screens appear on their next sign-in.`,
      });
    }

    if (action === 'revoke-admin') {
      if (u.role !== 'admin') return json(res, 400, { error: `${who} is not an administrator.` });
      if (u.id === account.id) {
        return json(res, 400, {
          error: 'You cannot remove your own administrator role. Ask another administrator to do it.',
        });
      }
      // The count is inside the statement rather than checked first, so two admins revoking each
      // other at the same moment cannot both pass the check and leave matbyus with none.
      const [moved] = await db.query(
        `UPDATE mb_users
            SET role = CASE WHEN owner_status = 'approved' THEN 'owner' ELSE 'customer' END,
                session_version = session_version + 1, updated_at = now()
          WHERE id = $1 AND role = 'admin'
            AND (SELECT count(*) FROM mb_users WHERE role = 'admin') > 1
          RETURNING role`, [u.id]);
      if (!moved) {
        return json(res, 409, {
          error: 'matbyus would be left with no administrator. Add another one first.',
        });
      }
      await record(u.owner_status, moved.role);
      return json(res, 200, {
        ok: true, role: moved.role,
        message: `${who} is no longer an administrator, and is now a ${moved.role}.`,
      });
    }

    return json(res, 400, { error: 'Unknown action.' });
  }

  // --- products (FR-8) ------------------------------------------------------
  if (resource === 'products') {
    if (action === 'create') {
      const p = readProduct(d, { lk });
      // An owner's listing is theirs, full stop — the body cannot say otherwise. An admin may
      // attribute one to an owner, or leave it with the house.
      const owner_id = mine || (d.ownerId ? String(d.ownerId) : null);
      if (owner_id && !mine) {
        const [o] = await db.query(
          "SELECT id FROM mb_users WHERE id = $1 AND role = 'owner'", [owner_id]);
        if (!o) return json(res, 400, { error: 'That owner was not found.' });
      }
      const row = {
        pricing_mode: 'fixed', gst_rate: '0', min_order_qty: '1', stock_status: 'in_stock',
        is_active: false, ...p, owner_id, created_by: account.id,
      };
      assertCoherent(row, lk);
      const cols = Object.keys(row);
      const [created] = await db.query(
        `INSERT INTO mb_products (${cols.join(',')})
         VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
        cols.map(c => row[c]));
      return json(res, 201, { product: created });
    }

    if (action === 'update') {
      if (!d.id) return json(res, 400, { error: 'id is required.' });
      const patch = readProduct(d, { partial: true, lk });
      delete patch.id;
      const merged = await mergedProduct(db, d.id, patch, mine);   // 404 for someone else's
      assertCoherent(merged, lk);
      const cols = Object.keys(patch);
      if (!cols.length) return json(res, 400, { error: 'Nothing to change.' });
      const [updated] = await db.query(
        `UPDATE mb_products SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${cols.length + 1} RETURNING *`,
        [...cols.map(c => patch[c]), d.id]);
      return json(res, 200, { product: updated });
    }

    if (action === 'activate' || action === 'deactivate') {
      if (!d.id) return json(res, 400, { error: 'id is required.' });
      const merged = await mergedProduct(db, d.id, {}, mine);      // 404 for someone else's
      if (action === 'activate') {
        assertCoherent(merged, lk);
        if (!merged.hsn_sac) {
          return json(res, 400, {
            error: merged.kind === 'service'
              ? 'A service needs a SAC code before it can go live.'
              : 'A material needs an HSN code before it can go live.',
          });
        }
      }
      const [row] = await db.query(
        'UPDATE mb_products SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [action === 'activate', d.id]);
      return json(res, 200, { product: row });
    }
    return json(res, 400, { error: 'Unknown action.' });
  }

  // --- categories (FR-8.11) -------------------------------------------------
  if (resource === 'categories') {
    if (action === 'create') {
      const name = str(d.name), slug = str(d.slug), kind = d.kind;
      if (!name || !slug) return json(res, 400, { error: 'Name and slug are required.' });
      if (!SLUG.test(slug)) return json(res, 400, { error: 'Slug may use lower-case letters, numbers and hyphens only.' });
      const kinds = (lk.lookup.product_kind || []).map(x => x.code);
      if (!kinds.includes(kind)) {
        return json(res, 400, { error: `Kind must be ${kinds.join(' or ')}.` });
      }
      const [c] = await db.query(
        `INSERT INTO mb_categories (slug, name, kind, parent_id, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [slug, name, kind, d.parentId || null, Number(d.sortOrder) || 0]);
      return json(res, 201, { category: c });
    }

    if (action === 'deactivate') {
      const [{ n }] = await db.query(
        'SELECT count(*)::int AS n FROM mb_products WHERE category_id = $1 AND is_active', [d.id]);
      if (n > 0) {
        const blocking = await db.query(
          'SELECT name FROM mb_products WHERE category_id = $1 AND is_active ORDER BY name LIMIT 10', [d.id]);
        return json(res, 400, {
          error: `That category still holds ${n} active product${n === 1 ? '' : 's'}.`,
          blocking: blocking.map(b => b.name),
        });
      }
      const [c] = await db.query(
        'UPDATE mb_categories SET is_active = false WHERE id = $1 RETURNING *', [d.id]);
      if (!c) return json(res, 404, { error: 'That category was not found.' });
      return json(res, 200, { category: c });
    }

    if (action === 'activate') {
      const [c] = await db.query(
        'UPDATE mb_categories SET is_active = true WHERE id = $1 RETURNING *', [d.id]);
      if (!c) return json(res, 404, { error: 'That category was not found.' });
      return json(res, 200, { category: c });
    }
    return json(res, 400, { error: 'Unknown action.' });
  }

  return json(res, 400, { error: 'Unknown resource.' });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus admin failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
