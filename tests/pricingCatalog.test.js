'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Pricing Catalog — Unit Tests
 *  tests/pricingCatalog.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Pure functions, no mocks needed. Covers the server-side pricing
 * recalculation that backs every booking and payment-order amount.
 */

const {
  calculateAmount,
  validateAmount,
  creditsFromAmount,
  PLATFORM_DISCOUNT,
  PLATFORM_DISCOUNT_USD,
} = require('../services/pricingCatalog');

// ─────────────────────────────────────────────────────────────────────────────
//  calculateAmount — Grooming (size + addons + currency)
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateAmount — Groomer', () => {
  test('INR base price for a valid package + size', () => {
    const result = calculateAmount({ serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Medium' });
    expect(result).toEqual({ base: 900, addonSum: 0, discount: PLATFORM_DISCOUNT, total: 900 - PLATFORM_DISCOUNT });
  });

  test('USD base price for a valid package + size', () => {
    const result = calculateAmount({ serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Medium', currency: 'USD' });
    expect(result).toEqual({ base: 88, addonSum: 0, discount: PLATFORM_DISCOUNT_USD, total: 88 - PLATFORM_DISCOUNT_USD });
  });

  test('adds the price of every requested addon (INR)', () => {
    const result = calculateAmount({
      serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Small',
      addons: ['dematting', 'anal_gland'],
    });
    // base 800 + dematting 550 + anal_gland 300 - discount 150
    expect(result.addonSum).toBe(850);
    expect(result.total).toBe(800 + 850 - PLATFORM_DISCOUNT);
  });

  test('adds the price of every requested addon (USD)', () => {
    const result = calculateAmount({
      serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Small', currency: 'USD',
      addons: ['dematting', 'tick_flea'],
    });
    // base 72 + dematting 40 + tick_flea 40 - discount 10
    expect(result.addonSum).toBe(80);
    expect(result.total).toBe(72 + 80 - PLATFORM_DISCOUNT_USD);
  });

  test('unknown addon ids are silently ignored (contribute 0)', () => {
    const result = calculateAmount({
      serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Small',
      addons: ['not_a_real_addon'],
    });
    expect(result.addonSum).toBe(0);
  });

  test('returns null for an unknown package name', () => {
    expect(calculateAmount({ serviceType: 'Groomer', serviceName: 'Nonexistent Package', petSize: 'Small' })).toBeNull();
  });

  test('returns null when petSize is missing', () => {
    expect(calculateAmount({ serviceType: 'Groomer', serviceName: 'Essential Bath+' })).toBeNull();
  });

  test('returns null when petSize is not a valid size', () => {
    expect(calculateAmount({ serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'ExtraLarge' })).toBeNull();
  });

  test('supports the Cat size bracket', () => {
    const result = calculateAmount({ serviceType: 'Groomer', serviceName: 'Essential Bath+', petSize: 'Cat' });
    expect(result.base).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  calculateAmount — Trainer / Walker / Boarding (flat-rate packages)
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateAmount — Trainer, Walker, Boarding', () => {
  test('Trainer: valid package returns base minus discount', () => {
    const result = calculateAmount({ serviceType: 'Trainer', serviceName: 'Leash Training' });
    expect(result).toEqual({ base: 800, addonSum: 0, discount: PLATFORM_DISCOUNT, total: 800 - PLATFORM_DISCOUNT });
  });

  test('Trainer: unknown package returns null', () => {
    expect(calculateAmount({ serviceType: 'Trainer', serviceName: 'Made Up Session' })).toBeNull();
  });

  test('Walker: USD package returns base minus USD discount', () => {
    const result = calculateAmount({ serviceType: 'Walker', serviceName: '60-min Walk', currency: 'USD' });
    expect(result).toEqual({ base: 48, addonSum: 0, discount: PLATFORM_DISCOUNT_USD, total: 48 - PLATFORM_DISCOUNT_USD });
  });

  test('Boarding: valid package returns base minus discount', () => {
    const result = calculateAmount({ serviceType: 'Boarding', serviceName: 'Weekend Stay' });
    expect(result).toEqual({ base: 1400, addonSum: 0, discount: PLATFORM_DISCOUNT, total: 1400 - PLATFORM_DISCOUNT });
  });

  test('Boarding: unknown package returns null', () => {
    expect(calculateAmount({ serviceType: 'Boarding', serviceName: 'Nonexistent Stay' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  calculateAmount — Vet (priced vs. quoted-on-site)
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateAmount — Vet', () => {
  test('priced service returns base minus discount', () => {
    const result = calculateAmount({ serviceType: 'Vet', serviceName: 'Vaccination' });
    expect(result).toEqual({ base: 1200, addonSum: 0, discount: PLATFORM_DISCOUNT, total: 1200 - PLATFORM_DISCOUNT });
  });

  test('Surgery is quoted on-site — returns null, never a price', () => {
    expect(calculateAmount({ serviceType: 'Vet', serviceName: 'Surgery' })).toBeNull();
  });

  test('Emergency Care is quoted on-site — returns null, never a price', () => {
    expect(calculateAmount({ serviceType: 'Vet', serviceName: 'Emergency Care' })).toBeNull();
  });

  test('unknown vet service name returns null', () => {
    expect(calculateAmount({ serviceType: 'Vet', serviceName: 'Unknown Procedure' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  calculateAmount — unknown / missing serviceType
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateAmount — unsupported serviceType', () => {
  test('returns null for an unrecognised serviceType', () => {
    expect(calculateAmount({ serviceType: 'Astrologer', serviceName: 'Anything' })).toBeNull();
  });

  test('returns null when serviceType is missing entirely', () => {
    expect(calculateAmount({ serviceName: 'Essential Bath+' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  validateAmount — belt-and-suspenders check against client-supplied amount
// ─────────────────────────────────────────────────────────────────────────────
describe('validateAmount', () => {
  test('valid when supplied amount matches the catalog total exactly', () => {
    const expected = 1200 - PLATFORM_DISCOUNT;
    const result = validateAmount({ service_type: 'Vet', service_name: 'Vaccination', amount: expected });
    expect(result).toEqual({ valid: true, expected });
  });

  test('valid within the ±1 rounding tolerance', () => {
    const expected = 1200 - PLATFORM_DISCOUNT;
    const result = validateAmount({ service_type: 'Vet', service_name: 'Vaccination', amount: expected + 0.5 });
    expect(result.valid).toBe(true);
  });

  test('invalid when supplied amount diverges from the catalog total', () => {
    const result = validateAmount({ service_type: 'Vet', service_name: 'Vaccination', amount: 1 });
    expect(result.valid).toBe(false);
    expect(result.expected).toBe(1200 - PLATFORM_DISCOUNT);
    expect(result.message).toMatch(/Amount mismatch/);
  });

  test('uses the $ symbol in the mismatch message for USD bookings', () => {
    const result = validateAmount({ service_type: 'Vet', service_name: 'Vaccination', amount: 1 }, 'USD');
    expect(result.message).toContain('$');
  });

  test('returns expected total when amount is omitted (still valid — caller fills it in)', () => {
    const expected = 1200 - PLATFORM_DISCOUNT;
    const result = validateAmount({ service_type: 'Vet', service_name: 'Vaccination' });
    expect(result).toEqual({ valid: true, expected });
  });

  test('valid with expected:null for quoted-on-site services (no catalog price to check)', () => {
    const result = validateAmount({ service_type: 'Vet', service_name: 'Surgery', amount: 5000 });
    expect(result).toEqual({ valid: true, expected: null });
  });

  test('valid with expected:null for an unrecognised service (nothing to validate against)', () => {
    const result = validateAmount({ service_type: 'Astrologer', service_name: 'Anything', amount: 999 });
    expect(result).toEqual({ valid: true, expected: null });
  });

  test('passes pet_size and addons through to the underlying catalog lookup', () => {
    const expected = 800 + 550 - PLATFORM_DISCOUNT; // Essential Bath+ Small + dematting
    const result = validateAmount({
      service_type: 'Groomer', service_name: 'Essential Bath+', pet_size: 'Small', addons: ['dematting'],
      amount: expected,
    });
    expect(result).toEqual({ valid: true, expected });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  creditsFromAmount — loyalty credit accrual (1 credit per ₹10 spent)
// ─────────────────────────────────────────────────────────────────────────────
describe('creditsFromAmount', () => {
  test('floors to the nearest whole credit', () => {
    expect(creditsFromAmount(199)).toBe(19);
  });

  test('exact multiples of 10 convert cleanly', () => {
    expect(creditsFromAmount(500)).toBe(50);
  });

  test('amounts under 10 earn zero credits', () => {
    expect(creditsFromAmount(9)).toBe(0);
  });

  test('treats missing amount as zero', () => {
    expect(creditsFromAmount(undefined)).toBe(0);
    expect(creditsFromAmount(null)).toBe(0);
  });

  test('parses numeric strings', () => {
    expect(creditsFromAmount('450')).toBe(45);
  });
});
