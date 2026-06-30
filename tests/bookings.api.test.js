'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Booking State Machine — API Integration Tests
 *  tests/bookings.api.test.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Covers the booking lifecycle at the HTTP layer:
 *
 *   POST /api/bookings          — creation (role guard, terms, pricing, RPC)
 *   PUT  /api/bookings/:id/status  — state machine transitions
 *   POST /api/bookings/:id/respond — professional accept / reject
 *
 * ── Mock architecture notes ────────────────────────────────────────
 *
 * 1. from('users') → mockUsersBuilder (always returns null, active user)
 *    Isolates auth-middleware + FCM-lookup single() calls from mockSingle,
 *    so tests work identically whether the auth cache is warm or cold.
 *
 * 2. from(anything else) → mockBuilder (uses mockSingle queue per-test)
 *
 * 3. mockBuilder.then returns { catch: () => {} } so fire-and-forget
 *    chains like `.gt(...).then(fn).catch(() => {})` never throw.
 *
 * 4. POST /api/bookings hits TWO PgRateLimitStore.rpc() calls (global
 *    rate limiter + booking rate limiter) before the handler's own
 *    supabase.rpc('create_booking_atomic').  Tests prepend 2 null Once
 *    values so the handler RPC gets the right fixture.
 *
 * 5. mockSingle and mockRpc are mockReset() in beforeEach to prevent
 *    unconsumed Once values bleeding across tests.
 */

// ── "mock"-prefixed vars are hoisted alongside jest.mock calls ────────────────
const mockUsersBuilder = {
  select: jest.fn().mockReturnThis(),
  eq:     jest.fn().mockReturnThis(),
  // single always returns an active null user — auth middleware treats null as active.
  // Also covers from('users') FCM lookups (null → no push sent).
  single: jest.fn().mockResolvedValue({ data: null, error: null }),
  then: (resolve) => { resolve({ data: null, error: null }); return { catch: () => {} }; },
};

const mockSingle = jest.fn().mockResolvedValue({ data: null, error: null });
const mockRpc    = jest.fn().mockResolvedValue({ data: null, error: null });
const mockBuilder = {
  select:  jest.fn().mockReturnThis(),
  insert:  jest.fn().mockReturnThis(),
  update:  jest.fn().mockReturnThis(),
  delete:  jest.fn().mockReturnThis(),
  upsert:  jest.fn().mockReturnThis(),
  eq:      jest.fn().mockReturnThis(),
  neq:     jest.fn().mockReturnThis(),
  gt:      jest.fn().mockReturnThis(),
  gte:     jest.fn().mockReturnThis(),
  is:      jest.fn().mockReturnThis(),
  in:      jest.fn().mockReturnThis(),
  ilike:   jest.fn().mockReturnThis(), // needed by findNextPro city fallback
  not:     jest.fn().mockReturnThis(),
  lt:      jest.fn().mockReturnThis(),
  order:   jest.fn().mockReturnThis(),
  range:   jest.fn().mockReturnThis(),
  limit:   jest.fn().mockReturnThis(),
  single:  mockSingle,
  // Returns { catch: () => {} } so .then(fn).catch(fn) chains never throw.
  then: (resolve) => { resolve({ data: null, error: null }); return { catch: () => {} }; },
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    // Route from('users') to a stable builder so auth + FCM lookups don't
    // consume slots from the per-test mockSingle queue.
    from: jest.fn().mockImplementation((table) =>
      table === 'users' ? mockUsersBuilder : mockBuilder
    ),
    rpc:     mockRpc,
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));

jest.mock('../services/loyaltyService', () => ({
  validateCoupon:    jest.fn().mockResolvedValue({ valid: true, coupon: { service_name: 'Test', discount_pct: 100, expires_at: null } }),
  awardPoints:       jest.fn().mockResolvedValue({ success: true }),
  redeemCredits:     jest.fn().mockResolvedValue({ success: true }),
  getLoyaltySummary: jest.fn().mockResolvedValue({ balance: 0 }),
  REFERRAL_BONUS:    100,
}));

jest.mock('../services/emailService', () => ({
  sendRawEmail:        jest.fn().mockResolvedValue(true),
  sendOtpEmail:        jest.fn().mockResolvedValue(true),
  sendWelcomeEmail:    jest.fn().mockResolvedValue(true),
  sendBookingEmail:    jest.fn().mockResolvedValue(true),
  sendSPAssignEmail:   jest.fn().mockResolvedValue(true),
  sendAdminNewSPEmail: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/refreshTokenService', () => ({
  REFRESH_COOKIE:      'petclub_refresh',
  REFRESH_COOKIE_OPTS: { httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/auth/refresh', maxAge: 2592000000 },
  issueRefreshToken:   jest.fn().mockResolvedValue({ rawToken: 'r', tokenHash: 'h' }),
  rotateRefreshToken:  jest.fn().mockResolvedValue(null),
  revokeAllForUser:    jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../server');

const JWT_SECRET = 'test-jwt-secret-petclub-not-real';

function makeToken(overrides = {}) {
  return jwt.sign({ id: 'u-cust', role: 'customer', phone: '+16099990000', ...overrides }, JWT_SECRET, { expiresIn: '1h' });
}

const CUSTOMER_TOKEN     = makeToken({ id: 'u-cust', role: 'customer', phone: '+16099990000' });
const PROFESSIONAL_TOKEN = makeToken({ id: 'u-pro',  role: 'professional', phone: '+16099990001' });
const ADMIN_TOKEN        = makeToken({ id: 'u-admin', role: 'admin', phone: '+16099990002' });

function authHeader(token) { return { Authorization: `Bearer ${token}` }; }

const BOOKING_ID = '00000000-0000-4000-8000-000000000001';
const PROF_ID    = '00000000-0000-4000-8000-000000000002';

// Reset per-test mocks before each test.
// mockResolvedValueOnce queue is cleared by mockReset(); base implementation is restored after.
beforeEach(() => {
  mockSingle.mockReset();
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockUsersBuilder.single.mockReset();
  mockUsersBuilder.single.mockResolvedValue({ data: null, error: null });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/bookings  — booking creation
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/bookings — creation', () => {
  const validBody = {
    terms_accepted: true,
    service_type:   'Trainer',
    service_name:   'Leash Training',
    city:           'Richardson',
  };

  test('professional role cannot create a booking → 403', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only customers/i);
  });

  test('missing terms_accepted → 400 (Zod schema rejects false/missing literal)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ ...validBody, terms_accepted: false });
    expect(res.status).toBe(400);
  });

  test('missing service_type → 400 (Zod schema validation)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ terms_accepted: true, service_name: 'Leash Training', city: 'Richardson' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  test('unauthenticated request → 401', async () => {
    const res = await request(app).post('/api/bookings').send(validBody);
    expect(res.status).toBe(401);
  });

  test('happy path: RPC succeeds → 200 with booking', async () => {
    const fakeBooking = { id: BOOKING_ID, status: 'upcoming', service_type: 'Trainer', service_name: 'Leash Training', customer_id: 'u-cust', city: 'Richardson', assignment_status: 'searching' };

    // POST /api/bookings hits 2 PgRateLimitStore.rpc() calls before the handler's own:
    //   (1) global rate limiter (app.use), (2) booking rate limiter, (3) create_booking_atomic
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (1) global rate limiter
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (2) booking rate limiter
    mockRpc.mockResolvedValueOnce({ data: fakeBooking, error: null }); // (3) create_booking_atomic

    // findNextPro: ilike → builder.then → allPros=null → null (no pro).
    // bookings.update(no_pros_available) → builder.then.
    // Final re-fetch of the created booking:
    mockSingle.mockResolvedValueOnce({ data: fakeBooking, error: null });

    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(CUSTOMER_TOKEN))
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.booking.id).toBe(BOOKING_ID);
  });

  test('RPC error with COUPON_INVALID → 409', async () => {
    // validateCoupon mock returns valid, so isLoyaltyRedemption=true; then RPC fails.
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (1) global rate limiter
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (2) booking rate limiter
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'COUPON_INVALID: already used' } }); // (3) handler

    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ ...validBody, coupon_code: 'PCR-STALE' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/coupon/i);
  });

  test('RPC error (generic) → 500', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (1) global rate limiter
    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // (2) booking rate limiter
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB timeout' } }); // (3) handler

    const res = await request(app)
      .post('/api/bookings')
      .set(authHeader(CUSTOMER_TOKEN))
      .send(validBody);

    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/bookings/:id/status — state machine
//
//  No booking-specific rate limiter, so only the global app.use(rateLimit)
//  fires (1 mockRpc call), and that uses the base mockRpc default (null).
//  No Once values needed for mockRpc in these tests.
//
//  Auth middleware calls from('users').single() via mockUsersBuilder (not
//  mockSingle), so tests are independent of the auth-cache state.
//
//  Cancellation path single() call sequence:
//    (1) booking fetch
//    (2) professional_profiles FCM lookup — fire-and-forget, .single() called
//        synchronously even though not awaited
//    (3) bookings.update().select().single() — final re-fetch
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/bookings/:id/status — state machine', () => {
  function existingBooking(overrides = {}) {
    return {
      id:              BOOKING_ID,
      customer_id:     'u-cust',
      professional_id: PROF_ID,
      status:          'upcoming',
      total_amount:    650,
      currency:        'USD',
      service_type:    'Trainer',
      service_name:    'Leash Training',
      scheduled_at:    new Date(Date.now() + 3 * 3_600_000).toISOString(),
      city:            'Richardson',
      address_lat:     null,
      address_lng:     null,
      pets:            null,
      ...overrides,
    };
  }

  test('booking not found → 404', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } }); // (1) booking fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(404);
  });

  test('customer who does not own the booking → 403', async () => {
    const otherCust = makeToken({ id: 'u-other', role: 'customer' });
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ customer_id: 'u-cust' }), error: null }); // (1) booking fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(otherCust))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  test('completed → cancelled is an invalid transition → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ status: 'completed' }), error: null }); // (1) booking fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot transition/i);
  });

  // The transition check (ALLOWED_TRANSITIONS.cancelled = []) fires before the
  // double-cancel guard, so the error says "Cannot transition", not "already cancelled".
  test('double-cancel rejected → 400 (transition check fires first)', async () => {
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ status: 'cancelled' }), error: null }); // (1) booking fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot transition/i);
  });

  test('upcoming → in_progress succeeds → 200', async () => {
    mockSingle.mockResolvedValueOnce({ data: existingBooking(), error: null });                        // (1) booking fetch
    mockSingle.mockResolvedValueOnce({ data: { id: PROF_ID, users: { name: 'Alex' } }, error: null }); // (2) professional_profiles ownership lookup
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ status: 'in_progress' }), error: null }); // (3) update re-fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('in_progress → completed succeeds → 200', async () => {
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ status: 'in_progress' }), error: null }); // (1) booking fetch
    mockSingle.mockResolvedValueOnce({ data: { id: PROF_ID, users: { name: 'Alex' } }, error: null });   // (2) professional_profiles ownership
    mockSingle.mockResolvedValueOnce({ data: existingBooking({ status: 'completed' }), error: null });   // (3) update re-fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('customer cancels ≥2h before → fee-free refund', async () => {
    const booking = existingBooking({ scheduled_at: new Date(Date.now() + 5 * 3_600_000).toISOString(), total_amount: 640 });
    const cancelledBooking = { ...booking, status: 'cancelled', cancellation_fee: 0, refund_amount: 640 };

    mockSingle.mockResolvedValueOnce({ data: booking, error: null });          // (1) booking fetch
    mockSingle.mockResolvedValueOnce({ data: null, error: null });              // (2) pro FCM notification .single() (fire-and-forget)
    mockSingle.mockResolvedValueOnce({ data: cancelledBooking, error: null }); // (3) bookings.update().select().single()

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.booking.cancellation_fee).toBe(0);
    expect(res.body.booking.refund_amount).toBe(640);
  });

  test('customer cancels <2h before → late-cancel fee deducted', async () => {
    const booking = existingBooking({ scheduled_at: new Date(Date.now() + 30 * 60_000).toISOString(), total_amount: 640, currency: 'USD' });
    const cancelledBooking = { ...booking, status: 'cancelled', cancellation_fee: 5, refund_amount: 635 };

    mockSingle.mockResolvedValueOnce({ data: booking, error: null });          // (1) booking fetch
    mockSingle.mockResolvedValueOnce({ data: null, error: null });              // (2) pro FCM notification .single()
    mockSingle.mockResolvedValueOnce({ data: cancelledBooking, error: null }); // (3) bookings.update().select().single()

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.booking.cancellation_fee).toBe(5);
    expect(res.body.booking.refund_amount).toBe(635);
  });

  test('customer tries to mark no_show → 403', async () => {
    mockSingle.mockResolvedValueOnce({ data: existingBooking(), error: null }); // (1) booking fetch

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ status: 'no_show' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/professional on-site/i);
  });

  test('admin can bypass state machine (completed → cancelled)', async () => {
    const completedBooking = existingBooking({ status: 'completed' });
    const afterUpdate      = existingBooking({ status: 'cancelled' });

    // Admin cancel fires pro notification (.single() on professional_profiles) since
    // !isProCancel && !isNoShow && booking.professional_id is set.
    mockSingle.mockResolvedValueOnce({ data: completedBooking, error: null }); // (1) booking fetch
    mockSingle.mockResolvedValueOnce({ data: null, error: null });              // (2) pro FCM notification .single()
    mockSingle.mockResolvedValueOnce({ data: afterUpdate, error: null });      // (3) bookings.update().select().single()

    const res = await request(app)
      .put(`/api/bookings/${BOOKING_ID}/status`)
      .set(authHeader(ADMIN_TOKEN))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/bookings/:id/respond — professional accept / reject
//
//  Schema: { action: 'accept' | 'reject' }   (see middleware/validate.js)
//  Handler reads: const { action } = req.body
//
//  from('users') calls (auth + customer FCM) go to mockUsersBuilder → not
//  counted in the mockSingle queue below.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/bookings/:id/respond — professional response', () => {
  const FUTURE_DEADLINE = new Date(Date.now() + 10 * 60_000).toISOString();
  const PAST_DEADLINE   = new Date(Date.now() - 5 * 60_000).toISOString();

  const mockProf       = { id: PROF_ID, users: { name: 'Alex', phone: '+16099990001', email: null } };
  const mockAssignment = { id: 'assign-1', booking_id: BOOKING_ID, professional_id: PROF_ID, status: 'offered', response_deadline: FUTURE_DEADLINE };
  const mockBooking    = { id: BOOKING_ID, status: 'upcoming', service_type: 'Trainer', service_name: 'Leash Training', city: 'Richardson', customer_id: 'u-cust', professional_id: null, pet_id: null, assignment_status: 'searching', currency: 'USD', address_lat: null, address_lng: null };

  test('non-professional cannot respond → 403', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } }); // (1) professional_profiles lookup → null → 403

    const res = await request(app)
      .post(`/api/bookings/${BOOKING_ID}/respond`)
      .set(authHeader(CUSTOMER_TOKEN))
      .send({ action: 'accept' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/professional profile not found/i);
  });

  test('no active offer for this pro → 404', async () => {
    mockSingle.mockResolvedValueOnce({ data: mockProf, error: null });             // (1) prof lookup
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } }); // (2) no assignment → 404

    const res = await request(app)
      .post(`/api/bookings/${BOOKING_ID}/respond`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ action: 'accept' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active offer/i);
  });

  test('response window expired → 400', async () => {
    mockSingle.mockResolvedValueOnce({ data: mockProf, error: null });
    mockSingle.mockResolvedValueOnce({ data: { ...mockAssignment, response_deadline: PAST_DEADLINE }, error: null });

    const res = await request(app)
      .post(`/api/bookings/${BOOKING_ID}/respond`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ action: 'accept' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('accept → 200, booking confirmed', async () => {
    const bookedWithCustomer = {
      ...mockBooking, professional_id: PROF_ID, assignment_status: 'confirmed',
      users: { id: 'u-cust', name: 'Priya', email: null, phone: '+16099990003' },
    };

    mockSingle.mockResolvedValueOnce({ data: mockProf, error: null });           // (1) prof lookup
    mockSingle.mockResolvedValueOnce({ data: mockAssignment, error: null });     // (2) assignment lookup
    // booking_assignments.update() → builder.then (no .single())
    // bookings.update() → builder.then
    mockSingle.mockResolvedValueOnce({ data: bookedWithCustomer, error: null }); // (3) bookings fetch for customer notify
    // FCM: supabase.from('users').single() → mockUsersBuilder (null) — no push, no mockSingle consumed

    const res = await request(app)
      .post(`/api/bookings/${BOOKING_ID}/respond`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ action: 'accept' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/accepted/i);
  });

  test('reject with no next pro available → 200, message no pros', async () => {
    // Reject path: tried-assignments query uses builder.then (no .single()), then
    // bookings fetch for findNextPro context, then findNextPro → ilike → builder.then
    // → allPros=null → null → update no_pros_available → builder.then.
    mockSingle.mockResolvedValueOnce({ data: mockProf, error: null });       // (1) prof lookup
    mockSingle.mockResolvedValueOnce({ data: mockAssignment, error: null }); // (2) assignment lookup
    mockSingle.mockResolvedValueOnce({ data: mockBooking, error: null });    // (3) bookings fetch for findNextPro context

    const res = await request(app)
      .post(`/api/bookings/${BOOKING_ID}/respond`)
      .set(authHeader(PROFESSIONAL_TOKEN))
      .send({ action: 'reject' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/no other professionals/i);
  });
});
