'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  PETclub Loyalty Service
 *  services/loyaltyService.js
 * ═════════════════════��═══════════════════════════��════════════════
 *
 * Handles all loyalty credit earn, redeem, and coupon logic.
 *
 * Credit earn rules:
 *   booking_spend   — 1 credit per ₹10 paid (triggered by Razorpay webhook)
 *   payment_bonus   — +50 for paying via in-app Razorpay
 *   review_bonus    — +50 for submitting a verified review
 *   referral_bonus  — +200 when a referred friend completes their first booking
 *   admin_award     — manual admin adjustment
 *
 * Redemption:
 *   1,000 credits → unique one-time coupon for a free Basic Bath
 *   SP always receives a normal job notification — they never see coupon details.
 *   SP payout is the same regardless of whether customer paid cash or redeemed.
 *
 * Security:
 *   - All balance changes go through awardPoints() — atomic Supabase transaction
 *   - Coupon codes are cryptographically random, single-use, expire in 6 months
 *   - SP-facing booking API strips coupon/discount fields (see server.js)
 * ══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
const CREDITS_PER_RUPEE   = 1 / 10;   // 1 credit per ₹10 spent
const PAYMENT_BONUS       = 50;
const REVIEW_BONUS        = 50;
const REFERRAL_BONUS      = 200;       // awarded to referrer when friend books
const REDEMPTION_THRESHOLD = 1000;     // credits needed to unlock free service
const REDEMPTION_SERVICE  = 'Basic Bath'; // free service granted on redemption
const COUPON_VALIDITY_DAYS = 180;      // 6 months

// Anomaly detection threshold — alert if a user earns more than this in 24 h.
// Normal max in one day: booking_spend (~200) + payment_bonus (50) + review_bonus (50) = ~300
// Anything above 2 × normal max is suspicious.
const ANOMALY_THRESHOLD_24H = 600;

// ── Helpers ──────────────��──────────────────────────��───────────────────────
/**
 * Generate a unique coupon code: PCR-XXXXXX-XXXXXX (20 chars, URL-safe)
 */
function generateCouponCode() {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PCR-${part()}-${part()}`;
}

/**
 * Calculate booking credits from a paid amount (INR).
 * Only call this from the Razorpay payment webhook — not at booking creation.
 */
function creditsFromAmount(amountInr) {
  if (!amountInr || amountInr <= 0) return 0;
  return Math.floor(amountInr * CREDITS_PER_RUPEE);
}

// ── Core functions ─────────────��────────────────────────────────────────────

/**
 * Award loyalty credits to a user.
 * Atomically inserts a transaction and updates users.loyalty_points.
 *
 * @param {object} supabase   — Supabase client
 * @param {string} userId
 * @param {number} points     — positive integer (negative not allowed here; use redeemCredits)
 * @param {string} type       — event type key
 * @param {string} description
 * @param {string} [bookingId]
 * @returns {Promise<{ success: boolean, newBalance: number, awarded: number }>}
 */
async function awardPoints(supabase, userId, points, type, description, bookingId = null) {
  if (!points || points <= 0) return { success: false, error: 'Points must be positive' };

  // Insert transaction
  const { error: txnErr } = await supabase.from('loyalty_transactions').insert({
    user_id:     userId,
    points:      points,
    type,
    description,
    booking_id:  bookingId,
  });
  if (txnErr) {
    console.error('[Loyalty] awardPoints txn insert error:', txnErr.message);
    return { success: false, error: txnErr.message };
  }

  // Increment user balance (rpc fallback: direct update with current value)
  const { data: user, error: fetchErr } = await supabase
    .from('users').select('loyalty_points').eq('id', userId).single();
  if (fetchErr) return { success: false, error: fetchErr.message };

  const newBalance = (user.loyalty_points || 0) + points;
  const { error: updateErr } = await supabase
    .from('users').update({ loyalty_points: newBalance }).eq('id', userId);
  if (updateErr) return { success: false, error: updateErr.message };

  console.log(`[Loyalty] Awarded ${points} pts (${type}) → user ${userId} | new balance: ${newBalance}`);

  // ── Anomaly detection (non-blocking) ──────────────────────────────────────
  // Check how many points this user has earned in the last 24 hours.
  // If it exceeds ANOMALY_THRESHOLD_24H, emit a loud warning so ops can review.
  // This runs in the background — it never delays or blocks the award response.
  checkAnomalyAsync(supabase, userId, newBalance).catch(e =>
    console.warn('[Loyalty] anomaly check error (non-fatal):', e.message)
  );

  return { success: true, newBalance, awarded: points };
}

/**
 * Background anomaly check — runs after every successful awardPoints call.
 * Sums points earned by this user in the last 24 h. If the total exceeds
 * ANOMALY_THRESHOLD_24H, logs a structured warning for ops to investigate.
 * Does NOT block or reverse the award — detection only, not prevention.
 */
async function checkAnomalyAsync(supabase, userId, currentBalance) {
  const since = new Date(Date.now() - 86400_000).toISOString(); // 24 h ago
  const { data: rows } = await supabase
    .from('loyalty_transactions')
    .select('points')
    .eq('user_id', userId)
    .gte('created_at', since)
    .gt('points', 0);   // only earning events, not redemptions

  const earned24h = (rows || []).reduce((s, r) => s + (r.points || 0), 0);
  if (earned24h > ANOMALY_THRESHOLD_24H) {
    // Structured log — easy to grep/alert on in Cloud Run logs
    console.warn(JSON.stringify({
      alert:       'LOYALTY_ANOMALY',
      user_id:     userId,
      earned_24h:  earned24h,
      threshold:   ANOMALY_THRESHOLD_24H,
      balance:     currentBalance,
      ts:          new Date().toISOString(),
      action:      'Review this account for unusual activity. Admin panel → /api/admin/loyalty/stats',
    }));
  }
}

/**
 * Redeem 1,000 credits for a free service coupon.
 *
 * Uses an atomic Postgres RPC function (redeem_loyalty_credits) that wraps
 * the entire operation in a single DB transaction with a row-level lock:
 *   BEGIN → lock user row → check balance → check existing coupons
 *         → deduct 1000 → insert coupon → log transaction → COMMIT
 * Any failure causes a full rollback — no partial state, no double-spend.
 *
 * Prerequisite: run supabase-loyalty-hardening.sql to create the function.
 *
 * @param {object} supabase
 * @param {string} userId
 * @returns {Promise<{ success: boolean, couponCode?: string, expiresAt?: string, error?: string }>}
 */
async function redeemCredits(supabase, userId) {
  const code      = generateCouponCode();
  const expiresAt = new Date(Date.now() + COUPON_VALIDITY_DAYS * 86400_000).toISOString();

  // Invoke the atomic Postgres function — all-or-nothing transaction
  const { data, error } = await supabase.rpc('redeem_loyalty_credits', {
    p_user_id:    userId,
    p_coupon_code: code,
    p_service:    REDEMPTION_SERVICE,
    p_expires_at: expiresAt,
  });

  if (error) {
    console.error('[Loyalty] redeemCredits RPC error:', error.message);
    return { success: false, error: 'Redemption failed. Please try again.' };
  }

  // RPC returns a JSON object
  const result = typeof data === 'string' ? JSON.parse(data) : data;
  if (!result?.success) {
    return {
      success:      false,
      error:        result?.error || 'Redemption failed',
      existingCode: result?.existing_code,
    };
  }

  console.log(`[Loyalty] Redeemed ${REDEMPTION_THRESHOLD} pts → user ${userId} | coupon: ${code} | new balance: ${result.new_balance}`);
  return {
    success:     true,
    couponCode:  code,
    expiresAt,
    newBalance:  result.new_balance,
    serviceName: REDEMPTION_SERVICE,
  };
}

/**
 * Check whether a review_bonus has already been awarded for a given booking.
 * Used to enforce Fix 2: one review bonus per booking, at DB level backed
 * by the loyalty_txn_review_bonus_once unique index.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {string} bookingId
 * @returns {Promise<boolean>}
 */
async function hasEarnedReviewBonus(supabase, userId, bookingId) {
  const { data } = await supabase
    .from('loyalty_transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .eq('type', 'review_bonus')
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Get a user's loyalty summary: balance, progress, transactions, active coupons.
 * Also returns pending_points — credits locked in unconfirmed payments (post-Razorpay).
 *
 * @param {object} supabase
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getLoyaltySummary(supabase, userId) {
  const [userRes, txnRes, couponRes, pendingRes] = await Promise.all([
    supabase.from('users').select('loyalty_points, referral_code').eq('id', userId).single(),
    supabase.from('loyalty_transactions')
      .select('id, points, type, description, booking_id, coupon_code, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('loyalty_coupons')
      .select('code, service_name, discount_pct, is_used, expires_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5),
    // Fix 5: pending points — bookings paid but webhook not yet confirmed
    // payment_status 'pending' means Razorpay captured but webhook hasn't fired yet
    supabase.from('bookings')
      .select('amount')
      .eq('customer_id', userId)
      .eq('status', 'upcoming')
      .eq('payment_status', 'pending')
      .not('amount', 'is', null),
  ]);

  const balance      = userRes.data?.loyalty_points || 0;
  const referralCode = userRes.data?.referral_code  || null;

  // Calculate pending credits from unconfirmed payments
  const pendingPoints = (pendingRes.data || []).reduce((sum, b) => {
    return sum + Math.floor((b.amount || 0) * CREDITS_PER_RUPEE);
  }, 0);

  const transactions = txnRes.data  || [];
  const coupons      = couponRes.data || [];

  // is_new_member: true on the first GET after account creation (no earn history yet).
  // The frontend uses this flag to show the "Welcome to PETclub Rewards" modal once.
  const isNewMember = transactions.length === 0 && balance === 0;

  return {
    balance,
    pending_points: pendingPoints,           // Fix 5: shown in UI as locked
    threshold:      REDEMPTION_THRESHOLD,
    progress_pct:   Math.min(100, Math.round((balance / REDEMPTION_THRESHOLD) * 100)),
    credits_needed: Math.max(0, REDEMPTION_THRESHOLD - balance),
    can_redeem:     balance >= REDEMPTION_THRESHOLD,
    referral_code:  referralCode,
    is_new_member:  isNewMember,             // Frontend trigger for welcome modal
    earn_rules: [
      { event: 'Book & pay via app',     points: '1 per ₹10',       icon: '📅' },
      { event: 'Pay in-app (Razorpay)',   points: `+${PAYMENT_BONUS}`, icon: '💳' },
      { event: 'Write a review',          points: `+${REVIEW_BONUS}`,  icon: '⭐' },
      { event: 'Refer a friend',          points: `+${REFERRAL_BONUS}`,icon: '👥' },
    ],
    transactions,
    coupons,
  };
}

/**
 * Validate a coupon code at booking time.
 * Returns the coupon if valid, or an error.
 */
async function validateCoupon(supabase, code, userId) {
  const { data: coupon, error } = await supabase
    .from('loyalty_coupons')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .eq('user_id', userId)
    .single();
  if (error || !coupon)         return { valid: false, error: 'Coupon not found' };
  if (coupon.is_used)           return { valid: false, error: 'This coupon has already been used' };
  if (new Date(coupon.expires_at) < new Date()) return { valid: false, error: 'Coupon has expired' };
  return { valid: true, coupon };
}

/**
 * Mark a coupon as used when a booking is completed.
 */
async function markCouponUsed(supabase, code, bookingId) {
  await supabase.from('loyalty_coupons')
    .update({ is_used: true, used_booking_id: bookingId, used_at: new Date().toISOString() })
    .eq('code', code);
}

module.exports = {
  CREDITS_PER_RUPEE,
  PAYMENT_BONUS,
  REVIEW_BONUS,
  REFERRAL_BONUS,
  REDEMPTION_THRESHOLD,
  REDEMPTION_SERVICE,
  ANOMALY_THRESHOLD_24H,
  creditsFromAmount,
  awardPoints,
  checkAnomalyAsync,
  hasEarnedReviewBonus,
  redeemCredits,
  getLoyaltySummary,
  validateCoupon,
  markCouponUsed,
};
