-- The daily leaderboard job has called this function since it was written, but
-- it never existed, so the job silently skipped every run. Idempotent.
CREATE OR REPLACE FUNCTION public.refresh_loyalty_leaderboard()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ REFRESH MATERIALIZED VIEW public.loyalty_leaderboard $$;
REVOKE EXECUTE ON FUNCTION public.refresh_loyalty_leaderboard() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_loyalty_leaderboard() TO service_role;
