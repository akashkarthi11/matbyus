# TSD — matbyus Phase 1: accounts and catalog

| | |
|---|---|
| Document | Technical Specification |
| Version | 1.1 (draft, awaiting approval) |
| Date | 2026-11-23 |
| Market | India — GST, INR, Indian identifiers and formats |
| Implements | [FSD — Phase 1](FSD-phase-1-accounts-and-catalog.md) v1.1 |
| Repository | `akashkarthi11/matbyus`, branch `claude-dev` |
| Reference implementation | Wealth (`akashkarthi11/wealth`) — `api/_routes/auth.js`, `api/_lib.js`, `api/_roles.js` |

> **Status: Phase 1 is built and tested, and has not yet been deployed or run against a real
> database.** 70 tests pass (`node --test test/`, run in Docker). The schema tests exercise
> `0000_baseline.sql` itself in PGlite, so every CHECK constraint is proven to reject the row it
> exists for. The browser front end has been syntax-checked but **not yet opened in a browser**;
> the contrast figures in §8.2 are computed, not yet measured with a tool (acceptance criterion 8
> is therefore still open). Deployment needs a database, `MB_SESSION_SECRET`, and a first admin
> created with `scripts/admin/create-admin.mjs`.

---

## 1. Architecture

matbyus mirrors the Wealth stack, because that stack already works on this owner's hosting, network
and tooling, and because the auth code being ported assumes it.

| Layer | Choice | Why |
|---|---|---|
| Hosting | Vercel serverless functions | Same as Wealth; the deploy path from this machine is proven. |
| Runtime | Node 20+, ESM, no framework | Same as Wealth. No build step to debug, no framework upgrade treadmill. |
| Database | Neon Postgres via `@neondatabase/serverless` | Same as Wealth, including its driver behaviour under serverless connection churn. |
| Rate-limit store | Redis, optional | Same as Wealth. Optional by design — see D-6. |
| Frontend | Vanilla JS, one `app.js`, one `style.css` | Same as Wealth. Phase 1 is small; a framework would be the largest dependency in the project. |
| Tests | `node --test`, run in Docker | This machine has no local Node. Docker is the only runtime available. |
| Source control | GitHub via the `karthi-github-relay` Vercel project | github.com is unreachable from this machine; the relay is the only route. |

**Decision D-1.** No framework, no bundler, no CSS library in Phase 1. Revisit only when the
customer module outgrows a single `app.js`, which is unlikely before the cart exists.

## 2. Repository layout (target)

```
matbyus/
  api/
    _lib.js            shared: db, hashing, session, cookie, json, rate limiting, validation
    _roles.js          role to menu mapping, role guards
    _india.js          GSTIN/PAN/PIN/mobile validation, paise arithmetic, GST view, en-IN formatting
    auth.js            GET current user; POST ?action=register|login|logout|reset
    catalog.js         GET public catalog list and product detail
    admin.js           admin-only: products, categories, customers, approvals
    health.js          configuration and dependency check
  scripts/
    migrations/        0000_baseline.sql, 0001_*.sql ...
    migrate-db.mjs     applies pending migrations in order
    admin/
      create-admin.mjs    creates the first admin (operator-run)
      reset-password.mjs  recovery for a locked-out admin
    run-tests.mjs
  test/                unit and integration tests
  docs/                this folder
  index.html
  app.js
  style.css
  vercel.json
  package.json
```

## 3. Data model

All tables are prefixed `mb_`. UUID primary keys, `timestamptz` throughout.

### 3.1 `mb_users` — FR-1, FR-2, FR-5, FR-6

```sql
CREATE TABLE mb_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  full_name       text,
  phone           text NOT NULL,          -- +91XXXXXXXXXX, normalised on write
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
  -- an individual never carries a business status; a business always does
  CONSTRAINT mb_users_type_status_check CHECK (
    (account_type = 'individual' AND business_status = 'none') OR
    (account_type = 'business'   AND business_status <> 'none')
  ),
  -- FR-1.3: stored normalised, so the format is a constraint and not a convention
  CONSTRAINT mb_users_phone_check CHECK (phone ~ '^\+91[6-9][0-9]{9}$')
);
CREATE INDEX mb_users_pending_idx ON mb_users (business_status) WHERE business_status = 'pending';
```

**Decision D-2.** `role` and `account_type` are separate columns with separate CHECK constraints.
Collapsing them into one enum (`individual`, `business`, `admin`) is the obvious shortcut and is
wrong: it makes "approve this business" and "grant admin" the same operation, which is how
privilege-escalation bugs are written. The final CHECK makes the illegal state — an individual with
a business status, or a business with none — unrepresentable rather than merely discouraged.

### 3.2 `mb_business_profiles` — FR-6

```sql
CREATE TABLE mb_business_profiles (
  user_id        uuid PRIMARY KEY REFERENCES mb_users(id) ON DELETE CASCADE,
  legal_name     text NOT NULL,
  gstin          text,                    -- optional (FSD A6); format + checksum validated when given
  pan            text,
  state_code     text NOT NULL,           -- GST state code, '01'..'38', '97'
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
  -- FR-6.2: a GSTIN's first two digits are its state; they cannot contradict the address
  CONSTRAINT mb_bp_gstin_state_check CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);

CREATE TABLE mb_business_status_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  note        text,
  actor_id    uuid REFERENCES mb_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mb_bstatus_log_user_idx ON mb_business_status_log (user_id, created_at DESC);
```

**Decision D-3.** Status history is an append-only log table, not a column on the user. FR-6.6 and
NFR-3 require knowing who approved a business and when; a mutable column cannot answer that after
the second change.

### 3.3 `mb_categories` — FR-8.9

```sql
CREATE TABLE mb_categories (
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
```

### 3.4 `mb_products` — FR-8, FR-9, FR-10

```sql
CREATE TABLE mb_products (
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
  hsn_sac        text,                    -- HSN for a material, SAC for a service (FR-8.5)
  gst_rate       numeric(5,2) NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES mb_users(id),
  CONSTRAINT mb_products_kind_check CHECK (kind IN ('material','service')),
  CONSTRAINT mb_products_pmode_check CHECK (pricing_mode IN ('fixed','quote')),
  CONSTRAINT mb_products_stock_status_check
    CHECK (stock_status IN ('in_stock','low','out_of_stock','made_to_order')),
  -- a fixed-price product must have a retail price
  CONSTRAINT mb_products_fixed_needs_price
    CHECK (pricing_mode <> 'fixed' OR price_retail IS NOT NULL),
  -- services carry neither stock nor pack size (FSD FR-8.4)
  CONSTRAINT mb_products_service_no_stock
    CHECK (kind <> 'service' OR (stock_qty IS NULL AND pack_size IS NULL)),
  CONSTRAINT mb_products_prices_non_negative
    CHECK (COALESCE(price_retail, 0) >= 0 AND COALESCE(price_business, 0) >= 0),
  CONSTRAINT mb_products_quote_has_no_price
    CHECK (pricing_mode <> 'quote' OR (price_retail IS NULL AND price_business IS NULL)),
  -- FR-8.4: the unit list is closed, so quantities stay comparable across the catalog.
  -- SUPERSEDED 2026-11-24 by migration 0005: `unit` is now a FOREIGN KEY to mb_units, and the
  -- kind/unit rule is the mb_products_unit_kind trigger reading mb_units.applies_to. The list is
  -- still closed; it is a table rather than a CHECK. See docs/lookups.md.
  CONSTRAINT mb_products_unit_check CHECK (unit IN (
    'bag','kg','quintal','tonne','brass','cft','number','box','litre','bundle','sqft','rft',
    'per_sqft','per_day','per_visit','lumpsum')),
  -- material units are not service units and vice versa
  CONSTRAINT mb_products_unit_kind_check CHECK (
    (kind = 'service' AND unit IN ('per_sqft','per_day','per_visit','lumpsum','sqft','rft')) OR
    (kind = 'material' AND unit NOT IN ('per_sqft','per_day','per_visit','lumpsum'))),
  CONSTRAINT mb_products_gst_rate_check CHECK (gst_rate >= 0 AND gst_rate <= 100),
  -- FR-8.5: an active product must carry its tax code
  CONSTRAINT mb_products_active_needs_hsn CHECK (NOT is_active OR hsn_sac IS NOT NULL)
);
CREATE INDEX mb_products_browse_idx ON mb_products (kind, category_id) WHERE is_active;
CREATE INDEX mb_products_search_idx ON mb_products
  USING gin (to_tsvector('simple', name || ' ' || COALESCE(summary,''))) WHERE is_active;
```

**Decision D-4.** One `mb_products` table with a `kind` discriminator, not separate
`mb_materials` and `mb_services` tables. Both are browsed in one list, filtered by one set of
facets, and will sit in one cart in Phase 2; two tables would mean a UNION on every read for the
life of the project. The columns that genuinely differ (`stock_qty`, `pack_size`) are nullable and
held to the right shape by CHECK constraints rather than by convention.

**Decision D-5.** Category is `NOT NULL`. FR-8.6 requires a category before activation; enforcing it
at insert rather than at activation keeps the rule in one place.

## 4. Authentication

Ported from Wealth `api/_lib.js` and `api/_routes/auth.js`. Mechanism unchanged; policy differs as
recorded in FSD §11.

### 4.1 Password hashing — FR-1.3, NFR-1

scrypt, 16 random bytes of salt, 64-byte derived key, stored as `s1$<salt-b64url>$<hash-b64url>`.
Verification derives with the stored salt and compares with `timingSafeEqual`, returning false on any
parse failure rather than throwing. The `s1$` prefix is a version marker so a future algorithm change
can rehash on next sign-in without a flag day.

**Length policy (FSD L9).** `PASSWORD_MIN` is 1: there is no minimum length, removed on the owner's
instruction. `PASSWORD_MAX` stays at 200, and it is not a strength rule — it stops a caller pinning
a serverless function by making it scrypt a megabyte, so it must not be removed alongside the
minimum. The two are in the same constant block for that reason, with the distinction written down.

With no length floor, the rate limiter of §4.3 is the control that keeps a short password out of
reach of online guessing, and `test/auth.test.mjs` asserts that directly rather than leaving it
implied. **If the rate limiter is ever weakened, L9 has to be reopened.**

### 4.2 Session — FR-3

Cookie `mb_session`, value `base64url({uid, exp, sv})` + `.` + HMAC-SHA256 of that body, keyed on
`MB_SESSION_SECRET` (minimum 32 characters; the helper refuses to issue a token otherwise, and
`/api/health` reports the misconfiguration without printing the value).

Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` (7 days).

Verification order: signature (constant-time) → expiry → `sv` against `mb_users.session_version`.
Any failure is indistinguishable to the caller from "signed out".

**Decision D-6.** Sessions stay stateless, as in Wealth. The cost is FSD L5 — sessions cannot be
revoked individually. The benefit is that an unauthenticated catalog page load touches no session
store at all, which is what makes NFR-4 reachable on serverless. Revocation-per-user is covered by
bumping `session_version`, which is the case that actually matters (password reset, account
compromise).

### 4.3 Rate limiting — FR-2.3, FR-2.4, NFR-5

Redis counters, 15-minute windows: 5 failed sign-ins per email, 20 per IP. Registration and reset
share the IP counter so neither becomes a way to probe around the sign-in limit. A limit breach
returns 429 with `Retry-After`. A successful sign-in clears that email's counter.

**Fails open.** If Redis is unreachable, every check reports "not limited" and the storefront keeps
serving. This is a deliberate availability-over-enforcement trade (NFR-5), copied from Wealth. It is
only defensible because passwords are scrypt-hashed and sign-in errors are uniform; it would not be
if either of those changed.

### 4.4 Role enforcement — FR-5

`api/_roles.js` holds the permission boundary: who is refused, and how an owner's queries are
narrowed. It no longer holds the menus.

**Decision D-7 — menus are a constant keyed by role, not a database table.** The reasoning was that
Wealth makes them configurable because its admin tailors one deployment, while a storefront's
navigation is part of the product; a constant removed a table, an admin screen and a class of
"the menu says I can but the API says I can't" bugs.

> **D-7 was reversed, twice.** Migration `0003_role_menus.sql` added `mb_role_menus` so an admin can
> switch a role's menus off, and migration `0005_lookups.sql` moved the menu *catalogue* itself into
> `mb_menus`. The bug class D-7 was protecting against is handled instead by the rule that menu
> visibility grants and removes nothing, pinned by the test that switches every customer menu off and
> proves they can still order. See [docs/lookups.md](lookups.md) and
> [docs/permissions.md](permissions.md).
>
> There are now three roles, not two: `customer`, `owner` and `admin`.

Every seller and platform handler calls its guard first and returns 403 before reading a request
body. Menu visibility is presentation only — FR-5.4.

## 5. API contracts

All responses are JSON. All errors are `{ error: "<human sentence>" }`. No error ever contains a
password, a token, a secret name's value, or a stack trace.

### `GET /api/auth` — current user

`200 {user: null}` when signed out. Otherwise:

```json
{ "user": { "id": "...", "email": "...", "role": "customer",
            "accountType": "business", "businessStatus": "approved",
            "fullName": "...", "menus": ["materials","services","account"] } }
```

### `POST /api/auth?action=register|login|logout|reset`

| Action | Body | Success | Failures |
|---|---|---|---|
| `register` | `{email, password, fullName, accountType, business?}` | `201 {user}` + cookie | 400 invalid email / password policy; 409 email exists |
| `login` | `{email, password}` | `200 {user}` + cookie | 401 uniform message; 429 + `Retry-After` |
| `logout` | — | `200 {ok:true}` + cleared cookie | — |
| `reset` | `{email, password}` | `200 {ok:true}` | 403 caller is not a signed-in admin; 404 no such account |

`business` on register is `{legalName, taxId, contactPerson, addressLine1, addressLine2, city, region, postcode}`,
required when `accountType` is `business`.

### `GET /api/catalog`

Public. Query: `kind`, `category`, `q`, `page`, `pageSize` (default 24, max 100).

Returns `{items:[...], page, pageSize, total}`. Each item carries `price` and `priceLabel` already
**resolved for the caller** by §6 — the browser receives one price, never both.

### `GET /api/catalog?slug=<slug>`

Returns one active product, or 404. Never returns an inactive product (FR-9.6).

### `/api/admin` — admin only

`GET ?resource=customers|products|categories|approvals` to list;
`POST ?resource=...&action=create|update|activate|deactivate|approve|reject` to change.
Every call passes the role guard of §4.4 first.

## 6. Price resolution — FR-10

One server-side function, used by every read path that returns a price:

```
resolvePrice(product, viewer):
  if product.pricing_mode == 'quote'              -> { price: null, label: 'Request a quote' }
  if viewer is an approved business
     and product.price_business is not null       -> { price: business, label: 'Business price',
                                                       compareAt: retail }
  otherwise                                       -> { price: retail,  label: 'Price' }
```

**Decision D-8.** The business price is resolved on the server and the losing price is never
serialised, except as `compareAt` for a viewer already entitled to the business price. Sending both
prices and letting the browser choose would put the trade price list in the page source of every
anonymous visitor.

## 7. India: tax, identifiers and formats — FR-12, FR-13

### 7.1 Money arithmetic

**Decision D-10.** Money is never held in a JavaScript `number` during a calculation. Prices are
`numeric(12,2)` in Postgres and are carried through the application as integer **paise**, converting
to a formatted string only at the edge. GST at 18% on ₹1,24,500 must produce the same paise every
time, on every machine (NFR-9). Floating point does not guarantee that, and a construction invoice
disputed over a paisa costs more to explain than the arithmetic costs to do properly.

### 7.2 GST on display — FR-12

Stored price is always GST-exclusive. One function derives everything shown:

```
gstView(product, viewer):
  base  = resolvePrice(product, viewer)         // section 6, in paise
  if base.price is null -> quote, no tax line
  tax   = roundHalfUp(base.price * product.gst_rate / 100)
  incl  = base.price + tax
  if viewer is an approved business -> headline = base.price, then "+ GST", then incl
  otherwise                         -> headline = incl,       then "incl. <rate>% GST"
```

Rounding happens once, on the final figure, half-up, to the paisa (FR-12.6). A zero rate renders no
tax line at all (FR-12.7).

**Phase 1 does not split the tax.** Whether a sale attracts CGST+SGST or IGST depends on place of
supply, which is a property of an order, and there are no orders yet. The inputs that decision will
need — `MB_SELLER_STATE_CODE`, the buyer's `state_code`, `hsn_sac`, `gst_rate` — are all captured in
Phase 1 so Phase 2 adds a table, not a backfill.

### 7.3 Indian identifiers

| Identifier | Rule | Enforced where |
|---|---|---|
| GSTIN | 15 chars: 2-digit state code, 10-char PAN, entity code, `Z`, check char | Format in a CHECK constraint; **checksum in application code** |
| PAN | `AAAAA9999A` | CHECK constraint |
| PIN code | 6 digits, first digit 1–8 | CHECK constraint |
| Mobile | 10 digits beginning 6–9, stored `+91XXXXXXXXXX` | Normalised on write, then CHECK constraint |
| State code | `01`–`38`, or `97` | CHECK constraint, and must equal the GSTIN's first two digits |

**Decision D-11.** The GSTIN *checksum* is validated in application code, not in a CHECK constraint.
The algorithm is a mod-36 weighted sum, which Postgres can only express as a stored function — and a
stored function in a migration is harder to test and version than a JavaScript function with a unit
test. The database still refuses a structurally wrong GSTIN; the application refuses an
arithmetically wrong one.

The checksum: map `0-9` to 0–35 and `A-Z` to 10–35; for each of the first 14 characters multiply its
value by an alternating factor of 1, 2, 1, 2 …; for each product add `floor(p / 36) + (p mod 36)`;
the check character is the one whose value is `(36 - (sum mod 36)) mod 36`.
**This implementation must be unit-tested against a set of known-valid GSTINs before it is trusted**
— a checksum implemented from a description and never checked against real data is worse than none,
because it rejects honest customers.

matbyus does **not** call the GSTN portal to confirm a GSTIN belongs to the business claiming it
(FSD L7). Format and checksum catch typos and invented numbers, which is what Phase 1 needs.

### 7.4 Formatting

| Thing | Rule | Implementation |
|---|---|---|
| Money | `₹1,24,500.00` — Indian grouping | `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})` |
| Dates | `DD/MM/YYYY`, IST | Stored `timestamptz` in UTC; formatted with `timeZone: 'Asia/Kolkata'` |
| Mobile | `+91 98765 43210` | Formatted at the edge from the stored normalised value |
| Quantity | `10 bags`, `2 brass`, `500 nos` | Unit label table keyed on the `unit` enum of §3.4 |

Indian digit grouping is not a `toLocaleString` afterthought — `en-IN` groups the last three digits
then in pairs, so a naive thousands separator produces a number an Indian buyer reads as wrong.
It is covered by an explicit test.

## 8. Theme — FR-11

Dark-first. Black and near-black surfaces, yellow reserved for action and emphasis, grey-white body
text. The look is deliberately industrial — hazard yellow on black is the construction trade's own
colour language.

### 8.1 Tokens

```css
:root {
  --mb-yellow:        #FFC400;  /* primary action, emphasis */
  --mb-yellow-bright: #FFD740;  /* hover */
  --mb-yellow-dim:    #C99A00;  /* pressed, borders on yellow surfaces */
  --mb-black:         #0D0D0D;  /* page background */
  --mb-surface:       #1A1A1A;  /* cards, panels */
  --mb-surface-2:     #262626;  /* raised rows, table headers */
  --mb-border:        #3A3A3A;
  --mb-text:          #F5F5F5;  /* body text */
  --mb-text-muted:    #A3A3A3;  /* secondary text */
  --mb-on-yellow:     #0D0D0D;  /* text on a yellow surface */
  --mb-danger:        #FF5A4E;
  --mb-success:       #4ADE80;
  --mb-focus:         #7FD4FF;  /* focus ring - deliberately NOT yellow */
}
```

### 8.2 Contrast — FR-11.3

Computed WCAG 2.1 ratios for the pairings actually used:

| Foreground | Background | Ratio | Passes |
|---|---|---|---|
| `--mb-text` #F5F5F5 | `--mb-black` #0D0D0D | ≈ 17.8 : 1 | AAA |
| `--mb-yellow` #FFC400 | `--mb-black` #0D0D0D | ≈ 12.2 : 1 | AAA |
| `--mb-on-yellow` #0D0D0D | `--mb-yellow` #FFC400 | ≈ 12.2 : 1 | AAA |
| `--mb-text-muted` #A3A3A3 | `--mb-black` #0D0D0D | ≈ 7.7 : 1 | AAA |
| `--mb-text` #F5F5F5 | `--mb-surface` #1A1A1A | ≈ 16.1 : 1 | AAA |

These are computed values and are to be re-checked with a contrast tool during build, with the
result recorded against acceptance criterion 8.

**Rules.** Yellow is never placed on white or on any surface lighter than `--mb-surface-2`. Yellow
text is never used below 16px. The focus ring is `--mb-focus`, never yellow, because a yellow ring on
a yellow button is invisible — which is exactly the control a keyboard user most needs to see.

**Decision D-9.** A single dark theme in Phase 1. A light mode is a token-set swap under
`@media (prefers-color-scheme: light)` and the variables above are structured to allow it, but
shipping one theme means one set of contrast checks, not two.

## 9. Configuration

| Variable | Purpose | Absent behaviour |
|---|---|---|
| `DATABASE_URL` | Neon connection string | `/api/health` reports it; APIs return 503 naming the variable, never its value |
| `MB_SESSION_SECRET` | HMAC key, ≥ 32 chars | Session issuing refuses; health reports it |
| `REDIS_URL` | Rate-limit store | Optional. Rate limiting fails open (§4.3) |
| `MB_SELLER_STATE_CODE` | The GST state the seller is registered in (A1). Decides CGST+SGST vs IGST in Phase 2 | Health reports it; Phase 1 still runs, since it issues no invoice |
| `MB_SELLER_GSTIN` | The seller's own GSTIN, shown on the storefront and later on invoices | Health reports it; tax lines are suppressed if absent (FR-12.7) |

No shared registration key exists, by design (FSD V1). The first admin is created by
`scripts/admin/create-admin.mjs`, run by the operator against the target database — never through
an HTTP endpoint.

## 10. Migrations

Numbered, forward-only SQL in `scripts/migrations/`, applied in filename order by `migrate-db.mjs`,
which records applied files in a `mb_migrations` table and is safe to re-run. `0000_baseline.sql`
carries the whole of §3. Phase 1 ships exactly one migration; later phases add numbered files and
never edit `0000`.

## 11. Testing — NFR-7

`node --test`, run in Docker (`node:20-alpine`), against PGlite for anything touching SQL so the
suite needs no network and no live database.

| Area | Must prove |
|---|---|
| Hashing | A correct password verifies; a wrong one does not; a corrupt hash returns false rather than throwing |
| Session | A valid cookie resolves; a tampered signature, an expired token and a stale `sv` each resolve to signed-out |
| Registration | Policy enforced; duplicate email is 409; **a register call cannot produce `role='admin'`** |
| Sign in | Unknown email and wrong password are byte-identical responses; 6th failure is 429; Redis down still signs in |
| Reset | Anonymous is 403; admin succeeds; the target's old session dies; an admin resetting their own keeps theirs |
| Role guard | Every admin route returns 403 for a customer session |
| Price resolution | All five branches of §6, including that a business price never appears for a pending business |
| Schema | Each CHECK constraint rejects the illegal row it exists for |
| GSTIN | **Checksum accepts a set of known-valid GSTINs and rejects each one with a single character altered** (D-11); a GSTIN whose state code contradicts the address is refused; absent GSTIN is accepted |
| PAN, PIN, mobile | Each format rule accepts valid values and rejects the near-misses; `098765 43210` and `+91-98765-43210` both normalise to `+919876543210` |
| GST display | An individual sees the inclusive headline, an approved business the exclusive headline; a zero rate renders no tax line; rounding happens once and matches a hand-computed paise figure |
| Money arithmetic | A rate applied to a large value is exact to the paisa and never drifts (D-10, NFR-9) |
| Indian formatting | 124500 renders `₹1,24,500.00`, not `₹124,500.00`; a date renders `DD/MM/YYYY` in IST when the process runs in UTC |

## 12. Deployment

Vercel, same path as Wealth: build and test locally in Docker, commit locally, push to
`claude-dev` through the relay, deploy with the Vercel CLI in Docker. `main` is not pushed through
the relay. The repository already carries `main`, `claude-dev` and `development`, and
`akashkarthi11/matbyus` is on the relay's `GITHUB_RELAY_REPOS` allowlist.

The Wealth push script is hardcoded to its own repository; matbyus needs its own copy that passes
`repo` to the relay. That is a Phase 1 build task.

## 13. Traceability

| FSD requirement | Design | Target file | Proven by |
|---|---|---|---|
| FR-1 registration | §3.1, §4.1, §5, §7.3 | `api/auth.js`, `0000_baseline.sql` | Registration tests, §11 |
| FR-2 sign in | §4.1, §4.3, §5 | `api/auth.js`, `api/_lib.js` | Sign-in tests, §11 |
| FR-3 session | §4.2 | `api/_lib.js` | Session tests, §11 |
| FR-4 reset | §4.2, §5 | `api/auth.js`, `scripts/admin/reset-password.mjs` | Reset tests, §11 |
| FR-5 modules | §4.4, D-7 | `api/_roles.js`, `app.js` | Role-guard tests, §11 |
| FR-6 business verification | §3.1, §3.2, §7.3, D-2, D-3, D-11 | `api/admin.js`, `api/_india.js`, `0000_baseline.sql` | Schema + GSTIN + approval tests |
| FR-7 admin customers | §5 | `api/admin.js` | Role-guard + approval tests |
| FR-8 catalog management | §3.3, §3.4, D-4, D-5 | `api/admin.js` | Schema constraint tests |
| FR-9 browse | §5, §3.4 indexes | `api/catalog.js`, `app.js` | Catalog tests |
| FR-10 price visibility | §6, D-8 | `api/catalog.js` | Price-resolution tests |
| FR-11 theme | §8 | `style.css` | Contrast check, acceptance 8 |
| FR-12 GST and tax presentation | §7.1, §7.2, D-10 | `api/_india.js`, `api/catalog.js` | GST display + money arithmetic tests |
| FR-13 Indian formats | §7.3, §7.4, D-11 | `api/_india.js`, `app.js`, `style.css` | Format + identifier tests, acceptance 11–12 |
| NFR-1, NFR-2, NFR-10 | §4.1, §5, §9 | `api/_lib.js` | Error-shape tests |
| NFR-3 | §3.2, D-3 | `0000_baseline.sql` | Status-log tests |
| NFR-4 | §3.4 indexes, D-6 | `0000_baseline.sql` | Timed catalog query |
| NFR-5 | §4.3 | `api/_lib.js` | Redis-down sign-in test |
| NFR-6 | §5 | all handlers | Input-validation tests |
| NFR-7 | §11 | `test/` | The suite itself |
| NFR-8 mobile-first | §8, FSD C9 | `style.css` | 360px check, acceptance 12 |
| NFR-9 exact money | §7.1, D-10 | `api/_india.js` | Money arithmetic tests |

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Admin-assisted password reset (FSD L1) becomes unworkable as customers arrive | Treat Phase 2 email reset as a launch blocker, not an enhancement |
| R2 | Fail-open rate limiting is a weakness if password hashing or error uniformity regress | The §11 tests pin both; they must not be weakened |
| R3 | The business-tier price column (A4) proves too coarse | D-4 keeps prices on the product; moving to a price-list table is one migration plus a change to §6 alone |
| R4 | `0000_baseline.sql` grows wrong before launch | Forward-only numbered migrations from the first deploy; never edit an applied file |
| R5 | A second product kind (hire, rental) appears later | D-4's discriminator absorbs it; the CHECK constraints are the only edit |
| R6 | **The GSTIN checksum is implemented from a description and rejects valid customers** | D-11 makes testing against known-valid GSTINs a release condition. Until that test exists, treat the checksum as unverified and let format validation stand alone |
| R7 | GST rates move by notification and the catalog goes stale | Rates are per-product and admin-editable (A2); no rate is in code. An admin screen to bulk-edit by HSN is a cheap Phase 2 addition |
| R8 | Individual buyers bounce at an email-and-password sign-in (FSD L6) | Mobile is captured from day one, so OTP sign-in is a new route over existing data, not a migration and a re-registration |
| R9 | Storing GST-exclusive prices (C3) surprises an admin entering MRP-style figures | The admin product form labels the field "Price excluding GST" and shows the computed inclusive figure live beside it |
