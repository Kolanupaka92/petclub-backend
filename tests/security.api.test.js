// Author: Sai Kolanupaka
'use strict';
// Regression tests for the 2026-11 security review.
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../services/emailService', () => Object.fromEntries(
  ['sendRawEmail', 'sendOtpEmail', 'sendWelcomeEmail', 'sendRoleAssignedEmail', 'sendProviderVerificationEmail', 'sendAccountSuspendedEmail', 'pingSmtp']
    .map(k => [k, jest.fn().mockResolvedValue(true)])));
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

describe('email never changes without a code', () => {
  it.each([
    ['PUT /users/me', 'customer', (r, e) => r.put('/api/users/me').send({ name: 'Me', email: e })],
    ['PUT /professionals/me', 'professional', (r, e) => r.put('/api/professionals/me').send({ name: 'Me', email: e })],
    ['POST /users/set-role', 'pending_role', (r, e) => r.post('/api/users/set-role').send({ role: 'customer', name: 'Me', email: e })],
  ])('%s leaves it alone and asks for verification', async (_n, role, call) => {
    for (const [email, needs] of [['admin@example.test', true], ['new@example.test', true], ['ME@example.test', false]]) {
      const t = setup({ users: [me({ role }), { ...victim }], customer_profiles: [], professional_profiles: [{ user_id: ME }], refresh_tokens: [] });
      const res = await call(request(app), email).set('Authorization', token(role));
      expect(res.status).toBe(200);
      expect(res.body.email_verification_required).toBe(needs);
      expect(t.users[0].email).toBe('me@example.test');
      expect(t.users[0].name).toBe('Me');
    }
  });
  it('sign-up does not email an address nobody has confirmed', async () => {
    const email = require('../services/emailService');
    setup({ users: [me({ role: 'pending_role', email: null })], customer_profiles: [], refresh_tokens: [] });
    await request(app).post('/api/users/set-role').set('Authorization', token('pending_role')).send({ role: 'customer', name: 'X', email: 'someone@example.test' });
    expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
  });
});

describe('verified email change', () => {
  const email = require('../services/emailService');
  const start = (e, who = ME) => request(app).post('/api/users/me/email').set('Authorization', `Bearer ${jwt.sign({ id: who, role: 'customer' }, process.env.JWT_SECRET)}`).send({ email: e });
  const finish = (e, otp, who = ME) => request(app).post('/api/users/me/email/verify').set('Authorization', `Bearer ${jwt.sign({ id: who, role: 'customer' }, process.env.JWT_SECRET)}`).send({ email: e, otp });
  const codeSent = () => email.sendRawEmail.mock.calls.filter(c => /Confirm/.test(c[1])).at(-1)[2].match(/>(\d{6})</)[1];
  beforeEach(() => email.sendRawEmail.mockResolvedValue(true));

  it('switches only after the code, alerts the old address, and the code works once', async () => {
    const t = setup({ users: [me()], otp_tokens: [] });
    expect((await start(' New@Example.test ')).body).toEqual({ success: true, email: 'new@example.test' });
    expect(email.sendRawEmail.mock.calls[0][0]).toBe('new@example.test');
    expect(t.users[0].email).toBe('me@example.test');
    const code = codeSent();
    expect((await finish('new@example.test', code)).body).toEqual({ success: true, email: 'new@example.test' });
    expect(t.users[0].email).toBe('new@example.test');
    expect(email.sendRawEmail.mock.calls.at(-1)[0]).toBe('me@example.test');
    expect((await finish('new@example.test', code)).status).toBe(400);
  });
  it('the code is bound to the address and the user', async () => {
    const t = setup({ users: [me(), { id: 'u2', email: 'u2@example.test', is_active: true, role: 'customer' }], otp_tokens: [] });
    await start('new@example.test');
    const code = codeSent();
    expect((await finish('other@example.test', code)).status).toBe(400);
    expect((await finish('new@example.test', code, 'u2')).status).toBe(400);
    expect(t.users.map(u => u.email)).toEqual(['me@example.test', 'u2@example.test']);
  });
  it('the code cannot be used to sign in, and a sign-in code cannot change the email', async () => {
    const t = setup({ users: [me()], otp_tokens: [] });
    await start('new@example.test');
    const code = codeSent();
    expect((await request(app).post('/api/auth/verify-email-otp').send({ email: 'new@example.test', otp: code })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email-otp').send({ email: `email-change:${ME}`, otp: code })).status).toBe(400);
    setup({ users: [me()], otp_tokens: [{ phone: 'new@example.test', otp: require('crypto').createHash('sha256').update('123123').digest('hex'), verified: false, expires_at: new Date(Date.now() + 6e5).toISOString() }] });
    expect((await finish('new@example.test', '123123')).status).toBe(400);
    expect(t.users[0].email).toBe('me@example.test');
  });
  it('rejects expired codes', async () => {
    const t = setup({ users: [me()], otp_tokens: [] });
    await start('new@example.test');
    t.otp_tokens[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await finish('new@example.test', codeSent())).status).toBe(400);
  });
  it('refuses an address in use, at request and again at confirm', async () => {
    const t = setup({ users: [me(), { ...victim }], otp_tokens: [] });
    expect((await start('ADMIN@example.test')).status).toBe(409);
    expect(email.sendRawEmail).not.toHaveBeenCalled();
    await start('new@example.test');
    t.users.push({ id: 'late', email: 'new@example.test' });
    expect((await finish('new@example.test', codeSent())).status).toBe(409);
    expect(t.users[0].email).toBe('me@example.test');
  });
  it('treats wildcards literally and fails closed', async () => {
    setup({ users: [victim] });
    expect(await emailTakenByOther(mockDb.current, '%@example.test', ME)).toBe(false);
    const t = setup({ users: [me()], otp_tokens: [] }, { 'otp_tokens.upsert': 'down' });
    expect((await start('new@example.test')).status).toBe(500);
    expect(email.sendRawEmail).not.toHaveBeenCalled();
    setup(t);
    email.sendRawEmail.mockResolvedValue(null);               // SMTP not configured
    expect((await start('new@example.test')).status).toBe(500);
    expect(t.users[0].email).toBe('me@example.test');
  });
  it('needs a login, and limits guesses and sends', async () => {
    setup({ users: [me()], otp_tokens: [] });
    expect((await request(app).post('/api/users/me/email').send({ email: 'a@b.co' })).status).toBe(401);
    expect((await request(app).post('/api/users/me/email/verify').send({ email: 'a@b.co', otp: '111111' })).status).toBe(401);
    const g = []; for (let i = 0; i < 9; i++) g.push((await finish('new@example.test', '111111')).status);
    expect(g.slice(0, 8).every(s => s === 400)).toBe(true); expect(g[8]).toBe(429);
    const s = []; for (let i = 0; i < 6; i++) s.push((await start(`n${i}@example.test`)).status);
    expect(s.slice(0, 5).every(x => x === 200)).toBe(true); expect(s[5]).toBe(429);
  });
  it('codes and addresses stay out of the logs', async () => {
    const real = jest.requireActual('../services/emailService');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await real.sendOtpEmail('someone@example.test', { otp: '918273' });
    const out = JSON.stringify(spy.mock.calls); spy.mockRestore();
    expect(out).not.toMatch(/918273|someone@/);
  });
});

describe('admin edit', () => {
  it('cannot give two accounts the same email', async () => {
    const t = setup({ users: [{ id: ME, role: 'admin', is_active: true }, { id: 'a', email: 'a@example.test', role: 'customer' }, { id: 'b', email: 'b@example.test', role: 'customer' }], admin_logs: [] });
    const res = await request(app).patch('/api/admin/users/a').set('Authorization', token('admin')).send({ email: 'B@example.test' });
    expect(res.status).toBe(409);
    expect(t.users[1].email).toBe('a@example.test');
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
  it('parallel calls cannot each earn the referral bonus', async () => {
    const t = setup(tables({ role: 'pending_role' }));
    const codes = (await Promise.all([call(), call(), call()])).map(r => r.status).sort();
    expect(codes.filter(c => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(t.users[0].role).toBe('customer');
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
