-- ══════════════════════════════════════════════════════════════════
--  PETclub — Fix refresh_tokens FK constraint
--  Run once in Supabase SQL Editor (already applied 2026-06-29).
--
--  Problem: refresh_tokens was created with REFERENCES users(id) without
--  a schema prefix. PostgreSQL resolved "users" to auth.users (Supabase's
--  built-in auth table) instead of public.users (our custom user table).
--  This caused every login to fail with FK violation because our users
--  live in public.users and don't exist in auth.users.
--
--  Fix: drop the bad FK and re-add it pointing to public.users(id).
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE public.refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey;

ALTER TABLE public.refresh_tokens
  ADD CONSTRAINT refresh_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
