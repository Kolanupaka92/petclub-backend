// Author: Sai Kolanupaka
'use strict';
// When nobody can take a booking, the admin and the customer are told once.
jest.mock('dotenv', () => ({ config: jest.fn() }));
const mockSend = jest.fn().mockResolvedValue(true);
jest.mock('../services/emailService', () => Object.fromEntries(
  ['sendOtpEmail', 'sendWelcomeEmail', 'sendRoleAssignedEmail', 'sendProviderVerificationEmail', 'sendAccountSuspendedEmail', 'pingSmtp']
    .map(k => [k, jest.fn().mockResolvedValue(true)]).concat([['sendRawEmail', (...a) => mockSend(...a)]])));
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const mockDb = { current: null };
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t) => mockDb.current.from(t), rpc: jest.fn().mockResolvedValue({ data: null, error: null }), storage: { createBucket: jest.fn().mockResolvedValue({}) } }),
}));
process.env.ADMIN_EMAIL = 'admin@example.test';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { markNoProsAvailable } = require('../services/noProAlert');
mockDb.current = makeFakeSupabase();
const { app } = require('../server');

const BID = '00000000-0000-4000-8000-0000000000b1';
const booking = (o = {}) => ({ id: BID, customer_id: 'cust', service_type: 'Groomer', service_name: 'Full <b>Groom</b>', status: 'upcoming', assignment_status: 'offered',
  professional_id: 'p1', scheduled_at: '2026-11-28T16:00:00Z', city: 'Frisco', address_lat: 33.1, address_lng: -96.8, payment_status: 'pending', ...o });
const customer = (o = {}) => ({ id: 'cust', name: 'Asha Rao', email: 'asha@example.test', fcm_token: null, is_active: true, role: 'customer', ...o });
const to = () => mockSend.mock.calls.map(c => c[0]);

describe('markNoProsAvailable', () => {
  const deps = (db, extra = {}) => ({ supabase: db, logger: { warn: jest.fn(), error: jest.fn() }, sendEmail: (...a) => mockSend(...a), sendPush: jest.fn().mockResolvedValue(),
    adminEmail: 'admin@example.test', appUrl: 'https://app.example.test', supportEmail: 'help@example.test', ...extra });

  it('marks the booking and tells admin and customer, with safe content', async () => {
    const db = makeFakeSupabase({ bookings: [booking()], users: [customer({ fcm_token: 'tok' })], notifications: [] });
    const d = deps(db);
    expect(await markNoProsAvailable(d, BID, 'offer timed out')).toBe(true);
    expect(db.tables.bookings[0]).toMatchObject({ assignment_status: 'no_pros_available', professional_id: null });
    expect(to()).toEqual(['admin@example.test', 'asha@example.test']);
    const [admin, cust] = mockSend.mock.calls;
    expect(admin[2]).toContain(BID); expect(admin[2]).toContain('offer timed out');
    expect(cust[1]).toBe("We couldn't find a groomer for Sat, Nov 28, 10:00 AM CT — PETclub");
    expect(cust[2]).toContain("You haven't been charged");
    for (const [, , html] of mockSend.mock.calls) { expect(html).not.toContain('<b>Groom'); expect(html).toContain('&lt;b&gt;Groom'); }
    expect(d.sendPush).toHaveBeenCalledWith('tok', 'No groomer available', expect.any(String), expect.objectContaining({ userId: 'cust', bookingId: BID }));
  });
  it('India bookings show IST; paid bookings promise follow-up, not "not charged"', async () => {
    const db = makeFakeSupabase({ bookings: [booking({ address_lng: 77.6, payment_status: 'paid', service_type: 'Vet' })], users: [customer()] });
    await markNoProsAvailable(deps(db), BID, 'new booking');
    const [, subject, html] = mockSend.mock.calls[1];
    expect(subject).toMatch(/vet for .* IST/);
    expect(html).toContain('contact you about your payment'); expect(html).not.toContain("haven't been charged");
  });
  it('alerts once, however many paths hit it', async () => {
    const db = makeFakeSupabase({ bookings: [booking()], users: [customer()] });
    const r = await Promise.all([1, 2, 3].map(() => markNoProsAvailable(deps(db), BID, 'x')));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
  it.each([['cancelled', { status: 'cancelled' }], ['completed', { status: 'completed' }], ['deleted', { deleted_at: '2026-11-01' }]])('leaves a %s booking alone', async (_n, o) => {
    const db = makeFakeSupabase({ bookings: [booking(o)], users: [customer()] });
    expect(await markNoProsAvailable(deps(db), BID, 'x')).toBe(false);
    expect(db.tables.bookings[0].assignment_status).toBe('offered');
    expect(mockSend).not.toHaveBeenCalled();
  });
  it.each([['suspended', { is_active: false }], ['deleted', { deleted_at: '2026-11-01' }], ['missing', null]])('a %s customer is not contacted; admin still is', async (_n, o) => {
    const db = makeFakeSupabase({ bookings: [booking()], users: o ? [customer(o)] : [] });
    await markNoProsAvailable(deps(db), BID, 'x');
    expect(to()).toEqual(['admin@example.test']);
  });
  it('one failed notification does not stop the others or fail the call', async () => {
    const db = makeFakeSupabase({ bookings: [booking()], users: [customer()] });
    mockSend.mockRejectedValueOnce(new Error('smtp down'));
    const d = deps(db);
    expect(await markNoProsAvailable(d, BID, 'x')).toBe(true);
    expect(to()).toEqual(['admin@example.test', 'asha@example.test']);
    expect(d.logger.error).toHaveBeenCalledWith(expect.stringContaining('admin email failed'));
  });
  it('throws if the booking cannot be updated', async () => {
    const db = makeFakeSupabase({ bookings: [booking()] }, { 'bookings.update': 'down' });
    await expect(markNoProsAvailable(deps(db), BID, 'x')).rejects.toThrow('down');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('every dispatch path that runs out of professionals alerts', () => {
  const pro = { id: 'p1', user_id: 'u-p1', sub_role: 'Groomer', verification_status: 'approved', is_available: true, city: 'Frisco', address_lat: 33.1, address_lng: -96.8, users: { name: 'Pat', is_active: true } };
  const tables = (b = {}) => ({ bookings: [booking(b)], users: [customer(), { id: 'u-p1', role: 'professional', is_active: true }], pets: [], notifications: [],
    professional_profiles: [{ ...pro }], booking_assignments: [{ id: 'a1', booking_id: BID, professional_id: 'p1', status: 'offered', response_deadline: '2026-01-01T00:00:00Z', bookings: booking(b) }] });
  const tok = (id, role) => `Bearer ${jwt.sign({ id, role }, process.env.JWT_SECRET)}`;
  const settle = () => new Promise(r => setTimeout(r, 50));
  const expectAlerted = (t) => {
    expect(t.bookings[0].assignment_status).toBe('no_pros_available');
    expect(to()).toEqual(['admin@example.test', 'asha@example.test']);
  };

  it('offer timed out', async () => {
    const t = tables(); mockDb.current = makeFakeSupabase(t);
    await request(app).post('/api/cron/booking-timeout').set('X-Cron-Secret', process.env.CRON_SECRET);
    expectAlerted(t);
  });
  it('professional declined', async () => {
    const t = tables(); t.booking_assignments[0].response_deadline = '2099-01-01T00:00:00Z'; mockDb.current = makeFakeSupabase(t);
    const r = await request(app).post(`/api/bookings/${BID}/respond`).set('Authorization', tok('u-p1', 'professional')).send({ action: 'reject' });
    expect(r.body.message).toMatch(/No other professionals/);
    expectAlerted(t);
  });
  it('professional cancelled: re-dispatch runs after the booking is saved, then alerts', async () => {
    const t = tables({ assignment_status: 'confirmed', status: 'upcoming' }); t.booking_assignments[0].status = 'accepted'; mockDb.current = makeFakeSupabase(t);
    const r = await request(app).put(`/api/bookings/${BID}/status`).set('Authorization', tok('u-p1', 'professional')).send({ status: 'cancelled', reason: 'sick' });
    expect(r.status).toBe(200);
    await settle();
    expect(t.bookings[0]).toMatchObject({ status: 'upcoming', assignment_status: 'no_pros_available' });
    expect(to()).toContain('admin@example.test');
  });
});
