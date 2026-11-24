# TSD — matbyus Phase 2: marketplace, negotiation and orders

| | |
|---|---|
| Document | Technical Specification |
| Version | 1.0 (draft, awaiting approval) |
| Date | 2026-11-23 |
| Implements | [FSD Phase 2](FSD-phase-2-marketplace.md) v1.0 |
| Builds on | [TSD Phase 1](TSD-phase-1-accounts-and-catalog.md) v1.1 — built, tested and deployed |

> **Build status, 2026-11-24 — partly built.** The three roles exist and are live: `customer`,
> `owner` and `admin`, where `admin` is what this document calls `superadmin`. Owner onboarding,
> per-owner listings, per-owner order scoping, per-owner GST, the owner list with sales totals, and
> admin creation and removal are all built, and so is the **QR handover** (FR-29.9) — see
> [The QR handover](handover.md). As of 2026-11-24, **messages (FR-23), bids (FR-24), the
> multi-owner basket (FR-25.1-2) and in-app notifications (FR-28) are built too.** What remains is
> only what §6 rules out of scope: payments, delivery, returns, ratings, message attachments, push
> or email delivery, and commission. See [Who can see and do what](permissions.md) for the live
> matrix and [the documentation index](index.md) for the line-by-line split.

---

## 1. The shape of the change

Phase 1 answers "what is for sale". Phase 2 has to answer "whose is it, what did they agree, and
what was bought" — and it has to answer the last two for people who must not see each other's
answers. Three forces drive every decision below:

1. **Ownership is a filter on everything.** Listings, bids, conversations and orders all belong to
   one owner and one customer. A query that forgets the filter is a data breach, not a bug.
2. **Agreed numbers must freeze.** A price negotiated on Tuesday and ordered on Wednesday is
   Tuesday's price. Anything derived at display time will eventually disagree with what was agreed.
3. **GST becomes per-order.** The supplier is the owner, so the owner's state and GSTIN, and the
   delivery state, decide the split. None of that can live in deployment settings any more.

## 2. Roles and the privilege boundary

`mb_users.role` becomes `customer` | `owner` | `superadmin`; `admin` is retired.

**Decision D-20.** Being an owner is two facts, not one: the role, and the approval that earned it.
They are separate columns with a constraint tying them together, so "approved but not an owner" and
"owner but never approved" are both unrepresentable. The alternative — inferring the role from the
status — is the same mistake as collapsing role and account type in Phase 1 (D-2).

**Decision D-21.** Granting `superadmin` is not an API action a request can ask for by setting a
field. It is its own endpoint, callable only by a superadmin, and it refuses to leave fewer than one
superadmin in existence. The count is checked in the same statement that performs the update, not
read first and acted on afterwards, so two concurrent revocations cannot both pass the check.

## 3. Schema (migration `0001_marketplace.sql`)

Forward-only. `0000_baseline.sql` is applied in production and is never edited (TSD Phase 1 §10).

### 3.1 Roles and owner onboarding

```sql
ALTER TABLE mb_users DROP CONSTRAINT mb_users_role_check;
UPDATE mb_users SET role = 'superadmin' WHERE role = 'admin';        -- FSD section 9.1
ALTER TABLE mb_users ADD CONSTRAINT mb_users_role_check
  CHECK (role IN ('customer','owner','superadmin'));

ALTER TABLE mb_users ADD COLUMN owner_status text NOT NULL DEFAULT 'none';
ALTER TABLE mb_users ADD CONSTRAINT mb_users_owner_status_check
  CHECK (owner_status IN ('none','pending','approved','rejected'));
-- D-20: an owner is, by definition, an approved one.
ALTER TABLE mb_users ADD CONSTRAINT mb_users_owner_role_check
  CHECK (role <> 'owner' OR owner_status = 'approved');

-- The owner's trading identity reuses the Phase 1 business profile: the fields are the same ones,
-- and one login may be both a business buyer and a seller.
ALTER TABLE mb_business_profiles ADD COLUMN shop_name text;

-- The Phase 1 status log gains a subject, so owner and role changes are audited the same way
-- business verification already is (NFR-3).
ALTER TABLE mb_business_status_log ADD COLUMN kind text NOT NULL DEFAULT 'business';
ALTER TABLE mb_business_status_log ADD CONSTRAINT mb_bsl_kind_check
  CHECK (kind IN ('business','owner','role'));
```

### 3.2 Listings belong to an owner

```sql
ALTER TABLE mb_products ADD COLUMN owner_id uuid REFERENCES mb_users(id);
CREATE INDEX mb_products_owner_idx ON mb_products (owner_id, is_active);
```

`owner_id` is left nullable by the migration and made `NOT NULL` by a second, later migration, once
the eleven seeded products have been assigned or deactivated (FSD §9.2). **That decision is the
owner's and is not guessed here**; a listing nobody owns cannot be sold, so until it is made the
catalogue query treats a null owner as inactive.

### 3.3 Conversations

```sql
CREATE TABLE mb_threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  product_id       uuid REFERENCES mb_products(id),
  customer_unread  integer NOT NULL DEFAULT 0,
  owner_unread     integer NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_threads_parties_differ CHECK (customer_id <> owner_id),
  -- FR-23.2: one conversation per customer, owner and listing. NULLS NOT DISTINCT is what makes
  -- the general (no listing) thread unique too; without it Postgres treats each NULL as different
  -- and a customer would accumulate a new "general" thread on every message.
  CONSTRAINT mb_threads_unique UNIQUE NULLS NOT DISTINCT (customer_id, owner_id, product_id)
);
CREATE INDEX mb_threads_owner_idx ON mb_threads (owner_id, last_message_at DESC);
CREATE INDEX mb_threads_customer_idx ON mb_threads (customer_id, last_message_at DESC);

CREATE TABLE mb_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES mb_threads(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES mb_users(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_messages_body_check CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX mb_messages_thread_idx ON mb_messages (thread_id, created_at);
```

**Decision D-22.** Unread counts are columns on the thread, maintained as messages are written, not
a `count(*)` over unread messages at read time. NFR-23 rules out the scan, and the counter is the
cheap correct answer for the one question the UI actually asks.

### 3.4 Bids

```sql
CREATE TABLE mb_bids (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES mb_threads(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES mb_products(id),
  customer_id   uuid NOT NULL REFERENCES mb_users(id),
  owner_id      uuid NOT NULL REFERENCES mb_users(id),
  qty           numeric(12,3) NOT NULL,
  opening_price numeric(12,2),            -- what the customer first offered; null for a quote request
  current_price numeric(12,2),            -- what is on the table now, after any counters
  turn          text NOT NULL DEFAULT 'owner',
  status        text NOT NULL DEFAULT 'open',
  expires_at    timestamptz NOT NULL,
  order_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_bids_qty_check CHECK (qty > 0),
  CONSTRAINT mb_bids_price_check CHECK (
    (opening_price IS NULL OR opening_price >= 0) AND (current_price IS NULL OR current_price >= 0)),
  CONSTRAINT mb_bids_turn_check CHECK (turn IN ('owner','customer')),
  CONSTRAINT mb_bids_status_check
    CHECK (status IN ('open','countered','accepted','rejected','withdrawn','expired','ordered')),
  -- an accepted bid has a number; a settled bid is nobody's turn to answer
  CONSTRAINT mb_bids_accepted_has_price
    CHECK (status <> 'accepted' OR current_price IS NOT NULL),
  CONSTRAINT mb_bids_ordered_has_order
    CHECK ((status = 'ordered') = (order_id IS NOT NULL))
);
CREATE INDEX mb_bids_owner_open_idx ON mb_bids (owner_id, status, expires_at);
CREATE INDEX mb_bids_customer_idx ON mb_bids (customer_id, created_at DESC);

-- FR-24.5, append-only. Who moved, from what to what, and when.
CREATE TABLE mb_bid_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id     uuid NOT NULL REFERENCES mb_bids(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES mb_users(id),
  action     text NOT NULL,
  from_price numeric(12,2),
  to_price   numeric(12,2),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_bid_events_action_check CHECK (
    action IN ('placed','countered','accepted','rejected','withdrawn','expired','ordered'))
);
CREATE INDEX mb_bid_events_bid_idx ON mb_bid_events (bid_id, created_at);
```

**Decision D-23.** Expiry is honoured by the **reader**, not by a job. A bid is treated as expired
the moment `expires_at` has passed, in the query and in every state transition, and a sweeper only
tidies the stored status afterwards. A design that waits for a cron to mark bids expired leaves a
window where a stale price can still be accepted, which is exactly the thing expiry exists to stop.

**Decision D-24.** Every move is one statement with the current state in its `WHERE` clause —
`UPDATE ... WHERE id = $1 AND status = $2 AND expires_at > now()`. If it updates no rows, the move
is refused with the current state. Reading the bid, deciding, and then writing would let two
simultaneous accepts both succeed.

### 3.5 Orders

```sql
CREATE TABLE mb_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text NOT NULL UNIQUE,
  customer_id           uuid NOT NULL REFERENCES mb_users(id),
  owner_id              uuid NOT NULL REFERENCES mb_users(id),
  status                text NOT NULL DEFAULT 'placed',
  -- the supplier, frozen at placement (FR-26.1, FR-26.4)
  owner_gstin           text NOT NULL,
  owner_state_code      text NOT NULL,
  place_of_supply_state text NOT NULL,
  is_interstate         boolean NOT NULL,
  ship_name             text NOT NULL,
  ship_phone            text NOT NULL,
  ship_line1            text NOT NULL,
  ship_line2            text,
  ship_city             text NOT NULL,
  ship_pincode          text NOT NULL,
  subtotal_excl         numeric(12,2) NOT NULL,
  cgst                  numeric(12,2) NOT NULL DEFAULT 0,
  sgst                  numeric(12,2) NOT NULL DEFAULT 0,
  igst                  numeric(12,2) NOT NULL DEFAULT 0,
  tax_total             numeric(12,2) NOT NULL,
  total                 numeric(12,2) NOT NULL,
  commission            numeric(12,2),      -- C4: nothing writes this yet
  placed_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_orders_status_check
    CHECK (status IN ('placed','confirmed','dispatched','delivered','cancelled')),
  CONSTRAINT mb_orders_pin_check CHECK (ship_pincode ~ '^[1-8][0-9]{5}$'),
  CONSTRAINT mb_orders_phone_check CHECK (ship_phone ~ '^\+91[6-9][0-9]{9}$'),
  -- FR-26.3: one regime or the other, never both
  CONSTRAINT mb_orders_gst_split_check CHECK (
    (is_interstate AND cgst = 0 AND sgst = 0) OR (NOT is_interstate AND igst = 0)),
  CONSTRAINT mb_orders_interstate_check CHECK (
    is_interstate = (owner_state_code <> place_of_supply_state)),
  CONSTRAINT mb_orders_total_check CHECK (total = subtotal_excl + tax_total),
  CONSTRAINT mb_orders_tax_total_check CHECK (tax_total = cgst + sgst + igst)
);
CREATE INDEX mb_orders_owner_idx ON mb_orders (owner_id, placed_at DESC);
CREATE INDEX mb_orders_customer_idx ON mb_orders (customer_id, placed_at DESC);

CREATE TABLE mb_order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES mb_orders(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES mb_products(id),
  bid_id          uuid REFERENCES mb_bids(id),
  -- copied, not joined: a later edit to the listing must never alter a placed order (FR-25.4)
  name            text NOT NULL,
  sku             text NOT NULL,
  unit            text NOT NULL,
  hsn_sac         text NOT NULL,
  qty             numeric(12,3) NOT NULL,
  unit_price_excl numeric(12,2) NOT NULL,
  gst_rate        numeric(5,2) NOT NULL,
  line_excl       numeric(12,2) NOT NULL,
  line_tax        numeric(12,2) NOT NULL,
  line_total      numeric(12,2) NOT NULL,
  CONSTRAINT mb_order_items_qty_check CHECK (qty > 0),
  CONSTRAINT mb_order_items_total_check CHECK (line_total = line_excl + line_tax)
);
CREATE INDEX mb_order_items_order_idx ON mb_order_items (order_id);
```

**Decision D-25.** The item copies the listing's name, SKU, unit and HSN rather than joining to it.
An order is a record of what was agreed; a join makes it a view of what the listing says today.
The `CHECK` constraints on the totals mean an order whose arithmetic does not add up cannot be
stored at all.

### 3.6 Notifications, order code and handover

```sql
CREATE TABLE mb_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  order_id   uuid REFERENCES mb_orders(id) ON DELETE CASCADE,
  thread_id  uuid REFERENCES mb_threads(id) ON DELETE CASCADE,
  bid_id     uuid REFERENCES mb_bids(id) ON DELETE CASCADE,
  body       text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_notifications_kind_check CHECK (kind IN (
    'order_placed','order_confirmed','order_rejected','order_dispatched','order_collected',
    'order_cancelled','bid_placed','bid_countered','bid_accepted','bid_rejected','message'))
);
-- the one query the badge asks: how many unread for me
CREATE INDEX mb_notifications_unread_idx
  ON mb_notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- FR-29: one live handover token per order at a time.
CREATE TABLE mb_handover_tokens (
  order_id   uuid PRIMARY KEY REFERENCES mb_orders(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Plus, on the order: `collected_at`, `collected_by` (the account that confirmed), and
`collection_method` (`scan` | `manual`), so FR-29.9's distinction survives in the record.

**Decision D-28.** The QR carries a random token, and the database stores only its **hash** — the
same reasoning as passwords. Anyone who can read the table should not be able to reconstruct a
working QR for an order awaiting collection.

**Decision D-29.** One token per order, as a primary key rather than a history. Regenerating
replaces the row, which is what makes an old screenshot stop working (FR-29.6). Single use is
`used_at`, set in the same statement that confirms the order:

```sql
UPDATE mb_handover_tokens SET used_at = now()
 WHERE order_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
```

If that updates no rows, the scan is refused. Checking and then updating would let two scans of the
same screen both succeed.

**Decision D-30.** The order code is not sequential. It is generated from a random alphabet that
excludes the characters people misread aloud — no `0`/`O`, no `1`/`I`/`L` — because its whole
purpose is being read out over a phone. Uniqueness is enforced by the `UNIQUE` constraint on
`reference` with a retry on collision, not by hoping.

**Decision D-31.** A scan is authenticated by **two independent facts**: the customer's session
proves who they are, and the token proves they were standing at the owner's screen. Neither alone
confirms a handover. This is why the token is never shown as text the customer could be read over
the phone — that would collapse the two facts into one.

### 3.7 The basket

**Decision D-26.** The basket lives in the browser (`localStorage`), not the database. Nothing is
reserved, so a server-side basket would buy nothing except a table to keep tidy.

**The price is never taken from the browser.** At checkout the client sends listing ids, quantities,
and the price it last displayed; the server re-prices from the database (or from the accepted bid)
and compares. If anything has moved it returns **409 with the new figures** and places nothing, so
the customer confirms the real price. This corrects FSD §8's "proceeds at the price shown in the
basket": a client-supplied price is a client-controlled price, which is not acceptable for money.

## 4. Owner scoping — the main risk

**Decision D-27.** There is no "current owner" global and no post-filtering. Every owner-facing
query takes the owner id from the session and puts it in the `WHERE` clause of the statement itself:

```sql
SELECT ... FROM mb_orders WHERE id = $1 AND owner_id = $2
```

A row belonging to someone else therefore does not come back, and the handler returns **404 rather
than 403** (NFR-21) — a 403 would confirm that the id exists.

One helper per audience wraps this so a handler cannot forget it:

```js
ownerScope(account)      // throws unless role === 'owner' and owner_status === 'approved'
customerScope(account)   // the caller's own customer id
platformScope(account)   // throws unless role === 'superadmin'
```

Every `/api/owner` query runs through `ownerScope`. The test suite asserts, for each owner
endpoint, that a second owner's row is invisible and reported as 404 — not merely that the UI hides it.

## 5. GST computation (FR-26)

```
split(lineExclPaise, rate, ownerState, placeOfSupply):
  tax = gstOn(lineExclPaise, rate)              // Phase 1 section 7.2, half-up, once, in BigInt
  if ownerState === placeOfSupply:
      cgst = tax / 2 rounded half-up, sgst = tax - cgst      // the odd paisa lands on SGST
  else:
      igst = tax
```

The halves are derived from the already-rounded total rather than rounded separately, so CGST + SGST
is always exactly the line's tax and the `mb_orders_tax_total_check` constraint can hold. Which half
takes the odd paisa is arbitrary but must be fixed; it is SGST, and a test pins it.

## 6. API surface

| Path | Audience | Purpose |
|---|---|---|
| `/api/catalog` | public | Phase 1, plus `owner` filter and the owner's shop name on each item |
| `/api/threads` | customer, owner | List conversations, open one, send a message |
| `/api/bids` | customer, owner | Place, counter, accept, reject, withdraw |
| `/api/orders` | customer | Checkout, own order list, cancel while `placed` |
| `/api/owner` | owner | Own listings, own orders, own bids, own conversations |
| `/api/platform` | superadmin | Owner list and sales, approvals, superadmin grants, platform totals |

Cache policy: `/api/catalog` stays public and edge-cached (Phase 1 §6). **Everything else here is
`private, no-store`** — orders, bids and messages are per-viewer by definition, and the Phase 1
default in `json()` already makes that the behaviour a handler gets for free.

## 7. Testing

Beyond repeating the Phase 1 disciplines, Phase 2 must prove:

| Area | Must prove |
|---|---|
| Role boundary | Registration cannot produce `owner` or `superadmin`; a pending owner cannot list; only a superadmin grants superadmin; the last superadmin cannot remove themselves |
| Owner scoping | For **every** owner endpoint, owner B's listing, order, bid and thread are 404 to owner A |
| Bid state machine | Each transition from each state, including the refusals: accepting an expired bid, accepting twice, countering out of turn, withdrawing someone else's bid |
| Concurrency | Two simultaneous accepts of one bid produce one order, not two (D-24) |
| Expiry | An expired bid is unacceptable the instant the clock passes, with no sweeper run (D-23) |
| Order arithmetic | Intra-state gives CGST + SGST summing exactly to the line tax, inter-state gives IGST only, the odd paisa goes to SGST, and the constraints reject a doctored total |
| Price integrity | A checkout claiming a stale or altered price is refused with 409 and places nothing |
| Basket split | A basket across three owners becomes three orders, each with that owner's GSTIN and state |
| Privacy | A superadmin reading a thread gets counts, never bodies (FSD L1) |
| Handover | A scan by the right customer collects the order; by anyone else it is refused without revealing whose it is; twice is refused; after regeneration the old token is refused; on a `placed` order it is refused |
| Handover concurrency | Two simultaneous scans of one screen collect the order once (D-29) |
| Order code | Codes contain no `0`, `O`, `1`, `I` or `L`, are not sequential, and a collision retries rather than failing |
| Notifications | Placing an order notifies that owner and no other; a count never survives the thing being opened |

## 8. Migration and rollout

1. `0001_marketplace.sql` — roles, owner status, ownership column, and the new tables.
2. The owner decides what happens to the eleven seeded products (FSD §9.2); a second migration then
   sets `owner_id NOT NULL`.
3. `MB_SELLER_GSTIN` and `MB_SELLER_STATE_CODE` are removed from the Vercel project.
4. `scripts/admin/create-admin.mjs` becomes `create-superadmin.mjs`, with the same operator-only path.

Order of build, so that each step is useful on its own: roles and owner onboarding → ownership of
listings → conversations → bids → basket and orders → superadmin reporting. Reporting is last
because it has nothing to report until orders exist.

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **An owner sees another owner's orders, bids or messages.** The worst failure available in this phase | D-27 puts the filter in the SQL and the suite proves 404 for every endpoint. No endpoint ships without that test |
| R2 | A race lets one bid become two orders, or a bid is accepted after expiry | D-23 and D-24: state in the `WHERE` clause, expiry judged by the reader. Both have concurrency tests |
| R3 | CGST + SGST does not equal the line tax, and an invoice is a paisa out | Halves derived from the rounded total, with a database constraint that refuses the row otherwise |
| R4 | A client-supplied price reaches an order | D-26: the server re-prices and returns 409 on any difference. Tested |
| R5 | Owners' products exist with no owner after migration | The catalogue treats a null owner as inactive until the owner decides, so nothing unowned can be sold meanwhile |
| R6 | Sales figures are read as revenue when no payment has been taken | FSD L5: the reports state on their face that "sold" means "ordered" |
| R7 | A handover QR is screenshotted and reused, or a photo of the owner's screen confirms a collection that never happened | Single-use token, short expiry, regeneration invalidates, and the scanner must be signed in as that customer (D-29, D-31). A photo alone is not enough without that customer's session |
| R8 | The owner marks orders collected manually to inflate their figures | The method is recorded, and a manual confirmation is visibly not a customer scan (FR-29.9). The superadmin report can separate the two |
| R9 | QR scanning needs a camera and HTTPS; an older phone or a denied permission blocks collection entirely | FR-29.9 keeps the manual path open, so a failed camera never traps an order |
