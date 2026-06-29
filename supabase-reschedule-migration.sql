-- ══════════════════════════════════════════════════════════════════════
--  PETclub — Reschedule Support Migration
--  Run in Supabase SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════════════

-- Store original scheduled_at when a booking is rescheduled (audit trail)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS rescheduled_from TIMESTAMPTZ;
