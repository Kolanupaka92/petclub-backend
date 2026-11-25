-- ═══════════════════════════════════════════════════════════════
--  Security lockdown: the browser roles (anon, authenticated) get no direct
--  database access. All reads and writes go through the API (service_role).
--
--  Before this: 8 SECURITY DEFINER functions were callable by anon (create a
--  booking at any price, spend another user's credits, read partner revenue,
--  trip rate limits), pet_health_documents was open to every role because its
--  policy had no TO clause, and loyalty_leaderboard exposed names and balances.
--
--  Idempotent. Frontend impact: none — the app only uses the anon key for
--  signed-URL uploads (token-authorised) and Realtime, which RLS already blocks.
-- ═══════════════════════════════════════════════════════════════

-- 1. Functions: service_role only, with a pinned search_path for definer ones.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')  -- skip extensions
      AND (p.prosecdef OR p.proname = 'generate_referral_code')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
END $$;

-- 2. Health documents: policy must name the role it is for.
DROP POLICY IF EXISTS service_role_all_pet_health_documents ON public.pet_health_documents;
CREATE POLICY service_role_all_pet_health_documents ON public.pet_health_documents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Tables, views and materialized views: no direct access (defence in depth under RLS).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 4. Same for anything created later.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 5. One live account per email (it is a login identity). No duplicates exist today.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_live_unique
  ON public.users (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
