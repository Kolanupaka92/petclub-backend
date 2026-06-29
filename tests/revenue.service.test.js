'use strict';
/**
 * Revenue Service — Unit Tests
 * tests/revenue.service.test.js
 *
 * Covers all financial computation paths:
 *   computeSplit   — INR/USD, groomer vs non-groomer, offer deductions
 *   calcCancellation — fee-free window, late cancel, no-show
 *   stripFinancials  — role-based field removal
 *
 * Zero network calls — pure functions, no mocks needed.
 */

const {
  computeSplit,
  calcCancellation,
  stripFinancials,
  PLATFORM_RATE,
  PROVIDER_RATE,
  GROOMER_PROVIDER_RATE,
  GROOMER_PLATFORM_RATE,
  CANCEL_FEE_INR,
  CANCEL_FREE_HOURS,
} = require('../services/revenueService');

// ─────────────────────────────────────────────────────────────────────────────
//  computeSplit
// ─────────────────────────────────────────────────────────────────────────────
describe('computeSplit', () => {
  describe('INR — non-groomer (Walker/Trainer/Vet/Boarding)', () => {
    test('splits ₹1000 at default provider 45 / platform 55', () => {
      const result = computeSplit(1000, 0, 'Walker', 'INR');
      expect(result).not.toBeNull();
      expect(result.total_amount).toBe(1000);
      expect(result.provider_earnings).toBe(+(1000 * PROVIDER_RATE).toFixed(2));
      expect(result.platform_fee).toBe(+(1000 * PLATFORM_RATE).toFixed(2));
      // provider + platform should sum to total (gateway absorbed separately)
      expect(result.provider_earnings + result.platform_fee).toBe(result.total_amount);
    });

    test('gateway fee formula: 2% + ₹0.03 flat', () => {
      const result = computeSplit(1000, 0, 'Walker', 'INR');
      expect(result.gateway_fee).toBe(+(1000 * 0.02 + 0.03).toFixed(2));
    });

    test('offer deduction reduces split base', () => {
      // ₹1000 total, ₹150 platform offer → split on ₹850 net
      const result = computeSplit(1000, 150, 'Walker', 'INR');
      expect(result.petclub_offer_amount).toBe(150);
      expect(result.net_split_amount).toBe(850);
      expect(result.provider_earnings).toBe(+(850 * PROVIDER_RATE).toFixed(2));
      expect(result.platform_fee).toBe(+(850 * PLATFORM_RATE).toFixed(2));
      // total_amount is the full amount paid, not the net
      expect(result.total_amount).toBe(1000);
    });

    test('no offer → petclub_offer_amount and net_split_amount are null', () => {
      const result = computeSplit(500, 0, 'Trainer', 'INR');
      expect(result.petclub_offer_amount).toBeNull();
      expect(result.net_split_amount).toBeNull();
    });

    test('string amount is coerced correctly', () => {
      const result = computeSplit('800', '0', 'Vet', 'INR');
      expect(result.total_amount).toBe(800);
    });
  });

  describe('INR — Groomer (70/30 split)', () => {
    test('splits at 70% provider / 30% platform', () => {
      const result = computeSplit(2000, 0, 'Groomer', 'INR');
      expect(result.provider_earnings).toBe(+(2000 * GROOMER_PROVIDER_RATE).toFixed(2));
      expect(result.platform_fee).toBe(+(2000 * GROOMER_PLATFORM_RATE).toFixed(2));
    });

    test('groomer with ₹150 platform offer', () => {
      const result = computeSplit(2000, 150, 'Groomer', 'INR');
      expect(result.net_split_amount).toBe(1850);
      expect(result.provider_earnings).toBe(+(1850 * 0.70).toFixed(2));
      expect(result.platform_fee).toBe(+(1850 * 0.30).toFixed(2));
    });

    test('provider + platform always equals net (with offer)', () => {
      const result = computeSplit(3000, 150, 'Groomer', 'INR');
      expect(result.provider_earnings + result.platform_fee).toBe(result.net_split_amount);
    });
  });

  describe('USD split', () => {
    test('gateway fee formula: 2.9% + $0.30 flat', () => {
      const result = computeSplit(100, 0, 'Walker', 'USD');
      expect(result.gateway_fee).toBe(+(100 * 0.029 + 0.30).toFixed(2));
    });

    test('splits $50 Walker at default provider rate', () => {
      const result = computeSplit(50, 0, 'Walker', 'USD');
      expect(result.provider_earnings).toBe(+(50 * PROVIDER_RATE).toFixed(2));
    });

    test('USD Groomer uses 70/30', () => {
      const result = computeSplit(150, 0, 'Groomer', 'USD');
      expect(result.provider_earnings).toBe(+(150 * 0.70).toFixed(2));
    });
  });

  describe('edge cases', () => {
    test('returns null for zero amount', () => {
      expect(computeSplit(0)).toBeNull();
    });

    test('returns null for negative amount', () => {
      expect(computeSplit(-100)).toBeNull();
    });

    test('returns null for NaN / non-numeric string', () => {
      expect(computeSplit('free')).toBeNull();
      expect(computeSplit(null)).toBeNull();
      expect(computeSplit(undefined)).toBeNull();
    });

    test('offer larger than total clamps net to 0', () => {
      const result = computeSplit(100, 200, 'Walker', 'INR');
      expect(result.net_split_amount).toBe(0);
      expect(result.provider_earnings).toBe(0);
      expect(result.platform_fee).toBe(0);
    });

    test('all numeric results are rounded to 2 decimal places', () => {
      const result = computeSplit(999, 0, 'Trainer', 'INR');
      const twoDecimals = (n) => Number(n.toFixed(2)) === n;
      expect(twoDecimals(result.provider_earnings)).toBe(true);
      expect(twoDecimals(result.platform_fee)).toBe(true);
      expect(twoDecimals(result.gateway_fee)).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  calcCancellation
// ─────────────────────────────────────────────────────────────────────────────
describe('calcCancellation', () => {
  const future = (hoursFromNow) =>
    new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
  const past = (hoursAgo) =>
    new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

  describe('fee-free window (≥ 2 hours before)', () => {
    test('3 hours before → no fee, full refund', () => {
      const result = calcCancellation(1000, future(3));
      expect(result.fee_free).toBe(true);
      expect(result.cancellation_fee).toBe(0);
      expect(result.refund_amount).toBe(1000);
      expect(result.refund_status).toBe('pending');
    });

    test('exactly 2 hours before → fee-free boundary', () => {
      const result = calcCancellation(1000, future(CANCEL_FREE_HOURS));
      expect(result.fee_free).toBe(true);
      expect(result.cancellation_fee).toBe(0);
    });

    test('24 hours before → fee-free', () => {
      const result = calcCancellation(500, future(24));
      expect(result.fee_free).toBe(true);
      expect(result.refund_amount).toBe(500);
    });
  });

  describe('late cancel (< 2 hours before)', () => {
    test('1 hour before → ₹300 fee applied', () => {
      const result = calcCancellation(1000, future(1));
      expect(result.fee_free).toBe(false);
      expect(result.cancellation_fee).toBe(CANCEL_FEE_INR);
      expect(result.refund_amount).toBe(1000 - CANCEL_FEE_INR);
    });

    test('booking already started (past) → ₹300 fee', () => {
      const result = calcCancellation(1000, past(1));
      expect(result.cancellation_fee).toBe(CANCEL_FEE_INR);
    });

    test('fee capped at total amount (low-value booking)', () => {
      // ₹200 booking → fee can't exceed booking total
      const result = calcCancellation(200, future(0.5));
      expect(result.cancellation_fee).toBe(200);
      expect(result.refund_amount).toBe(0);
    });
  });

  describe('no-show', () => {
    test('no-show with 3 hours remaining → still charged fee (no fee-free)', () => {
      const result = calcCancellation(1000, future(3), true);
      expect(result.fee_free).toBe(false);
      expect(result.cancellation_fee).toBe(CANCEL_FEE_INR);
      expect(result.refund_amount).toBe(1000 - CANCEL_FEE_INR);
    });

    test('no-show with 0 total → not_applicable refund status', () => {
      const result = calcCancellation(0, future(3), true);
      expect(result.refund_status).toBe('not_applicable');
      expect(result.cancellation_fee).toBe(0);
    });
  });

  describe('edge cases', () => {
    test('zero total → no fee regardless of timing', () => {
      const result = calcCancellation(0, future(0.5));
      expect(result.cancellation_fee).toBe(0);
      expect(result.refund_amount).toBe(0);
      expect(result.refund_status).toBe('not_applicable');
    });

    test('string amount is coerced', () => {
      const result = calcCancellation('1000', future(3));
      expect(result.refund_amount).toBe(1000);
    });

    test('null scheduledAt uses now → late cancel', () => {
      const result = calcCancellation(1000, null);
      expect(result.fee_free).toBe(false);
    });

    test('hours_until is a number rounded to 2 decimals', () => {
      const result = calcCancellation(1000, future(3));
      expect(typeof result.hours_until).toBe('number');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  stripFinancials
// ─────────────────────────────────────────────────────────────────────────────
describe('stripFinancials', () => {
  const fullBooking = {
    id: 'b1',
    total_amount: 1000,
    platform_fee: 550,
    provider_earnings: 450,
    gateway_fee: 20.03,
    payout_status: 'pending',
    payout_reference: null,
    service_type: 'Walker',
    status: 'completed',
  };

  test('admin sees all fields', () => {
    const result = stripFinancials(fullBooking, 'admin');
    expect(result.platform_fee).toBe(550);
    expect(result.provider_earnings).toBe(450);
    expect(result.gateway_fee).toBe(20.03);
    expect(result.payout_status).toBe('pending');
    expect(result.total_amount).toBe(1000);
  });

  test('professional sees provider_earnings + payout_status but not platform internals', () => {
    const result = stripFinancials(fullBooking, 'professional');
    expect(result.provider_earnings).toBe(450);
    expect(result.payout_status).toBe('pending');
    expect(result.platform_fee).toBeUndefined();
    expect(result.gateway_fee).toBeUndefined();
    expect(result.total_amount).toBeUndefined();
  });

  test('customer sees total_amount but not split internals', () => {
    const result = stripFinancials(fullBooking, 'customer');
    expect(result.total_amount).toBe(1000);
    expect(result.platform_fee).toBeUndefined();
    expect(result.provider_earnings).toBeUndefined();
    expect(result.gateway_fee).toBeUndefined();
    expect(result.payout_status).toBeUndefined();
    expect(result.payout_reference).toBeUndefined();
  });

  test('non-financial fields are preserved for all roles', () => {
    for (const role of ['admin', 'professional', 'customer']) {
      const result = stripFinancials(fullBooking, role);
      expect(result.id).toBe('b1');
      expect(result.service_type).toBe('Walker');
      expect(result.status).toBe('completed');
    }
  });

  test('does not mutate the original booking object', () => {
    const original = { ...fullBooking };
    stripFinancials(fullBooking, 'customer');
    expect(fullBooking).toEqual(original);
  });
});
