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

// ── Config ──────────────────────────────────���──────────────────────────────
const CREDITS_PER_RUPEE   = 1 / 10;   // 1 credit per ₹10 spent
const PAYMENT_BONUS       = 50;
const REVIEW_BONUS        = 50;
const REFERRAL_BONUS      = 200;       // awarded to referrer when friend books
const REDEMPTION_THRESHOLD = 1000;     // credits needed to unlock free service
const REDEMPTION_SERVICE  = 'Basic Bath'; // free service granted on redemption
const COUPON_VALIDITY_DAYS = 180;      // 6 months

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
  return { success: true, newBalance, awarded: points };
}

/**
 * Redeem 1,000 credits for a free service coupon.
 * Fails if user has fewer than REDEMPTION_THRESHOLD credits.
 *
 * @param {object} supabase
 * @param {string} userId
 * @returns {Promise<{ success: boolean, couponCode?: string, expiresAt?: string, error?: string }>}
 */
async function redeemCredits(supabase, userId) {
  // Get current balance
  const { data: user, error: fetchErr } = await supabase
    .from('users').select('loyalty_points').eq('id', userId).single();
  if (fetchErr) return { success: false, error: 'Could not fetch loyalty balance' };

  const balance = user.loyalty_points || 0;
  if (balance < REDEMPTION_THRESHOLD) {
    return { success: false, error: `Insufficient credits. You have ${balance} — need ${REDEMPTION_THRESHOLD}.` };
  }

  // Check for existing unused coupons (don't stack)
  const { data: existingCoupons } = await supabase
    .from('loyalty_coupons')
    .select('code, expires_at')
    .eq('user_id', userId)
    .eq('is_used', false)
    .gt('expires_at', new Date().toISOString());
  if (existingCoupons?.length > 0) {
    return {
      success: false,
      error:   `You already have an active coupon: ${existingCoupons[0].code}. Use it before redeeming again.`,
      existingCode: existingCoupons[0].code,
    };
  }

  // Generate coupon
  const code      = generateCouponCode();
  const expiresAt = new Date(Date.now() + COUPON_VALIDITY_DAYS * 86400_000).toISOString();

  const { error: couponErr } = await supabase.from('loyalty_coupons').insert({
    code,
    user_id:      userId,
    service_name: REDEMPTION_SERVICE,
    discount_pct: 100,
    expires_at:   expiresAt,
  });
  if (couponErr) return { success: false, error: 'Could not generate coupon' };

  // Deduct credits
  const newBalance = balance - REDEMPTION_THRESHOLD;
  const { error: updateErr } = await supabase
    .from('users').update({ loyalty_points: newBalance }).eq('id', userId);
  if (updateErr) return { success: false, error: 'Credit deduction failed' };

  // Log redemption transaction
  await supabase.from('loyalty_transactions').insert({
    user_id:     userId,
    points:      -REDEMPTION_THRESHOLD,
    type:        'redemption',
    description: `Redeemed for free ${REDEMPTION_SERVICE}`,
    coupon_code: code,
  });

  console.log(`[Loyalty] Redeemed ${REDEMPTION_THRESHOLD} pts → user ${userId} | coupon: ${code} | new balance: ${newBalance}`);
  return { success: true, couponCode: code, expiresAt, newBalance, serviceName: REDEMPTION_SERVICE };
}

/**
 * Get a user's loyalty summary: balance, progress, transactions, active coupons.
 *
 * @param {object} supabase
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getLoyaltySummary(supabase, userId) {
  const [userRes, txnRes, couponRes] = await Promise.all([
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
  ]);

  const balance      = userRes.data?.loyalty_points || 0;
  const referralCode = userRes.data?.referral_code  || null;

  return {
    balance,
    threshold:      REDEMPTION_THRESHOLD,
    progress_pct:   Math.min(100, Math.round((balance / REDEMPTION_THRESHOLD) * 100)),
    credits_needed: Math.max(0, REDEMPTION_THRESHOLD - balance),
    can_redeem:     balance >= REDEMPTION_THRESHOLD,
    referral_code:  referralCode,
    earn_rules: [
      { event: 'Book & pay via app',     points: '1 per ₹10',       icon: '📅' },
      { event: 'Pay in-app (Razorpay)',   points: `+${PAYMENT_BONUS}`, icon: '💳' },
      { event: 'Write a review',          points: `+${REVIEW_BONUS}`,  icon: '⭐' },
      { event: 'Refer a friend',          points: `+${REFERRAL_BONUS}`,icon: '👥' },
    ],
    transactions:  txnRes.data  || [],
    coupons:       couponRes.data || [],
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
  creditsFromAmount,
  awardPoints,
  redeemCredits,
  getLoyaltySummary,
  validateCoupon,
  markCouponUsed,
};
