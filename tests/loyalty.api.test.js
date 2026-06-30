'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Loyalty System — API Integration Tests
 *  tests/loyalty.api.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Hits the real Express routes via Supertest.
 * The Supabase client is mocked so no network calls are made.
 * The loyalty service module is mocked so each test controls
 * exactly what the service layer returns — this keeps these tests
 * focused on the HTTP / auth / routing layer.
 *
 * Journey 1 — Happy Path (Earn & Update)
 *   GET  /api/loyalty         — returns summary for authenticated customer
 *   POST /api/admin/loyalty/award — admin can manually award credits
 *
 * Journey 2 — Double-Spend / Race Condition
 *   POST /api/loyalty/redeem  — success path returns coupon details
 *   POST /api/loyalty/redeem  — service-layer rejection bubbles up as 400
 *   POST /api/loyalty/redeem  — professional role gets 403
 *
 * Journey 3 — Referral Logic
 *   GET  /api/loyalty         — referral_code included in summary
 *
 * Journey 4 — Edge Cases & Auth Guards
 *   All protected routes return 401 without a token
 *   All protected routes return 401 with an invalid token
 *   POST /api/loyalty/validate-coupon — valid coupon returns coupon info
 *   POST /api/loyalty/validate-coupon — invalid coupon returns 400
 *   POST /api/admin/loyalty/award     — non-admin gets 403
 *   POST /api/admin/loyalty/award     — missing body fields return 400
 * ══════════════════════════════════════════════════════════════════
 */

// ── Mock @supabase/supabase-js BEFORE requiring server ───────────────────────
// server.js calls createClient() at module load time; return a minimal stub so
// it doesn't try to connect to a real Supabase instance.
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq:     jest.fn().mockReturnThis(),
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
    rpc:     jest.fn().mockResolvedValue({ data: null, error: null }),
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));

// ── Mock the loyalty service — we test the HTTP layer here ───────────────────
jest.mock('../services/loyaltyService');

// ── Mock the email service — prevents SMTP connections during tests ──────────
jest.mock('../services/emailService', () => ({
  sendRawEmail:       jest.fn().mockResolvedValue(true),
  sendOtpEmail:       jest.fn().mockResolvedValue(true),
  sendWelcomeEmail:   jest.fn().mockResolvedValue(true),
  sendBookingEmail:   jest.fn().mockResolvedValue(true),
  sendSPAssignEmail:  jest.fn().mockResolvedValue(true),
  sendAdminNewSPEmail: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const loyalty = require('../services/loyaltyService');

// Server is required AFTER mocks are in place
const { app } = require('../server');

// ── JWT helpers ───────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-jwt-secret-petclub-not-real'; // matches setupEnv.js

function makeToken(overrides = {}) {
  return jwt.sign(
    { id: 'user-001', role: 'customer', phone: '9999900000', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const CUSTOMER_TOKEN   = makeToken({ id: 'user-001', role: 'customer' });
const ADMIN_TOKEN      = makeToken({ id: 'admin-001', role: 'admin' });
const PROVIDER_TOKEN   = makeToken({ id: 'sp-001',    role: 'professional' });
const INVALID_TOKEN    = 'Bearer eyJhbGciOiJIUzI1NiJ9.bad.sig';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOURNEY 1 — Happy Path: GET summary & admin award
// ─────────────────────────────────────────────────────────────────────────────
describe('Journey 1 — Happy Path: GET /api/loyalty and admin award', () => {

  const MOCK_SUMMARY = {
    balance:        850,
    pending_points: 80,
    threshold:      1000,
    progress_pct:   85,
    credits_needed: 150,
    can_redeem:     false,
    referral_code:  'PC-ABCD1234',
    earn_rules:     [],
    transactions:   [{ id: 't1', points: 50, type: 'payment_bonus', created_at: '2024-01-01' }],
    coupons:        [],
  };

  beforeEach(() => {
    loyalty.getLoyaltySummary.mockResolvedValue(MOCK_SUMMARY);
    loyalty.awardPoints.mockResolvedValue({ success: true, newBalance: 1050, awarded: 200 });
  });

  test('GET /api/loyalty returns 200 with full loyalty summary for authenticated customer', async () => {
    const res = await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.balance).toBe(850);
    expect(res.body.progress_pct).toBe(85);
    expect(res.body.credits_needed).toBe(150);
    expect(res.body.can_redeem).toBe(false);
    expect(res.body.transactions).toHaveLength(1);
  });

  test('GET /api/loyalty calls getLoyaltySummary with the authenticated user ID', async () => {
    await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(loyalty.getLoyaltySummary).toHaveBeenCalledTimes(1);
    // First arg is the supabase client (any object), second is the user id from token
    expect(loyalty.getLoyaltySummary.mock.calls[0][1]).toBe('user-001');
  });

  test('POST /api/admin/loyalty/award — admin awards credits successfully', async () => {
    const res = await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(ADMIN_TOKEN))
      .send({ userId: '11111111-1111-4111-8111-111111111111', points: 200, description: 'Goodwill gesture' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.awarded).toBe(200);
    expect(res.body.newBalance).toBe(1050);
  });

  test('POST /api/admin/loyalty/award — calls awardPoints with correct arguments', async () => {
    await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(ADMIN_TOKEN))
      .send({ userId: '22222222-2222-4222-8222-222222222222', points: 500, type: 'referral_bonus', description: 'Referral from campaign' });

    const call = loyalty.awardPoints.mock.calls[0];
    expect(call[1]).toBe('22222222-2222-4222-8222-222222222222');    // userId
    expect(call[2]).toBe(500);           // points
    expect(call[3]).toBe('referral_bonus'); // type
    expect(call[4]).toBe('Referral from campaign'); // description
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  JOURNEY 2 — Redemption: success, rejection, and SP block
// ─────────────────────────────────────────────────────────────────────────────
describe('Journey 2 — Redemption via POST /api/loyalty/redeem', () => {

  test('Successful redemption returns 200 with coupon code and expiry', async () => {
    loyalty.redeemCredits.mockResolvedValue({
      success:     true,
      couponCode:  'PCR-AA1B2C-DD3E4F',
      expiresAt:   '2024-07-01T00:00:00.000Z',
      newBalance:  0,
      serviceName: 'Basic Bath',
    });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.couponCode).toBe('PCR-AA1B2C-DD3E4F');
    expect(res.body.newBalance).toBe(0);
    expect(res.body.serviceName).toBe('Basic Bath');
    expect(res.body.message).toContain('PCR-AA1B2C-DD3E4F');
  });

  test('Insufficient credits — service returns failure, API returns 400', async () => {
    loyalty.redeemCredits.mockResolvedValue({
      success: false,
      error:   'Insufficient credits. You have 850 — need 1000.',
    });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient/);
  });

  test('Active coupon already exists — returns 400 with existing code', async () => {
    loyalty.redeemCredits.mockResolvedValue({
      success:      false,
      error:        'Active coupon already exists: PCR-OLD1-OLD2. Use it before redeeming again.',
      existingCode: 'PCR-OLD1-OLD2',
    });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(400);
    expect(res.body.existingCode).toBe('PCR-OLD1-OLD2');
  });

  test('Professional (SP) role is blocked from redemption with 403', async () => {
    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(PROVIDER_TOKEN));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/customers only/i);
    // Service should NOT be called — auth guard fires first
    expect(loyalty.redeemCredits).not.toHaveBeenCalled();
  });

  test('Admin CAN redeem (no SP restriction on admin role)', async () => {
    loyalty.redeemCredits.mockResolvedValue({
      success: true, couponCode: 'PCR-ADM-001', expiresAt: '2024-07-01T00:00:00.000Z',
      newBalance: 0, serviceName: 'Basic Bath',
    });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(ADMIN_TOKEN));

    // Admin is not 'professional' so the guard passes
    expect(res.status).toBe(200);
    expect(loyalty.redeemCredits).toHaveBeenCalledTimes(1);
  });

  test('Service-layer exception results in 500', async () => {
    loyalty.redeemCredits.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Redemption failed/);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  JOURNEY 3 — Referral: referral_code surfaced in summary
// ─────────────────────────────────────────────────────────────────────────────
describe('Journey 3 — Referral: referral_code in GET /api/loyalty', () => {

  test('Loyalty summary includes referral_code for the user', async () => {
    loyalty.getLoyaltySummary.mockResolvedValue({
      balance:       200,
      pending_points: 0,
      threshold:     1000,
      progress_pct:  20,
      credits_needed: 800,
      can_redeem:    false,
      referral_code: 'PC-ABCD1234',
      earn_rules:    [],
      transactions:  [],
      coupons:       [],
    });

    const res = await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(200);
    expect(res.body.referral_code).toBe('PC-ABCD1234');
  });

  test('referral_code is null when user has no referral code yet', async () => {
    loyalty.getLoyaltySummary.mockResolvedValue({
      balance: 0, pending_points: 0, threshold: 1000,
      progress_pct: 0, credits_needed: 1000, can_redeem: false,
      referral_code: null,
      earn_rules: [], transactions: [], coupons: [],
    });

    const res = await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(200);
    expect(res.body.referral_code).toBeNull();
  });

  test('can_redeem is true when balance >= 1000', async () => {
    loyalty.getLoyaltySummary.mockResolvedValue({
      balance: 1000, pending_points: 0, threshold: 1000,
      progress_pct: 100, credits_needed: 0, can_redeem: true,
      referral_code: 'PC-XXXX9999',
      earn_rules: [], transactions: [], coupons: [],
    });

    const res = await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.body.can_redeem).toBe(true);
    expect(res.body.progress_pct).toBe(100);
    expect(res.body.credits_needed).toBe(0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  JOURNEY 4 — Edge Cases: auth guards, coupon validation, bad inputs
// ─────────────────────────────────────────────────────────────────────────────
describe('Journey 4 — Edge Cases, Auth Guards & Input Validation', () => {

  // ── Auth guard: all protected routes ──
  const PROTECTED = [
    { method: 'get',  path: '/api/loyalty' },
    { method: 'post', path: '/api/loyalty/redeem' },
    { method: 'post', path: '/api/loyalty/validate-coupon' },
    { method: 'post', path: '/api/admin/loyalty/award' },
  ];

  PROTECTED.forEach(({ method, path }) => {
    test(`${method.toUpperCase()} ${path} → 401 without Authorization header`, async () => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    test(`${method.toUpperCase()} ${path} → 401 with malformed token`, async () => {
      const res = await request(app)[method](path)
        .set({ Authorization: 'Bearer not.a.valid.token' });
      expect(res.status).toBe(401);
    });
  });

  // ── Admin route blocked for non-admin ──
  test('POST /api/admin/loyalty/award → 403 for customer role', async () => {
    const res = await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ userId: 'user-001', points: 100 });

    expect(res.status).toBe(403);
    expect(loyalty.awardPoints).not.toHaveBeenCalled();
  });

  test('POST /api/admin/loyalty/award → 403 for professional role', async () => {
    const res = await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(PROVIDER_TOKEN))
      .send({ userId: 'user-001', points: 100 });

    expect(res.status).toBe(403);
  });

  // ── Missing required body fields ──
  test('POST /api/admin/loyalty/award → 400 when userId is missing', async () => {
    loyalty.awardPoints.mockResolvedValue({ success: false, error: 'bad input' });

    const res = await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(ADMIN_TOKEN))
      .send({ points: 100 }); // no userId

    expect(res.status).toBe(400);
    expect(loyalty.awardPoints).not.toHaveBeenCalled();
  });

  test('POST /api/admin/loyalty/award → 400 when points is missing', async () => {
    const res = await request(app)
      .post('/api/admin/loyalty/award')
      .set(authHeader(ADMIN_TOKEN))
      .send({ userId: 'user-001' }); // no points

    expect(res.status).toBe(400);
    expect(loyalty.awardPoints).not.toHaveBeenCalled();
  });

  // ── Coupon validation ──
  test('POST /api/loyalty/validate-coupon → 400 when code is missing from body', async () => {
    const res = await request(app)
      .post('/api/loyalty/validate-coupon')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({}); // no code

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed'); // rejected by Zod schema before the handler runs
    expect(loyalty.validateCoupon).not.toHaveBeenCalled();
  });

  test('POST /api/loyalty/validate-coupon → 400 for expired coupon', async () => {
    loyalty.validateCoupon.mockResolvedValue({ valid: false, error: 'Coupon has expired' });

    const res = await request(app)
      .post('/api/loyalty/validate-coupon')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ code: 'PCR-EXPIRED-000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Coupon has expired');
  });

  test('POST /api/loyalty/validate-coupon → 400 for already-used coupon', async () => {
    loyalty.validateCoupon.mockResolvedValue({ valid: false, error: 'This coupon has already been used' });

    const res = await request(app)
      .post('/api/loyalty/validate-coupon')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ code: 'PCR-USED00-00000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been used/);
  });

  test('POST /api/loyalty/validate-coupon → 200 with coupon details for a valid code', async () => {
    loyalty.validateCoupon.mockResolvedValue({
      valid: true,
      coupon: {
        code:         'PCR-VALID0-12345',
        service_name: 'Basic Bath',
        discount_pct: 100,
        expires_at:   '2024-12-31T00:00:00.000Z',
      },
    });

    const res = await request(app)
      .post('/api/loyalty/validate-coupon')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ code: 'PCR-VALID0-12345' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.coupon.service_name).toBe('Basic Bath');
    expect(res.body.coupon.discount_pct).toBe(100);
    // Route must NOT expose sensitive fields beyond what it explicitly selects
    expect(res.body.coupon.code).toBeUndefined();
  });

  // ── getLoyaltySummary error bubbles up as 500 ──
  test('GET /api/loyalty → 500 when service throws unexpectedly', async () => {
    loyalty.getLoyaltySummary.mockRejectedValue(new Error('Unexpected DB error'));

    const res = await request(app)
      .get('/api/loyalty')
      .set(authHeader(CUSTOMER_TOKEN));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/loyalty data/i);
  });

});
