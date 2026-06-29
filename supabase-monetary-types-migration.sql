-- Migration: fix monetary fields stored as text → numeric(10,2)
--
-- Background: schema.sql defined cost/price fields as TEXT across 5 tables.
-- This caused silent bugs: sorting by cost was lexicographic, summing required
-- parseFloat() in every query, and NULL-vs-empty-string had to be handled everywhere.
--
-- Safe migration strategy: ALTER COLUMN ... USING cast (existing text to numeric).
-- Supabase rewrites each column in-place. Test in staging first.
-- If any row has non-numeric text in these columns the ALTER will fail — fix data first
-- with: SELECT * FROM <table> WHERE cost !~ '^[0-9]+(\.[0-9]+)?$' AND cost IS NOT NULL;
--
-- Run in Supabase SQL Editor (staging first, then prod).

BEGIN;

-- ── grooming_records ──────────────────────────────────────────────────────────
ALTER TABLE grooming_records
  ALTER COLUMN cost TYPE numeric(10,2) USING NULLIF(cost, '')::numeric;

-- ── training_records ──────────────────────────────────────────────────────────
ALTER TABLE training_records
  ALTER COLUMN cost TYPE numeric(10,2) USING NULLIF(cost, '')::numeric;

-- ── food_orders ───────────────────────────────────────────────────────────────
ALTER TABLE food_orders
  ALTER COLUMN cost TYPE numeric(10,2) USING NULLIF(cost, '')::numeric;

-- ── vet_records ───────────────────────────────────────────────────────────────
ALTER TABLE vet_records
  ALTER COLUMN cost TYPE numeric(10,2) USING NULLIF(cost, '')::numeric;

-- ── professional_profiles ─────────────────────────────────────────────────────
ALTER TABLE professional_profiles
  ALTER COLUMN price_basic  TYPE numeric(10,2) USING NULLIF(price_basic,  '')::numeric,
  ALTER COLUMN price_full   TYPE numeric(10,2) USING NULLIF(price_full,   '')::numeric,
  ALTER COLUMN price_custom TYPE numeric(10,2) USING NULLIF(price_custom, '')::numeric;

COMMIT;

-- Verify: should return column_name + data_type = 'numeric' for all above
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name IN ('grooming_records','training_records','food_orders','vet_records','professional_profiles')
  AND column_name IN ('cost','price_basic','price_full','price_custom')
ORDER BY table_name, column_name;
