'use strict';
/**
 * PETclub Revenue Service
 *
 * All financial computation lives here — server.js imports and calls these
 * functions; it never re-implements the maths inline.
 *
 * Rates are read from env vars at module load so they can be overridden in
 * tests without touching process.env at runtime.
 *
 * PUBLIC API
 *   computeSplit(totalAmount, offerAmount, serviceType, currency) → split | null
 *   calcCancellation(totalAmount, scheduledAt, byNoShow)          → cancellation
 *   stripFinancials(booking, role)                                → booking copy
 */

// ── Revenue split rates ───────────────────────────────────────────────────────
// Groomer: provider 70 % / platform 30 % (of net after PETclub offer).
// All others: env-var-driven (default provider 45 % / platform 55 %).
const PLATFORM_RATE          = parseFloat(process.env.PLATFORM_RATE)         || 0.55;
const PROVIDER_RATE          = parseFloat(process.env.PROVIDER_RATE)         || 0.45;
const GROOMER_PROVIDER_RATE  = 0.70;
const GROOMER_PLATFORM_RATE  = 0.30;

// Gateway fees absorbed by PETclub — never charged to provider.
const GW_PCT_USD  = parseFloat(process.env.GATEWAY_FEE_PCT_USD)  || 0.029;  // 2.9 %
const GW_FLAT_USD = parseFloat(process.env.GATEWAY_FEE_FLAT_USD) || 0.30;   // $0.30
const GW_PCT_INR  = parseFloat(process.env.GATEWAY_FEE_PCT_INR)  || 0.02;   // 2 %
const GW_FLAT_INR = parseFloat(process.env.GATEWAY_FEE_FLAT_INR) || 0.03;   // ₹0.03

// ── Cancellation policy ───────────────────────────────────────────────────────
const CANCEL_FEE_INR    = 300;  // ₹300 flat fee for late / no-show cancellations
const CANCEL_FREE_HOURS = 2;    // hours before booking that allow fee-free cancel

/**
 * computeSplit — server-side revenue split calculation.
 *
 * @param {number|string} totalAmount  - what the customer paid
 * @param {number|string} offerAmount  - PETclub subsidy absorbed (e.g. ₹150 platform discount)
 * @param {string}        serviceType  - 'Groomer' uses 70/30; all others use env-var rates
 * @param {'INR'|'USD'}   currency
 * @returns {{ total_amount, petclub_offer_amount, net_split_amount,
 *             platform_fee, provider_earnings, gateway_fee } | null}
 *   Returns null for zero / invalid amounts (free services, loyalty redemptions).
 */
function computeSplit(totalAmount, offerAmount = 0, serviceType = '', currency = 'INR') {
  const amt = parseFloat(totalAmount);
  if (!amt || isNaN(amt) || amt <= 0) return null;

  const offer     = Math.max(0, parseFloat(offerAmount) || 0);
  const net       = Math.max(0, +(amt - offer).toFixed(2));
  const isGroomer = serviceType === 'Groomer';
  const provRate  = isGroomer ? GROOMER_PROVIDER_RATE : PROVIDER_RATE;
  const platRate  = isGroomer ? GROOMER_PLATFORM_RATE : PLATFORM_RATE;

  const gatewayFee = currency === 'USD'
    ? +(amt * GW_PCT_USD + GW_FLAT_USD).toFixed(2)
    : +(amt * GW_PCT_INR + GW_FLAT_INR).toFixed(2);

  return {
    total_amount:         +amt.toFixed(2),
    petclub_offer_amount: offer > 0 ? offer : null,
    net_split_amount:     offer > 0 ? net   : null,
    platform_fee:         +(net * platRate).toFixed(2),
    provider_earnings:    +(net * provRate).toFixed(2),
    gateway_fee:          gatewayFee,
  };
}

/**
 * calcCancellation — determine fee and refund for a booking cancellation.
 *
 * Policy:
 *   ≥ 2 h before appointment  → fee-free, full refund
 *   < 2 h before appointment  → ₹300 fee, refund remainder
 *   No-show at location        → ₹300 fee, refund remainder
 *   No reschedule under any circumstances.
 *
 * @param {number|string} totalAmount   - original booking amount
 * @param {string|Date}   scheduledAt   - booking start time (ISO string or Date)
 * @param {boolean}       byNoShow      - true when professional marks customer no-show
 */
function calcCancellation(totalAmount, scheduledAt, byNoShow = false) {
  const total      = parseFloat(totalAmount) || 0;
  const now        = Date.now();
  const bookingMs  = scheduledAt ? new Date(scheduledAt).getTime() : now;
  const hoursUntil = (bookingMs - now) / 3_600_000;
  const feeFree    = !byNoShow && hoursUntil >= CANCEL_FREE_HOURS;
  const fee        = feeFree ? 0 : Math.min(CANCEL_FEE_INR, total);

  return {
    cancellation_fee: +fee.toFixed(2),
    refund_amount:    +Math.max(0, total - fee).toFixed(2),
    refund_status:    total > 0 ? 'pending' : 'not_applicable',
    fee_free:         feeFree,
    hours_until:      +hoursUntil.toFixed(2),
  };
}

/**
 * stripFinancials — remove internal revenue fields from a booking object
 * before sending it to a customer or professional.
 *
 * admin  → full data, no stripping
 * professional → sees provider_earnings + payout_status; platform internals hidden
 * customer     → sees total_amount they paid; split internals hidden
 */
function stripFinancials(booking, role) {
  const b = { ...booking };
  if (role === 'professional') {
    delete b.total_amount;
    delete b.platform_fee;
    delete b.gateway_fee;
  } else if (role === 'customer') {
    delete b.platform_fee;
    delete b.provider_earnings;
    delete b.gateway_fee;
    delete b.payout_status;
    delete b.payout_reference;
  }
  return b;
}

// ── Exported constants (tests + server.js need these) ────────────────────────
module.exports = {
  computeSplit,
  calcCancellation,
  stripFinancials,
  // Export rates so tests can assert against the same defaults
  PLATFORM_RATE,
  PROVIDER_RATE,
  GROOMER_PROVIDER_RATE,
  GROOMER_PLATFORM_RATE,
  CANCEL_FEE_INR,
  CANCEL_FREE_HOURS,
};
