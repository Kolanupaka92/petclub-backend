-- ══════════════════════════════════════════════════════════════════
--  PETclub Partner & Referral Tracking
--  Run in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════
--
--  Adds three columns to the users table:
--
--  referred_by_code  — the referral_code of the PETclub customer who
--                      referred this new user (populated if the sign-up
--                      field matches an existing referral_code).
--
--  partner_source    — free-text partner name entered at sign-up when
--                      the input does NOT match any existing referral_code.
--                      Examples: "Dr. Sharma's Vet Clinic", "Paws Pet Shop".
--                      Used for monthly commission reporting.
--
--  commission_paid   — admin flag, set to TRUE once the partner's
--                      commission for the month has been paid.
--                      Resets are handled externally (new rows or a
--                      separate commission_payments ledger table).
--
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by_code TEXT,
  ADD COLUMN IF NOT EXISTS partner_source   TEXT,
  ADD COLUMN IF NOT EXISTS commission_paid  BOOLEAN DEFAULT FALSE;

-- Index for partner commission report (GROUP BY partner_source)
CREATE INDEX IF NOT EXISTS users_partner_source_idx
  ON users (partner_source)
  WHERE partner_source IS NOT NULL;

-- Index for tracing referral chains
CREATE INDEX IF NOT EXISTS users_referred_by_code_idx
  ON users (referred_by_code)
  WHERE referred_by_code IS NOT NULL;

-- ── Verify ───────────────────────────────────────────────────────
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('referred_by_code', 'partner_source', 'commission_paid');

SELECT indexname FROM pg_indexes
WHERE indexname IN ('users_partner_source_idx', 'users_referred_by_code_idx');
