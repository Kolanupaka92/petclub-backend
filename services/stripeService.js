'use strict';
/**
 * PETclub Stripe Service (USA payments)
 *
 * Env-gated like Razorpay: no-ops until STRIPE_SECRET_KEY is set.
 * Use test-mode keys (sk_test_...) until the LLC/live keys are ready —
 * the full flow works identically in test mode.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       - sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET   - whsec_... (from the Stripe dashboard webhook config)
 *
 * PUBLIC API
 *   isConfigured()                                → boolean
 *   createPaymentIntent({ amountUsd, bookingId, customerId }) → PaymentIntent
 *   verifyWebhook(rawBody, signature)             → Stripe.Event (throws on bad sig)
 */

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    console.info('[Stripe] initialized (USA payments live —', process.env.STRIPE_SECRET_KEY.startsWith('sk_test') ? 'TEST mode)' : 'LIVE mode)');
  } catch (e) {
    console.error('[Stripe] Failed to init:', e.message);
  }
}

const isConfigured = () => Boolean(stripe);

/**
 * Create a PaymentIntent for a USD booking.
 * Amount is in dollars; Stripe wants integer cents.
 */
const createPaymentIntent = async ({ amountUsd, bookingId, customerId }) => {
  if (!stripe) throw new Error('Stripe not configured');
  const cents = Math.round(parseFloat(amountUsd) * 100);
  if (!Number.isFinite(cents) || cents < 50) throw new Error('Amount must be at least $0.50');
  return stripe.paymentIntents.create({
    amount: cents,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    metadata: { booking_id: bookingId, customer_id: customerId, platform: 'petclub' },
  });
};

/**
 * Verify a webhook payload came from Stripe. Throws if the signature is bad
 * or STRIPE_WEBHOOK_SECRET is unset.
 */
const verifyWebhook = (rawBody, signature) => {
  if (!stripe) throw new Error('Stripe not configured');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
};

module.exports = { isConfigured, createPaymentIntent, verifyWebhook };
