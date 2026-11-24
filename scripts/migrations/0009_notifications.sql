-- In-app notifications. FSD Phase 2 FR-28.
--
-- "A notification is addressed to exactly one account" (FR-28.5) is the whole shape of this table:
-- one row, one recipient, never a broadcast. An order placed against a house listing (no owner)
-- notifies nobody — there is no seller account to tell — which the application layer handles by
-- simply not calling notify() in that case, rather than this table needing to represent "nobody".
--
-- No push, no email, no SMS (FR-28.2, L4). This is read by the signed-in account polling or loading
-- its own list; nothing here assumes a delivery channel beyond that.
--
-- Forward-only. 0000-0008 are applied in production and are never edited.

CREATE TABLE IF NOT EXISTS mb_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES mb_users(id),
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  -- A hash route the front end jumps to when the notification is opened — '#/order/MB-XXXX',
  -- '#/messages/<conversation id>', '#/bids/<bid id>'. Opaque to the server; it never recomputes a
  -- link to re-check access, because the target screen re-checks it itself when it loads (the same
  -- "the API is the control, not the link" rule as everywhere else in this project).
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_notifications_kind_check
    CHECK (kind IN ('order_placed','order_status','message','bid'))
);

-- The two queries this table actually serves: "how many unread" and "the list, newest first". Both
-- are index-only, per NFR-23 — neither scans every notification a user has ever had.
CREATE INDEX IF NOT EXISTS mb_notifications_unread_idx
  ON mb_notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS mb_notifications_list_idx
  ON mb_notifications (user_id, created_at DESC);
