// matbyus — every lookup, read from the database.
//
// Roles, menus, units, GST states, the order status machine, the bid status machine and the labels
// for the small enums all live in tables (migrations 0005, 0011). This module reads them and hands
// the rest of the server one object to ask. Nothing here is a copy of what is in the database: if a
// row is missing, the answer is "that is not a thing", not a constant quietly standing in for it.
//
// Two consequences worth being explicit about:
//
//   * **No fallback list.** If the lookup tables are absent the server returns 503 and says the
//     deployment is not configured. A hardcoded standby would make a half-migrated deployment look
//     healthy while validating against a list the database does not share, which is the exact
//     failure this change exists to remove.
//
//   * **A short cache.** Serverless invocations are short-lived; reading every lookup table on each
//     request would add a round trip to every page. One read per database handle per minute is the
//     compromise, so an edit to a unit or a menu label is visible within a minute rather than
//     instantly. Permission changes do NOT go through this cache — menusForRole reads the saved
//     choice live, because an admin switching a menu off expects to see it gone.

const TTL = 60_000;

// Keyed by the database handle, so a test's throwaway database never answers for another one, and
// in production there is one entry per cold start.
const cache = new WeakMap();

const configFailure = detail => Object.assign(
  new Error('the lookup tables could not be read (' + detail + '). Run the migrations.'),
  { code: 'CONFIG' });

export async function lookups(db) {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await load(db);
  cache.set(db, { at: Date.now(), data });
  return data;
}

// Called after anything writes to a lookup table, and by the test harness between cases.
export function forgetLookups(db) {
  if (db) cache.delete(db);
}

// Every lookup table in one round trip. One SELECT per table was the obvious shape and the wrong
// one: it put that many queries in front of the public catalogue, which is the endpoint this
// project has already paid once to make a single round trip. One query also means one error when
// the tables are missing, rather than several concurrent failures.
const LOAD_SQL = `
  SELECT
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.code), '[]'::json)
       FROM mb_roles x) AS roles,
    (SELECT COALESCE(json_agg(x ORDER BY x.role, x.sort_order, x.key), '[]'::json)
       FROM mb_menus x) AS menus,
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.code), '[]'::json)
       FROM mb_units x WHERE x.is_active) AS units,
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.code), '[]'::json)
       FROM mb_states x WHERE x.is_active) AS states,
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.code), '[]'::json)
       FROM mb_order_statuses x) AS statuses,
    (SELECT COALESCE(json_agg(x ORDER BY x.actor, x.from_status, x.sort_order), '[]'::json)
       FROM mb_order_transitions x) AS transitions,
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.code), '[]'::json)
       FROM mb_bid_statuses x) AS bidstatuses,
    (SELECT COALESCE(json_agg(x ORDER BY x.sort_order, x.action), '[]'::json)
       FROM mb_bid_actions x) AS bidactions,
    (SELECT COALESCE(json_agg(x ORDER BY x.domain, x.sort_order, x.code), '[]'::json)
       FROM mb_lookups x WHERE x.is_active) AS flat`;

const asArray = v => (Array.isArray(v) ? v : JSON.parse(v || '[]'));

async function load(db) {
  let row;
  try {
    [row] = await db.query(LOAD_SQL);
  } catch (e) {
    throw configFailure(e?.message || 'unknown error');
  }
  if (!row) throw configFailure('the lookup query returned nothing');
  const roles = asArray(row.roles);
  const menuRows = asArray(row.menus);
  const units = asArray(row.units);
  const states = asArray(row.states);
  const statuses = asArray(row.statuses);
  const bidStatuses = asArray(row.bidstatuses);
  const bidActions = asArray(row.bidactions);
  if (!roles.length || !menuRows.length || !units.length || !states.length || !statuses.length
      || !bidStatuses.length || !bidActions.length) {
    throw configFailure('a lookup table is empty');
  }
  return build({
    roles, menuRows, units, states, statuses,
    transitions: asArray(row.transitions),
    bidStatuses, bidActions,
    flat: asArray(row.flat),
  });
}

function build({ roles, menuRows, units, states, statuses, transitions, bidStatuses, bidActions, flat }) {
  // --- roles ---------------------------------------------------------------
  const roleByCode = new Map(roles.map(r => [r.code, r]));
  const roleCodes = roles.map(r => r.code);
  const configurableRoles = roles.filter(r => r.is_configurable).map(r => r.code);

  // --- menus ---------------------------------------------------------------
  const menus = {};
  const alwaysOn = {};
  for (const code of roleCodes) { menus[code] = []; alwaysOn[code] = []; }
  for (const m of menuRows) {
    (menus[m.role] ||= []).push({ key: m.key, label: m.label, icon: m.icon || m.key });
    if (m.always_on) (alwaysOn[m.role] ||= []).push(m.key);
  }

  // --- units ---------------------------------------------------------------
  const unitByCode = new Map(units.map(u => [u.code, u]));
  const unit = code => unitByCode.get(String(code || '')) || null;
  const unitAllowedFor = (code, kind) => {
    const u = unit(code);
    return !!u && (u.applies_to === 'both' || u.applies_to === kind);
  };
  const formatQuantity = (qty, code) => {
    const u = unit(code);
    if (!u) return String(qty);
    const n = Number(qty);
    return `${n} ${n === 1 ? u.label : u.plural}`;
  };

  // --- states --------------------------------------------------------------
  const stateByCode = new Map(states.map(s => [s.code, s.name]));
  const stateName = code => stateByCode.get(String(code || '')) || null;
  const validStateCode = code => stateByCode.has(String(code || ''));

  // --- the order status machine --------------------------------------------
  const statusByCode = new Map(statuses.map(s => [s.code, s]));
  const flows = {};    // actor -> from_status -> [{ action, to, label, primary, needsReason }]
  const moves = {};    // actor -> action -> { action, to, from: [...], needsReason }
  for (const t of transitions) {
    const flow = (flows[t.actor] ||= {});
    (flow[t.from_status] ||= []).push({
      action: t.action, to: t.to_status, label: t.label,
      primary: t.is_primary, needsReason: t.needs_reason, needsToken: !!t.needs_token,
    });
    const byAction = (moves[t.actor] ||= {});
    const m = (byAction[t.action] ||= {
      action: t.action, to: t.to_status, from: [], needsReason: false, needsToken: false,
    });
    // One action lands on one status. If two rows disagree the handler's single-destination UPDATE
    // would silently pick one, so the disagreement is refused here instead.
    if (m.to !== t.to_status) {
      throw configFailure(`the ${t.actor} action "${t.action}" leads to both ${m.to} and ${t.to_status}`);
    }
    m.from.push(t.from_status);
    if (t.needs_reason) m.needsReason = true;
    if (t.needs_token) m.needsToken = true;
  }

  // --- the bid status machine (migration 0011) ------------------------------
  const bidStatusByCode = new Map(bidStatuses.map(s => [s.code, s]));
  const bidActionByCode = new Map(bidActions.map(a => [a.action, {
    action: a.action, to: a.to_status, label: a.label,
    needsPrice: !!a.needs_price, restrictSide: a.restrict_side || null, anyTurn: !!a.any_turn,
  }]));

  // --- the small enums -------------------------------------------------------
  const domains = {};
  for (const r of flat) {
    (domains[r.domain] ||= []).push({ code: r.code, label: r.label, meta: r.meta || {} });
  }
  const label = (domain, code) =>
    (domains[domain] || []).find(x => x.code === String(code ?? ''))?.label || null;
  const meta = (domain, code) =>
    (domains[domain] || []).find(x => x.code === String(code ?? ''))?.meta || {};

  return {
    roles, roleCodes, configurableRoles,
    role: code => roleByCode.get(String(code || '')) || null,
    isConfigurable: code => configurableRoles.includes(String(code || '')),
    homeView: code => roleByCode.get(String(code || ''))?.home_view || 'materials',

    menus, alwaysOn,

    units, unit, unitAllowedFor, formatQuantity,
    unitCodes: units.map(u => u.code),
    unitList: kind => units.filter(u => !kind || u.applies_to === 'both' || u.applies_to === kind),

    states, stateName, validStateCode,

    statuses, statusByCode,
    statusCodes: statuses.map(s => s.code),
    status: code => statusByCode.get(String(code || '')) || null,
    // What an actor can do to an order in a given state, and the whole move table for that actor.
    flowFor: (actor, status) => (flows[actor] || {})[String(status || '')] || [],
    movesFor: actor => moves[actor] || {},
    move: (actor, action) => (moves[actor] || {})[String(action || '')] || null,

    bidStatuses,
    bidStatusCodes: bidStatuses.map(s => s.code),
    bidStatus: code => bidStatusByCode.get(String(code || '')) || null,
    bidActions,
    bidAction: action => bidActionByCode.get(String(action || '')) || null,

    lookup: domains, label, meta,
  };
}
