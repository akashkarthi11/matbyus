-- Orders. The first slice of Phase 2: a customer can buy a listing.
--
-- Deliberately narrower than FSD Phase 2 FR-25. There is one seller for now, so there is no
-- owner_id, no basket spanning owners, and no split into one order per owner. `owner_id` is added
-- here as nullable so that when the marketplace lands it is a backfill rather than a table rewrite.
--
-- Forward-only. 0000_baseline.sql is applied in production and is never edited.

CREATE TABLE IF NOT EXISTS mb_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text NOT NULL,
  customer_id           uuid NOT NULL REFERENCES mb_users(id),
  owner_id              uuid REFERENCES mb_users(id),      -- null until the marketplace exists
  status                text NOT NULL DEFAULT 'placed',

  -- Who supplied it and where it is going. Captured at placement so a later change to a setting or
  -- an address can never alter a placed order (FR-25.4).
  seller_state_code     text,
  place_of_supply_state text NOT NULL,

  ship_name             text NOT NULL,
  ship_phone            text NOT NULL,
  ship_line1            text NOT NULL,
  ship_line2            text,
  ship_city             text NOT NULL,
  ship_pincode          text NOT NULL,
  ship_note             text,

  subtotal_excl         numeric(12,2) NOT NULL,
  cgst                  numeric(12,2) NOT NULL DEFAULT 0,
  sgst                  numeric(12,2) NOT NULL DEFAULT 0,
  igst                  numeric(12,2) NOT NULL DEFAULT 0,
  tax_total             numeric(12,2) NOT NULL,
  total                 numeric(12,2) NOT NULL,
  -- Which GST regime the tax was recorded under. 'unsplit' is honest about the case where the
  -- seller's own state is not configured yet: the tax is correct, but matbyus is not yet claiming
  -- it is CGST+SGST or IGST, because that depends on a state it has not been told.
  tax_split             text NOT NULL DEFAULT 'unsplit',
  commission            numeric(12,2),                     -- FSD C4: nothing writes this

  placed_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  cancelled_at          timestamptz,
  cancel_reason         text,

  CONSTRAINT mb_orders_reference_key UNIQUE (reference),
  CONSTRAINT mb_orders_status_check
    CHECK (status IN ('placed','confirmed','dispatched','collected','cancelled')),
  CONSTRAINT mb_orders_tax_split_check CHECK (tax_split IN ('cgst_sgst','igst','unsplit')),
  CONSTRAINT mb_orders_pin_check CHECK (ship_pincode ~ '^[1-8][0-9]{5}$'),
  CONSTRAINT mb_orders_phone_check CHECK (ship_phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT mb_orders_state_check CHECK (place_of_supply_state ~ '^([0-3][0-9]|97)$'),

  -- One regime or the other, never both, and the parts must add up to the whole.
  CONSTRAINT mb_orders_split_shape_check CHECK (
    (tax_split = 'cgst_sgst' AND igst = 0 AND tax_total = cgst + sgst) OR
    (tax_split = 'igst'      AND cgst = 0 AND sgst = 0 AND tax_total = igst) OR
    (tax_split = 'unsplit'   AND cgst = 0 AND sgst = 0 AND igst = 0)
  ),
  CONSTRAINT mb_orders_total_check CHECK (total = subtotal_excl + tax_total),
  CONSTRAINT mb_orders_amounts_check CHECK (
    subtotal_excl >= 0 AND tax_total >= 0 AND cgst >= 0 AND sgst >= 0 AND igst >= 0)
);

CREATE INDEX IF NOT EXISTS mb_orders_customer_idx ON mb_orders (customer_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS mb_orders_owner_idx ON mb_orders (owner_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS mb_orders_status_idx ON mb_orders (status, placed_at DESC);

-- D-25: the item copies the listing's details rather than joining to it. An order is a record of
-- what was agreed, not a view of what the listing says today.
CREATE TABLE IF NOT EXISTS mb_order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES mb_orders(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES mb_products(id),
  name            text NOT NULL,
  sku             text NOT NULL,
  unit            text NOT NULL,
  hsn_sac         text,
  qty             numeric(12,3) NOT NULL,
  unit_price_excl numeric(12,2) NOT NULL,
  gst_rate        numeric(5,2) NOT NULL,
  line_excl       numeric(12,2) NOT NULL,
  line_tax        numeric(12,2) NOT NULL,
  line_total      numeric(12,2) NOT NULL,
  CONSTRAINT mb_order_items_qty_check CHECK (qty > 0),
  CONSTRAINT mb_order_items_amounts_check CHECK (
    unit_price_excl >= 0 AND line_excl >= 0 AND line_tax >= 0),
  CONSTRAINT mb_order_items_total_check CHECK (line_total = line_excl + line_tax)
);

CREATE INDEX IF NOT EXISTS mb_order_items_order_idx ON mb_order_items (order_id);
CREATE INDEX IF NOT EXISTS mb_order_items_product_idx ON mb_order_items (product_id);
