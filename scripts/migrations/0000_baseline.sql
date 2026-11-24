-- matbyus baseline schema. TSD section 3.
-- Forward-only. Once this file has been applied anywhere, it is never edited; later changes
-- arrive as 0001_, 0002_ ... (TSD section 10, risk R4).

-- ---------------------------------------------------------------------------
-- Accounts (FR-1, FR-2, FR-5, FR-6)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  full_name       text,
  phone           text NOT NULL,
  role            text NOT NULL DEFAULT 'customer',
  account_type    text NOT NULL DEFAULT 'individual',
  business_status text NOT NULL DEFAULT 'none',
  session_version integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_users_email_key UNIQUE (email),
  CONSTRAINT mb_users_role_check CHECK (role IN ('customer','admin')),
  CONSTRAINT mb_users_type_check CHECK (account_type IN ('individual','business')),
  CONSTRAINT mb_users_bstatus_check CHECK (business_status IN ('none','pending','approved','rejected')),
  -- D-2: an individual never carries a business status, a business always does.
  CONSTRAINT mb_users_type_status_check CHECK (
    (account_type = 'individual' AND business_status = 'none') OR
    (account_type = 'business'   AND business_status <> 'none')
  ),
  -- FR-1.3: stored normalised, so the format is a constraint rather than a convention.
  CONSTRAINT mb_users_phone_check CHECK (phone ~ '^\+91[6-9][0-9]{9}$')
);

CREATE INDEX IF NOT EXISTS mb_users_pending_idx
  ON mb_users (business_status) WHERE business_status = 'pending';

CREATE TABLE IF NOT EXISTS mb_business_profiles (
  user_id        uuid PRIMARY KEY REFERENCES mb_users(id) ON DELETE CASCADE,
  legal_name     text NOT NULL,
  gstin          text,
  pan            text,
  state_code     text NOT NULL,
  contact_person text,
  address_line1  text NOT NULL,
  address_line2  text,
  city           text NOT NULL,
  pincode        text NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_bp_gstin_check CHECK (
    gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT mb_bp_pan_check   CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT mb_bp_pin_check   CHECK (pincode ~ '^[1-8][0-9]{5}$'),
  CONSTRAINT mb_bp_state_check CHECK (state_code ~ '^([0-3][0-9]|97)$'),
  -- FR-6.2: a GSTIN's first two digits are its state; they cannot contradict the address.
  CONSTRAINT mb_bp_gstin_state_check CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);

-- D-3: status history is append-only. A mutable column cannot answer "who approved this, and when"
-- after the second change (FR-6.9, NFR-3).
CREATE TABLE IF NOT EXISTS mb_business_status_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  note        text,
  actor_id    uuid REFERENCES mb_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mb_bstatus_log_user_idx
  ON mb_business_status_log (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Catalog (FR-8, FR-9, FR-10)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  kind       text NOT NULL,
  parent_id  uuid REFERENCES mb_categories(id),
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_categories_kind_check CHECK (kind IN ('material','service'))
);

-- D-4: one table with a `kind` discriminator. Both kinds are browsed in one list and will sit in
-- one cart; two tables would mean a UNION on every read for the life of the project.
CREATE TABLE IF NOT EXISTS mb_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku            text NOT NULL UNIQUE,
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  kind           text NOT NULL,
  category_id    uuid NOT NULL REFERENCES mb_categories(id),
  summary        text,
  description    text,
  unit           text NOT NULL,
  pack_size      numeric(12,3),
  pricing_mode   text NOT NULL DEFAULT 'fixed',
  price_retail   numeric(12,2),
  price_business numeric(12,2),
  min_order_qty  numeric(12,3) NOT NULL DEFAULT 1,
  stock_qty      numeric(12,3),
  stock_status   text NOT NULL DEFAULT 'in_stock',
  hsn_sac        text,
  gst_rate       numeric(5,2) NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES mb_users(id),
  CONSTRAINT mb_products_kind_check CHECK (kind IN ('material','service')),
  CONSTRAINT mb_products_pmode_check CHECK (pricing_mode IN ('fixed','quote')),
  CONSTRAINT mb_products_stock_status_check
    CHECK (stock_status IN ('in_stock','low','out_of_stock','made_to_order')),
  CONSTRAINT mb_products_fixed_needs_price
    CHECK (pricing_mode <> 'fixed' OR price_retail IS NOT NULL),
  CONSTRAINT mb_products_service_no_stock
    CHECK (kind <> 'service' OR (stock_qty IS NULL AND pack_size IS NULL)),
  CONSTRAINT mb_products_prices_non_negative
    CHECK (COALESCE(price_retail, 0) >= 0 AND COALESCE(price_business, 0) >= 0),
  CONSTRAINT mb_products_quote_has_no_price
    CHECK (pricing_mode <> 'quote' OR (price_retail IS NULL AND price_business IS NULL)),
  -- FR-8.4: a closed unit list keeps quantities comparable across the catalog.
  CONSTRAINT mb_products_unit_check CHECK (unit IN (
    'bag','kg','quintal','tonne','brass','cft','number','box','litre','bundle','sqft','rft',
    'per_sqft','per_day','per_visit','lumpsum')),
  CONSTRAINT mb_products_unit_kind_check CHECK (
    (kind = 'service'  AND unit IN ('per_sqft','per_day','per_visit','lumpsum','sqft','rft')) OR
    (kind = 'material' AND unit NOT IN ('per_sqft','per_day','per_visit','lumpsum'))),
  CONSTRAINT mb_products_gst_rate_check CHECK (gst_rate >= 0 AND gst_rate <= 100),
  -- FR-8.5: an active product must carry its HSN (material) or SAC (service) code.
  CONSTRAINT mb_products_active_needs_hsn CHECK (NOT is_active OR hsn_sac IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mb_products_browse_idx
  ON mb_products (kind, category_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS mb_products_search_idx
  ON mb_products USING gin (to_tsvector('simple', name || ' ' || COALESCE(summary, '')))
  WHERE is_active;
