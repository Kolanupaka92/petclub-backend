-- ══════════════════════════════════════════════════════════════════
--  Migration 20240002 — SQL-native professional rating aggregation
--
--  Problem (W-3 race condition):
--    server.js previously fetched all reviews into Node memory, then
--    computed the average with a JS Array.reduce(). Two simultaneous
--    rating submissions both read the same stale review set, computed
--    the same (wrong) average, and overwrote each other — leaving
--    total_reviews one short and rating potentially incorrect.
--
--  Fix:
--    A single SQL function runs the AVG() and COUNT() aggregations
--    entirely inside Postgres. The UPDATE is atomic — no stale reads,
--    no overwrite races, no data transferred to Node.
--
--  Run order: after supabase-migration-20240001-redeem-loyalty-coupon.sql
--
--  Notes on SECURITY DEFINER:
--    RLS is enabled on both `reviews` and `professional_profiles`.
--    Without SECURITY DEFINER the function would run as the calling
--    user's role, which may not have a SELECT policy on reviews or an
--    UPDATE policy on professional_profiles for other users' rows.
--    SECURITY DEFINER lets it run as the function owner (postgres/supabase),
--    which has full access — matching the behaviour of the service-role
--    key used by server.js.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refresh_professional_rating(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER   -- bypass RLS on reviews + professional_profiles
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

-- ── Grant execute ────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION refresh_professional_rating(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION refresh_professional_rating(UUID) TO service_role;

-- ── Verify ───────────────────────────────────────────────────────
SELECT routine_name, routine_type, security_type
FROM   information_schema.routines
WHERE  routine_name = 'refresh_professional_rating'
  AND  routine_schema = 'public';
