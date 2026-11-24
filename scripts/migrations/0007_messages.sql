-- Conversations and messages between a customer and an owner. FSD Phase 2 FR-23.
--
-- One conversation per (customer, owner, listing) — or per (customer, owner) when the conversation
-- is not about one particular listing — so a negotiation has one place to live rather than a new
-- thread every time someone writes again (FR-23.2). Two partial unique indexes express that, because
-- a plain UNIQUE constraint treats every NULL product_id as distinct from every other, which would
-- let a customer and an owner accumulate an unbounded number of "general" conversations.
--
-- A superadmin does not read these (FSD L1): nothing here grants that, and no admin-reachable query
-- is written against mb_messages. What a superadmin may see is a count — api/messages.js enforces it.
--
-- Forward-only. 0000-0006 are applied in production and are never edited.

CREATE TABLE IF NOT EXISTS mb_conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES mb_users(id),
  owner_id              uuid NOT NULL REFERENCES mb_users(id),
  product_id            uuid REFERENCES mb_products(id),
  -- Read tracking per side. An unread count is "messages from the other side newer than this",
  -- which needs no separate per-message read flag and no table scan (NFR-23): the index below
  -- answers it in one lookup.
  customer_last_read_at timestamptz,
  owner_last_read_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mb_conversations_with_product_idx
  ON mb_conversations (customer_id, owner_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mb_conversations_general_idx
  ON mb_conversations (customer_id, owner_id) WHERE product_id IS NULL;

CREATE INDEX IF NOT EXISTS mb_conversations_customer_idx
  ON mb_conversations (customer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mb_conversations_owner_idx
  ON mb_conversations (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mb_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES mb_conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES mb_users(id),
  -- FR-23.7: a message is never edited or deleted. There is no UPDATE path and no deleted_at; a
  -- correction is another row, so the record a dispute would be settled from cannot be rewritten.
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mb_messages_body_check CHECK (length(btrim(body)) > 0 AND length(body) <= 4000)
);

CREATE INDEX IF NOT EXISTS mb_messages_conversation_idx
  ON mb_messages (conversation_id, created_at);
