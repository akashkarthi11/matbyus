-- Bids: a customer asks an owner for a better price, the two settle it in a conversation. FSD
-- Phase 2 FR-24.
--
-- "Back-and-forth is the normal case and is not limited to one round" (FR-24.4) is the one rule that
-- decides the shape of this table. A bid's `status` is the seven values FR-24.3 names; it does not
-- also encode whose turn it is, because `countered` is reached by both an owner's counter and a
-- customer's counter-to-a-counter, and treating those as different statuses would double the state
-- space for no reason anyone reads off a screen. `turn` is the separate fact of who must act next.
--
-- This is deliberately NOT modelled as rows in a generic transitions table the way order status is
-- (migration 0005). An order's moves are "from state X, action Y, to state Z" — pure data. A bid's
-- moves also depend on whose turn it is, which a (from_status, to_status) pair cannot express without
-- inventing parallel statuses. Turn-taking is business logic, so it stays in code
-- (api/bids.js:TRANSITIONS), the same reasoning that keeps the role boundary in api/_roles.js rather
-- than a table. The bid *status labels* — what "countered" is called on screen — are still reference
-- data and live in mb_lookups like every other small enum (docs/lookups.md).
--
-- Forward-only. 0000-0007 are applied in production and are never edited.

CREATE TABLE IF NOT EXISTS mb_bids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES mb_conversations(id),
  product_id      uuid NOT NULL REFERENCES mb_products(id),
  customer_id     uuid NOT NULL REFERENCES mb_users(id),
  owner_id        uuid NOT NULL REFERENCES mb_users(id),
  status          text NOT NULL DEFAULT 'open',
  -- Whose move it is. A bid is created by a customer, so the owner moves first.
  turn            text NOT NULL DEFAULT 'owner',
  qty             numeric(12,3) NOT NULL,
  -- The price currently on the table, excluding GST. Null only for a quote-priced listing's first
  -- bid, where FR-24.10 says the customer is asking "what would you charge", not naming a figure —
  -- the owner's first counter is where a price appears.
  unit_price      numeric(12,2),
  expires_at      timestamptz NOT NULL,
  -- Set once, when the bid is accepted and turned into an order (FR-24.8). After that the bid is
  -- 'ordered' and nothing can act on it again — checked in code, not just by the order existing.
  order_id        uuid REFERENCES mb_orders(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_bids_status_check
    CHECK (status IN ('open','countered','accepted','rejected','withdrawn','expired','ordered')),
  CONSTRAINT mb_bids_turn_check CHECK (turn IN ('customer','owner')),
  CONSTRAINT mb_bids_qty_check CHECK (qty > 0),
  CONSTRAINT mb_bids_price_check CHECK (unit_price IS NULL OR unit_price >= 0),
  -- D-33: a bid that reached 'ordered' always names the order it became; every other status never
  -- does. Without this, a bug that forgets to set order_id on acceptance would be invisible until
  -- someone went looking for the order and could not find it.
  CONSTRAINT mb_bids_ordered_shape_check
    CHECK ((status = 'ordered') = (order_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS mb_bids_customer_idx ON mb_bids (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mb_bids_owner_idx ON mb_bids (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mb_bids_conversation_idx ON mb_bids (conversation_id, created_at DESC);
-- The sweep that lazily expires a bid asks for exactly this set; see expireDue() in api/bids.js.
CREATE INDEX IF NOT EXISTS mb_bids_open_idx
  ON mb_bids (expires_at) WHERE status IN ('open','countered');

-- D-34: append-only, like the business and owner status logs (migrations 0000, 0004). "Who moved,
-- from what price to what, when, and any note" (FR-24.5) is a sentence about history, and a mutable
-- row cannot answer it once the second move has happened.
CREATE TABLE IF NOT EXISTS mb_bid_moves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id     uuid NOT NULL REFERENCES mb_bids(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES mb_users(id),           -- null for a system move (expiry)
  action     text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  from_price  numeric(12,2),
  to_price    numeric(12,2),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_bid_moves_action_check
    CHECK (action IN ('open','counter','accept','reject','withdraw','expire'))
);

CREATE INDEX IF NOT EXISTS mb_bid_moves_bid_idx ON mb_bid_moves (bid_id, created_at);

-- An order can trace back to the bid that priced it (FR-25.3: "it records the bid it came from,
-- where it came from one"). Nullable: most orders are not bids.
ALTER TABLE mb_orders ADD COLUMN IF NOT EXISTS bid_id uuid REFERENCES mb_bids(id);

-- Labels for the bid status, alongside every other small enum (migration 0005, docs/lookups.md).
INSERT INTO mb_lookups (domain, code, label, sort_order) VALUES
  ('bid_status', 'open',      'Awaiting the seller',       1),
  ('bid_status', 'countered', 'Countered',                 2),
  ('bid_status', 'accepted',  'Accepted',                  3),
  ('bid_status', 'rejected',  'Declined',                  4),
  ('bid_status', 'withdrawn', 'Withdrawn',                 5),
  ('bid_status', 'expired',   'Expired',                   6),
  ('bid_status', 'ordered',   'Ordered',                   7)
ON CONFLICT (domain, code) DO NOTHING;
