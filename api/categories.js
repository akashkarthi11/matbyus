// Category list with live product counts. Split out of the catalog so the browser stops fetching
// 100 products purely to discover which categories exist — that second request was costing roughly
// as much as the page itself.
//
// Nothing here depends on who is asking: a category name is the same for every viewer, and no
// price is involved. So it is cached on the edge for everyone, with no Vary.

import { json } from './_lib.js';
import { db as defaultDb } from './_db.js';

export async function handle(req, res, db) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });

  const kind = new URL(req.url, 'https://local').searchParams.get('kind');
  if (kind && kind !== 'material' && kind !== 'service') {
    return json(res, 400, { error: 'Unknown kind.' });
  }

  const rows = await db.query(
    `SELECT c.slug, c.name, c.kind, count(p.id)::int AS products
       FROM mb_categories c
       LEFT JOIN mb_products p ON p.category_id = c.id AND p.is_active
      WHERE c.is_active ${kind ? 'AND c.kind = $1' : ''}
      GROUP BY c.slug, c.name, c.kind, c.sort_order
      HAVING count(p.id) > 0
      ORDER BY c.sort_order, c.name`, kind ? [kind] : []);

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  return json(res, 200, { categories: rows });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus categories failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
