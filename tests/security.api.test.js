'use strict';
// Regression tests for the 2026-11 security review.
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../services/emailService', () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? false : jest.fn().mockResolvedValue(true)) }));
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const mockDb = { current: null, hits: {} };
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t) => mockDb.current.from(t),
    rpc: jest.fn(async (fn, a) => {
      if (fn !== 'rate_limit_increment') return { data: null, error: null };
      mockDb.hits[a.p_key] = (mockDb.hits[a.p_key] || 0) + 1;
      return { data: [{ hit_count: mockDb.hits[a.p_key], window_reset_at: a.p_reset_at }], error: null };
    }),
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));
const request = require('supertest');
const jwt = require('jsonwebtoken');
mockDb.current = makeFakeSupabase();
const { app } = require('../server');
const { secretEquals, emailTakenByOther, identityKey } = require('../services/accountSecurity');

const ME = 'user-me';
const setup = (t, failing) => { mockDb.current = makeFakeSupabase(t, failing); return t; };
const token = (role) => `Bearer ${jwt.sign({ id: ME, role }, process.env.JWT_SECRET)}`;
const me = (o = {}) => ({ id: ME, role: 'customer', email: 'me@example.test', is_active: true, deleted_at: null, referred_by_code: null, ...o });
const victim = { id: 'admin-1', role: 'admin', email: 'Admin@Example.test', is_active: true };
beforeEach(() => { mockDb.hits = {}; });

describe('email hijack: one account per email', () => {
  it.each([
    ['PUT /users/me', 'customer', (r) => r.put('/api/users/me').send({ email: 'ADMIN@example.TEST' })],
    ['PUT /professionals/me', 'professional', (r) => r.put('/api/professionals/me').send({ email: 'admin@example.test' })],
    ['POST /users/set-role', 'pending_role', (r) => r.post('/api/users/set-role').send({ role: 'customer', name: 'X', email: 'admin@example.test' })],
  ])('%s refuses another account\'s email, in any case', async (_n, role, call) => {
    const t = setup({ users: [me({ role }), victim] });
    const res = await call(request(app)).set('Authorization', token(role));
    expect(res.status).toBe(409);
    expect(t.users[0].email).toBe('me@example.test');
  });
  it('allows your own email and stores it lower-case', async () => {
    const t = setup({ users: [me()], customer_profiles: [] });
    expect((await request(app).put('/api/users/me').set('Authorization', token('customer')).send({ name: 'Me', email: 'New@Example.test' })).status).toBe(200);
    expect(t.users[0].email).toBe('new@example.test');
  });
  it('fails closed when the check cannot run; wildcards are literal', async () => {
    const t = setup({ users: [me(), victim] }, { 'users.select': 'db down' });
    expect((await request(app).put('/api/users/me').set('Authorization', token('customer')).send({ email: 'x@example.test' })).status).toBeGreaterThanOrEqual(403);
    expect(t.users[0].email).toBe('me@example.test');
    setup({ users: [victim] });
    expect(await emailTakenByOther(mockDb.current, '%@example.test', ME)).toBe(false);
  });
});

describe('set-role', () => {
  const call = () => request(app).post('/api/users/set-role').set('Authorization', token('customer')).send({ role: 'customer', name: 'Me', referral_input: 'PCR-1' });
  const tables = (o) => ({ users: [me(o), { id: 'ref', role: 'customer', referral_code: 'PCR-1' }], customer_profiles: [], refresh_tokens: [] });
  it('records a referral on first sign-up but never again', async () => {
    let t = setup(tables({ role: 'pending_role' }));
    await call();
    expect(t.users[0].referred_by_code).toBe('PCR-1');
    t = setup(tables({ role: 'customer' }));
    await call();
    expect(t.users[0].referred_by_code).toBeNull();
  });
  it('does not erase the verified email when none is sent', async () => {
    const t = setup(tables({ role: 'pending_role' }));
    await call();
    expect(t.users[0].email).toBe('me@example.test');
  });
  it('refuses admin accounts', async () => {
    const t = setup(tables({ role: 'admin' }));
    expect((await call()).status).toBe(403);
    expect(t.users[0].role).toBe('admin');
  });
});

describe('booking status', () => {
  it.each(['in_progress', 'completed'])('a customer cannot set %s on their own booking', async (status) => {
    const t = setup({ users: [me()], bookings: [{ id: '00000000-0000-4000-8000-000000000001', customer_id: ME, status: status === 'completed' ? 'in_progress' : 'upcoming' }] });
    const before = t.bookings[0].status;
    expect((await request(app).put(`/api/bookings/${t.bookings[0].id}/status`).set('Authorization', token('customer')).send({ status })).status).toBe(403);
    expect(t.bookings[0].status).toBe(before);
  });
});

describe('OTP guessing and flooding are limited per account, across IPs', () => {
  const ip = (i) => `203.0.113.${i}`;
  it('verify', async () => {
    setup({ otp_tokens: [], users: [] });
    const codes = [];
    for (let i = 1; i <= 10; i++) codes.push((await request(app).post('/api/auth/verify-email-otp').set('X-Forwarded-For', ip(i)).send({ email: i % 2 ? 'v@example.test' : 'V@Example.test', otp: '111111' })).status);
    expect(codes.slice(0, 8)).not.toContain(429);
    expect(codes.slice(8)).toEqual([429, 429]);
    expect((await request(app).post('/api/auth/verify-email-otp').set('X-Forwarded-For', ip(99)).send({ email: 'other@example.test', otp: '111111' })).status).not.toBe(429);
  });
  it('send', async () => {
    setup({ otp_tokens: [], users: [] });
    const codes = [];
    for (let i = 1; i <= 8; i++) codes.push((await request(app).post('/api/auth/send-email-otp').set('X-Forwarded-For', ip(i)).send({ email: 'v@example.test' })).status);
    expect(codes.slice(6)).toEqual([429, 429]);
  });
  it('limiter keys hold no email or phone', () => {
    expect(identityKey({ body: { email: 'v@example.test' } })).toMatch(/^[0-9a-f]{32}$/);
    expect(identityKey({ body: { phone: '+1 555' } })).toBe(identityKey({ body: { phone: '+1555' } }));
  });
});

describe('secrets and tracking', () => {
  it('secretEquals', () => {
    expect([secretEquals('a', 'a'), secretEquals('a', 'b'), secretEquals('', ''), secretEquals(undefined, undefined), secretEquals('a', undefined), secretEquals(['a'], 'a')])
      .toEqual([true, false, false, false, false, false]);
  });
  it.each([[undefined, 401], ['wrong', 401], [process.env.CRON_SECRET, 200]])('cron with secret %s -> %i', async (s, code) => {
    setup({ users: [], admin_logs: [] });
    const r = request(app).post('/api/cron/auto-delete');
    expect((await (s ? r.set('X-Cron-Secret', s) : r)).status).toBe(code);
  });
  it('a suspended customer cannot open live tracking', async () => {
    setup({ users: [me({ id: 'susp', is_active: false })], bookings: [{ id: 'b', customer_id: 'susp' }] });
    const t = `Bearer ${jwt.sign({ id: 'susp', role: 'customer' }, process.env.JWT_SECRET)}`;
    expect((await request(app).get('/api/bookings/b/track').set('Authorization', t)).status).toBe(403);
  });
});
