'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Auth Flows — API Integration Tests
 *  tests/auth.api.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Covers the four auth pathways:
 *   1. Legacy OTP endpoints → 410 Gone
 *   2. Firebase Phone Auth  → schema validation + 503 not-configured
 *   3. Email OTP (send + verify) → happy path, error cases
 *   4. Token refresh / logout
 *
 * Strategy:
 *   - The Supabase client is mocked via the @supabase/supabase-js factory.
 *     `mockSingle` (prefixed "mock" so jest's hoist plugin lifts it alongside
 *     jest.mock calls) is the shared `.single()` implementation; per-test
 *     behaviour is configured with .mockResolvedValueOnce stacking.
 *   - refreshTokenService is mocked at the module level so `issueRefreshToken`
 *     and `rotateRefreshToken` can be controlled per test.
 *   - emailService is mocked to prevent SMTP connections.
 *   - firebaseAdmin initialises only when FIREBASE_SERVICE_ACCOUNT_JSON is set;
 *     setupEnv.js deletes that var, so firebase-verify tests exercise the
 *     "Firebase not configured" branch (503) without any network calls.
 */

// ── variables prefixed "mock" are hoisted alongside jest.mock ─────────────────
const mockSingle = jest.fn().mockResolvedValue({ data: null, error: null });
const mockBuilder = {
  select:  jest.fn().mockReturnThis(),
  insert:  jest.fn().mockReturnThis(),
  update:  jest.fn().mockReturnThis(),
  delete:  jest.fn().mockReturnThis(),
  upsert:  jest.fn().mockReturnThis(),
  eq:      jest.fn().mockReturnThis(),
  neq:     jest.fn().mockReturnThis(),
  is:      jest.fn().mockReturnThis(),
  in:      jest.fn().mockReturnThis(),
  order:   jest.fn().mockReturnThis(),
  range:   jest.fn().mockReturnThis(),
  single:  mockSingle,
  // thenable: allows `await supabase.from(...).update(...).eq(...)` to resolve
  then: (resolve) => resolve({ data: null, error: null }),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from:    jest.fn().mockReturnValue(mockBuilder),
    rpc:     jest.fn().mockResolvedValue({ data: null, error: null }),
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));

jest.mock('../services/refreshTokenService', () => ({
  REFRESH_COOKIE:      'petclub_refresh',
  REFRESH_COOKIE_OPTS: { httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/auth/refresh', maxAge: 2592000000 },
  issueRefreshToken:   jest.fn().mockResolvedValue({ rawToken: 'test-refresh-raw', tokenHash: 'test-refresh-hash' }),
  rotateRefreshToken:  jest.fn().mockResolvedValue(null), // default: invalid token
  revokeAllForUser:    jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/emailService', () => ({
  sendRawEmail:        jest.fn().mockResolvedValue(true),
  sendOtpEmail:        jest.fn().mockResolvedValue(true),
  sendWelcomeEmail:    jest.fn().mockResolvedValue(true),
  sendBookingEmail:    jest.fn().mockResolvedValue(true),
  sendSPAssignEmail:   jest.fn().mockResolvedValue(true),
  sendAdminNewSPEmail: jest.fn().mockResolvedValue(true),
}));

const crypto  = require('crypto');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { issueRefreshToken, rotateRefreshToken } = require('../services/refreshTokenService');
const emailService = require('../services/emailService');

const { app } = require('../server');

const JWT_SECRET = 'test-jwt-secret-petclub-not-real';

// Replicate server.js's hashOTP (sha256 hex) so tests can produce matching hashes
const hashOTP = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

const FUTURE_EXPIRY = new Date(Date.now() + 10 * 60_000).toISOString();
const PAST_EXPIRY   = new Date(Date.now() - 10 * 60_000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
//  1. Legacy OTP endpoints → 410 Gone
// ─────────────────────────────────────────────────────────────────────────────
describe('Legacy OTP endpoints (removed)', () => {
  test('POST /api/auth/send-otp → 410 Gone', async () => {
    const res = await request(app).post('/api/auth/send-otp').send({ phone: '+14155550100' });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/removed/i);
  });

  test('POST /api/auth/verify-otp → 410 Gone', async () => {
    const res = await request(app).post('/api/auth/verify-otp').send({ phone: '+14155550100', otp: '123456' });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/removed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Firebase Phone Auth  POST /api/auth/firebase-verify
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/firebase-verify', () => {
  test('missing idToken → 400 Validation failed (Zod schema)', async () => {
    const res = await request(app).post('/api/auth/firebase-verify').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  test('valid schema but Firebase not configured (no FIREBASE_SERVICE_ACCOUNT_JSON) → 503', async () => {
    const res = await request(app)
      .post('/api/auth/firebase-verify')
      .send({ idToken: 'any-string-at-least-10-chars' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/firebase not configured/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3a. Email OTP — send  POST /api/auth/send-email-otp
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/send-email-otp', () => {
  test('invalid email → 400 Validation failed', async () => {
    const res = await request(app).post('/api/auth/send-email-otp').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('missing email → 400', async () => {
    const res = await request(app).post('/api/auth/send-email-otp').send({});
    expect(res.status).toBe(400);
  });

  test('valid email → 200, stores OTP in DB, sends email', async () => {
    const res = await request(app)
      .post('/api/auth/send-email-otp')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('test@example.com');
    expect(emailService.sendOtpEmail).toHaveBeenCalledWith('test@example.com', expect.objectContaining({ otp: expect.any(String) }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3b. Email OTP — verify  POST /api/auth/verify-email-otp
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/verify-email-otp', () => {
  const TEST_OTP = '482916';
  const HASHED   = hashOTP(TEST_OTP);

  const baseOtpRecord = {
    phone: 'test@example.com',
    otp:   HASHED,
    expires_at: FUTURE_EXPIRY,
    verified:   false,
  };

  const existingUser = {
    id: 'user-abc', name: 'Priya', email: 'test@example.com',
    phone: '+919999900000', role: 'customer', is_active: true,
  };

  test('missing fields → 400 Validation failed', async () => {
    const res = await request(app).post('/api/auth/verify-email-otp').send({ email: 'test@example.com' }); // no otp
    expect(res.status).toBe(400);
  });

  test('OTP not found in DB → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/OTP not found/i);
  });

  test('OTP already used → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: { ...baseOtpRecord, verified: true }, error: null });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already used/i);
  });

  test('OTP expired → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: { ...baseOtpRecord, expires_at: PAST_EXPIRY }, error: null });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/OTP expired/i);
  });

  test('incorrect OTP → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: baseOtpRecord, error: null });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: '000000' }); // wrong OTP

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incorrect OTP/i);
  });

  test('happy path — returning user → 200 with token in cookie and body', async () => {
    // First single() call: otp_tokens lookup
    mockSingle.mockResolvedValueOnce({ data: baseOtpRecord, error: null });
    // Second single() call: users lookup (returning user)
    mockSingle.mockResolvedValueOnce({ data: existingUser, error: null });

    issueRefreshToken.mockResolvedValueOnce({ rawToken: 'fresh-refresh-tok', tokenHash: 'h' });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNew).toBe(false);
    expect(res.body.token).toBeDefined();
    // JWT should contain the user's role
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.role).toBe('customer');
    expect(decoded.id).toBe('user-abc');
    // httpOnly cookie should be set
    expect(res.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/petclub_token=/)]));
    // refreshToken should NOT be in body for web clients
    expect(res.body.refreshToken).toBeUndefined();
  });

  test('mobile client receives refreshToken in body', async () => {
    mockSingle.mockResolvedValueOnce({ data: baseOtpRecord, error: null });
    mockSingle.mockResolvedValueOnce({ data: existingUser, error: null });
    issueRefreshToken.mockResolvedValueOnce({ rawToken: 'mobile-refresh', tokenHash: 'h' });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .set('x-client-type', 'mobile')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBe('mobile-refresh');
  });

  test('suspended user is blocked with 403 after OTP verification', async () => {
    const suspendedUser = { ...existingUser, is_active: false };
    mockSingle.mockResolvedValueOnce({ data: baseOtpRecord, error: null });
    mockSingle.mockResolvedValueOnce({ data: suspendedUser, error: null });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/i);
  });

  test('new user is created and issued a token', async () => {
    // First single() call: otp_tokens lookup
    mockSingle.mockResolvedValueOnce({ data: baseOtpRecord, error: null });
    // Second single() call: users lookup — no existing user
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });
    // Third single() call: users insert().select().single()
    const newUser = { id: 'new-user-id', name: null, email: 'test@example.com', phone: 'email_placeholder', role: 'pending_role', is_active: true };
    mockSingle.mockResolvedValueOnce({ data: newUser, error: null });

    issueRefreshToken.mockResolvedValueOnce({ rawToken: 'new-refresh', tokenHash: 'h' });

    const res = await request(app)
      .post('/api/auth/verify-email-otp')
      .send({ email: 'test@example.com', otp: TEST_OTP });

    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.role).toBe('pending_role');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Token Refresh  POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/refresh', () => {
  test('no refresh token in cookie or header → 401', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/no refresh token/i);
  });

  test('invalid / expired refresh token (service returns null) → 401', async () => {
    rotateRefreshToken.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-refresh-token', 'bad-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session expired/i);
  });

  test('valid refresh token → 200, new access token in response', async () => {
    rotateRefreshToken.mockResolvedValueOnce({ userId: 'user-abc', rawToken: 'new-refresh-raw' });
    // supabase.from('users').select().eq().single() — returns user for JWT claims
    mockSingle.mockResolvedValueOnce({ data: { id: 'user-abc', role: 'customer' }, error: null });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-refresh-token', 'valid-raw-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.id).toBe('user-abc');
    expect(decoded.role).toBe('customer');
  });

  test('web client: new refresh token in cookie, not in body', async () => {
    rotateRefreshToken.mockResolvedValueOnce({ userId: 'user-abc', rawToken: 'new-refresh-raw' });
    mockSingle.mockResolvedValueOnce({ data: { id: 'user-abc', role: 'customer' }, error: null });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'petclub_refresh=some-old-cookie-token');

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined(); // web: in cookie, not body
    expect(res.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/petclub_token=/)]));
  });

  test('mobile client: new refresh token in body', async () => {
    rotateRefreshToken.mockResolvedValueOnce({ userId: 'user-abc', rawToken: 'new-refresh-mobile' });
    mockSingle.mockResolvedValueOnce({ data: { id: 'user-abc', role: 'customer' }, error: null });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-client-type', 'mobile')
      .set('x-refresh-token', 'valid-raw-token');

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBe('new-refresh-mobile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Logout  POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/logout', () => {
  test('no cookies → 200 (logout is always safe to call)', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('clears auth cookie on logout', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'petclub_token=sometoken; petclub_refresh=somerefresh');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.some(c => c.startsWith('petclub_token=;'))).toBe(true);
  });
});
