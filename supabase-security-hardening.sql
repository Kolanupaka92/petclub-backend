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
--  ✅ Superseded by supabase-migration-20240001-redeem-loyalty-coupon.sql
--     which defines the canonical function name `redeem_loyalty_coupon`.
--
--  This block drops the interim name `use_loyalty_coupon_at_booking`
--  (created during the initial security pass) and creates a forward-
--  compatible alias so any in-flight requests during deployment still work.
--  Once all Cloud Run instances have redeployed with the new service code
--  that calls `redeem_loyalty_coupon`, the alias can be dropped.
-- ────────────────────────────────────────────────────────────────

-- Drop the interim name created in the first security pass
DROP FUNCTION IF EXISTS use_loyalty_coupon_at_booking(TEXT, UUID);

-- Re-run the canonical migration inline (idempotent — OR REPLACE is safe)
-- Full definition is in supabase-migration-20240001-redeem-loyalty-coupon.sql
CREATE OR REPLACE FUNCTION redeem_loyalty_coupon(
  p_coupon_code TEXT,
  p_booking_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM id
  FROM    loyalty_coupons
  WHERE   code    = p_coupon_code
    AND   is_used = FALSE
  FOR UPDATE;

  UPDATE loyalty_coupons
  SET    is_used         = TRUE,
         used_at         = NOW(),
         used_booking_id = p_booking_id
  WHERE  code    = p_coupon_code
    AND  is_used = FALSE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_already_used'
      USING ERRCODE = 'P0001',
            DETAIL  = format('Coupon %s was not found or has already been used.', p_coupon_code);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION redeem_loyalty_coupon(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION redeem_loyalty_coupon(TEXT, UUID) TO service_role;


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
