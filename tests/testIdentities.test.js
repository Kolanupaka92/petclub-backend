'use strict';
// Fixed-OTP test logins must be impossible in production.
jest.mock('dotenv', () => ({ config: jest.fn() }));
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const mockUpserts = [];
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t) => Object.assign(global.__db.from(t), { upsert: (row) => { mockUpserts.push({ t, row }); return Promise.resolve({ error: null }); } }),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));
jest.mock('../services/emailService', () => ({
  sendRawEmail: jest.fn().mockResolvedValue(true),
  sendOtpEmail: jest.fn().mockResolvedValue(true),
}));
const mockSms = jest.fn();
jest.mock('twilio', () => Object.assign(() => ({ messages: { create: mockSms } }), { validateRequest: jest.fn() }));

const request = require('supertest');
const { testOtpFor } = require('../services/testIdentities');
const OTP = '246810';
const PHONE = '+19995550102';
const E2E = { E2E_FIXED_OTP: OTP, E2E_TEST_PHONES: `+19995550101;${PHONE}`, E2E_TEST_EMAIL_DOMAIN: 'mailinator.com' };

describe('testOtpFor', () => {
  const ids = [{ email: 'Groomer@E2E.mypetclub.app' }, { phone: PHONE }, { email: 'x@mailinator.com' }];
  it.each(ids)('allows %j outside production', (id) => expect(testOtpFor(id, { isProd: false, env: E2E })).toBe(OTP));
  it.each(ids)('refuses %j when IS_PROD', (id) => expect(testOtpFor(id, { isProd: true, env: E2E })).toBeNull());
  it.each(ids)('refuses %j when NODE_ENV=production even if dev tools are on', (id) => expect(testOtpFor(id, { isProd: false, env: { ...E2E, NODE_ENV: 'production' } })).toBeNull());
  it.each(ids)('refuses %j on any Cloud Run service', (id) => expect(testOtpFor(id, { isProd: false, env: { ...E2E, K_SERVICE: 'petclub-backend-staging' } })).toBeNull());
  it('refuses everyone else, and everyone when unset or malformed', () => {
    const o = { isProd: false, env: E2E };
    expect(testOtpFor({ email: 'a@e2e.mypetclub.app.evil.com' }, o)).toBeNull();
    expect(testOtpFor({ email: 'a@notmailinator.com' }, o)).toBeNull();
    expect(testOtpFor({ phone: '+19995559999' }, o)).toBeNull();
    expect(testOtpFor(undefined, o)).toBeNull();
    expect(testOtpFor(ids[0], { isProd: false, env: {} })).toBeNull();
    expect(testOtpFor(ids[0], { isProd: false, env: { E2E_FIXED_OTP: '1' } })).toBeNull();
  });
});

const loadApp = (env) => {
  jest.resetModules();
  Object.assign(process.env, E2E, env);
  return require('../server').app;
};
const saved = { ...process.env };
beforeEach(() => { mockUpserts.length = 0; global.__db = makeFakeSupabase({ users: [{ phone: PHONE, email: 'onfile@example.test', role: 'customer' }] }); });
afterEach(() => { process.env = { ...saved }; });
const otpRows = () => mockUpserts.filter(u => u.t === 'otp_tokens').map(u => u.row.otp);

describe('production API', () => {
  const prod = { NODE_ENV: 'production', ALLOW_DEV_TOOLS: '', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'x', TWILIO_PHONE_NUMBER: '+15005550006' };

  it('email: a test address gets a real random OTP, not the fixed one', async () => {
    const app = loadApp(prod);
    await request(app).post('/api/auth/send-email-otp').send({ email: 'groomer@e2e.mypetclub.app' });
    const email = require('../services/emailService');
    const sent = JSON.stringify([...email.sendOtpEmail.mock.calls, ...email.sendRawEmail.mock.calls]);
    expect(sent).not.toBe('[]');          // went down the normal send path
    expect(sent).not.toContain(OTP);
  });

  it('phone: a test number goes to real SMS, and a failed SMS never goes to a caller-supplied address', async () => {
    const app = loadApp(prod);
    mockSms.mockRejectedValue(Object.assign(new Error('not a valid phone number'), { code: 21211 }));
    await request(app).post('/api/auth/send-phone-otp').send({ phone: PHONE, email: 'attacker@example.test' });
    expect(mockSms).toHaveBeenCalled();
    expect(JSON.stringify(mockSms.mock.calls)).not.toContain(OTP);
    const to = require('../services/emailService').sendRawEmail.mock.calls.map(c => c[0]);
    expect(to).toContain('onfile@example.test');
    expect(to).not.toContain('attacker@example.test');
  });
});

describe('local development API', () => {
  it('still offers the fixed OTP, without sending anything', async () => {
    const app = loadApp({ NODE_ENV: 'test', ALLOW_DEV_TOOLS: 'true' });
    const res = await request(app).post('/api/auth/send-email-otp').send({ email: 'customer@e2e.mypetclub.app' });
    expect(res.status).toBe(200);
    expect(otpRows()).toHaveLength(1);
    expect(require('../services/emailService').sendRawEmail).not.toHaveBeenCalled();
  });
  it('refuses it for admin accounts', async () => {
    global.__db = makeFakeSupabase({ users: [{ email: 'admin@e2e.mypetclub.app', role: 'admin' }] });
    const app = loadApp({ NODE_ENV: 'test', ALLOW_DEV_TOOLS: 'true' });
    const res = await request(app).post('/api/auth/send-email-otp').send({ email: 'admin@e2e.mypetclub.app' });
    expect(res.status).toBe(403);
    expect(otpRows()).toHaveLength(0);
  });
});
