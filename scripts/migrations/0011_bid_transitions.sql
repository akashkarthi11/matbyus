-- The bid status list and the bid move table — the same treatment migration 0005 gave order status.
--
-- Migration 0008 put bid status labels in mb_lookups, alongside every other small enum, on the
-- reasoning that the code branches on the value either way so a foreign key buys nothing. That
-- undersold it: bid status is not a flat label like 'in_stock' or 'pending' — it is the state of a
-- machine with moves between its values, exactly like order status (mb_order_statuses,
-- mb_order_transitions). It gets the same shape here: a dedicated status table a move can reference,
-- and a dedicated transitions table, instead of a generic label list.
--
-- What stays genuinely in code (api/bids.js) is turn-taking itself: whose move it is, and the fact
-- that 'countered' is reached by both sides. That is a decision about the request in front of the
-- handler, not a fact two different bids could disagree about — see the file's own comment.
--
-- Forward-only. 0000-0010 are applied in production and are never edited.

CREATE TABLE IF NOT EXISTS mb_bid_statuses (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_open    boolean NOT NULL DEFAULT true   -- still negotiable; false once settled one way or another
);

INSERT INTO mb_bid_statuses (code, label, sort_order, is_open) VALUES
  ('open',      'Awaiting the seller', 1, true),
  ('countered', 'Countered',           2, true),
  ('accepted',  'Accepted',            3, false),
  ('rejected',  'Declined',            4, false),
  ('withdrawn', 'Withdrawn',           5, false),
  ('expired',   'Expired',             6, false),
  ('ordered',   'Ordered',             7, false)
ON CONFLICT (code) DO NOTHING;

-- The flat label list from migration 0008 is superseded by the table above; the front end now reads
-- bid statuses from a dedicated list in /api/meta (`bidStatuses`), the same way it already reads
-- order statuses, rather than from the general-purpose enum bag.
DELETE FROM mb_lookups WHERE domain = 'bid_status';

ALTER TABLE mb_bids DROP CONSTRAINT IF EXISTS mb_bids_status_check;
-- mb_bid_moves_action_check stays: 'action' here also carries 'open' (the bid's creation) and
-- 'expire' (the lazy sweep in expireIfDue()), neither of which is a side choosing a response, so
-- neither belongs in mb_bid_actions below. from_status/to_status, though, are always one of the
-- seven bid statuses, 'open' and 'expired' among them, so the FKs below cover every row this table
-- has ever held — nothing here needs a value mb_bid_statuses does not already have.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_bids_status_fkey') THEN
    ALTER TABLE mb_bids ADD CONSTRAINT mb_bids_status_fkey
      FOREIGN KEY (status) REFERENCES mb_bid_statuses(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_bid_moves_from_status_fkey') THEN
    ALTER TABLE mb_bid_moves ADD CONSTRAINT mb_bid_moves_from_status_fkey
      FOREIGN KEY (from_status) REFERENCES mb_bid_statuses(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_bid_moves_to_status_fkey') THEN
    ALTER TABLE mb_bid_moves ADD CONSTRAINT mb_bid_moves_to_status_fkey
      FOREIGN KEY (to_status) REFERENCES mb_bid_statuses(code);
  END IF;
END $$;

-- --- which moves exist, and what each one needs --------------------------------
--
-- Every action applies from the same two open statuses ('open', 'countered'), which is why this is
-- one row per action rather than one row per (action, from_status) the way mb_order_transitions is:
-- an order's allowed "from" states differ action by action (confirm only from placed; collect from
-- confirmed or dispatched), a bid's do not.

CREATE TABLE IF NOT EXISTS mb_bid_actions (
  action        text PRIMARY KEY,
  to_status     text NOT NULL REFERENCES mb_bid_statuses(code),
  label         text NOT NULL,       -- "was <label>" in a notification to the other side
  needs_price   boolean NOT NULL DEFAULT false,
  -- NULL = either side may do this, once it is their turn. A value restricts the action to that
  -- side regardless of turn — withdrawing your own offer is yours to do, not a move that waits its
  -- turn in the negotiation.
  restrict_side text,
  any_turn      boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  CONSTRAINT mb_bid_actions_restrict_check CHECK (restrict_side IS NULL OR restrict_side IN ('customer','owner'))
);

INSERT INTO mb_bid_actions (action, to_status, label, needs_price, restrict_side, any_turn, sort_order) VALUES
  ('counter',  'countered', 'countered', true,  NULL,       false, 1),
  ('accept',   'accepted',  'accepted',  false, NULL,       false, 2),
  ('reject',   'rejected',  'declined',  false, NULL,       false, 3),
  ('withdraw', 'withdrawn', 'withdrawn', false, 'customer', true,  4)
ON CONFLICT (action) DO NOTHING;
