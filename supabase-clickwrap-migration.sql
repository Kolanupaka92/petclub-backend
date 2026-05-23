-- ══════════════════════════════════════════════════════════════════
--  PETclub Clickwrap — Booking Consent Audit Trail
--  Run in Supabase SQL Editor AFTER supabase-loyalty-hardening.sql
-- ══════════════════════════════════════════════════════════════════
--
--  Adds two columns to the bookings table so every booking carries
--  a permanent record of exactly WHICH version of the Terms & Privacy
--  Policy the customer agreed to, and WHEN they agreed.
--
--  This is required for:
--    • Proving consent if a customer later disputes a charge
--    • Knowing which users agreed to T&C v1 when you release v2
--    • Regulatory compliance (consumer protection / DPDP Act 2023)
-- ══════════════════════════════════════════════════════════════════

-- terms_version: e.g. 'v1'. Increment to 'v2' when you update your T&C.
-- terms_accepted_at: server-side timestamp — NOT client-supplied.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS terms_version    TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Index for compliance queries: "all bookings made under T&C v1"
CREATE INDEX IF NOT EXISTS bookings_terms_version_idx
  ON bookings (terms_version, created_at);

-- ── Verify ───────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN ('terms_version', 'terms_accepted_at');

SELECT indexname FROM pg_indexes
WHERE indexname = 'bookings_terms_version_idx';
