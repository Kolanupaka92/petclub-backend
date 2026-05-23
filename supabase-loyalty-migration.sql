-- ══════════════════════════════════════════════════════════════════
--  PETclub Loyalty System — DB Migration
--  Run in Supabase SQL Editor (Project: PET CLUB / zjrgbsrsthtmxkislgcm)
-- ══════════════════════════════════════════════════════════════════

-- 1. Add loyalty columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_points  INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code   TEXT    UNIQUE;

-- Auto-generate referral codes for existing users (PC- + first 8 chars of UUID)
UPDATE users
SET referral_code = 'PC-' || UPPER(SUBSTRING(id::text, 1, 8))
WHERE referral_code IS NULL;

-- Ensure all new users also get a referral code (via trigger)
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := 'PC-' || UPPER(SUBSTRING(NEW.id::text, 1, 8));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_generate_referral_code ON users;
CREATE TRIGGER trg_generate_referral_code
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION generate_referral_code();

-- 2. Loyalty transactions — full audit trail of every earn/redeem event
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  points      INTEGER     NOT NULL,          -- positive = earn, negative = redeem
  type        TEXT        NOT NULL,          -- see types below
  description TEXT,
  booking_id  UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  coupon_code TEXT,                          -- populated on redemption
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Types: 'booking_spend' | 'payment_bonus' | 'referral_earned' |
--        'referral_bonus' | 'review_bonus' | 'redemption' | 'admin_award' | 'expiry'

CREATE INDEX IF NOT EXISTS loyalty_txn_user_idx ON loyalty_transactions(user_id);
CREATE INDEX IF NOT EXISTS loyalty_txn_booking_idx ON loyalty_transactions(booking_id);

-- 3. Loyalty coupons — generated on 1,000 credit redemption
CREATE TABLE IF NOT EXISTS loyalty_coupons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT        UNIQUE NOT NULL,
  user_id         UUID        REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  service_name    TEXT        DEFAULT 'Basic Bath',
  discount_pct    INTEGER     DEFAULT 100,   -- 100% = free service
  is_used         BOOLEAN     DEFAULT FALSE,
  used_booking_id UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  used_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '6 months',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS loyalty_coupons_user_idx ON loyalty_coupons(user_id);
CREATE INDEX IF NOT EXISTS loyalty_coupons_code_idx ON loyalty_coupons(code);

-- 4. RLS policies (Supabase Row Level Security)
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_coupons      ENABLE ROW LEVEL SECURITY;

-- Users can read their own rows; backend service role bypasses RLS
CREATE POLICY "Users read own loyalty txns"
  ON loyalty_transactions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users read own coupons"
  ON loyalty_coupons FOR SELECT
  USING (user_id = auth.uid());

-- ══════════════════════════════════════════════════════════════════
--  Verify
-- ══════════════════════════════════════════════════════════════════
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('loyalty_points', 'referral_code');

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('loyalty_transactions', 'loyalty_coupons');
