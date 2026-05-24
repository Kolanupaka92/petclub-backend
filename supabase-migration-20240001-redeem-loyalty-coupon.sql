-- ══════════════════════════════════════════════════════════════════
--  Migration 20240001 — Atomic coupon redemption at booking time
--
--  Problem (C-4 race condition):
--    server.js previously called validateCoupon() then markCouponUsed()
--    as two separate round-trips. Between those calls, a second concurrent
--    request could also pass validateCoupon() (coupon still "unused") and
--    insert a second free booking before either update committed.
--
--  Fix:
--    A single Postgres function acquires a FOR UPDATE row-level lock,
--    checks is_used, and marks the coupon used — all in one transaction.
--    Any concurrent session hitting the same coupon row blocks until this
--    transaction commits, then finds is_used = TRUE and raises an exception.
--
--  Run order: after supabase-loyalty-migration.sql
--
--  ⚠️  Column name correction vs. the original specification:
--    The spec used `used` and `booking_id`. The actual loyalty_coupons
--    schema (supabase-loyalty-migration.sql) defines these columns as
--    `is_used` and `used_booking_id`. This migration uses the real names.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION redeem_loyalty_coupon(
  p_coupon_code TEXT,
  p_booking_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER   -- runs as DB owner so RLS policies on loyalty_coupons
                   -- do not block the lock or update
AS $$
BEGIN
  -- ── Step 1: acquire row-level lock ──────────────────────────────────────
  -- FOR UPDATE blocks any concurrent session that is also trying to update
  -- this row until we COMMIT or ROLLBACK. The AND is_used = FALSE condition
  -- means we only lock un-used coupons — already-used coupons skip the lock
  -- and fall straight through to the NOT FOUND check below.
  PERFORM id
  FROM    loyalty_coupons
  WHERE   code     = p_coupon_code
    AND   is_used  = FALSE
  FOR UPDATE;

  -- ── Step 2: mark as used ────────────────────────────────────────────────
  -- Re-check is_used = FALSE inside the UPDATE so that if another session
  -- committed between our PERFORM and this UPDATE (which cannot happen with
  -- FOR UPDATE but is a belt-and-braces guard), we still catch it.
  UPDATE loyalty_coupons
  SET    is_used          = TRUE,
         used_at          = NOW(),
         used_booking_id  = p_booking_id
  WHERE  code             = p_coupon_code
    AND  is_used          = FALSE;

  -- ── Step 3: verify the UPDATE matched a row ─────────────────────────────
  -- NOT FOUND is true if:
  --   a) the coupon code doesn't exist, OR
  --   b) is_used was already TRUE (raced to another session), OR
  --   c) the coupon expired between validation and use
  -- All three are treated as "already used" — the booking route will roll
  -- back the booking insert on this exception.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_already_used'
      USING ERRCODE = 'P0001',
            DETAIL  = format('Coupon %s was not found or has already been used.', p_coupon_code);
  END IF;
END;
$$;

-- ── Grant execute to the authenticated role ──────────────────────────────
-- The Supabase service-role key bypasses RLS, but we grant to authenticated
-- as well so the function is callable from server-side Supabase clients that
-- use the anon/service key depending on environment.
GRANT EXECUTE ON FUNCTION redeem_loyalty_coupon(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION redeem_loyalty_coupon(TEXT, UUID) TO service_role;

-- ── Verify ───────────────────────────────────────────────────────────────
SELECT routine_name, routine_type, security_type
FROM   information_schema.routines
WHERE  routine_name = 'redeem_loyalty_coupon'
  AND  routine_schema = 'public';
