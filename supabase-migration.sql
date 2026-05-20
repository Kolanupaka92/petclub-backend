-- ═══════════════════════════════════════════════════════════
--  PETclub — Booking Assignment Migration
--  Run this in Supabase SQL Editor:
--  https://app.supabase.com → Your Project → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Add assignment tracking columns to bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS assignment_status TEXT DEFAULT 'searching',
  ADD COLUMN IF NOT EXISTS response_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS service_type      TEXT,   -- 'Groomer' | 'Trainer' | 'Vet'
  ADD COLUMN IF NOT EXISTS city              TEXT,
  ADD COLUMN IF NOT EXISTS address           TEXT,
  ADD COLUMN IF NOT EXISTS notes             TEXT;

-- 2. Add round-robin tracker to professional_profiles
ALTER TABLE professional_profiles
  ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;

-- 3. Booking assignments — tracks full round-robin history per booking
CREATE TABLE IF NOT EXISTS booking_assignments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES bookings(id)             ON DELETE CASCADE,
  professional_id  UUID REFERENCES professional_profiles(id) ON DELETE CASCADE,
  status           TEXT DEFAULT 'offered',   -- offered | accepted | rejected | timed_out
  offered_at       TIMESTAMPTZ DEFAULT NOW(),
  responded_at     TIMESTAMPTZ,
  response_deadline TIMESTAMPTZ NOT NULL
);

-- Indexes for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_ba_booking_pro
  ON booking_assignments(booking_id, professional_id);
CREATE INDEX IF NOT EXISTS idx_ba_status_deadline
  ON booking_assignments(status, response_deadline)
  WHERE status = 'offered';
CREATE INDEX IF NOT EXISTS idx_ba_pro
  ON booking_assignments(professional_id);

-- 4. Add country to customer_profiles
ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'India';

-- 5. Reviews table — add booking_id for one-rating-per-booking enforcement
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking
  ON reviews(booking_id) WHERE booking_id IS NOT NULL;

-- 6. Professional profile rating columns (if not already present)
ALTER TABLE professional_profiles
  ADD COLUMN IF NOT EXISTS rating       NUMERIC(3,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_reviews INTEGER      DEFAULT 0;

-- 7. FCM push notification token per user
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- 8. Payment fields on bookings (Razorpay — active after LLC registration)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_status   TEXT DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS razorpay_order_id  TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;

-- 9. Payment audit log table
CREATE TABLE IF NOT EXISTS payment_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,
  user_id             UUID REFERENCES users(id)    ON DELETE SET NULL,
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  amount              INTEGER,  -- in paise
  currency            TEXT DEFAULT 'INR',
  status              TEXT DEFAULT 'pending',  -- pending | success | failed | refunded
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Done! After running, redeploy: railway up --service petclub-backend --detach
