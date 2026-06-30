'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  RBAC Enforcement — API Integration Tests
 *  tests/rbac.api.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Verifies the authorization layer, not business logic:
 *   - auth middleware: no token / invalid token → 401
 *   - adminOnly middleware: every /api/admin/* (+ admin-gated) route
 *     rejects non-admin roles with 403 and unauthenticated callers with 401
 *   - inline role guards on professional-only and customer-only routes
 *
 * adminOnly and the inline role checks run BEFORE any handler body executes
 * (and before request-body validation, where both are present), so these
 * are pure middleware-ordering tests — no Supabase data needs to be realistic,
 * because the route handler is never reached on the negative paths.
 */

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

jest.mock('../services/emailService', () => ({
  sendRawEmail:        jest.fn().mockResolvedValue(true),
  sendOtpEmail:         jest.fn().mockResolvedValue(true),
  sendWelcomeEmail:     jest.fn().mockResolvedValue(true),
  sendBookingEmail:     jest.fn().mockResolvedValue(true),
  sendSPAssignEmail:    jest.fn().mockResolvedValue(true),
  sendAdminNewSPEmail:  jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../server');

const JWT_SECRET = 'test-jwt-secret-petclub-not-real'; // matches setupEnv.js

function makeToken(overrides = {}) {
  return jwt.sign(
    { id: 'user-001', role: 'customer', phone: '9999900000', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const CUSTOMER_TOKEN    = makeToken({ id: 'cust-001', role: 'customer' });
const PROFESSIONAL_TOKEN = makeToken({ id: 'sp-001',   role: 'professional' });
const ADMIN_TOKEN       = makeToken({ id: 'admin-001', role: 'admin' });
const EXPIRED_TOKEN = jwt.sign({ id: 'cust-001', role: 'customer' }, JWT_SECRET, { expiresIn: '-1h' });

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
//  auth middleware — applies to every protected route
// ─────────────────────────────────────────────────────────────────────────────
describe('auth middleware', () => {
  test('no token → 401', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  test('malformed/invalid token → 401', async () => {
    const res = await request(app).get('/api/admin/stats').set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  test('expired token → 401', async () => {
    const res = await request(app).get('/api/admin/stats').set(authHeader(EXPIRED_TOKEN));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  adminOnly middleware — every /api/admin/* (and admin-gated) route
// ─────────────────────────────────────────────────────────────────────────────
// [method, path, body] — body only matters if the route ever reaches handler
// logic, which it doesn't on these negative-path checks (adminOnly precedes
// validate() and the handler in every one of these route definitions).
const ADMIN_ROUTES = [
  ['post',   '/api/admin/loyalty/award'],
  ['get',    '/api/admin/loyalty/stats'],
  ['get',    '/api/admin/loyalty/partner-report'],
  ['get',    '/api/admin/revenue-report'],
  ['put',    '/api/admin/bookings/00000000-0000-4000-8000-000000000000/refund-status'],
  ['put',    '/api/bookings/00000000-0000-4000-8000-000000000000/assign'],
  ['get',    '/api/admin/otp'],
  ['get',    '/api/admin/stats'],
  ['get',    '/api/admin/users'],
  ['get',    '/api/admin/signed-url'],
  ['get',    '/api/admin/payouts'],
  ['post',   '/api/admin/payouts/sp-001/mark-paid'],
  ['get',    '/api/admin/pending-verifications'],
  ['put',    '/api/admin/verify/00000000-0000-4000-8000-000000000000'],
  ['put',    '/api/admin/users/00000000-0000-4000-8000-000000000000/set-role'],
  ['patch',  '/api/admin/users/00000000-0000-4000-8000-000000000000'],
  ['post',   '/api/admin/users/00000000-0000-4000-8000-000000000000/edit'],
  ['put',    '/api/admin/users/00000000-0000-4000-8000-000000000000/suspend'],
  ['delete', '/api/admin/users/suspended/purge-all'],
  ['delete', '/api/admin/users/00000000-0000-4000-8000-000000000000'],
  ['get',    '/api/admin/health'],
  ['get',    '/api/admin/db-audit'],
  ['delete', '/api/admin/db-cleanup'],
];

describe('adminOnly middleware — admin route sweep', () => {
  test.each(ADMIN_ROUTES)('%s %s rejects an unauthenticated caller with 401', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  test.each(ADMIN_ROUTES)('%s %s rejects a customer with 403', async (method, path) => {
    const res = await request(app)[method](path).set(authHeader(CUSTOMER_TOKEN));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  test.each(ADMIN_ROUTES)('%s %s rejects a professional with 403', async (method, path) => {
    const res = await request(app)[method](path).set(authHeader(PROFESSIONAL_TOKEN));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Inline role guards — professional-only routes
// ─────────────────────────────────────────────────────────────────────────────
describe('professional-only routes', () => {
  test('POST /api/professionals/payout rejects a customer with 403', async () => {
    const res = await request(app)
      .post('/api/professionals/payout')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ upi_id: 'test@upi' }); // valid body so schema validation passes before the role check
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Professionals only');
  });

  test('POST /api/professionals/payout rejects an admin with 403 (admin is not a professional)', async () => {
    const res = await request(app)
      .post('/api/professionals/payout')
      .set(authHeader(ADMIN_TOKEN))
      .send({ upi_id: 'test@upi' });
    expect(res.status).toBe(403);
  });

  test('GET /api/professionals/earnings rejects a customer with 403', async () => {
    const res = await request(app)
      .get('/api/professionals/earnings')
      .set(authHeader(CUSTOMER_TOKEN));
    expect(res.status).toBe(403);
  });

  test('GET /api/professionals/earnings rejects an unauthenticated caller with 401', async () => {
    const res = await request(app).get('/api/professionals/earnings');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Inline role guards — customer-only routes
// ─────────────────────────────────────────────────────────────────────────────
describe('customer-only routes', () => {
  test('POST /api/bookings/:id/rate rejects a professional with 403', async () => {
    const res = await request(app)
      .post('/api/bookings/00000000-0000-4000-8000-000000000000/rate')
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ rating: 5 }); // valid body so schema validation passes before the role check
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only customers can rate bookings');
  });

  test('POST /api/bookings/:id/rate rejects an admin with 403 (admin is not a customer)', async () => {
    const res = await request(app)
      .post('/api/bookings/00000000-0000-4000-8000-000000000000/rate')
      .set(authHeader(ADMIN_TOKEN))
      .send({ rating: 5 });
    expect(res.status).toBe(403);
  });

  test('POST /api/bookings/:id/rate rejects an unauthenticated caller with 401', async () => {
    const res = await request(app)
      .post('/api/bookings/00000000-0000-4000-8000-000000000000/rate')
      .send({ rating: 5 });
    expect(res.status).toBe(401);
  });
});
