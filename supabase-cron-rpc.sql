-- ══════════════════════════════════════════════════════════════════
--  PETclub — Cron RPC helper
--  Run once in Supabase SQL Editor (Database → SQL Editor).
--
--  Creates a SECURITY DEFINER function so the service_role key
--  (used by server.js) can refresh the materialized view without
--  needing superuser privileges.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refresh_loyalty_leaderboard()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY loyalty_leaderboard;
END;
$$;

-- Grant execute to the service_role used by server.js
GRANT EXECUTE ON FUNCTION refresh_loyalty_leaderboard() TO service_role;
