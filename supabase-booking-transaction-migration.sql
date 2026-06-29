-- Migration: atomic booking creation
-- Wraps booking insert + coupon mark-used into a single Postgres transaction
-- so a partial failure (booking inserted but coupon not marked) is impossible.
--
-- Run in Supabase SQL Editor → Settings → SQL Editor
-- After running, the existing loyalty.markCouponUsed + manual booking insert
-- in server.js can be replaced with a single call to this RPC.

CREATE OR REPLACE FUNCTION create_booking_atomic(
  p_customer_id         uuid,
  p_service_type        text,
  p_service_name        text,
  p_city                text,
  p_pet_id              uuid,
  p_scheduled_at        timestamptz,
  p_address             text,
  p_notes               text,
  p_address_lat         double precision,
  p_address_lng         double precision,
  p_amount              numeric,
  p_pet_size            text,
  p_coupon_code         text,        -- NULL if no coupon
  p_is_loyalty_redemption boolean,
  p_total_amount        numeric,
  p_petclub_offer_amount numeric,
  p_platform_fee        numeric,
  p_provider_earnings   numeric,
  p_gateway_fee         numeric,
  p_currency            text,
  p_terms_version       text,
  p_terms_accepted_at   timestamptz
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id  uuid;
  v_coupon_row  loyalty_coupons%ROWTYPE;
  v_booking     bookings%ROWTYPE;
BEGIN
  -- ── 1. Validate coupon if provided ──────────────────────────────────────────
  IF p_coupon_code IS NOT NULL THEN
    SELECT * INTO v_coupon_row
    FROM loyalty_coupons
    WHERE code = p_coupon_code
      AND is_used = false
      AND expires_at > now()
    FOR UPDATE;                        -- row-level lock prevents double-use race

    IF NOT FOUND THEN
      RAISE EXCEPTION 'COUPON_INVALID: Coupon % is invalid, expired, or already used', p_coupon_code;
    END IF;
  END IF;

  -- ── 2. Insert booking ────────────────────────────────────────────────────────
  INSERT INTO bookings (
    customer_id, status, assignment_status,
    service_type, service_name, city, pet_id, scheduled_at,
    address, notes, address_lat, address_lng,
    amount, pet_size, coupon_code_used, is_loyalty_redemption,
    total_amount, petclub_offer_amount, platform_fee,
    provider_earnings, gateway_fee, currency,
    payout_status, terms_version, terms_accepted_at
  ) VALUES (
    p_customer_id, 'upcoming', 'searching',
    p_service_type, p_service_name, p_city, p_pet_id, p_scheduled_at,
    p_address, p_notes, p_address_lat, p_address_lng,
    p_amount, p_pet_size, p_coupon_code, p_is_loyalty_redemption,
    p_total_amount, p_petclub_offer_amount, p_platform_fee,
    p_provider_earnings, p_gateway_fee, p_currency,
    'pending', p_terms_version, p_terms_accepted_at
  )
  RETURNING id INTO v_booking_id;

  -- ── 3. Mark coupon used (same transaction — atomic with insert) ─────────────
  IF p_coupon_code IS NOT NULL THEN
    UPDATE loyalty_coupons
    SET is_used = true, used_at = now(), used_booking_id = v_booking_id
    WHERE code = p_coupon_code;
  END IF;

  -- ── 4. Return the created booking ───────────────────────────────────────────
  SELECT * INTO v_booking FROM bookings WHERE id = v_booking_id;
  RETURN row_to_json(v_booking);

EXCEPTION
  WHEN OTHERS THEN
    -- Any error rolls back insert + coupon update automatically (transaction)
    RAISE;
END;
$$;

-- Grant execute to the service role used by the backend
GRANT EXECUTE ON FUNCTION create_booking_atomic TO service_role;

-- Add index on loyalty_coupons.code if not already present
CREATE INDEX IF NOT EXISTS idx_loyalty_coupons_code ON loyalty_coupons(code) WHERE is_used = false;
