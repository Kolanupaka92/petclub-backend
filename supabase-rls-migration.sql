-- ══════════════════════════════════════════════════════════════════
--  PETclub — Row Level Security (RLS) Migration
--  Run in Supabase SQL Editor (one-time setup)
--
--  Why:
--    The backend always uses the service_role key, which bypasses RLS
--    by design. Enabling RLS is defence-in-depth:
--    • If anon key is ever accidentally exposed, no data leaks
--    • Supabase is removing implicit public-schema access (Oct 2026)
--    • Audit trail: explicit policy = intentional access decision
--
--  Effect on backend: NONE — service_role bypasses all RLS policies.
--  Effect on frontend: N/A — frontend never calls Supabase directly.
-- ══════════════════════════════════════════════════════════════════

-- ── Enable RLS on all core tables ────────────────────────────────
ALTER TABLE public.users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pets                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_tokens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grooming_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vet_records            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_orders            ENABLE ROW LEVEL SECURITY;

-- ── Drop any existing policies (idempotent re-run) ───────────────
DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ── service_role full-access policies ────────────────────────────
-- service_role bypasses RLS by default in Supabase, but explicit
-- policies make the intent auditable and survive future Supabase changes.

CREATE POLICY "service_role_all_users"
  ON public.users FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_customer_profiles"
  ON public.customer_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_pets"
  ON public.pets FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_professional_profiles"
  ON public.professional_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_bookings"
  ON public.bookings FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_otp_tokens"
  ON public.otp_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_rate_limits"
  ON public.rate_limits FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_loyalty_transactions"
  ON public.loyalty_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_grooming_records"
  ON public.grooming_records FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_training_records"
  ON public.training_records FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_vet_records"
  ON public.vet_records FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_food_orders"
  ON public.food_orders FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── No anon / authenticated policies ─────────────────────────────
-- Deliberately NOT granting any access to anon or authenticated roles.
-- All data access goes through the backend (service_role).
-- If you ever add client-side Supabase calls, add scoped policies here.

-- ── Verify ───────────────────────────────────────────────────────
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
