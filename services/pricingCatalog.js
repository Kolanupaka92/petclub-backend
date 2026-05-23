'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  PETclub Pricing Catalog
 *  services/pricingCatalog.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Single source of truth for service pricing.
 * Used by:
 *   - GET /api/services/catalog  → returns catalog to authenticated customers
 *   - POST /api/bookings         → validates + calculates final amount server-side
 *   - POST /api/payments/*       → amount verification before Razorpay order creation
 *
 * IMPORTANT (platform-owned pricing model):
 *   - Prices are NEVER exposed to Service Provider (SP) roles.
 *   - SP API responses are stripped of all financial fields (see server.js sanitizeBookingForRole).
 *   - platform_discount is a platform subsidy — invisible to SPs.
 *   - provider_earnings is set separately by admin payout module, not derived from booking amount.
 *
 * ── Pricing tiers ─────────────────────────────────────────────────
 *   Grooming: tiered by pet size (Small / Medium / Large / Cat)
 *   Training: flat per-session or per-package prices
 *   Vet:      quoted on-site (no upfront price)
 * ══════════════════════════════════════════════════════════════════
 */

// ── Platform discount (applied to every bookable service at checkout) ─────
const PLATFORM_DISCOUNT = 150; // ₹150 PETclub platform subsidy

// ── Grooming ───────────────────────────────────────────────────────────────
const GROOMING_PACKAGES = [
  {
    name:   'Basic Bath',
    icon:   '🛁',
    desc:   'Shampoo, blow-dry & ear clean',
    prices: { Small: 800, Medium: 1000, Large: 1300, Cat: 900 },
  },
  {
    name:   'Trimming & Hygiene',
    icon:   '✂️',
    desc:   'Bath + full trim, nail & paw care',
    prices: { Small: 1300, Medium: 1500, Large: 1800, Cat: 1400 },
  },
  {
    name:   'Complete Makeover',
    icon:   '✨',
    desc:   'Full groom + styling + spa finish',
    prices: { Small: 1900, Medium: 2200, Large: 2600, Cat: 1600 },
  },
];

const PET_SIZES = ['Small', 'Medium', 'Large', 'Cat'];

// Add-on services — layered on top of any grooming package
const GROOMING_ADDONS = [
  { id: 'dematting',  label: 'De-matting',            price: 550, desc: 'For long-haired breeds — Shih Tzu, Golden Retriever, etc.' },
  { id: 'tick_flea',  label: 'Tick & Flea Treatment',  price: 750, desc: 'Medicated treatment, product cost included' },
  { id: 'anal_gland', label: 'Anal Gland Expression',  price: 300, desc: 'Hygienic value-add service' },
];

// ── Training ───────────────────────────────────────────────────────────────
// Time-based pricing — not size-dependent.
// 'Puppy/Kitten First Groom' is a grooming discount handled in GROOMING (20% off Basic Bath).
const TRAINING_PACKAGES = [
  { name: 'Consultation Session',          price: 650,   icon: '💬', desc: '60 min temperament & behaviour assessment' },
  { name: 'Puppy Basics',                  price: 650,   icon: '🐶', desc: 'Gentle first sessions for pups under 6 months' },
  { name: 'Leash Training',                price: 800,   icon: '🦮', desc: 'Per session — walking & heel training' },
  { name: 'Behavioural Modification',      price: 1500,  icon: '🧠', desc: 'Per session — anxiety, aggression, reactivity' },
  { name: 'Agility Training',              price: 1500,  icon: '⚡', desc: 'Per session — obstacle & agility course' },
  { name: 'Advanced Obedience',            price: 1800,  icon: '🏆', desc: 'Per session — off-leash & complex commands' },
  { name: 'Basic Obedience (10 Sessions)', price: 10000, icon: '🎓', desc: 'Full package — sit, stay, recall & leash basics' },
];

// ── Vet ────────────────────────────────────────────────────────────────────
// Pricing quoted on-site by the vet after initial assessment.
const VET_SERVICES = [
  'General Check-up',
  'Vaccination',
  'Deworming',
  'Dental Care',
  'Surgery',
  'Emergency Care',
];

// ── Calculation helper ─────────────────────────────────────────────────────
/**
 * Calculate the final amount a customer pays.
 * Returns null for vet services (quoted on-site).
 *
 * @param {object} params
 * @param {string} params.serviceType  — 'Groomer' | 'Trainer' | 'Vet'
 * @param {string} params.serviceName  — package/service name from catalog
 * @param {string} [params.petSize]    — 'Small' | 'Medium' | 'Large' | 'Cat' (required for grooming)
 * @param {string[]} [params.addons]   — array of addon IDs (grooming only)
 * @returns {{ base, addonSum, discount, total } | null}
 */
function calculateAmount({ serviceType, serviceName, petSize, addons = [] }) {
  if (serviceType === 'Groomer') {
    const pkg = GROOMING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg || !petSize || !PET_SIZES.includes(petSize)) return null;
    const base     = pkg.prices[petSize];
    const addonSum = addons.reduce((sum, id) => {
      const a = GROOMING_ADDONS.find(x => x.id === id);
      return sum + (a ? a.price : 0);
    }, 0);
    return {
      base,
      addonSum,
      discount: PLATFORM_DISCOUNT,
      total:    Math.max(0, base + addonSum - PLATFORM_DISCOUNT),
    };
  }
  if (serviceType === 'Trainer') {
    const pkg = TRAINING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    return {
      base:     pkg.price,
      addonSum: 0,
      discount: PLATFORM_DISCOUNT,
      total:    Math.max(0, pkg.price - PLATFORM_DISCOUNT),
    };
  }
  return null; // Vet — quoted on-site
}

/**
 * Validate that a customer-supplied amount matches the catalog amount.
 * Used by POST /api/bookings to prevent price tampering.
 *
 * @param {object} bookingBody  — request body from customer
 * @returns {{ valid: boolean, expected: number|null, message?: string }}
 */
function validateAmount(bookingBody) {
  const { service_type, service_name, pet_size, addons, amount } = bookingBody;
  const catalog = calculateAmount({ serviceType: service_type, serviceName: service_name, petSize: pet_size, addons });
  if (!catalog) return { valid: true, expected: null }; // Vet — skip validation
  if (amount == null) return { valid: true, expected: catalog.total }; // allow null — will be filled
  const supplied = parseFloat(amount);
  if (Math.abs(supplied - catalog.total) > 1) {
    return { valid: false, expected: catalog.total, message: `Amount mismatch — expected ₹${catalog.total}, got ₹${supplied}` };
  }
  return { valid: true, expected: catalog.total };
}

module.exports = {
  PLATFORM_DISCOUNT,
  GROOMING_PACKAGES,
  GROOMING_ADDONS,
  PET_SIZES,
  TRAINING_PACKAGES,
  VET_SERVICES,
  calculateAmount,
  validateAmount,
};
