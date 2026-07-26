-- ══════════════════════════════════════════════════════════════════
--  Booking reminder log — idempotency for the reminder cron
--
--  Problem: POST /api/cron/booking-reminders now checks 4 time windows
--  (24h, 5h, 2h, 1h before service) on an hourly cron. Windows must be
--  wide enough that a booking is never missed even if the cron run is
--  a few minutes late, but a wide window checked every hour risks the
--  same booking matching on two consecutive runs — a customer getting
--  the same "2 hours before" reminder twice.
--
--  Fix: claim-before-send. Each (booking, checkpoint, recipient, channel)
--  tuple can be inserted exactly once; the second attempt hits the
--  unique constraint and is silently skipped. This is the same
--  claim-based idempotency pattern already used for loyalty review
--  bonuses (supabase-loyalty-hardening.sql).
--
--  Idempotent: safe to re-run.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.booking_reminder_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  checkpoint   text NOT NULL,   -- '24h' | '5h' | '2h' | '1h'
  recipient    text NOT NULL,   -- 'customer' | 'professional'
  channel      text NOT NULL,   -- 'email' | 'push'
  sent_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_reminder_log_checkpoint_chk CHECK (checkpoint IN ('24h','5h','2h','1h')),
  CONSTRAINT booking_reminder_log_recipient_chk  CHECK (recipient  IN ('customer','professional')),
  CONSTRAINT booking_reminder_log_channel_chk    CHECK (channel    IN ('email','push')),
  CONSTRAINT booking_reminder_log_unique UNIQUE (booking_id, checkpoint, recipient, channel)
);

CREATE INDEX IF NOT EXISTS idx_booking_reminder_log_booking ON public.booking_reminder_log(booking_id);

-- Housekeeping: reminder log rows are only useful for a few days after the
-- booking; no automatic cleanup is required at current volume, but the
-- booking_id FK cascade means they're removed if the booking itself is
-- ever hard-deleted.

ALTER TABLE public.booking_reminder_log ENABLE ROW LEVEL SECURITY;
-- Backend uses service_role (bypasses RLS) — no policies needed, this is
-- an internal-only table never queried by client code.
