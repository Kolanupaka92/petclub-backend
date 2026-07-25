-- ══════════════════════════════════════════════════════════════════
--  Active-row views — eliminate the soft-delete bug class
--
--  Problem: bookings, pets, and users use soft-delete (deleted_at).
--  Every read must remember `.is('deleted_at', null)`. Forgetting it
--  has repeatedly leaked deleted rows into audits, earnings, and stats.
--  Discipline across 100+ call sites doesn't scale.
--
--  Fix: canonical views that pre-filter deleted rows. Raw SQL, RPCs,
--  reporting, and analytics query the view and physically cannot see
--  deleted rows. (App-code reads via supabase-js get the same guarantee
--  through the activeSelect() helper in services/db.js.)
--
--  Writes still go to the BASE tables (insert/update/delete) — these
--  views are read surfaces only.
--
--  Idempotent: safe to re-run.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW active_users AS
  SELECT * FROM public.users     WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW active_bookings AS
  SELECT * FROM public.bookings  WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW active_pets AS
  SELECT * FROM public.pets      WHERE deleted_at IS NULL;

-- The backend uses the service_role key, which bypasses RLS and can read
-- these views. Grant explicitly anyway so intent is documented and the
-- views work if queried under a future non-service role.
GRANT SELECT ON active_users, active_bookings, active_pets TO service_role;

COMMENT ON VIEW active_users    IS 'users WHERE deleted_at IS NULL — use for all reads; write to base table users.';
COMMENT ON VIEW active_bookings IS 'bookings WHERE deleted_at IS NULL — use for all reads; write to base table bookings.';
COMMENT ON VIEW active_pets     IS 'pets WHERE deleted_at IS NULL — use for all reads; write to base table pets.';
