// matbyus — roles, navigation and the permission boundary. TSD section 4.4.
//
// Three roles: **customer** buys, **owner** sells, **admin** runs the platform. An admin is the
// "OG admin" of the brief — they approve owners, see across every owner, and are the only role
// that can create another admin.
//
// None of that is written here. The roles, their menus, which of them an admin may tailor and
// which menus a role always keeps are rows in mb_roles and mb_menus (migration 0005), read through
// api/_lookups.js. What this file holds is the *boundary*: who is refused, and how an owner's
// queries are narrowed. Those are decisions, not data, and they stay in code where they are tested.
//
// The one rule that matters: **hiding a menu is presentation, never protection.**
// Every endpoint checks the caller's role for itself (FR-5.4), and every owner-facing query names
// the owner in its WHERE clause. An admin switching a menu off makes it disappear from the app; it
// does not close an API. docs/permissions.md sets out the whole matrix.

import { fail } from './_lib.js';
import { lookups } from './_lookups.js';

// --- navigation -------------------------------------------------------------

// The menus a role sees: the catalogue from mb_menus, narrowed by whatever an admin saved in
// mb_role_menus. The saved choice is read live rather than through the lookup cache, because an
// admin who switches a menu off expects it gone on the next load, not within the minute.
export async function menusForRole(role, db) {
  const lk = await lookups(db);
  const all = lk.menus[role] || [];
  if (!all.length) return [];
  if (!lk.isConfigurable(role)) return all;
  let saved = null;
  try {
    [saved] = await db.query('SELECT menus FROM mb_role_menus WHERE role = $1', [role]);
  } catch {
    // The override table may be absent on a part-migrated deployment. The catalogue is the safe
    // answer: the APIs still refuse whatever the caller may not do.
    return all;
  }
  if (!saved) return all;
  const keep = new Set([...(saved.menus || []), ...(lk.alwaysOn[role] || [])]);
  const chosen = all.filter(m => keep.has(m.key));
  return chosen.length ? chosen : all;
}

export async function roleMenuOverview(db) {
  const lk = await lookups(db);
  const rows = await db.query('SELECT role, menus, updated_at FROM mb_role_menus');
  const users = await db.query('SELECT role, count(*)::int AS n FROM mb_users GROUP BY role');
  const count = r => users.find(u => u.role === r)?.n || 0;
  const saved = r => rows.find(x => x.role === r);
  return {
    roles: lk.roles.map(r => {
      const all = lk.menus[r.code] || [];
      const on = lk.isConfigurable(r.code) && saved(r.code)
        ? all.filter(m => saved(r.code).menus.includes(m.key) || (lk.alwaysOn[r.code] || []).includes(m.key))
        : all;
      return {
        role: r.code,
        label: r.label,
        description: r.description,
        users: count(r.code),
        locked: !r.is_configurable,
        alwaysOn: lk.alwaysOn[r.code] || [],
        all,
        menus: on.map(m => m.key),
        updatedAt: saved(r.code)?.updated_at || null,
      };
    }),
  };
}

export async function setRoleMenus(db, actorId, role, menus) {
  const lk = await lookups(db);
  if (!lk.role(role)) throw fail(400, `There is no ${role || 'unnamed'} role.`);
  if (!lk.isConfigurable(role)) {
    throw fail(400, `The ${role} role always sees every menu and cannot be changed.`);
  }
  if (!Array.isArray(menus)) throw fail(400, 'Choose the menus.');
  const valid = new Set((lk.menus[role] || []).map(m => m.key));
  const unknown = menus.find(k => !valid.has(k));
  if (unknown) throw fail(400, `There is no "${unknown}" menu for the ${role} role.`);
  const keep = [...new Set([...menus.filter(k => valid.has(k)), ...(lk.alwaysOn[role] || [])])];
  if (!keep.length) throw fail(400, 'Choose at least one menu.');
  await db.query(
    `INSERT INTO mb_role_menus (role, menus, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (role) DO UPDATE SET menus = EXCLUDED.menus, updated_at = now(),
                                      updated_by = EXCLUDED.updated_by`,
    [role, keep, actorId]);
  return keep;
}

// --- who is who ---------------------------------------------------------------
//
// These names are the only place a role code appears in server code, and they are assertions about
// behaviour rather than a copy of the role list: `admin` is the role that is not narrowed, `owner`
// is the role that is. A fourth role added to mb_roles gets no access from either until something
// here says so, which is the conservative direction for a new role to fail in.

export const isAdmin = account => !!account && account.role === 'admin';
export const isOwner = account => !!account && account.role === 'owner';

// Both roles sell, so both reach the seller screens. What they see through them differs: an owner
// is scoped to their own id, an admin is not scoped at all. ownerScope() below is that difference,
// and it is the only place the distinction is expressed.
export const isSeller = account => isAdmin(account) || isOwner(account);

// An approved business is the only viewer entitled to business pricing (FR-10).
export const isApprovedBusiness = account =>
  !!account && account.account_type === 'business' && account.business_status === 'approved';

const DENY = 'You do not have access to this.';

export function requireAdmin(account) {
  if (!isAdmin(account)) throw fail(403, DENY);
  return account;
}

export function requireSeller(account) {
  if (!isSeller(account)) throw fail(403, DENY);
  return account;
}

export function requireRole(account, roles) {
  if (!account || !roles.includes(account.role)) throw fail(403, DENY);
  return account;
}

// The id an owner's queries must be narrowed to, or null for an admin, who sees across owners.
// Passing this straight into SQL as `($n::uuid IS NULL OR owner_id = $n)` means one query serves
// both roles and there is no second, unscoped code path to forget about.
export const ownerScope = account => (isOwner(account) ? account.id : null);
