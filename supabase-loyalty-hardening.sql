-- ══════════════════════════════════════════════════════════════════
--  PETclub Loyalty Hardening — Migration v2
--  Run in Supabase SQL Editor AFTER supabase-loyalty-migration.sql
-- ══════════════════════════════════════════════════════════════════

-- ── Fix 1: Atomic redemption via Postgres function ────────────────
-- All balance check + deduction + coupon creation happen inside one
-- database transaction with a row-level lock. If ANY step fails the
-- entire operation rolls back — eliminating the double-spend risk.

CREATE OR REPLACE FUNCTION redeem_loyalty_credits(
  p_user_id    UUID,
  p_coupon_code TEXT,
  p_service    TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER   -- runs as DB owner, bypasses RLS for atomicity
AS $$
DECLARE
  v_balance        INTEGER;
  v_existing_code  TEXT;
  v_new_balance    INTEGER;
BEGIN
  -- Lock this user's row so concurrent requests cannot both pass the balance check
  SELECT loyalty_points INTO v_balance
  FROM users
  WHERE id = p_user_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  IF v_balance < 1000 THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Insufficient credits. You have %s — need 1000.', v_balance)
    );
  END IF;

  -- Check for an existing active coupon (prevent stacking)
  SELECT code INTO v_existing_code
  FROM loyalty_coupons
  WHERE user_id  = p_user_id
    AND is_used  = false
    AND expires_at > NOW()
  LIMIT 1;

  IF v_existing_code IS NOT NULL THEN
    RETURN json_build_object(
      'success',       false,
      'error',         format('Active coupon already exists: %s. Use it before redeeming again.', v_existing_code),
      'existing_code', v_existing_code
    );
  END IF;

  -- Deduct 1000 credits atomically
  v_new_balance := v_balance - 1000;
  UPDATE users SET loyalty_points = v_new_balance WHERE id = p_user_id;

  -- Create coupon
  INSERT INTO loyalty_coupons (code, user_id, service_name, discount_pct, expires_at)
  VALUES (p_coupon_code, p_user_id, p_service, 100, p_expires_at);

  -- Audit trail
  INSERT INTO loyalty_transactions (user_id, points, type, description, coupon_code)
  VALUES (p_user_id, -1000, 'redemption', format('Redeemed for free %s', p_service), p_coupon_code);

  RETURN json_build_object(
    'success',     true,
    'new_balance', v_new_balance,
    'coupon_code', p_coupon_code
  );

EXCEPTION WHEN OTHERS THEN
  -- Any unexpected error rolls back everything automatically
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ── Fix 2: Review-bonus dedup constraint ─────────────────────────
-- Prevent earning +50 credits more than once per booking.
-- A partial unique index on loyalty_transactions ensures this at DB level.

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_txn_review_bonus_once
  ON loyalty_transactions (user_id, booking_id)
  WHERE type = 'review_bonus';

-- ── Fix 3: Booking accounting flags ──────────────────────────────
-- Lets admin/finance distinguish platform-subsidised bookings from
-- full-price bookings when calculating monthly SP payouts.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_loyalty_redemption BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS coupon_code_used       TEXT;

-- Index for finance reports: "all loyalty-redeemed bookings this month"
CREATE INDEX IF NOT EXISTS bookings_loyalty_redemption_idx
  ON bookings (is_loyalty_redemption, created_at)
  WHERE is_loyalty_redemption = true;

-- ── Verify ───────────────────────────────────────────────────────
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'redeem_loyalty_credits';

SELECT indexname FROM pg_indexes
WHERE indexname IN ('loyalty_txn_review_bonus_once', 'bookings_loyalty_redemption_idx');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN ('is_loyalty_redemption', 'coupon_code_used');
