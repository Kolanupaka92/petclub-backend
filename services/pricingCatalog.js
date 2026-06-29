'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  PETclub Pricing Catalog
 *  services/pricingCatalog.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Single source of truth for service pricing — both INR and USD.
 * USD prices benchmarked against Rover, Wag!, Barkbus, PetSmart,
 * VetCo, and Banfield (June 2026 US market rates).
 *
 * Used by:
 *   - GET /api/services/catalog  → returns catalog to authenticated customers
 *   - POST /api/bookings         → calculates final amount server-side
 *   - POST /api/payments/*       → amount verification before Razorpay order
 *
 * IMPORTANT (platform-owned pricing model):
 *   - Prices are NEVER exposed to Service Provider (SP) roles.
 *   - SP API responses are stripped of all financial fields.
 *   - platform_discount is a platform subsidy — invisible to SPs.
 * ══════════════════════════════════════════════════════════════════
 */

// ── Platform discount ─────────────────────────────────────────────
const PLATFORM_DISCOUNT     = 150; // ₹150 PETclub subsidy (INR bookings)
const PLATFORM_DISCOUNT_USD = 10;  // $10  PETclub subsidy (USD bookings)

// ── Grooming ──────────────────────────────────────────────────────
// USD: mobile/in-home rates benchmarked vs Barkbus + PetSmart salon +20–30%
const GROOMING_PACKAGES = [
  {
    name: 'Essential Bath+', icon: '🛁',
    desc: 'Premium shampoo · Blow dry · FREE ear cleaning & nail trim · 45–60 min',
    prices:     { Small: 800,  Medium: 900,  Large: 1000, Cat: 1000 },
    prices_usd: { Small: 72,   Medium: 88,   Large: 110,  Cat: 82   },
  },
  {
    name: 'Premium Bath+', icon: '✨',
    desc: 'Plus Puppy shampoo · Premium blow dry · FREE ear cleaning & nail trim',
    prices:     { Small: 2000, Medium: 2200, Large: 2500, Cat: 2000 },
    prices_usd: { Small: 95,   Medium: 115,  Large: 145,  Cat: 110  },
  },
  {
    name: 'Complete Makeover', icon: '💆',
    desc: 'Full groom · Premium shampoo · Nail trim + grind · Deshedding · 1.5–2 hrs',
    prices:     { Small: 1700, Medium: 1750, Large: 1800, Cat: 1500 },
    prices_usd: { Small: 95,   Medium: 118,  Large: 155,  Cat: 108  },
  },
  {
    name: 'Luxury Makeover', icon: '👑',
    desc: 'Premium spa · Plus Puppy shampoo · Coat-specific care · Salon-quality finish',
    prices:     { Small: 3000, Medium: 3100, Large: 3200, Cat: 3000 },
    prices_usd: { Small: 135,  Medium: 165,  Large: 210,  Cat: 145  },
  },
  {
    name: 'Trim & Style', icon: '✂️',
    desc: 'Haircut any size · Dog or cat',
    prices:     { Small: 1300, Medium: 1400, Large: 1500, Cat: 1300 },
    prices_usd: { Small: 72,   Medium: 92,   Large: 118,  Cat: 82   },
  },
  {
    name: 'Care Combo', icon: '💅',
    desc: 'Nails + ear cleaning + face trim',
    prices:     { Small: 500,  Medium: 500,  Large: 500,  Cat: 500  },
    prices_usd: { Small: 45,   Medium: 45,   Large: 45,   Cat: 45   },
  },
  {
    name: 'Puppy Dry Spa', icon: '🐾',
    desc: 'Gentle dry bath for tiny puppies',
    prices:     { Small: 600,  Medium: 600,  Large: 600,  Cat: 600  },
    prices_usd: { Small: 48,   Medium: 48,   Large: 48,   Cat: 48   },
  },
  {
    name: 'Puppy Wet Bath', icon: '🐶',
    desc: 'Gentle wet bath for puppies',
    prices:     { Small: 800,  Medium: 800,  Large: 900,  Cat: 800  },
    prices_usd: { Small: 65,   Medium: 65,   Large: 75,   Cat: 65   },
  },
];

const PET_SIZES = ['Small', 'Medium', 'Large', 'Cat'];

const GROOMING_ADDONS = [
  { id: 'dematting',  label: 'De-matting',            price: 550, price_usd: 40, desc: 'For long-haired breeds — Shih Tzu, Golden Retriever, etc.' },
  { id: 'tick_flea',  label: 'Tick & Flea Treatment',  price: 750, price_usd: 40, desc: 'Medicated treatment, product cost included' },
  { id: 'anal_gland', label: 'Anal Gland Expression',  price: 300, price_usd: 30, desc: 'Hygienic value-add service' },
];

// ── Training ──────────────────────────────────────────────────────
// USD: private certified trainer rates (Rover/independent trainers)
const TRAINING_PACKAGES = [
  { name: 'Consultation Session',          price: 650,   price_usd: 100, icon: '💬', desc: '60 min temperament & behaviour assessment' },
  { name: 'Puppy Basics',                  price: 650,   price_usd: 95,  icon: '🐶', desc: 'Gentle first sessions for pups under 6 months' },
  { name: 'Leash Training',                price: 800,   price_usd: 110, icon: '🦮', desc: 'Per session — walking & heel training' },
  { name: 'Behavioural Modification',      price: 1500,  price_usd: 175, icon: '🧠', desc: 'Per session — anxiety, aggression, reactivity' },
  { name: 'Agility Training',              price: 1500,  price_usd: 165, icon: '⚡', desc: 'Per session — obstacle & agility course' },
  { name: 'Advanced Obedience',            price: 1800,  price_usd: 185, icon: '🏆', desc: 'Per session — off-leash & complex commands' },
  { name: 'Basic Obedience (10 Sessions)', price: 10000, price_usd: 900, icon: '🎓', desc: 'Full package — sit, stay, recall & leash basics' },
];

// ── Dog Walking ───────────────────────────────────────────────────
// USD: Rover/Wag! mid-range + slight premium for solo GPS-tracked service
const WALKING_PACKAGES = [
  { name: '30-min Walk',             price: 250,  price_usd: 28,  icon: '🦮', desc: 'GPS-tracked 30-minute walk, solo' },
  { name: '60-min Walk',             price: 400,  price_usd: 48,  icon: '🐕', desc: 'GPS-tracked 60-minute walk, solo' },
  { name: '5-Walk Weekly Pack',      price: 1600, price_usd: 125, icon: '📅', desc: '5 × 30-min walks, Mon–Fri' },
  { name: 'Monthly Pack (22 Walks)', price: 5500, price_usd: 460, icon: '🏆', desc: '22 daily walks — best value per walk' },
];

// ── Pet Boarding ──────────────────────────────────────────────────
// USD: Rover in-home boarding mid-range national average
const BOARDING_PACKAGES = [
  { name: 'Overnight Stay',          price: 800,  price_usd: 68,  icon: '🌙', desc: '1 night · cage-free home · updates sent' },
  { name: 'Weekend Stay',            price: 1400, price_usd: 130, icon: '📅', desc: 'Fri eve to Sun eve · 2 nights' },
  { name: '5-Night Stay',            price: 3200, price_usd: 310, icon: '🏠', desc: '5 nights · daily photo updates' },
  { name: 'Weekly Stay (7 Nights)',  price: 4200, price_usd: 420, icon: '⭐', desc: '7 nights · best rate · holiday special' },
];

// ── Vet ───────────────────────────────────────────────────────────
// Priced services: clinic rate + $40–60 in-home house-call premium (VetCo/Banfield baseline)
// Surgery and Emergency Care: not listed here — quoted on-site after assessment
const VET_PACKAGES = [
  { name: 'General Check-up', price: 1000, price_usd: 120, icon: '🩺', desc: 'Full physical examination at your home' },
  { name: 'Vaccination',       price: 1200, price_usd: 110, icon: '💉', desc: 'Vaccine administered at home (includes house call)' },
  { name: 'Deworming',         price: 700,  price_usd: 95,  icon: '💊', desc: 'Oral/injectable deworming treatment at your home' },
  { name: 'Dental Care',       price: 3500, price_usd: 280, icon: '🦷', desc: 'Basic dental assessment and cleaning' },
];

// Full list used for the booking dropdown — includes quoted-on-site services
const VET_SERVICES = [
  'General Check-up',
  'Vaccination',
  'Deworming',
  'Dental Care',
  'Surgery',
  'Emergency Care',
];

// Surgery and Emergency Care are quoted on-site — no upfront price
const VET_QUOTED_ON_SITE = new Set(['Surgery', 'Emergency Care']);

// ── Calculation helper ────────────────────────────────────────────
/**
 * Calculate the final amount a customer pays.
 * Returns null for vet quoted-on-site services and unknown service types.
 *
 * @param {object} params
 * @param {string} params.serviceType  — 'Groomer'|'Trainer'|'Walker'|'Boarding'|'Vet'
 * @param {string} params.serviceName  — package/service name from catalog
 * @param {string} [params.petSize]    — 'Small'|'Medium'|'Large'|'Cat' (grooming only)
 * @param {string[]} [params.addons]   — addon IDs (grooming only)
 * @param {'INR'|'USD'} [params.currency]
 * @returns {{ base, addonSum, discount, total } | null}
 */
function calculateAmount({ serviceType, serviceName, petSize, addons = [], currency = 'INR' }) {
  const isUSD    = currency === 'USD';
  const discount = isUSD ? PLATFORM_DISCOUNT_USD : PLATFORM_DISCOUNT;

  if (serviceType === 'Groomer') {
    const pkg = GROOMING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg || !petSize || !PET_SIZES.includes(petSize)) return null;
    const base     = isUSD ? pkg.prices_usd[petSize] : pkg.prices[petSize];
    const addonSum = addons.reduce((sum, id) => {
      const a = GROOMING_ADDONS.find(x => x.id === id);
      return sum + (a ? (isUSD ? a.price_usd : a.price) : 0);
    }, 0);
    return { base, addonSum, discount, total: Math.max(0, base + addonSum - discount) };
  }
  if (serviceType === 'Trainer') {
    const pkg = TRAINING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    const base = isUSD ? pkg.price_usd : pkg.price;
    return { base, addonSum: 0, discount, total: Math.max(0, base - discount) };
  }
  if (serviceType === 'Walker') {
    const pkg = WALKING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    const base = isUSD ? pkg.price_usd : pkg.price;
    return { base, addonSum: 0, discount, total: Math.max(0, base - discount) };
  }
  if (serviceType === 'Boarding') {
    const pkg = BOARDING_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    const base = isUSD ? pkg.price_usd : pkg.price;
    return { base, addonSum: 0, discount, total: Math.max(0, base - discount) };
  }
  if (serviceType === 'Vet') {
    if (VET_QUOTED_ON_SITE.has(serviceName)) return null; // quoted after assessment
    const pkg = VET_PACKAGES.find(p => p.name === serviceName);
    if (!pkg) return null;
    const base = isUSD ? pkg.price_usd : pkg.price;
    return { base, addonSum: 0, discount, total: Math.max(0, base - discount) };
  }
  return null;
}

/**
 * Validate a customer-supplied amount against the catalog.
 * server.js recalculates from scratch so this is a belt-and-suspenders check.
 */
function validateAmount(bookingBody, currency = 'INR') {
  const { service_type, service_name, pet_size, addons, amount } = bookingBody;
  const catalog = calculateAmount({ serviceType: service_type, serviceName: service_name, petSize: pet_size, addons, currency });
  if (!catalog) return { valid: true, expected: null };
  if (amount == null) return { valid: true, expected: catalog.total };
  const supplied = parseFloat(amount);
  const symbol   = currency === 'USD' ? '$' : '₹';
  if (Math.abs(supplied - catalog.total) > 1) {
    return { valid: false, expected: catalog.total, message: `Amount mismatch — expected ${symbol}${catalog.total}, got ${symbol}${supplied}` };
  }
  return { valid: true, expected: catalog.total };
}

module.exports = {
  PLATFORM_DISCOUNT,
  PLATFORM_DISCOUNT_USD,
  GROOMING_PACKAGES,
  GROOMING_ADDONS,
  PET_SIZES,
  TRAINING_PACKAGES,
  WALKING_PACKAGES,
  BOARDING_PACKAGES,
  VET_PACKAGES,
  VET_SERVICES,
  VET_QUOTED_ON_SITE,
  calculateAmount,
  validateAmount,
  creditsFromAmount: (amount) => Math.floor(parseFloat(amount || 0) / 10),
};
