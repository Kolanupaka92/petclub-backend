'use strict';
// Cron authentication (real token verification against a local key) and the
// booking-offer timeout job, which now runs every 5 minutes.
jest.mock('dotenv', () => ({ config: jest.fn() }));
const crypto = require('crypto');
const mockSend = jest.fn().mockResolvedValue(true);
jest.mock('../services/emailService', () => ({ sendRawEmail: (...a) => mockSend(...a) }));
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const mockDb = { current: null };
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t) => mockDb.current.from(t), rpc: jest.fn().mockResolvedValue({ data: null, error: null }), storage: { createBucket: jest.fn().mockResolvedValue({}) } }),
}));
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const { makeCronAuth, DEFAULT_AUDIENCE } = require('../services/cronAuth');

describe('cron authentication', () => {
  const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const google = pair(), attacker = pair();
  const SA = 'petclub-scheduler@proj.iam.gserviceaccount.com';
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (claims = {}, key = google, alg = 'RS256') => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${b({ alg, kid: 'k1', typ: 'JWT' })}.${b({ iss: 'https://accounts.google.com', aud: DEFAULT_AUDIENCE, email: SA, email_verified: true, sub: '1', iat: now() - 10, exp: now() + 600, ...claims })}`;
    return `${head}.${alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(head), key.privateKey).toString('base64url')}`;
  };
  const logger = { warn: jest.fn() };
  const run = async (headers, env = { CRON_OIDC_SERVICE_ACCOUNT: SA }) => {
    const client = new OAuth2Client();
    client.getFederatedSignonCertsAsync = async () => ({ certs: { k1: google.publicKey }, format: 'PEM' });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const ok = await makeCronAuth({ logger, env, client })({ headers }, res);
    expect(ok).toBe(res.status.mock.calls.length === 0);   // allowed, or exactly one refusal
    if (!ok) expect(res.status).toHaveBeenCalledWith(401);
    return ok;
  };
  const bearer = (t) => ({ authorization: `Bearer ${t}` });

  it('accepts the scheduler identity', async () => expect(await run(bearer(sign()))).toBe(true));
  it.each([
    ['another Google account', () => sign({ email: 'evil@proj.iam.gserviceaccount.com' })],
    ['an unverified email', () => sign({ email_verified: false })],
    ['a missing email', () => sign({ email: undefined })],
    ['a token for another service', () => sign({ aud: 'https://other.example' })],
    ['an expired token', () => sign({ iat: now() - 7200, exp: now() - 3600 })],
    ['another issuer', () => sign({ iss: 'https://evil.example' })],
    ['a forged signature', () => sign({}, attacker)],
    ['alg none', () => sign({}, google, 'none')],
    ['garbage', () => 'abc.def.ghi'],
  ])('rejects %s', async (_n, t) => expect(await run(bearer(t()))).toBe(false));
  it('rejects everything when the identity is not configured', async () => expect(await run(bearer(sign()), {})).toBe(false));
  it('the old secret works only while it is set', async () => {
    expect(await run({ 'x-cron-secret': 's' }, { CRON_SECRET: 's' })).toBe(true);
    expect(await run({ 'x-cron-secret': 's' }, {})).toBe(false);
    expect(await run({ 'x-cron-secret': '' }, { CRON_SECRET: '' })).toBe(false);
    expect(await run({})).toBe(false);
  });
  it('never logs the token', () => expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/eyJ/));
});

describe('every cron route is guarded and scheduled', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const routes = [...src.matchAll(/app\.post\('\/api\/cron\/([a-z-]+)', async \(req, res\) => \{\s*\n\s*(.*)/g)];
  it('awaits cronAuth first', () => {
    expect(routes.length).toBe((src.match(/'\/api\/cron\//g) || []).length);
    for (const r of routes) expect(r[2].trim()).toBe('if (!(await cronAuth(req, res))) return;');
  });
  it('has a Cloud Scheduler job', () => {
    const sh = fs.readFileSync(path.join(__dirname, '../scripts/setup-scheduler.sh'), 'utf8');
    const jobs = [...sh.matchAll(/^(?:JOBS=')?([a-z-]+)\|[^|]+\|\d\|\d+'?$/gm)].map(m => m[1]);
    expect(jobs.sort()).toEqual(routes.map(r => r[1]).sort());
  });
});

describe('booking-offer timeout', () => {
  const request = require('supertest');
  const { app } = require('../server');
  const past = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const pro = (id, o = {}) => ({ id, user_id: `u-${id}`, sub_role: 'Groomer', verification_status: 'approved', is_available: true, city: 'Frisco', last_assigned_at: past(id === 'p1' ? 10 : 99), address_lat: 33.1, address_lng: -96.8, users: { name: id, email: `${id}@example.test`, is_active: true }, ...o });
  const setup = (pros, bk = {}) => {
    const b = { id: 'b1', city: 'Frisco', service_type: 'Groomer', status: 'upcoming', assignment_status: 'offered', professional_id: 'p1', address_lat: 33.1, address_lng: -96.8, ...bk };
    const t = { bookings: [b], pets: [], users: [], professional_profiles: pros, booking_assignments: [{ id: 'a1', booking_id: 'b1', professional_id: 'p1', status: 'offered', response_deadline: past(1), bookings: b }] };
    mockDb.current = makeFakeSupabase(t);
    return t;
  };
  const run = () => request(app).post('/api/cron/booking-timeout').set('X-Cron-Secret', process.env.CRON_SECRET);

  it('moves the booking to the next professional', async () => {
    const t = setup([pro('p1'), pro('p2')]);
    expect((await run()).body).toEqual({ success: true, timed_out: 1 });
    expect(t.bookings[0].professional_id).toBe('p2');
  });
  it('a lone professional is never offered it again, however often the job runs', async () => {
    const t = setup([pro('p1')]);
    for (let i = 0; i < 4; i++) expect((await run()).status).toBe(200);
    expect(t.bookings[0]).toMatchObject({ assignment_status: 'no_pros_available', professional_id: null });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('overlapping runs offer it once', async () => {
    const t = setup([pro('p1'), pro('p2'), pro('p3')]);
    const r = await Promise.all([run(), run(), run()]);
    expect(r.map(x => x.body.timed_out).sort()).toEqual([0, 0, 1]);
    expect(t.booking_assignments).toHaveLength(2);
  });
  it.each([
    ['cancelled', { status: 'cancelled', assignment_status: 'cancelled' }], ['deleted', { deleted_at: past(1) }],
    ['confirmed', { assignment_status: 'confirmed' }], ['reassigned', { professional_id: 'p9' }],
  ])('never revives a booking that was %s', async (_n, bk) => {
    const t = setup([pro('p1'), pro('p2')], bk);
    const before = JSON.stringify(t.bookings[0]);
    await run();
    expect(JSON.stringify(t.bookings[0])).toBe(before);
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('fails visibly when offers cannot be loaded', async () => {
    mockDb.current = makeFakeSupabase({}, { 'booking_assignments.select': 'down' });
    expect((await run()).status).toBe(500);
  });
});
