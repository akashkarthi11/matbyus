-- Which menus a role sees. Modelled on the Wealth app's role management.
--
-- This hides a menu in the app. It is NOT a data permission: every endpoint checks the caller's
-- role for itself (FSD FR-5.4), so switching a menu back on grants nothing that was previously
-- refused, and switching it off stops nothing that an API would otherwise allow. The distinction
-- matters enough that it is written here, in the admin screen, and in docs/permissions.md.

CREATE TABLE IF NOT EXISTS mb_role_menus (
  role       text PRIMARY KEY,
  menus      text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES mb_users(id),
  CONSTRAINT mb_role_menus_role_check CHECK (role IN ('customer','owner')),
  CONSTRAINT mb_role_menus_not_empty CHECK (cardinality(menus) > 0)
);
