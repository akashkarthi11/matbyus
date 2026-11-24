-- How an order was closed out. FSD Phase 2 FR-29.9: a customer scanning a QR is proof they were
-- there; the store marking it by hand is the store's word. Those are different claims, so the
-- record keeps them apart rather than flattening both into "delivered".
--
-- The QR itself arrives later. These columns exist now so the manual path is honest from the start
-- and the scan path is a backfill of behaviour, not of data.

ALTER TABLE mb_orders ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE mb_orders ADD COLUMN IF NOT EXISTS collected_by uuid REFERENCES mb_users(id);
ALTER TABLE mb_orders ADD COLUMN IF NOT EXISTS collection_method text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mb_orders_collection_method_check'
  ) THEN
    ALTER TABLE mb_orders ADD CONSTRAINT mb_orders_collection_method_check
      CHECK (collection_method IS NULL OR collection_method IN ('scan','manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mb_orders_collected_shape_check'
  ) THEN
    -- collected is all three facts or none of them
    ALTER TABLE mb_orders ADD CONSTRAINT mb_orders_collected_shape_check
      CHECK ((collected_at IS NULL AND collection_method IS NULL)
          OR (collected_at IS NOT NULL AND collection_method IS NOT NULL));
  END IF;
END $$;
