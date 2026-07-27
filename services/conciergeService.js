'use strict';
/**
 * PETclub AI Concierge (WhatsApp booking assistant)
 *
 * Env-gated like Twilio/Razorpay: replies with a static menu until
 * ANTHROPIC_API_KEY is set, then upgrades to a Claude-powered concierge.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY   - enables the AI concierge
 *   CONCIERGE_MODEL     - optional model override (default claude-opus-4-8)
 *
 * PUBLIC API
 *   isConfigured()               → boolean (AI available, not just fallback)
 *   reply(userMessage, context)  → Promise<string> (always resolves — falls
 *                                  back to the static menu on any error)
 */

const APP_URL = process.env.APP_URL || 'https://app.mypetclub.app';
const pricing = require('./pricingCatalog');
const { withRetry } = require('./retry');

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
    console.info('[Concierge] Claude AI concierge initialized');
  } catch (e) {
    console.error('[Concierge] Failed to init Anthropic SDK:', e.message);
  }
}

const isConfigured = () => Boolean(anthropic);

const MODEL = process.env.CONCIERGE_MODEL || 'claude-opus-4-8';

// ── "From" prices, computed from the real pricing catalog ──────────────────
// The system prompt used to hardcode these as plain strings, which drifted
// out of sync with services/pricingCatalog.js (e.g. it said "Grooming from
// ~$10" when the real cheapest package is $45 — a customer-facing pricing
// error waiting to happen the moment this concierge goes live). Computing
// the minimums here means the prompt can never silently go stale again.
const minPrice = (items, incField, usdField) => {
  let inr = Infinity, usd = Infinity;
  for (const it of items) {
    const incs = it[incField] ?? it.price;
    const usds = it[usdField] ?? it.price_usd;
    const incVals = typeof incs === 'object' ? Object.values(incs) : [incs];
    const usdVals = typeof usds === 'object' ? Object.values(usds) : [usds];
    inr = Math.min(inr, ...incVals);
    usd = Math.min(usd, ...usdVals);
  }
  return { inr, usd };
};
const groomingFrom = minPrice(pricing.GROOMING_PACKAGES, 'prices', 'prices_usd');
const trainingFrom = minPrice(pricing.TRAINING_PACKAGES, 'price', 'price_usd');
const walkingFrom  = minPrice(pricing.WALKING_PACKAGES, 'price', 'price_usd');
const boardingFrom = minPrice(pricing.BOARDING_PACKAGES, 'price', 'price_usd');
const vetFrom      = minPrice(pricing.VET_PACKAGES, 'price', 'price_usd');

const SYSTEM_PROMPT = `You are the PETclub WhatsApp concierge. PETclub is an all-in-one pet care platform for dogs and cats, serving India and launching across the USA.

Services (all bookable at ${APP_URL}):
- Grooming (dogs & cats) — from ₹${groomingFrom.inr} / ~$${groomingFrom.usd}
- Training (dogs) — from ₹${trainingFrom.inr} / ~$${trainingFrom.usd}
- Vet Care (in-home visits, dogs & cats) — from ₹${vetFrom.inr} / ~$${vetFrom.usd} (Surgery & Emergency Care are quoted on-site, not fixed-price)
- Dog Walking (GPS-tracked) — from ₹${walkingFrom.inr} / ~$${walkingFrom.usd}
- Pet Boarding (cage-free home stays) — from ₹${boardingFrom.inr} / ~$${boardingFrom.usd} per night
- Pet Food delivery — coming soon

Facts you can rely on:
- Every professional is manually ID-verified within 48 hours.
- Every appointment is GPS-tracked live in the app.
- Loyalty credits accrue automatically on every booking; 1,000 credits = free Essential Bath.
- Free cancellation up to 1 hour before the appointment; a flat fee applies after that (₹300 in India, $5 in the USA).
- Rescheduling is free up to 2 hours before the appointment; not available after that.
- Matching radius is 70 km in India and 30 miles in the USA; service currently centred on Hyderabad, India, with USA launch underway.

Rules:
- Keep replies under 100 words — this is WhatsApp.
- Always end with the booking link ${APP_URL} when the user shows booking intent.
- Never invent prices, availability, or medical advice. For health emergencies, tell them to contact a local vet immediately.
- Never claim to have completed, confirmed, or modified a booking yourself — you can only inform and direct to the app link. All bookings, cancellations, and reschedules must happen in the app.
- If asked something unrelated to pet care or PETclub, politely steer back.
- Reply in the language the user wrote in.`;

const FALLBACK_REPLY =
  `🐾 Welcome to PETclub! We offer:\n` +
  `✂️ Grooming · 🎓 Training · 🏥 Vet Care · 🦮 Walking · 🏠 Boarding\n\n` +
  `Book in under a minute (no download needed):\n${APP_URL}\n\n` +
  `Our team will reply here shortly for anything else!`;

/**
 * Generate a concierge reply. Never throws — always returns a string so the
 * webhook can respond to the user no matter what.
 */
const reply = async (userMessage, context = {}) => {
  if (!anthropic) return FALLBACK_REPLY;
  try {
    const response = await withRetry(() => anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `WhatsApp message from ${context.from || 'a customer'}:\n\n${String(userMessage).slice(0, 2000)}`,
      }],
    }), { onRetry: (err, n) => console.warn(`[Concierge] retry ${n} after: ${err.message}`) });
    if (response.stop_reason === 'refusal') return FALLBACK_REPLY;
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || FALLBACK_REPLY;
  } catch (e) {
    console.error('[Concierge] Claude call failed:', e.message);
    return FALLBACK_REPLY;
  }
};

module.exports = { isConfigured, reply, FALLBACK_REPLY, SYSTEM_PROMPT };
