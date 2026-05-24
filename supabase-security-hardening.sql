-- ══════════════════════════════════════════════════════════════════
--  PETclub Security Hardening — Migration
--  Run in Supabase SQL Editor after all prior migrations.
--
--  Covers:
--    1. Atomic coupon-at-booking redemption RPC  (C-4 fix)
--    2. SQL-native professional rating refresh   (W-3 fix)
--    3. Admin users paginated query support      (O-1 — index)
--    4. Partner report SQL aggregate function    (O-2 fix)
--    5. Loyalty leaderboard materialized view    (O-5 fix)
-- ══════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────
--  1. Atomic coupon-use-at-booking RPC  (C-4)
--
--  Problem: server.js called markCouponUsed() as a fire-and-forget
--  AFTER inserting the booking. A concurrent request could validate
--  the same coupon (still "unused") and insert a second free booking
--  before the first update committed.
--
--  Fix: a single DB function that:
--    a) acquires a row-level lock on the coupon row
--    b) verifies it is still unused and not expired
--    c) marks it used — all inside one transaction
--  The calling code rolls back the booking if this RPC fails.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION use_loyalty_coupon_at_booking(
  p_coupon_code TEXT,
  p_booking_id  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER   -- runs as DB owner so RLS doesn't block the lock
AS $$
DECLARE
  v_coupon_id  UUID;
  v_is_used    BOOLEAN;
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- Lock the coupon row — prevents concurrent requests from passing
  -- the "is_used = false" check simultaneously
  SELECT id, is_used, expires_at
  INTO   v_coupon_id, v_is_used, v_expires_at
  FROM   loyalty_coupons
  WHERE  code = p_coupon_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Coupon not found');
  END IF;

  IF v_is_used THEN
    RETURN json_build_object('success', false, 'error', 'Coupon has already been used');
  END IF;

  IF v_expires_at < NOW() THEN
    RETURN json_build_object('success', false, 'error', 'Coupon has expired');
  END IF;

  -- Mark as used atomically
  UPDATE loyalty_coupons
  SET    is_used          = TRUE,
         used_booking_id  = p_booking_id,
         used_at          = NOW()
  WHERE  id = v_coupon_id;

  RETURN json_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ────────────────────────────────────────────────────────────────
--  2. SQL-native professional rating refresh  (W-3)
--
--  Problem: server.js fetched all reviews then computed AVG in JS.
--  Two concurrent rating submissions would both read the same stale
--  list and overwrite each other with the same (wrong) average.
--
--  Fix: a single SQL function that runs the aggregation in-database.
--  Called as: supabase.rpc('refresh_professional_rating', { p_user_id })
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_professional_rating(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE professional_profiles
  SET
    rating        = (
      SELECT ROUND(AVG(rating)::numeric, 2)
      FROM   reviews
      WHERE  reviewee_id = p_user_id
    ),
    total_reviews = (
      SELECT COUNT(*)
      FROM   reviews
      WHERE  reviewee_id = p_user_id
    )
  WHERE user_id = p_user_id;
$$;


-- ────────────────────────────────────────────────────────────────
--  3. Index for paginated admin user listing  (O-1)
--
--  GET /api/admin/users now supports ?page=&limit=&search= params.
--  This index makes the ordered scan fast even at 100k+ users.
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS users_created_at_desc_idx
  ON users (created_at DESC);

-- Trigram index for ILIKE search on name and phone
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS users_name_trgm_idx
  ON users USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS users_phone_trgm_idx
  ON users USING gin (phone gin_trgm_ops);


-- ────────────────────────────────────────────────────────────────
--  4. Partner revenue report SQL aggregate  (O-2)
--
--  Problem: GET /api/admin/partner-report fetched all completed
--  bookings and grouped them via JS reduce() in Cloud Run memory.
--  At scale this saturates memory and is slow.
--
--  Fix: a SQL function that runs the aggregation in Postgres.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION partner_revenue_report(
  p_from DATE DEFAULT '2000-01-01',
  p_to   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  professional_id   UUID,
  professional_name TEXT,
  sub_role          TEXT,
  total_bookings    BIGINT,
  total_revenue     NUMERIC,
  provider_earnings NUMERIC,
  platform_fee      NUMERIC,
  gateway_fee       NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    b.professional_id,
    u.name                                    AS professional_name,
    pp.sub_role,
    COUNT(*)                                  AS total_bookings,
    ROUND(SUM(COALESCE(b.total_amount, b.amount, 0))::numeric, 2) AS total_revenue,
    ROUND(SUM(COALESCE(b.provider_earnings, 0))::numeric, 2)      AS provider_earnings,
    ROUND(SUM(COALESCE(b.platform_fee, 0))::numeric, 2)           AS platform_fee,
    ROUND(SUM(COALESCE(b.gateway_fee, 0))::numeric, 2)            AS gateway_fee
  FROM bookings b
  JOIN users               u  ON u.id  = b.professional_id
  LEFT JOIN professional_profiles pp ON pp.user_id = b.professional_id
  WHERE b.status      = 'completed'
    AND b.created_at::date BETWEEN p_from AND p_to
    AND b.professional_id IS NOT NULL
  GROUP BY b.professional_id, u.name, pp.sub_role
  ORDER BY total_revenue DESC;
$$;


-- ────────────────────────────────────────────────────────────────
--  5. Loyalty leaderboard materialized view  (O-5)
--
--  Problem: loyalty stats dashboard aggregated top earners by
--  iterating ALL loyalty_transactions rows in JS memory.
--
--  Fix: a materialized view refreshed nightly. Leaderboard reads
--  become a simple indexed scan instead of a full table scan.
-- ────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS loyalty_leaderboard AS
  SELECT
    lt.user_id,
    u.name,
    SUM(CASE WHEN lt.points > 0 THEN lt.points ELSE 0 END) AS total_earned,
    SUM(CASE WHEN lt.points < 0 THEN ABS(lt.points) ELSE 0 END) AS total_spent,
    COALESCE(u.loyalty_points, 0) AS current_balance
  FROM loyalty_transactions lt
  JOIN users u ON u.id = lt.user_id
  GROUP BY lt.user_id, u.name, u.loyalty_points
  ORDER BY total_earned DESC
  LIMIT 100;

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_leaderboard_user_idx
  ON loyalty_leaderboard (user_id);

-- Refresh nightly at 02:00 UTC via pg_cron.
-- If pg_cron is not available on your Supabase plan, trigger a refresh
-- from your keepalive GitHub Actions workflow instead (see keepalive.yml).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.schedule(
      'loyalty-leaderboard-refresh',
      '0 2 * * *',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY loyalty_leaderboard'
    );
  END IF;
END;
$$;


-- ── Verification queries ────────────────────────────────────────
SELECT routine_name
FROM   information_schema.routines
WHERE  routine_name IN (
  'use_loyalty_coupon_at_booking',
  'refresh_professional_rating',
  'partner_revenue_report'
);

SELECT matviewname FROM pg_matviews WHERE matviewname = 'loyalty_leaderboard';

SELECT indexname
FROM   pg_indexes
WHERE  indexname IN (
  'users_created_at_desc_idx',
  'users_name_trgm_idx',
  'users_phone_trgm_idx',
  'loyalty_leaderboard_user_idx'
);
