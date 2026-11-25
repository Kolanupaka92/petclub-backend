// Author: Sai Kolanupaka
'use strict';
// Saves that used to fail (or claim success) because the columns didn't exist.
// The fake database rejects unknown columns, like the real one.
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
const request = require('supertest');
const jwt = require('jsonwebtoken');
mockDb.current = makeFakeSupabase();
const { app } = require('../server');

const ME = 'u-pro';
const setup = (prof = {}, extra = {}, failing) => {
  const t = { users: [{ id: ME, role: 'professional', name: 'Pat', email: 'pat@example.test', phone: '+15550001111', is_active: true }],
    professional_profiles: [{ id: 'p1', user_id: ME, sub_role: 'Groomer', verification_status: 'pending', bio: null, experience: null, ...prof }], ...extra };
  mockDb.current = makeFakeSupabase(t, failing);
  return t;
};
const as = (r, role = 'professional') => r.set('Authorization', `Bearer ${jwt.sign({ id: ME, role }, process.env.JWT_SECRET)}`);
const save = (body) => as(request(app).put('/api/professionals/me')).send(body);

// Exactly what ProOnboarding.jsx and ProDashboard.jsx send.
const onboarding = (o = {}) => ({
  sub_role: 'Vet', name: 'Pat', email: undefined, city: 'Frisco', area: '', address: '1 Main St', pincode: '75034',
  address_lat: 33.15, address_lng: -96.82, address_postal_code: '75034', address_state: 'TX',
  bio: 'Hi', experience: '2–5 years', services: ['Checkup'], pet_types: ['Dogs', 'Cats'], service_areas: '', langs: 'English',
  certification: '', license_number: 'DVM-1', clinic_name: 'Paws', price_basic: '49', price_full: '', price_custom: '', ...o,
});

describe('professional profile', () => {
  it('completing onboarding saves every field, including location for dispatch', async () => {
    const t = setup();
    expect((await save(onboarding())).status).toBe(200);
    expect(t.professional_profiles[0]).toMatchObject({
      sub_role: 'Vet', license_number: 'DVM-1', clinic_name: 'Paws', certification: '', pet_types: ['Dogs', 'Cats'], services: ['Checkup'],
      address_lat: 33.15, address_lng: -96.82, address_postal_code: '75034', address_state: 'TX',
      price_basic: 49, price_full: null, price_custom: null, verification_status: 'pending',
    });
  });
  it('works with no location chosen and nothing optional filled in', async () => {
    const t = setup({ address_lat: 1, address_lng: 2 });
    expect((await save(onboarding({ sub_role: 'Groomer', address_lat: null, address_lng: null, address_postal_code: '', address_state: '', license_number: '', clinic_name: '', langs: '', services: [], pet_types: [], price_basic: '' }))).status).toBe(200);
    expect(t.professional_profiles[0]).toMatchObject({ address_lat: 1, address_lng: 2, price_basic: null });
  });
  it('editing later works with the numbers and blanks read back from the database', async () => {
    const t = setup({ verification_status: 'approved', city: 'Frisco', price_full: 80 });
    const res = await save({ name: 'Pat', email: undefined, city: '', langs: null, service_areas: '', bio: 'New', experience: '', certification: null, license_number: '', clinic_name: '', price_basic: 49.5, price_full: '', price_custom: 0 });
    expect(res.status).toBe(200);
    expect(t.professional_profiles[0]).toMatchObject({ city: 'Frisco', bio: 'New', price_basic: 49.5, price_full: null, price_custom: 0, verification_status: 'approved' });
  });
  it.each([['price_basic', 'abc'], ['price_basic', -1], ['address_lat', 999], ['pet_types', 'Dogs'], ['sub_role', 'Admin']])('rejects a bad %s', async (k, v) => {
    const t = setup(); const before = JSON.stringify(t.professional_profiles[0]);
    expect((await save({ ...onboarding(), [k]: v })).status).toBe(400);
    expect(JSON.stringify(t.professional_profiles[0])).toBe(before);
  });
  it('cannot change role once approved, or set protected fields', async () => {
    const t = setup({ verification_status: 'approved', sub_role: 'Groomer', rating: 3 });
    expect((await save({ sub_role: 'Vet' })).status).toBe(403);
    expect((await save({ sub_role: 'Groomer', bio: 'ok', verification_status: 'approved', is_available: true, rating: 5, user_id: 'x' })).status).toBe(200);
    expect(t.professional_profiles[0]).toMatchObject({ sub_role: 'Groomer', rating: 3, user_id: ME });
    expect(t.professional_profiles[0].is_available).toBeUndefined();
  });
  it('an unverified professional cannot approve themselves', async () => {
    const t = setup();
    await save({ bio: 'x', verification_status: 'approved' });
    expect(t.professional_profiles[0].verification_status).toBe('pending');
  });
  it('does not leak database errors', async () => {
    setup({}, {}, { 'professional_profiles.update': 'relation secret_table' });
    const res = await save(onboarding());
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret_table/);
  });
});

describe('payout details', () => {
  const bank = { payment_type: 'bank', bank_name: 'HDFC', account_holder: 'Pat', account_number: '123456789012', ifsc_code: 'HDFC0001234' };
  const post = (b) => as(request(app).post('/api/professionals/payout')).send(b);
  it('saves bank details, warns the owner, and reveals only the last 4 digits', async () => {
    const t = setup({}, { payout_details: [] });
    expect((await post(bank)).status).toBe(200);
    expect(t.payout_details[0]).toMatchObject({ prof_id: 'p1', ...bank });
    const [to, , html] = mockSend.mock.calls.at(-1);
    expect(to).toBe('pat@example.test'); expect(html).toContain('9012'); expect(html).not.toContain('123456789012');
  });
  it('switching to UPI replaces the bank details', async () => {
    const t = setup({}, { payout_details: [{ prof_id: 'p1', ...bank }] });
    await post({ payment_type: 'upi', upi_id: 'pat@upi' });
    expect(t.payout_details).toHaveLength(1);
    expect(t.payout_details[0]).toMatchObject({ payment_type: 'upi', upi_id: 'pat@upi', account_number: null });
  });
  it('never claims success when the save fails', async () => {
    setup({}, { payout_details: [] }, { 'payout_details.upsert': 'down' });
    expect((await post(bank)).status).toBe(500);
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('customers cannot set payout details', async () => {
    const t = setup({}, { payout_details: [] });
    expect((await as(request(app).post('/api/professionals/payout'), 'customer').send(bank)).status).toBe(403);
    expect(t.payout_details).toHaveLength(0);
  });
});

describe('ID documents', () => {
  it.each([
    ['/api/professionals/upload-id', { doc_type: 'Passport', doc_number: 'X1', cert_type: 'DVM', cert_number: 'C9' }],
    ['/api/professionals/upload-id-photo', { docType: 'Passport', docNumber: 'X1', certType: 'DVM', certNumber: 'C9' }],
  ])('%s saves, and reports failure', async (url, body) => {
    const t = setup({}, { id_documents: [] });
    expect((await as(request(app).post(url)).send(body)).status).toBe(200);
    expect(t.id_documents[0]).toEqual({ prof_id: 'p1', doc_type: 'Passport', doc_number: 'X1', cert_type: 'DVM', cert_number: 'C9' });
    setup({}, {}, { 'id_documents.upsert': 'down' });
    expect((await as(request(app).post(url)).send(body)).status).toBe(500);
  });
});

describe('service record when a booking is completed', () => {
  const BID = '00000000-0000-4000-8000-00000000000b';
  it.each([['Groomer', 'grooming_records'], ['Walker', 'grooming_records'], ['Trainer', 'training_records'], ['Vet', 'vet_records']])('%s -> %s', async (svc, table) => {
    const t = setup({ users: { name: 'Pat' } }, { bookings: [{ id: BID, customer_id: 'c', professional_id: 'p1', pet_id: 'pet1', service_type: svc, service_name: 'Full', status: 'in_progress', scheduled_at: '2026-11-20T10:00:00Z' }], [table]: [], pets: [] });
    expect((await as(request(app).put(`/api/bookings/${BID}/status`)).send({ status: 'completed' })).status).toBe(200);
    expect(t[table]).toHaveLength(1);
    expect(t[table][0]).toMatchObject({ pet_id: 'pet1', booking_id: BID, date: '2026-11-20' });
  });
});

describe('admin payouts screen', () => {
  it('shows the saved details', async () => {
    setup({}, { payout_details: [{ prof_id: 'p1', payment_type: 'upi', upi_id: 'pat@upi', updated_at: 'x' }], bookings: [] });
    const r = await as(request(app).get('/api/admin/payouts'), 'admin');
    expect(r.body.payouts[0]).toMatchObject({ payment_type: 'upi', upi_id: 'pat@upi' });
  });
  it('fails visibly rather than showing an empty list', async () => {
    setup({}, {}, { 'payout_details.select': 'down' });
    expect((await as(request(app).get('/api/admin/payouts'), 'admin')).status).toBe(500);
  });
});
