-- Three roles: customer, owner, admin.
--
-- Until now there were two. `admin` meant "the store", because there was one seller. This splits
-- that apart: an **owner** is a seller, and **admin** is the platform — Karthi and Viju — who
-- approve owners and see across all of them. FSD Phase 2 called these `owner` and `superadmin`;
-- the names here are the ones in use, and `admin` is that superadmin.
--
-- Two rules are written as constraints rather than left to the application:
--
--   1. `role = 'owner'` is only reachable with `owner_status = 'approved'`. There is no way to be
--      an owner without having been approved as one, whatever a handler forgets to check.
--   2. The owner status trail is append-only, like the business one (D-3). "Who let this seller
--      in, and when" has to survive the second status change.
--
-- Forward-only. 0000-0003 are applied in production and are never edited.

-- --- 1. the role itself -----------------------------------------------------

ALTER TABLE mb_users DROP CONSTRAINT IF EXISTS mb_users_role_check;
ALTER TABLE mb_users ADD CONSTRAINT mb_users_role_check
  CHECK (role IN ('customer','owner','admin'));

ALTER TABLE mb_users ADD COLUMN IF NOT EXISTS owner_status text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_users_owner_status_check') THEN
    ALTER TABLE mb_users ADD CONSTRAINT mb_users_owner_status_check
      CHECK (owner_status IN ('none','requested','approved','rejected'));
  END IF;
  -- D-31: being an owner and having been approved as one are the same fact. The database will not
  -- hold a row where they disagree.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mb_users_owner_role_check') THEN
    ALTER TABLE mb_users ADD CONSTRAINT mb_users_owner_role_check
      CHECK (role <> 'owner' OR owner_status = 'approved');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mb_users_owner_requests_idx
  ON mb_users (owner_status) WHERE owner_status = 'requested';

CREATE INDEX IF NOT EXISTS mb_users_owners_idx
  ON mb_users (role) WHERE role = 'owner';

-- --- 2. the trail -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS mb_owner_status_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  from_role   text,
  to_role     text,
  note        text,
  actor_id    uuid REFERENCES mb_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mb_owner_status_log_user_idx
  ON mb_owner_status_log (user_id, created_at DESC);

-- --- 3. a listing belongs to someone ----------------------------------------
--
-- Nullable, and it stays nullable. A null owner means "the house": the eleven products seeded
-- before owners existed, and anything an admin lists directly. Making this NOT NULL would force a
-- fictional owner onto those rows, and a fiction in a FOREIGN KEY is worse than a null that every
-- query already handles.

ALTER TABLE mb_products ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES mb_users(id);

CREATE INDEX IF NOT EXISTS mb_products_owner_idx ON mb_products (owner_id);

-- An owner's own listing screen, which is the query they hit most.
CREATE INDEX IF NOT EXISTS mb_products_owner_live_idx
  ON mb_products (owner_id, kind) WHERE is_active;
