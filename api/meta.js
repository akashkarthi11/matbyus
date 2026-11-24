// Reference data the browser needs: roles, menus, units, GST states, the order status machine and
// the labels for every small enum. All of it comes from the lookup tables (migration 0005) — the
// same rows the API validates against, so a dropdown can never offer a value the server rejects.
//
// This used to be built from constants in _india.js. The dropdown and the validation were two
// copies of one list that agreed only because someone remembered; now there is one list.

import { json } from './_lib.js';
import { db as defaultDb } from './_db.js';
import { lookups } from './_lookups.js';

export async function handle(req, res, db) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const lk = await lookups(db);

  // Reference data, identical for every viewer and carrying nothing about who is asking, so it is
  // safe to cache at the edge. A minute at the browser keeps an edit visible the same day without
  // a deploy; a day at the edge keeps it off the database.
  res.setHeader('Cache-Control',
    'public, max-age=60, s-maxage=86400, stale-while-revalidate=604800');

  return json(res, 200, {
    states: lk.states.map(s => ({ code: s.code, name: s.name })),
    units: lk.units.map(u => ({
      key: u.code, label: u.label, plural: u.plural, kind: u.applies_to,
    })),
    roles: lk.roles.map(r => ({
      code: r.code, label: r.label, labelOne: r.label_one, home: r.home_view,
    })),
    orderStatuses: lk.statuses.map(s => ({
      code: s.code, label: s.label, sellerLabel: s.seller_label, open: s.is_open, tone: s.tone,
    })),
    // Keyed by the status an order is in, so the seller's screen can draw the buttons for a row
    // without knowing the state machine itself.
    orderFlow: Object.fromEntries(lk.statuses.map(s => [s.code, lk.flowFor('seller', s.code)])),
    customerFlow: Object.fromEntries(lk.statuses.map(s => [s.code, lk.flowFor('customer', s.code)])),
    // The bid status machine (migration 0011) — a dedicated list, the same treatment order status
    // gets, now that it moved out of the general-purpose enum bag in `lookups` below.
    bidStatuses: lk.bidStatuses.map(s => ({ code: s.code, label: s.label, open: s.is_open })),
    bidActions: lk.bidActions.map(a => ({
      action: a.action, to: a.to_status, label: a.label, needsPrice: a.needs_price,
      restrictSide: a.restrict_side, anyTurn: a.any_turn,
    })),
    lookups: lk.lookup,
  });
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    console.error('matbyus meta failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'This deployment is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
