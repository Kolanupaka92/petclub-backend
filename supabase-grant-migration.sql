-- ══════════════════════════════════════════════════════════════════
--  PETclub — Explicit PostgREST Table Grants
--  Run in Supabase SQL Editor BEFORE October 30, 2026
--
--  Background:
--    Supabase is removing the implicit "all public tables are exposed
--    to the Data API" default. From Oct 30 2026, any table without an
--    explicit GRANT will be invisible to PostgREST / supabase-js.
--
--    Reference: https://supabase.com/changelog/public-schema-grants
--
--  Architecture note:
--    PETclub backend uses service_role key server-side only.
--    No direct supabase-js calls from the frontend.
--    - service_role  → needs full access (backend writes)
--    - authenticated → NOT granted (no client-side Supabase)
--    - anon          → NOT granted (no public unauthenticated access)
--
--  Add this block at the bottom of any future CREATE TABLE migration.
-- ══════════════════════════════════════════════════════════════════

-- Core tables (schema.sql)
GRANT ALL ON TABLE public.users               TO service_role;
GRANT ALL ON TABLE public.customer_profiles   TO service_role;
GRANT ALL ON TABLE public.pets                TO service_role;
GRANT ALL ON TABLE public.grooming_records    TO service_role;
GRANT ALL ON TABLE public.training_records    TO service_role;
GRANT ALL ON TABLE public.food_orders         TO service_role;
GRANT ALL ON TABLE public.vet_records         TO service_role;
GRANT ALL ON TABLE public.professional_profiles TO service_role;
GRANT ALL ON TABLE public.id_documents        TO service_role;
GRANT ALL ON TABLE public.payout_details      TO service_role;
GRANT ALL ON TABLE public.bookings            TO service_role;
GRANT ALL ON TABLE public.reviews             TO service_role;
GRANT ALL ON TABLE public.admin_logs          TO service_role;
GRANT ALL ON TABLE public.website_leads       TO service_role;

-- Loyalty tables (supabase-loyalty-migration.sql)
GRANT ALL ON TABLE public.loyalty_transactions TO service_role;
GRANT ALL ON TABLE public.loyalty_coupons      TO service_role;

-- Sequences (needed for INSERT with serial/identity columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
