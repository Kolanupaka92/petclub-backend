'use strict';
// Suspended / deleted users: auto-delete job, admin actions, outgoing email.
jest.mock('dotenv', () => ({ config: jest.fn() }));

const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const mockDb = { current: null };
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t) => mockDb.current.from(t),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    storage: { createBucket: jest.fn().mockResolvedValue({}) },
  }),
}));
jest.mock('../services/emailService', () => ({
  sendRawEmail: jest.fn().mockResolvedValue(true),
  sendAccountSuspendedEmail: jest.fn().mockResolvedValue(true),
}));

process.env.ADMIN_EMAIL = 'admin@example.test';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const { idsPastGrace, isContactable } = require('../services/suspendedUserCleanup');
mockDb.current = makeFakeSupabase();
const { app } = require('../server');

const HOUR = 3600_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const ID = '00000000-0000-4000-8000-0000000000a1';
const suspendedUser = (o = {}) => ({ id: ID, name: null, phone: '+910000000001', email: null, role: 'pending_role', is_active: false, deleted_at: null, ...o });
const log = (action, h) => ({ target_id: ID, action, created_at: ago(h), notes: 'x' });
const runJob = () => request(app).post('/api/cron/auto-delete').set('X-Cron-Secret', process.env.CRON_SECRET);
const setup = (tables, failing) => { mockDb.current = makeFakeSupabase(tables, failing); return tables; };

describe('auto-delete job', () => {
  it('deletes a user suspended over 24h ago and emails the admin exactly once across runs', async () => {
    const t = setup({ users: [suspendedUser()], admin_logs: [log('suspend_user', 25)], customer_profiles: [{ user_id: ID }], pets: [{ owner_id: ID, deleted_at: null }] });
    const first = await runJob();
    expect(first.body).toEqual({ success: true, deleted: 1, cleanup_errors: 0, emailed: true });
    expect(t.users[0].deleted_at).toBeTruthy();
    expect(t.customer_profiles).toHaveLength(0);
    expect(t.pets[0].deleted_at).toBeTruthy();
    expect(t.admin_logs[0].notes).toMatch(/redacted/);

    const second = await runJob();
    expect(second.body).toMatchObject({ success: true, deleted: 0, emailed: false });
    expect(emailService.sendRawEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendRawEmail.mock.calls[0][1]).not.toContain("--'");
  });

  it('never emails about a user an admin already deleted manually', async () => {
    const when = ago(24 * 85);
    const t = setup({ users: [suspendedUser({ deleted_at: when })], admin_logs: [log('suspend_user', 24 * 85)] });
    const res = await runJob();
    expect(res.body.deleted).toBe(0);
    expect(t.users[0].deleted_at).toBe(when);       // purge clock must not restart
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['suspended under 24h ago', { is_active: false }, [['suspend_user', 2]]],
    ['restored after suspension', { is_active: true }, [['suspend_user', 50], ['restore_user', 40]]],
    ['suspended again recently', { is_active: false }, [['suspend_user', 50], ['restore_user', 40], ['suspend_user', 2]]],
    ['suspended with no suspension on record', { is_active: false }, []],
  ])('leaves alone a user %s', async (_n, o, logs) => {
    const t = setup({ users: [suspendedUser(o)], admin_logs: logs.map(l => log(...l)) });
    expect((await runJob()).body.deleted).toBe(0);
    expect(t.users[0].deleted_at).toBeNull();
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it('fails the cron run, with no email, when the delete itself fails', async () => {
    setup({ users: [suspendedUser()], admin_logs: [log('suspend_user', 25)] }, { 'users.update': 'db down' });
    expect((await runJob()).status).toBe(500);
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it('still deletes, emails and reports it when one cleanup step fails', async () => {
    const t = setup({ users: [suspendedUser()], admin_logs: [log('suspend_user', 25)], pets: [{ owner_id: ID, deleted_at: null }] }, { 'professional_profiles.delete': 'fk violation' });
    expect((await runJob()).body).toEqual({ success: true, deleted: 1, cleanup_errors: 1, emailed: true });
    expect(t.pets[0].deleted_at).toBeTruthy();
  });
});

describe('admin actions on an already-deleted user', () => {
  const token = jwt.sign({ id: 'admin-1', role: 'admin' }, process.env.JWT_SECRET);
  const as = (r) => r.set('Authorization', `Bearer ${token}`);
  beforeEach(() => setup({ users: [suspendedUser({ deleted_at: ago(5) }), { id: 'admin-1', role: 'admin', is_active: true }] }));

  it('delete returns 404 and sends nothing', async () => {
    expect((await as(request(app).delete(`/api/admin/users/${ID}`))).status).toBe(404);
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });
  it('suspend/restore returns 404 and sends nothing', async () => {
    expect((await as(request(app).put(`/api/admin/users/${ID}/suspend`)).send({})).status).toBe(404);
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });
  it('purge-all does not count them again', async () => {
    const res = await as(request(app).delete('/api/admin/users/suspended/purge-all'));
    expect(res.body.count).toBe(0);
  });
});

describe('outgoing email to suspended or deleted users', () => {
  const cron = (p) => request(app).post(`/api/cron/${p}`).set('X-Cron-Secret', process.env.CRON_SECRET);
  const state = { active: { is_active: true, deleted_at: null }, suspended: { is_active: false, deleted_at: null }, deleted: { is_active: true, deleted_at: ago(1) } };

  it.each([['active', 1], ['suspended', 0], ['deleted', 0]])('%s owner: care reminders sent = %i', async (k, n) => {
    setup({ vet_records: [{ next_due: new Date(Date.now() + 6 * 24 * HOUR).toISOString().slice(0, 10), vtype: 'Rabies', pets: { name: 'P', owner_id: ID } }], users: [{ ...suspendedUser(), email: 'o@example.test', ...state[k] }] });
    expect((await cron('care-reminders')).body.emails_sent).toBe(n);
  });
  it.each([['active', 1], ['suspended', 0], ['deleted', 0]])('%s customer: coupon warnings sent = %i', async (k, n) => {
    setup({ loyalty_coupons: [{ is_used: false, expires_at: new Date(Date.now() + 72 * HOUR).toISOString(), code: 'C', service_name: 'S', users: { email: 'c@example.test', ...state[k] } }] });
    expect((await cron('coupon-expiry')).body.emails_sent).toBe(n);
  });
});

describe('helpers', () => {
  it('idsPastGrace uses the latest event per user', () => {
    expect(idsPastGrace([log('suspend_user', 30)])).toEqual([ID]);
    expect(idsPastGrace([log('restore_user', 26), log('suspend_user', 30)])).toEqual([]);
  });
  it('isContactable', () => {
    expect([isContactable({ is_active: true }), isContactable({ is_active: false }), isContactable({ deleted_at: 'x' }), isContactable(null)]).toEqual([true, false, false, false]);
  });
});
