-- The QR handover. FSD Phase 2 FR-29.9.
--
-- A customer scanning a code is proof they were there; a seller marking an order by hand is the
-- seller's word. Migration 0002 kept those apart in the record and said the scan would arrive
-- later. This is later.
--
-- The thing a QR must not be is the order reference. Order codes are designed to be read aloud
-- down a phone line, so anyone who overheard one could "confirm" a collection from their sofa. The
-- code in the QR is therefore a separate secret: issued by the seller, short-lived, single-use, and
-- stored only as a hash so a copy of this table cannot be replayed.
--
-- Forward-only. 0000-0005 are applied in production and are never edited.

-- --- 1. a move may require a handover token ---------------------------------
--
-- Which moves need one is data, like the moves themselves. The seller's `collect` does not: it is
-- the manual path, and taking it away would leave a yard with a flat phone unable to close an order.

ALTER TABLE mb_order_transitions
  ADD COLUMN IF NOT EXISTS needs_token boolean NOT NULL DEFAULT false;

INSERT INTO mb_order_transitions
  (actor, action, from_status, to_status, label, is_primary, needs_reason, needs_token, sort_order) VALUES
  ('customer', 'collect', 'dispatched', 'collected', 'Scan to confirm delivery',   true, false, true, 1),
  ('customer', 'collect', 'confirmed',  'collected', 'Scan to confirm collection', true, false, true, 1)
ON CONFLICT (actor, action, from_status) DO NOTHING;

-- --- 2. the tokens ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_order_handover_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES mb_orders(id) ON DELETE CASCADE,
  -- SHA-256 of the code shown on the seller's screen. The code itself is never stored: this table
  -- leaking should not let anyone close an order.
  token_hash text NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  issued_by  uuid REFERENCES mb_users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    uuid REFERENCES mb_users(id),
  CONSTRAINT mb_handover_window_check CHECK (expires_at > issued_at),
  -- spent is both facts or neither
  CONSTRAINT mb_handover_used_shape_check CHECK ((used_at IS NULL) = (used_by IS NULL))
);

-- D-32: one unspent token per order, enforced here rather than hoped for in the handler. The QR on
-- the seller's screen is the only code that works; issuing a new one deletes the one it replaces,
-- so a photograph of an earlier screen is worth nothing.
CREATE UNIQUE INDEX IF NOT EXISTS mb_handover_one_live_idx
  ON mb_order_handover_tokens (order_id) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS mb_handover_order_idx
  ON mb_order_handover_tokens (order_id, issued_at DESC);

-- --- 3. how a collection was confirmed, in words ----------------------------
-- 'scan' already carried a label from 0005. This spells out what it now means in practice.

UPDATE mb_lookups SET label = 'Confirmed by the customer''s scan'
  WHERE domain = 'collection_method' AND code = 'scan';
