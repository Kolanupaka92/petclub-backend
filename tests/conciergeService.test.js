'use strict';
/**
 * Regression test for a real bug: the concierge's SYSTEM_PROMPT once
 * hardcoded "from" prices as plain strings (e.g. "Grooming from ~$10")
 * that drifted out of sync with services/pricingCatalog.js — the real
 * cheapest grooming package is $45. If this had shipped, the AI would
 * have confidently quoted customers a wrong price on day one.
 *
 * The prompt now computes these from the catalog at load time. This
 * test asserts the prompt reflects the CURRENT catalog, not a snapshot —
 * so if someone reverts to a hardcoded string, or the catalog changes
 * without the prompt updating, this fails.
 */

const concierge = require('../services/conciergeService');
const pricing = require('../services/pricingCatalog');

const minOf = (items, incField, usdField) => {
  let inr = Infinity, usd = Infinity;
  for (const it of items) {
    const incs = it[incField] ?? it.price;
    const usds = it[usdField] ?? it.price_usd;
    inr = Math.min(inr, ...(typeof incs === 'object' ? Object.values(incs) : [incs]));
    usd = Math.min(usd, ...(typeof usds === 'object' ? Object.values(usds) : [usds]));
  }
  return { inr, usd };
};

describe('conciergeService SYSTEM_PROMPT pricing', () => {
  test('grooming "from" price matches the real catalog minimum, in both currencies', () => {
    const { inr, usd } = minOf(pricing.GROOMING_PACKAGES, 'prices', 'prices_usd');
    expect(concierge.SYSTEM_PROMPT).toContain(`₹${inr}`);
    expect(concierge.SYSTEM_PROMPT).toContain(`$${usd}`);
  });

  test('training "from" price matches the real catalog minimum', () => {
    const { inr, usd } = minOf(pricing.TRAINING_PACKAGES, 'price', 'price_usd');
    expect(concierge.SYSTEM_PROMPT).toContain(`₹${inr}`);
    expect(concierge.SYSTEM_PROMPT).toContain(`$${usd}`);
  });

  test('walking "from" price matches the real catalog minimum', () => {
    const { inr, usd } = minOf(pricing.WALKING_PACKAGES, 'price', 'price_usd');
    expect(concierge.SYSTEM_PROMPT).toContain(`₹${inr}`);
    expect(concierge.SYSTEM_PROMPT).toContain(`$${usd}`);
  });

  test('boarding "from" price matches the real catalog minimum', () => {
    const { inr, usd } = minOf(pricing.BOARDING_PACKAGES, 'price', 'price_usd');
    expect(concierge.SYSTEM_PROMPT).toContain(`₹${inr}`);
    expect(concierge.SYSTEM_PROMPT).toContain(`$${usd}`);
  });

  test('vet "from" price matches the real catalog minimum', () => {
    const { inr, usd } = minOf(pricing.VET_PACKAGES, 'price', 'price_usd');
    expect(concierge.SYSTEM_PROMPT).toContain(`₹${inr}`);
    expect(concierge.SYSTEM_PROMPT).toContain(`$${usd}`);
  });

  test('does NOT contain the old, wrong hardcoded prices', () => {
    expect(concierge.SYSTEM_PROMPT).not.toContain('~$10');
    expect(concierge.SYSTEM_PROMPT).not.toContain('~$8');
    expect(concierge.SYSTEM_PROMPT).not.toContain('~$5');
    expect(concierge.SYSTEM_PROMPT).not.toContain('~$3');
  });

  test('cancellation policy states 1 hour, not the old 2-hour figure', () => {
    expect(concierge.SYSTEM_PROMPT).toMatch(/cancellation.*1 hour/i);
    expect(concierge.SYSTEM_PROMPT).not.toMatch(/cancellation up to 2 hours/i);
  });

  test('reschedule policy states 2 hours', () => {
    expect(concierge.SYSTEM_PROMPT).toMatch(/reschedul.*2 hours/i);
  });

  test('explicitly forbids claiming to complete bookings itself', () => {
    expect(concierge.SYSTEM_PROMPT).toMatch(/never claim to have completed, confirmed, or modified a booking/i);
  });
});
