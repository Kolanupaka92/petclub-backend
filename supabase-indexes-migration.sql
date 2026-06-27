-- ══════════════════════════════════════════════════════════════════════
--  PETclub — Performance Indexes Migration
--  Run in Supabase SQL Editor → New Query
--  Safe to re-run: all statements use IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════════

-- ── bookings ─────────────────────────────────────────────────────────
-- Customer view: "show me my bookings" + status filter
CREATE INDEX IF NOT EXISTS idx_bookings_customer_status
  ON bookings (customer_id, status, created_at DESC);

-- Professional view: "show me my assigned bookings"
CREATE INDEX IF NOT EXISTS idx_bookings_professional_status
  ON bookings (professional_id, status, scheduled_at);

-- Assignment search: find upcoming bookings in a city needing a pro
CREATE INDEX IF NOT EXISTS idx_bookings_assignment
  ON bookings (status, assignment_status, created_at)
  WHERE status = 'upcoming';

-- Scheduled time lookups (upcoming filter, cancellation fee calc)
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_at
  ON bookings (scheduled_at)
  WHERE status = 'upcoming';

-- Payment status (Razorpay webhook lookups)
CREATE INDEX IF NOT EXISTS idx_bookings_payment_status
  ON bookings (payment_status)
  WHERE payment_status = 'pending';

-- ── loyalty_transactions ──────────────────────────────────────────────
-- Per-user history (getLoyaltySummary fetches last 20 ordered by date)
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_user_created
  ON loyalty_transactions (user_id, created_at DESC);

-- 30-day window aggregate (admin stats endpoint)
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_created_at
  ON loyalty_transactions (created_at DESC);

-- ── otp_tokens ────────────────────────────────────────────────────────
-- OTP lookup by phone + expiry (verify-phone-otp, verify-email-otp)
CREATE INDEX IF NOT EXISTS idx_otp_tokens_phone_expires
  ON otp_tokens (phone, expires_at DESC);

-- ── admin_logs ────────────────────────────────────────────────────────
-- Auto-suspend queries: "suspensions in last 24h per user"
CREATE INDEX IF NOT EXISTS idx_admin_logs_action_created
  ON admin_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_target
  ON admin_logs (target_id, action, created_at DESC);

-- ── professional_profiles ─────────────────────────────────────────────
-- Assignment: find available verified pros by city
CREATE INDEX IF NOT EXISTS idx_prof_city_available
  ON professional_profiles (city, is_available, verification_status)
  WHERE verification_status = 'approved';

-- ── Verification ──────────────────────────────────────────────────────
-- Expected: indexes listed above (run SELECT indexname FROM pg_indexes
-- WHERE tablename IN ('bookings','loyalty_transactions','otp_tokens',
-- 'admin_logs','professional_profiles') to confirm)
