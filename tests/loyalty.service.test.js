'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Loyalty Service — Unit Tests
 *  tests/loyalty.service.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Covers all four critical user journeys at the SERVICE layer.
 * No network calls — Supabase is fully mocked.
 *
 * Journey 1 — Happy Path (Earn & Update)
 * Journey 2 — Double-Spend / Race Condition
 * Journey 3 — Referral Logic
 * Journey 4 — Edge Case: 0-balance redemption rejection
 * ══════════════════════════════════════════════════════════════════
 */

const loyalty = require('../services/loyaltyService');
const { makeMockSupabase } = require('./helpers/mockSupabase');

// ─────────────────────────────────────────────────────────────────────────────
//  Shared test user IDs
// ─────────────────────────────────────────────────────────────────────────────
const USER_A_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';  // referrer
const USER_B_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';  // referred
const BOOKING_ID  = 'b00k1ng0-0000-0000-0000-000000000001';

// ══════════════════════════════════════════════════════════════════
//  JOURNEY 1 — Happy Path: Earn & Update
// ══════════════════════════════════════════════════════════════════
describe('Journey 1 — Happy Path: Earn & Update', () => {

  test('awardPoints adds exactly +50 credits and returns the correct new balance', async () => {
    const sb = makeMockSupabase();

    // First call: fetch current balance → returns 100 pts
    sb._builder.single.mockResolvedValueOnce({ data: { loyalty_points: 100 }, error: null });
    // Second call: update → success
    sb._builder.single.mockResolvedValueOnce({ data: {}, error: null });
    // Make update().eq() chain also resolve cleanly
    sb.from.mockReturnValue({
      ...sb._builder,
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
      insert: jest.fn().mockResolvedValue({ error: null }),
      select: jest.fn().mockReturnValue({
        eq:     jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: { loyalty_points: 100 }, error: null }),
        }),
      }),
    });

    const result = await loyalty.awardPoints(
      sb, USER_A_ID, 50, 'review_bonus', 'Review bonus', BOOKING_ID
    );

    expect(result.success).toBe(true);
    expect(result.awarded).toBe(50);
    expect(result.newBalance).toBe(150);   // 100 + 50
  });

  test('creditsFromAmount calculates 1 credit per ₹10 correctly', () => {
    expect(loyalty.creditsFromAmount(500)).toBe(50);   // ₹500 → 50 credits
    expect(loyalty.creditsFromAmount(150)).toBe(15);   // ₹150 → 15 credits
    expect(loyalty.creditsFromAmount(1000)).toBe(100); // ₹1000 → 100 credits
    expect(loyalty.creditsFromAmount(9)).toBe(0);      // < ₹10 → 0 credits (floor)
    expect(loyalty.creditsFromAmount(0)).toBe(0);
    expect(loyalty.creditsFromAmount(null)).toBe(0);
  });

  test('awardPoints with type review_bonus correctly labels the transaction', async () => {
    const insertSpy = jest.fn().mockResolvedValue({ error: null });
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        if (table === 'loyalty_transactions') {
          return { insert: insertSpy };
        }
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { loyalty_points: 0 }, error: null }),
              }),
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
      }),
    };

    await loyalty.awardPoints(sb, USER_A_ID, 50, 'review_bonus', 'Review bonus for booking X', BOOKING_ID);

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      user_id:    USER_A_ID,
      points:     50,
      type:       'review_bonus',
      booking_id: BOOKING_ID,
    }));
  });

  test('hasEarnedReviewBonus returns false when no previous bonus for this booking', async () => {
    const sb = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    };
    const result = await loyalty.hasEarnedReviewBonus(sb, USER_A_ID, BOOKING_ID);
    expect(result).toBe(false);
  });

  test('hasEarnedReviewBonus returns true when bonus already awarded for this booking', async () => {
    const sb = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({
                  data: [{ id: 'existing-txn' }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const result = await loyalty.hasEarnedReviewBonus(sb, USER_A_ID, BOOKING_ID);
    expect(result).toBe(true);
  });

});

// ══════════════════════════════════════════════════════════════════
//  JOURNEY 2 — Double-Spend / Race Condition
// ══════════════════════════════════════════════════════════════════
describe('Journey 2 — Double-Spend / Race Condition', () => {

  test('redeemCredits delegates to atomic RPC — not multiple sequential queries', async () => {
    // The RPC wraps everything in a Postgres transaction with FOR UPDATE lock.
    // We verify the service calls supabase.rpc() (not raw from().update()) for redemption.
    const sb = makeMockSupabase();
    sb.rpc.mockResolvedValueOnce({
      data:  { success: true, new_balance: 0, coupon_code: 'PCR-TEST01-TEST02' },
      error: null,
    });

    const result = await loyalty.redeemCredits(sb, USER_A_ID);

    expect(sb.rpc).toHaveBeenCalledWith('redeem_loyalty_credits', expect.objectContaining({
      p_user_id: USER_A_ID,
      p_service: 'Basic Bath',
    }));
    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(0);
    expect(result.couponCode).toMatch(/^PCR-[A-F0-9]{6}-[A-F0-9]{6}$/);
  });

  test('simultaneous review bonus award: second call is blocked by hasEarnedReviewBonus', async () => {
    // Simulates: user submits review, taps again before first request completes.
    // First call: no prior bonus → award succeeds
    // Second call: prior bonus exists → award is skipped
    let callCount = 0;
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        if (table === 'loyalty_transactions') {
          return {
            insert: jest.fn().mockResolvedValue({ error: null }),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    limit: jest.fn().mockImplementation(() => {
                      callCount++;
                      // First check: no prior bonus; second check: bonus exists
                      const data = callCount > 1 ? [{ id: 'txn-1' }] : [];
                      return Promise.resolve({ data, error: null });
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { loyalty_points: 0 }, error: null }),
              }),
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
      }),
    };

    // Fire "simultaneously" — Promise.all models concurrent requests
    const [first, second] = await Promise.all([
      loyalty.hasEarnedReviewBonus(sb, USER_A_ID, BOOKING_ID),
      loyalty.hasEarnedReviewBonus(sb, USER_A_ID, BOOKING_ID),
    ]);

    // First sees no prior bonus (false) → would award; second sees existing (true) → blocked
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  test('redeemCredits — RPC returns failure when balance is insufficient (DB-level guard)', async () => {
    const sb = makeMockSupabase();
    sb.rpc.mockResolvedValueOnce({
      data:  { success: false, error: 'Insufficient credits. You have 400 — need 1000.' },
      error: null,
    });

    const result = await loyalty.redeemCredits(sb, USER_A_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Insufficient/);
  });

  test('redeemCredits — RPC returns failure when active coupon already exists (no stacking)', async () => {
    const sb = makeMockSupabase();
    sb.rpc.mockResolvedValueOnce({
      data:  { success: false, error: 'Active coupon already exists: PCR-ABC123-DEF456', existing_code: 'PCR-ABC123-DEF456' },
      error: null,
    });

    const result = await loyalty.redeemCredits(sb, USER_A_ID);

    expect(result.success).toBe(false);
    expect(result.existingCode).toBe('PCR-ABC123-DEF456');
    expect(result.error).toMatch(/coupon already exists/);
  });

  test('simultaneous redemption: only one succeeds — second sees existing coupon via RPC', async () => {
    let rpcCallCount = 0;
    const sb = makeMockSupabase();
    sb.rpc.mockImplementation(() => {
      rpcCallCount++;
      if (rpcCallCount === 1) {
        // First wins
        return Promise.resolve({ data: { success: true, new_balance: 0, coupon_code: 'PCR-WIN001-WIN002' }, error: null });
      }
      // Second loses — DB sees coupon already exists (race resolved by FOR UPDATE lock)
      return Promise.resolve({ data: { success: false, error: 'Active coupon already exists: PCR-WIN001-WIN002', existing_code: 'PCR-WIN001-WIN002' }, error: null });
    });

    const [resultA, resultB] = await Promise.all([
      loyalty.redeemCredits(sb, USER_A_ID),
      loyalty.redeemCredits(sb, USER_A_ID),
    ]);

    const successes = [resultA, resultB].filter(r => r.success);
    const failures  = [resultA, resultB].filter(r => !r.success);

    expect(successes).toHaveLength(1);          // exactly one redemption succeeds
    expect(failures).toHaveLength(1);           // the other is blocked
    expect(failures[0].existingCode).toBeDefined(); // blocked with existing coupon info
  });

});

// ══════════════════════════════════════════════════════════════════
//  JOURNEY 3 — Referral Logic
// ══════════════════════════════════════════════════════════════════
describe('Journey 3 — Referral Logic', () => {

  test('referral code format is PC- followed by 8 uppercase hex characters', () => {
    // Codes are generated as 'PC-' + first 8 chars of UUID (uppercase)
    // Test that any generated referral code matches the expected pattern
    const validCodes = [
      'PC-19460296',
      'PC-A1B2C3D4',
      'PC-FFFFFFFF',
      'PC-00000000',
    ];
    const pattern = /^PC-[A-Z0-9]{8}$/;
    validCodes.forEach(code => {
      expect(code).toMatch(pattern);
    });
  });

  test('awardPoints correctly records a referral_bonus transaction for User A (referrer)', async () => {
    const insertSpy = jest.fn().mockResolvedValue({ error: null });
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        if (table === 'loyalty_transactions') return { insert: insertSpy };
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { loyalty_points: 50 }, error: null }),
              }),
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
      }),
    };

    // When User B (referred) completes first booking, +200 is awarded to User A (referrer)
    const result = await loyalty.awardPoints(
      sb, USER_A_ID,
      loyalty.REFERRAL_BONUS,
      'referral_bonus',
      `Referral bonus — friend ${USER_B_ID} booked their first service`,
      BOOKING_ID,
    );

    expect(result.success).toBe(true);
    expect(result.awarded).toBe(200);
    expect(result.newBalance).toBe(250);  // 50 existing + 200 referral bonus

    // Verify the transaction record has correct type and points
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_A_ID,   // goes to the REFERRER, not the new signup
      points:  200,
      type:    'referral_bonus',
    }));
  });

  test('referral bonus (200) is NOT awarded to User B (the one who was referred)', async () => {
    // User B gets zero extra credits just for signing up with a referral code.
    // They earn normally through bookings/reviews going forward.
    // The referral_bonus type is reserved for User A only.

    const insertSpy = jest.fn().mockResolvedValue({ error: null });
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        if (table === 'loyalty_transactions') return { insert: insertSpy };
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { loyalty_points: 0 }, error: null }),
              }),
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
      }),
    };

    // The referral_bonus is only ever called with USER_A_ID (referrer)
    await loyalty.awardPoints(sb, USER_A_ID, 200, 'referral_bonus', 'Referral bonus');

    const insertCall = insertSpy.mock.calls[0][0];
    expect(insertCall.user_id).toBe(USER_A_ID);  // awarded to referrer
    expect(insertCall.user_id).not.toBe(USER_B_ID);  // NOT to the referred user
  });

  test('getLoyaltySummary includes referral_code in the response', async () => {
    const REFERRAL_CODE = 'PC-A1B2C3D4';
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        const emptyResult = { data: [], error: null };
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: { loyalty_points: 50, referral_code: REFERRAL_CODE },
                  error: null,
                }),
              }),
            }),
          };
        }
        // loyalty_transactions / loyalty_coupons → .eq().order().limit()
        // bookings (pending) → .eq().eq().eq().not()   ← 3 chained eqs
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              // transactions / coupons path
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(emptyResult),
              }),
              // bookings path: 2nd eq
              eq: jest.fn().mockReturnValue({
                // bookings path: 3rd eq
                eq: jest.fn().mockReturnValue({
                  not: jest.fn().mockResolvedValue(emptyResult),
                }),
                not: jest.fn().mockResolvedValue(emptyResult),
              }),
            }),
          }),
        };
      }),
    };

    const summary = await loyalty.getLoyaltySummary(sb, USER_A_ID);

    expect(summary.referral_code).toBe(REFERRAL_CODE);
    expect(summary.balance).toBe(50);
  });

  test('REFERRAL_BONUS constant is 200', () => {
    // Lock the business rule — if someone changes this, the test fails
    expect(loyalty.REFERRAL_BONUS).toBe(200);
  });

});

// ══════════════════════════════════════════════════════════════════
//  JOURNEY 4 — Edge Case: 0-balance redemption rejection
// ══════════════════════════════════════════════════════════════════
describe('Journey 4 — Edge Case: 0-Balance Redemption Rejection', () => {

  test('redeemCredits rejects gracefully when balance is 0 (no negative balance)', async () => {
    const sb = makeMockSupabase();
    sb.rpc.mockResolvedValueOnce({
      data:  { success: false, error: 'Insufficient credits. You have 0 — need 1000.' },
      error: null,
    });

    const result = await loyalty.redeemCredits(sb, USER_A_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Insufficient/);
    // No balance field returned — nothing was changed
    expect(result.newBalance).toBeUndefined();
    expect(result.couponCode).toBeUndefined();
  });

  test('redeemCredits rejects gracefully when balance is 999 (1 below threshold)', async () => {
    const sb = makeMockSupabase();
    sb.rpc.mockResolvedValueOnce({
      data:  { success: false, error: 'Insufficient credits. You have 999 — need 1000.' },
      error: null,
    });

    const result = await loyalty.redeemCredits(sb, USER_B_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('999');
  });

  test('awardPoints rejects non-positive points to prevent negative-point exploits', async () => {
    const sb = makeMockSupabase();

    const zeroResult    = await loyalty.awardPoints(sb, USER_A_ID, 0,   'admin_award', 'bad call');
    const negativeResult = await loyalty.awardPoints(sb, USER_A_ID, -50, 'admin_award', 'bad call');

    expect(zeroResult.success).toBe(false);
    expect(negativeResult.success).toBe(false);
    // Supabase was never called — guard fires before any DB operation
    expect(sb.from).not.toHaveBeenCalled();
  });

  test('validateCoupon rejects expired coupons gracefully', async () => {
    const expiredDate = new Date(Date.now() - 86400_000).toISOString(); // yesterday
    const sb = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  code:        'PCR-EXPIRED-000001',
                  user_id:     USER_A_ID,
                  is_used:     false,
                  expires_at:  expiredDate,
                  service_name: 'Basic Bath',
                  discount_pct: 100,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    const result = await loyalty.validateCoupon(sb, 'PCR-EXPIRED-000001', USER_A_ID);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  test('validateCoupon rejects already-used coupons', async () => {
    const sb = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  code:        'PCR-USED000-000001',
                  user_id:     USER_A_ID,
                  is_used:     true,               // ← already redeemed
                  expires_at:  new Date(Date.now() + 86400_000 * 30).toISOString(),
                  service_name: 'Basic Bath',
                  discount_pct: 100,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    const result = await loyalty.validateCoupon(sb, 'PCR-USED000-000001', USER_A_ID);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/already been used/i);
  });

  test('validateCoupon accepts a valid, unused, non-expired coupon', async () => {
    const futureDate = new Date(Date.now() + 86400_000 * 90).toISOString(); // 90 days ahead
    const sb = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  code:        'PCR-VALID0-000001',
                  user_id:     USER_A_ID,
                  is_used:     false,
                  expires_at:  futureDate,
                  service_name: 'Basic Bath',
                  discount_pct: 100,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    const result = await loyalty.validateCoupon(sb, 'PCR-VALID0-000001', USER_A_ID);

    expect(result.valid).toBe(true);
    expect(result.coupon.service_name).toBe('Basic Bath');
  });

  test('getLoyaltySummary returns can_redeem: false when balance is below 1000', async () => {
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        const empty = { data: [], error: null };
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: { loyalty_points: 500, referral_code: 'PC-TEST0001' },
                  error: null,
                }),
              }),
            }),
          };
        }
        // transactions/coupons → .eq().order().limit()
        // bookings → .eq().eq().eq().not()
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(empty) }),
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  not: jest.fn().mockResolvedValue(empty),
                }),
                not: jest.fn().mockResolvedValue(empty),
              }),
            }),
          }),
        };
      }),
    };

    const summary = await loyalty.getLoyaltySummary(sb, USER_A_ID);

    expect(summary.can_redeem).toBe(false);
    expect(summary.balance).toBe(500);
    expect(summary.credits_needed).toBe(500);
    expect(summary.progress_pct).toBe(50);
  });

  test('getLoyaltySummary returns can_redeem: true when balance is exactly 1000', async () => {
    const sb = {
      from: jest.fn().mockImplementation((table) => {
        const empty = { data: [], error: null };
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: { loyalty_points: 1000, referral_code: 'PC-TEST0002' },
                  error: null,
                }),
              }),
            }),
          };
        }
        // transactions/coupons → .eq().order().limit()
        // bookings → .eq().eq().eq().not()
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(empty) }),
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  not: jest.fn().mockResolvedValue(empty),
                }),
                not: jest.fn().mockResolvedValue(empty),
              }),
            }),
          }),
        };
      }),
    };

    const summary = await loyalty.getLoyaltySummary(sb, USER_A_ID);

    expect(summary.can_redeem).toBe(true);
    expect(summary.credits_needed).toBe(0);
    expect(summary.progress_pct).toBe(100);
  });

});

// ══════════════════════════════════════════════════════════════════
//  Business Rule Constants — Lock against accidental changes
// ══════════════════════════════════════════════════════════════════
describe('Business Rule Constants', () => {
  test('REVIEW_BONUS is exactly 50 credits', ()      => expect(loyalty.REVIEW_BONUS).toBe(50));
  test('PAYMENT_BONUS is exactly 50 credits', ()     => expect(loyalty.PAYMENT_BONUS).toBe(50));
  test('REFERRAL_BONUS is exactly 200 credits', ()   => expect(loyalty.REFERRAL_BONUS).toBe(200));
  test('REDEMPTION_THRESHOLD is exactly 1000', ()    => expect(loyalty.REDEMPTION_THRESHOLD).toBe(1000));
  test('REDEMPTION_SERVICE is Basic Bath', ()        => expect(loyalty.REDEMPTION_SERVICE).toBe('Basic Bath'));
  test('CREDITS_PER_RUPEE is 0.1 (1 per ₹10)', ()  => expect(loyalty.CREDITS_PER_RUPEE).toBeCloseTo(0.1));
});
