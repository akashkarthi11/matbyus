-- Lookups live in the database, not in the code.
--
-- Until now the roles, the menus, the GST state list, the unit list and the order status machine
-- were JavaScript constants. Adding a unit meant a deploy; adding a state meant a deploy; the
-- product form's dropdown and the API's validation were two copies of the same list that agreed
-- only because someone remembered. This migration makes the database the single source for all of
-- it, and the code reads it.
--
-- Where the line falls, and why it falls there:
--
--   * Reference data the business edits — roles, menus, units, states, order statuses and the
--     moves between them — becomes a table, and the columns that used to carry a CHECK list now
--     carry a FOREIGN KEY to it. Adding a unit is an INSERT.
--
--   * Row-shape rules stay as CHECK constraints, because a foreign key cannot express them: that
--     a service carries no stock, that a quote carries no price, that CGST and SGST add to the
--     tax. Those are not lookups; they are the shape of a legal row.
--
--   * A handful of small enums — account_type, business_status, pricing_mode, stock_status and so
--     on — keep their CHECK and gain their **labels** in mb_lookups. The code branches on these
--     values, so a new one needs code either way; what does not belong in code is how they are
--     spelled and ordered on screen. That is what moves.
--
-- Forward-only. 0000-0004 are applied in production and are never edited.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_roles (
  code            text PRIMARY KEY,
  label           text NOT NULL,                      -- plural, for the admin screens
  label_one       text NOT NULL,                      -- singular, for "you are an owner"
  sort_order      integer NOT NULL DEFAULT 0,
  -- Whether an admin may hide menus from this role. The admin role is deliberately false: an
  -- administrator able to hide their own Permissions menu can lock themselves out of undoing it.
  is_configurable boolean NOT NULL DEFAULT false,
  home_view       text NOT NULL,                      -- the screen a sign-in lands on
  description     text
);

INSERT INTO mb_roles (code, label, label_one, sort_order, is_configurable, home_view, description) VALUES
  ('admin',    'Administrators', 'Administrator', 1, false, 'dashboard',   'Runs matbyus. Approves owners, sees across every owner, and is the only role that can create another administrator.'),
  ('owner',    'Owners',         'Owner',         2, true,  'storeorders', 'Sells on matbyus. Sees their own listings and the orders placed with them, and nothing belonging to another owner.'),
  ('customer', 'Customers',      'Customer',      3, true,  'materials',   'Buys on matbyus. Browses every owner''s listings and sees only their own orders.')
ON CONFLICT (code) DO NOTHING;

-- The role column is now a reference, not a list repeated in three places.
ALTER TABLE mb_users DROP CONSTRAINT IF EXISTS mb_users_role_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_users_role_fkey') THEN
    ALTER TABLE mb_users ADD CONSTRAINT mb_users_role_fkey
      FOREIGN KEY (role) REFERENCES mb_roles(code);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Menus — what each role's navigation can contain
-- ---------------------------------------------------------------------------
--
-- This is the catalogue of what exists. mb_role_menus (migration 0003) stays as it was: the
-- admin's choice of which of these to show. Two tables because they answer two questions — "what
-- screens does this role have" and "which of them has an admin switched off" — and collapsing them
-- would lose the difference between a menu that was never built and one that was hidden.

CREATE TABLE IF NOT EXISTS mb_menus (
  role       text NOT NULL REFERENCES mb_roles(code) ON DELETE CASCADE,
  key        text NOT NULL,                     -- the view the front end routes to
  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  -- A menu the role keeps whatever an admin saves, so nobody can be left with no route to their
  -- own data or to the orders they are expected to fulfil.
  always_on  boolean NOT NULL DEFAULT false,
  icon       text,
  PRIMARY KEY (role, key)
);

INSERT INTO mb_menus (role, key, label, sort_order, always_on) VALUES
  ('admin',    'dashboard',   'Dashboard',          1, false),
  ('admin',    'storeorders', 'Orders',             2, false),
  ('admin',    'owners',      'Owners',             3, false),
  ('admin',    'products',    'Products',           4, false),
  ('admin',    'categories',  'Categories',         5, false),
  ('admin',    'customers',   'Customers',          6, false),
  ('admin',    'approvals',   'Business approvals', 7, false),
  ('admin',    'permissions', 'Permissions',        8, false),

  ('owner',    'storeorders', 'Orders received',    1, true),
  ('owner',    'products',    'My listings',        2, false),
  ('owner',    'dashboard',   'My sales',           3, false),
  ('owner',    'account',     'My account',         4, true),

  ('customer', 'materials',   'Materials',          1, false),
  ('customer', 'services',    'Services',           2, false),
  ('customer', 'orders',      'My orders',          3, false),
  ('customer', 'account',     'My account',         4, true)
ON CONFLICT (role, key) DO NOTHING;

-- The saved choice now references the role list too, and which roles may be tailored is read from
-- mb_roles.is_configurable rather than being a second list inside a CHECK.
ALTER TABLE mb_role_menus DROP CONSTRAINT IF EXISTS mb_role_menus_role_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_role_menus_role_fkey') THEN
    ALTER TABLE mb_role_menus ADD CONSTRAINT mb_role_menus_role_fkey
      FOREIGN KEY (role) REFERENCES mb_roles(code) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Units of sale
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_units (
  code       text PRIMARY KEY,
  label      text NOT NULL,                     -- singular, as it reads beside a number
  plural     text NOT NULL,
  applies_to text NOT NULL DEFAULT 'both',      -- material | service | both
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  CONSTRAINT mb_units_applies_check CHECK (applies_to IN ('material','service','both'))
);

INSERT INTO mb_units (code, label, plural, applies_to, sort_order) VALUES
  ('bag',       'bag',        'bags',       'material',  1),
  ('kg',        'kg',         'kg',         'material',  2),
  ('quintal',   'quintal',    'quintals',   'material',  3),
  ('tonne',     'tonne',      'tonnes',     'material',  4),
  ('brass',     'brass',      'brass',      'material',  5),
  ('cft',       'cft',        'cft',        'material',  6),
  ('number',    'no',         'nos',        'material',  7),
  ('box',       'box',        'boxes',      'material',  8),
  ('litre',     'litre',      'litres',     'material',  9),
  ('bundle',    'bundle',     'bundles',    'material', 10),
  ('sqft',      'sq ft',      'sq ft',      'both',     11),
  ('rft',       'rft',        'rft',        'both',     12),
  ('per_sqft',  'per sq ft',  'per sq ft',  'service',  13),
  ('per_day',   'per day',    'per day',    'service',  14),
  ('per_visit', 'per visit',  'per visit',  'service',  15),
  ('lumpsum',   'lump sum',   'lump sum',   'service',  16)
ON CONFLICT (code) DO NOTHING;

-- The closed list of units was a CHECK repeated in the application. It becomes a reference.
ALTER TABLE mb_products DROP CONSTRAINT IF EXISTS mb_products_unit_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_products_unit_fkey') THEN
    ALTER TABLE mb_products ADD CONSTRAINT mb_products_unit_fkey
      FOREIGN KEY (unit) REFERENCES mb_units(code);
  END IF;
END $$;

-- "A service is not sold per bag" was also a CHECK listing units by name. It is now a rule about
-- mb_units.applies_to, which a CHECK cannot read — so it becomes a trigger. The invariant stays in
-- the database either way, which is the point: no application code has to remember it.
CREATE OR REPLACE FUNCTION mb_check_unit_kind() RETURNS trigger AS $fn$
DECLARE
  applies text;
BEGIN
  SELECT applies_to INTO applies FROM mb_units WHERE code = NEW.unit AND is_active;
  IF applies IS NULL THEN
    RAISE EXCEPTION 'new row violates the unit list: "%" is not an active unit', NEW.unit
      USING ERRCODE = 'check_violation';
  END IF;
  IF applies <> 'both' AND applies <> NEW.kind THEN
    RAISE EXCEPTION 'new row violates the unit rule: a % cannot be sold per %', NEW.kind, NEW.unit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

ALTER TABLE mb_products DROP CONSTRAINT IF EXISTS mb_products_unit_kind_check;
DROP TRIGGER IF EXISTS mb_products_unit_kind ON mb_products;
CREATE TRIGGER mb_products_unit_kind
  BEFORE INSERT OR UPDATE OF unit, kind ON mb_products
  FOR EACH ROW EXECUTE FUNCTION mb_check_unit_kind();

-- ---------------------------------------------------------------------------
-- 4. GST state codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_states (
  code       text PRIMARY KEY,                  -- the first two digits of a GSTIN
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  CONSTRAINT mb_states_code_check CHECK (code ~ '^([0-3][0-9]|9[0-9])$')
);

INSERT INTO mb_states (code, name, sort_order) VALUES
  ('01', 'Jammu and Kashmir', 1),  ('02', 'Himachal Pradesh', 2),
  ('03', 'Punjab', 3),             ('04', 'Chandigarh', 4),
  ('05', 'Uttarakhand', 5),        ('06', 'Haryana', 6),
  ('07', 'Delhi', 7),              ('08', 'Rajasthan', 8),
  ('09', 'Uttar Pradesh', 9),      ('10', 'Bihar', 10),
  ('11', 'Sikkim', 11),            ('12', 'Arunachal Pradesh', 12),
  ('13', 'Nagaland', 13),          ('14', 'Manipur', 14),
  ('15', 'Mizoram', 15),           ('16', 'Tripura', 16),
  ('17', 'Meghalaya', 17),         ('18', 'Assam', 18),
  ('19', 'West Bengal', 19),       ('20', 'Jharkhand', 20),
  ('21', 'Odisha', 21),            ('22', 'Chhattisgarh', 22),
  ('23', 'Madhya Pradesh', 23),    ('24', 'Gujarat', 24),
  ('25', 'Daman and Diu', 25),
  ('26', 'Dadra and Nagar Haveli and Daman and Diu', 26),
  ('27', 'Maharashtra', 27),
  ('28', 'Andhra Pradesh (pre-bifurcation)', 28),
  ('29', 'Karnataka', 29),         ('30', 'Goa', 30),
  ('31', 'Lakshadweep', 31),       ('32', 'Kerala', 32),
  ('33', 'Tamil Nadu', 33),        ('34', 'Puducherry', 34),
  ('35', 'Andaman and Nicobar Islands', 35),
  ('36', 'Telangana', 36),         ('37', 'Andhra Pradesh', 37),
  ('38', 'Ladakh', 38),            ('97', 'Other Territory', 97)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE mb_business_profiles DROP CONSTRAINT IF EXISTS mb_bp_state_check;
ALTER TABLE mb_orders DROP CONSTRAINT IF EXISTS mb_orders_state_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_bp_state_fkey') THEN
    ALTER TABLE mb_business_profiles ADD CONSTRAINT mb_bp_state_fkey
      FOREIGN KEY (state_code) REFERENCES mb_states(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_orders_place_of_supply_fkey') THEN
    ALTER TABLE mb_orders ADD CONSTRAINT mb_orders_place_of_supply_fkey
      FOREIGN KEY (place_of_supply_state) REFERENCES mb_states(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_orders_seller_state_fkey') THEN
    ALTER TABLE mb_orders ADD CONSTRAINT mb_orders_seller_state_fkey
      FOREIGN KEY (seller_state_code) REFERENCES mb_states(code);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The order status machine
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_order_statuses (
  code         text PRIMARY KEY,
  label        text NOT NULL,                   -- what a customer reads
  seller_label text NOT NULL,                   -- what the seller's filter chip says
  sort_order   integer NOT NULL DEFAULT 0,
  is_open      boolean NOT NULL DEFAULT true,   -- still in flight
  tone         text NOT NULL DEFAULT 'plain',   -- plain | yellow | out — how the pill is drawn
  CONSTRAINT mb_order_statuses_tone_check CHECK (tone IN ('plain','yellow','out'))
);

INSERT INTO mb_order_statuses (code, label, seller_label, sort_order, is_open, tone) VALUES
  ('placed',     'Placed',     'New',        1, true,  'yellow'),
  ('confirmed',  'Accepted',   'Accepted',   2, true,  'plain'),
  ('dispatched', 'Dispatched', 'Dispatched', 3, true,  'plain'),
  ('collected',  'Collected',  'Collected',  4, false, 'plain'),
  ('cancelled',  'Cancelled',  'Cancelled',  5, false, 'out')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE mb_orders DROP CONSTRAINT IF EXISTS mb_orders_status_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_orders_status_fkey') THEN
    ALTER TABLE mb_orders ADD CONSTRAINT mb_orders_status_fkey
      FOREIGN KEY (status) REFERENCES mb_order_statuses(code);
  END IF;
END $$;

-- Which moves exist, who may make them, and what the button says. The handler used to hold this as
-- a MOVES object and the front end as an ORDER_FLOW object — two copies of one state machine. Both
-- now read these rows, so a move that is not in this table cannot be made by anyone.
CREATE TABLE IF NOT EXISTS mb_order_transitions (
  actor        text NOT NULL,                   -- seller | customer
  action       text NOT NULL,
  from_status  text NOT NULL REFERENCES mb_order_statuses(code),
  to_status    text NOT NULL REFERENCES mb_order_statuses(code),
  label        text NOT NULL,                   -- the button, in the actor's words
  is_primary   boolean NOT NULL DEFAULT false,
  needs_reason boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (actor, action, from_status),
  CONSTRAINT mb_order_transitions_actor_check CHECK (actor IN ('seller','customer')),
  CONSTRAINT mb_order_transitions_moves_check CHECK (from_status <> to_status)
);

INSERT INTO mb_order_transitions
  (actor, action, from_status, to_status, label, is_primary, needs_reason, sort_order) VALUES
  ('seller',   'confirm',  'placed',     'confirmed',  'Accept',          true,  false, 1),
  ('seller',   'cancel',   'placed',     'cancelled',  'Reject',          false, true,  2),
  ('seller',   'dispatch', 'confirmed',  'dispatched', 'Dispatched',      true,  false, 1),
  ('seller',   'collect',  'confirmed',  'collected',  'Collected',       false, false, 2),
  ('seller',   'cancel',   'confirmed',  'cancelled',  'Cancel',          false, true,  3),
  ('seller',   'collect',  'dispatched', 'collected',  'Mark collected',  true,  false, 1),
  -- A customer may withdraw an order only while nobody has acted on it (FR-25.5).
  ('customer', 'cancel',   'placed',     'cancelled',  'Cancel this order', false, true, 1)
ON CONFLICT (actor, action, from_status) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. The small enums — their labels and their order
-- ---------------------------------------------------------------------------
--
-- These keep their CHECK constraints on the rows that use them, because the code branches on the
-- values and a new one needs code regardless. What does not belong in code is how they are spelled
-- on screen and what order they appear in, and that is what lives here.

CREATE TABLE IF NOT EXISTS mb_lookups (
  domain     text NOT NULL,
  code       text NOT NULL,
  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (domain, code)
);

INSERT INTO mb_lookups (domain, code, label, sort_order) VALUES
  ('account_type',      'individual',    'Individual',                  1),
  ('account_type',      'business',      'Business',                    2),

  ('business_status',   'none',          '—',                           1),
  ('business_status',   'pending',       'Being verified',              2),
  ('business_status',   'approved',      'Verified — trade pricing active', 3),
  ('business_status',   'rejected',      'Not approved',                4),

  ('owner_status',      'none',          'Not an owner',                1),
  ('owner_status',      'requested',     'Asked to sell here',          2),
  ('owner_status',      'approved',      'Approved to sell',            3),
  ('owner_status',      'rejected',      'Not approved to sell',        4),

  ('product_kind',      'material',      'Material',                    1),
  ('product_kind',      'service',       'Service',                     2),

  ('pricing_mode',      'fixed',         'Fixed price',                 1),
  ('pricing_mode',      'quote',         'Price on request',            2),

  ('stock_status',      'in_stock',      'In stock',                    1),
  ('stock_status',      'low',           'Low stock',                   2),
  ('stock_status',      'out_of_stock',  'Out of stock',                3),
  ('stock_status',      'made_to_order', 'Made to order',               4),

  ('collection_method', 'scan',          'Confirmed by the customer''s scan', 1),
  ('collection_method', 'manual',        'Marked by the store',         2),

  ('tax_split',         'cgst_sgst',     'CGST + SGST (same state)',    1),
  ('tax_split',         'igst',          'IGST (interstate)',           2),
  ('tax_split',         'unsplit',       'GST (seller state not set)',  3),

  -- The rates a seller may pick on the product form. Not a constraint — gst_rate is a number and
  -- the CHECK only holds it between 0 and 100 — but the list a form offers is reference data.
  ('gst_rate',          '0',             '0% — exempt',                 1),
  ('gst_rate',          '5',             '5%',                          2),
  ('gst_rate',          '12',            '12%',                         3),
  ('gst_rate',          '18',            '18%',                         4),
  ('gst_rate',          '28',            '28%',                         5)
ON CONFLICT (domain, code) DO NOTHING;

-- The stock_status pill colour belongs with the label, not in a stylesheet keyed by value.
UPDATE mb_lookups SET meta = '{"tone":"out"}'::jsonb
  WHERE domain = 'stock_status' AND code = 'out_of_stock' AND meta = '{}'::jsonb;
UPDATE mb_lookups SET meta = '{"tone":"low"}'::jsonb
  WHERE domain = 'stock_status' AND code = 'low' AND meta = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS mb_lookups_domain_idx ON mb_lookups (domain, sort_order);
