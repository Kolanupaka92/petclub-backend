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
  { name: 'Essential Bath+',   icon: '🛁', desc: 'Premium shampoo · Blow dry · FREE ear cleaning & nail trim · 45–60 min', prices: { Small: 800,  Medium: 900,  Large: 1000, Cat: 1000 } },
  { name: 'Premium Bath+',     icon: '✨', desc: 'Plus Puppy shampoo · Premium blow dry · FREE ear cleaning & nail trim',    prices: { Small: 2000, Medium: 2200, Large: 2500, Cat: 2000 } },
  { name: 'Complete Makeover', icon: '💆', desc: 'Full groom · Premium shampoo · Nail trim + grind · Deshedding · 1.5–2 hrs', prices: { Small: 1700, Medium: 1750, Large: 1800, Cat: 1500 } },
  { name: 'Luxury Makeover',   icon: '👑', desc: 'Premium spa · Plus Puppy shampoo · Coat-specific care · Salon-quality finish', prices: { Small: 3000, Medium: 3100, Large: 3200, Cat: 3000 } },
  { name: 'Trim & Style',      icon: '✂️', desc: 'Haircut any size · Dog or cat',                                             prices: { Small: 1300, Medium: 1400, Large: 1500, Cat: 1300 } },
  { name: 'Care Combo',        icon: '💅', desc: 'Nails + ear cleaning + face trim',                                          prices: { Small: 500,  Medium: 500,  Large: 500,  Cat: 500  } },
  { name: 'Puppy Dry Spa',     icon: '🐾', desc: 'Gentle dry bath for tiny puppies',                                         prices: { Small: 600,  Medium: 600,  Large: 600,  Cat: 600  } },
  { name: 'Puppy Wet Bath',    icon: '🐶', desc: 'Gentle wet bath for puppies',                                               prices: { Small: 800,  Medium: 800,  Large: 900,  Cat: 800  } },
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

// ── Dog Walking — duration-based ───────────────────────────────────────────
const WALKING_PACKAGES = [
  { name: '30-min Walk',             price: 250,  icon: '🦮', desc: 'GPS-tracked 30-minute walk, solo' },
  { name: '60-min Walk',             price: 400,  icon: '🐕', desc: 'GPS-tracked 60-minute walk, solo' },
  { name: '5-Walk Weekly Pack',      price: 1600, icon: '📅', desc: '5 × 30-min walks, Mon–Fri (save ₹650)' },
  { name: 'Monthly Pack (22 Walks)', price: 5500, icon: '🏆', desc: '22 daily walks — best value per walk' },
];

// ── Pet Boarding — cage-free, home-based ───────────────────────────────────
const BOARDING_PACKAGES = [
  { name: 'Overnight Stay',          price: 800,  icon: '🌙', desc: '1 night · cage-free home · updates sent' },
  { name: 'Weekend Stay',            price: 1400, icon: '📅', desc: 'Fri eve to Sun eve · 2 nights' },
  { name: '5-Night Stay',            price: 3200, icon: '🏠', desc: '5 nights · daily photo updates' },
  { name: 'Weekly Stay (7 Nights)',  price: 4200, icon: '⭐', desc: '7 nights · best rate · holiday special' },
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
  if (serviceType === 'Walker') {
    const pkg = WALKING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    return {
      base:     pkg.price,
      addonSum: 0,
      discount: PLATFORM_DISCOUNT,
      total:    Math.max(0, pkg.price - PLATFORM_DISCOUNT),
    };
  }
  if (serviceType === 'Boarding') {
    const pkg = BOARDING_PACKAGES.find(p => p.name === serviceName);
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
  WALKING_PACKAGES,
  BOARDING_PACKAGES,
  VET_SERVICES,
  calculateAmount,
  validateAmount,
  creditsFromAmount: (amount) => Math.floor(parseFloat(amount || 0) / 10),
};
