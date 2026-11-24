// matbyus — public catalog. TSD sections 5, 6. Implements FR-9, FR-10, FR-12.
//
//   GET /api/catalog?kind=&category=&q=&page=&pageSize=   -> { items, page, pageSize, total }
//   GET /api/catalog?slug=<slug>                          -> { product }
//
// D-8: the price a viewer is entitled to is chosen here, on the server. The losing price is never
// serialised. Sending both and letting the browser pick would put the trade price list in the page
// source of every anonymous visitor.

import { json, fail, sessionAccount } from './_lib.js';
import { db as defaultDb } from './_db.js';
import { isApprovedBusiness } from './_roles.js';
import { lookups } from './_lookups.js';
import { toPaise, gstView } from './_india.js';

const PAGE_DEFAULT = 24, PAGE_MAX = 100;

// FR-10. Returns the base price in paise, or null for a quote-priced product.
export function resolvePrice(product, businessView) {
  if (product.pricing_mode === 'quote') return null;
  if (businessView && product.price_business != null) return toPaise(product.price_business);
  return toPaise(product.price_retail);
}

export function presentProduct(p, businessView) {
  const base = resolvePrice(p, businessView);
  const view = gstView(base, p.gst_rate, businessView);
  // The unit's label comes down the same query as the product (mb_units, migration 0005), so this
  // function needs no lookup of its own and cannot disagree with what the form offered.

  const out = {
    id: p.id,
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    summary: p.summary,
    category: p.category_slug ? { slug: p.category_slug, name: p.category_name } : null,
    unit: p.unit,
    unitLabel: p.unit_label || p.unit,
    minOrderQty: Number(p.min_order_qty),
    pricingMode: p.pricing_mode,
    hsnSac: p.hsn_sac,
    gstRate: Number(p.gst_rate),
    price: view,
    // FSD Phase 2 §4: a listing shows which owner sells it. Null is the house (no owner) — see
    // docs/permissions.md on what a null owner means. ownerId is what the front end's "ask for a
    // better price" and "message the seller" entry points need to reach api/bids.js and
    // api/messages.js, which require it.
    seller: p.owner_id ? { ownerId: p.owner_id, name: p.owner_name } : null,
  };
  if (p.kind === 'material') {
    out.packSize = p.pack_size == null ? null : Number(p.pack_size);
    out.stockStatus = p.stock_status;
  }
  // FR-10.2: the retail price is disclosed as a comparison only to a viewer already entitled to
  // the business price, so the saving can be shown.
  if (businessView && p.price_business != null && p.pricing_mode === 'fixed') {
    out.price.compareAtLabel = gstView(toPaise(p.price_retail), p.gst_rate, true).headlineLabel;
  }
  return out;
}

const SELECT = `
  SELECT p.*, c.slug AS category_slug, c.name AS category_name,
         un.label AS unit_label, un.plural AS unit_plural, ow.full_name AS owner_name
    FROM mb_products p
    JOIN mb_categories c ON c.id = p.category_id
    LEFT JOIN mb_units un ON un.code = p.unit
    LEFT JOIN mb_users ow ON ow.id = p.owner_id
   WHERE p.is_active`;

export async function handle(req, res, db) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });

  const q = new URL(req.url, 'https://local').searchParams;
  // One read of the lookup tables per cold start, held for a minute (api/_lookups.js). On the
  // public path this is the only extra round trip, and the response it helps produce is itself
  // edge-cached for a minute, so in practice it is paid once per deployment per region.
  const lk = await lookups(db);

  // Two shapes of response, split by URL rather than by cookie.
  //
  // The default is retail for everybody and depends on nothing about the caller, so a CDN can hold
  // one copy and serve the whole world from it. `?trade=1` is the signed-in business view; it
  // carries the trade price list, so it is private and never cached.
  //
  // The first attempt varied one URL on the Cookie header instead. It was correct but useless:
  // Vercel will not edge-cache a response that varies on cookies, so every request stayed a MISS.
  // Splitting by URL keeps the guarantee — the public URL cannot produce a business price at all —
  // and lets the common case be cached. A business viewer who somehow lands on the public URL sees
  // retail prices, which is wrong for them but is not a disclosure.
  const wantsTrade = q.get('trade') === '1';
  const account = wantsTrade ? await sessionAccount(req, db) : null;   // public path: no session lookup
  const businessView = wantsTrade && isApprovedBusiness(account);

  // --- one product (FR-9.6) -------------------------------------------------
  const slug = q.get('slug');
  if (slug) {
    const rows = await db.query(SELECT + ' AND p.slug = $1', [slug]);
    // An inactive product is a 404, not an empty shell.
    if (!rows.length) return json(res, 404, { error: 'That product was not found.' });
    const product = presentProduct(rows[0], businessView);
    product.description = rows[0].description;
    cacheHeaders(res, wantsTrade);
    return json(res, 200, { product });
  }

  // --- list (FR-9.1, FR-9.2) ------------------------------------------------
  const where = [], params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', '$' + params.length)); };

  const kind = q.get('kind');
  if (kind) {
    if (!(lk.lookup.product_kind || []).some(k => k.code === kind)) {
      return json(res, 400, { error: 'Unknown kind.' });
    }
    add('p.kind = ?', kind);
  }
  const category = q.get('category');
  if (category) add('c.slug = ?', category);

  const text = (q.get('q') || '').trim();
  if (text) {
    add("to_tsvector('simple', p.name || ' ' || COALESCE(p.summary, '')) @@ plainto_tsquery('simple', ?)", text);
  }

  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  const pageSize = Math.min(PAGE_MAX, Math.max(1, parseInt(q.get('pageSize') || String(PAGE_DEFAULT), 10) || PAGE_DEFAULT));

  const filter = where.length ? ' AND ' + where.join(' AND ') : '';

  // One round trip, not two. count(*) OVER () returns the unpaged total on every row, so the
  // separate COUNT query is gone — it was doubling the latency of the slowest endpoint.
  const rows = await db.query(
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name,
            un.label AS unit_label, un.plural AS unit_plural, ow.full_name AS owner_name,
            count(*) OVER ()::int AS total_count
       FROM mb_products p
       JOIN mb_categories c ON c.id = p.category_id
       LEFT JOIN mb_units un ON un.code = p.unit
       LEFT JOIN mb_users ow ON ow.id = p.owner_id
      WHERE p.is_active${filter}
      ORDER BY p.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]);

  const total = rows.length ? Number(rows[0].total_count) : 0;
  cacheHeaders(res, wantsTrade);
  return json(res, 200, {
    items: rows.map(r => presentProduct(r, businessView)),
    page, pageSize, total,
    viewer: { businessPricing: businessView },
  });
}

// Keyed on the URL, not the cookie, so there is nothing to vary on. The trade URL is private
// whether or not the caller turned out to be entitled to trade pricing — otherwise the header
// itself would tell an attacker whose session they hold.
export function cacheHeaders(res, isTradeUrl) {
  res.setHeader('Cache-Control', isTradeUrl
    ? 'private, no-store'
    : 'public, s-maxage=60, stale-while-revalidate=600');
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus catalog failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
