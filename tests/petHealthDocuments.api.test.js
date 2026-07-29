'use strict';
/**
 * Pet health passport routes — region gate + auth ordering.
 *
 * The feature is US-only per product decision (paper vaccination cards →
 * digital passport; not offered to Indian accounts yet). Region is derived
 * server-side from the owner's phone (see isUSRegion in server.js), never
 * trusted from the client, so this test's real job is proving a US phone
 * passes the gate and a non-US phone is rejected — anything else is
 * ordinary auth/ownership plumbing already covered by rbac.api.test.js.
 */

const PET_ID = '00000000-0000-4000-8000-0000000000aa';
const OWNER_ID = 'cust-001';

// Route-local Supabase mock: owns the pet, and phone varies per test via
// a mutable module-level variable so both region branches can be tested
// against the same mock shape.
let mockUserPhone = '+19995550101'; // US by default

jest.mock('@supabase/supabase-js', () => {
  const petRow = { owner_id: OWNER_ID };
  return {
    createClient: () => ({
      from: jest.fn((table) => {
        if (table === 'pets') {
          return {
            select: () => ({ eq: () => ({ is: () => ({ single: async () => ({ data: petRow, error: null }) }) }) }),
          };
        }
        if (table === 'users') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: { phone: mockUserPhone }, error: null }) }) }),
          };
        }
        if (table === 'pet_health_documents') {
          return {
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'doc-1' }, error: null }) }) }),
          };
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq:     jest.fn().mockReturnThis(),
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      storage: {
        from: () => ({
          createSignedUploadUrl: async () => ({ data: { signedUrl: 'https://example.test/upload', token: 'tok' }, error: null }),
        }),
      },
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  };
});

jest.mock('../services/emailService', () => ({
  sendRawEmail: jest.fn().mockResolvedValue(true), sendOtpEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true), sendBookingEmail: jest.fn().mockResolvedValue(true),
  sendSPAssignEmail: jest.fn().mockResolvedValue(true), sendAdminNewSPEmail: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../server');

const JWT_SECRET = 'test-jwt-secret-petclub-not-real'; // matches setupEnv.js
const token = jwt.sign({ id: OWNER_ID, role: 'customer' }, JWT_SECRET, { expiresIn: '1h' });
const authHeader = { Authorization: `Bearer ${token}` };

describe('POST /api/pets/:petId/health-documents/presign — region gate', () => {
  test('unauthenticated caller → 401', async () => {
    const res = await request(app).post(`/api/pets/${PET_ID}/health-documents/presign`).send({});
    expect(res.status).toBe(401);
  });

  test('US phone (+1) → allowed, returns an upload URL', async () => {
    mockUserPhone = '+19995550101';
    const res = await request(app)
      .post(`/api/pets/${PET_ID}/health-documents/presign`)
      .set(authHeader)
      .send({ docKind: 'vaccination_card', ext: 'jpg' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.uploadUrl).toBeTruthy();
  });

  test('India phone (+91) → 403, feature not available', async () => {
    mockUserPhone = '+919876543210';
    const res = await request(app)
      .post(`/api/pets/${PET_ID}/health-documents/presign`)
      .set(authHeader)
      .send({ docKind: 'vaccination_card', ext: 'jpg' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/US accounts only/i);
  });

  test('invalid document kind → 400 (US phone, past the region gate)', async () => {
    mockUserPhone = '+19995550101';
    const res = await request(app)
      .post(`/api/pets/${PET_ID}/health-documents/presign`)
      .set(authHeader)
      .send({ docKind: 'not-a-real-kind', ext: 'jpg' });
    expect(res.status).toBe(400);
  });

  test('invalid file extension → 400', async () => {
    mockUserPhone = '+19995550101';
    const res = await request(app)
      .post(`/api/pets/${PET_ID}/health-documents/presign`)
      .set(authHeader)
      .send({ docKind: 'vaccination_card', ext: 'exe' });
    expect(res.status).toBe(400);
  });
});
