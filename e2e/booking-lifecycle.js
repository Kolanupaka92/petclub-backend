'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  Booking Lifecycle — Real E2E Test
 *  e2e/booking-lifecycle.js
 *
 *  Runs against a LIVE backend + LIVE Supabase.
 *  No mocks.  Every HTTP request hits the actual server.
 *  Every assertion queries the real DB.
 *
 *  Usage:
 *    # 1. Start the backend in another terminal:  npm run dev
 *    # 2. Run:
 *    node e2e/booking-lifecycle.js
 *
 *  Or against the deployed Cloud Run URL:
 *    E2E_BASE_URL=https://petclub-backend-xxx.run.app node e2e/booking-lifecycle.js
 *
 *  What it tests:
 *    ✓ POST /api/bookings              → booking row created in DB
 *    ✓ booking_assignments row         → dispatch offered to our test pro
 *    ✓ POST /api/bookings/:id/respond  → booking confirmed, assignment updated
 *    ✓ PUT  /api/bookings/:id/status   → booking cancelled, fee computed
 *    ✓ DB state after each step        → not just HTTP 200s
 *
 *  Teardown removes every row this script creates, tagged by RUN_ID.
 *  Safe to run against the production DB — test rows use a unique phone
 *  prefix (+1555999XXXX) and are deleted at the end.
 * ══════════════════════════════════════════════════════════════════
 */

require('dotenv').config();               // load .env
const { createClient } = require('@supabase/supabase-js');
const jwt              = require('jsonwebtoken');
const crypto           = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────
const BASE_URL    = process.env.E2E_BASE_URL || 'http://localhost:5000';
const JWT_SECRET  = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!JWT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  Missing env vars: JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  console.error('    Make sure .env is in petclub-backend/ and is loaded.');
  process.exit(1);
}

// ── Supabase admin client (bypasses RLS for seeding / assertions) ───────────
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Unique run ID — tags every row this script inserts ──────────────────────
const RUN_ID      = crypto.randomBytes(4).toString('hex');   // e.g. "a3f7c1b2"
const CUST_PHONE  = `+1555999${RUN_ID.slice(0, 4)}`;        // unique per run
const PRO_PHONE   = `+1555998${RUN_ID.slice(0, 4)}`;
const TEST_CITY   = 'Richardson';
const SERVICE_TYPE = 'Trainer';
const SERVICE_NAME = 'Leash Training';

// ── State shared between steps ──────────────────────────────────────────────
let custId, proId, proProfileId;
let custJWT, proJWT;
let bookingId;

// ── Helpers ─────────────────────────────────────────────────────────────────
function pass(label) { console.log(`  ✅  ${label}`); }
function fail(label, detail) {
  console.error(`  ❌  ${label}`);
  if (detail) console.error('     ', detail);
}
function section(title) { console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`); }

async function api(method, path, body, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

async function dbRow(table, filters) {
  let q = sb.from(table).select('*');
  for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`DB query ${table}: ${error.message}`);
  return data;
}

function assert(condition, label, detail) {
  if (condition) { pass(label); return true; }
  fail(label, detail);
  return false;
}

// ── Setup: seed test users ──────────────────────────────────────────────────
async function setup() {
  section('SETUP — seeding test users');

  // Insert customer
  const { data: cust, error: ce } = await sb
    .from('users')
    .insert({ phone: CUST_PHONE, role: 'customer', name: `E2E Customer ${RUN_ID}`, is_active: true })
    .select()
    .single();
  if (ce) { fail('Insert customer', ce.message); process.exit(1); }
  custId = cust.id;
  pass(`Customer created: ${custId} (${CUST_PHONE})`);

  // Insert professional user
  const { data: pro, error: pe } = await sb
    .from('users')
    .insert({ phone: PRO_PHONE, role: 'professional', name: `E2E Pro ${RUN_ID}`, is_active: true })
    .select()
    .single();
  if (pe) { fail('Insert professional', pe.message); process.exit(1); }
  proId = pro.id;
  pass(`Professional user created: ${proId} (${PRO_PHONE})`);

  // Insert professional profile — approved, available, matching city + sub_role
  const { data: prof, error: ppe } = await sb
    .from('professional_profiles')
    .insert({
      user_id:             proId,
      sub_role:            SERVICE_TYPE,
      city:                TEST_CITY,
      is_available:        true,
      verification_status: 'approved',   // so findNextPro picks this pro up
      last_assigned_at:    null,         // ensures round-robin puts this pro first
    })
    .select()
    .single();
  if (ppe) { fail('Insert professional_profiles', ppe.message); process.exit(1); }
  proProfileId = prof.id;
  pass(`Professional profile created: ${proProfileId}`);

  // Mint real JWTs
  custJWT = jwt.sign({ id: custId, role: 'customer', phone: CUST_PHONE }, JWT_SECRET, { expiresIn: '1h' });
  proJWT  = jwt.sign({ id: proId,  role: 'professional', phone: PRO_PHONE }, JWT_SECRET, { expiresIn: '1h' });
  pass('JWTs minted');
}

// ── Test 1: Create booking ──────────────────────────────────────────────────
async function testCreateBooking() {
  section('TEST 1 — POST /api/bookings');

  const { status, body } = await api('POST', '/api/bookings', {
    terms_accepted: true,
    service_type:   SERVICE_TYPE,
    service_name:   SERVICE_NAME,
    city:           TEST_CITY,
  }, custJWT);

  if (!assert(status === 200, `HTTP 200 (got ${status})`, body.error)) return;
  if (!assert(body.success === true, 'body.success is true')) return;

  bookingId = body.booking?.id;
  if (!assert(!!bookingId, 'booking.id present in response', JSON.stringify(body.booking))) return;
  pass(`Booking ID: ${bookingId}`);

  // Verify DB row
  const row = await dbRow('bookings', { id: bookingId });
  assert(row !== null,                        'bookings row exists in DB');
  assert(row.customer_id === custId,          `customer_id matches (${row.customer_id})`);
  assert(row.service_type === SERVICE_TYPE,   `service_type = ${SERVICE_TYPE}`);
  assert(row.city === TEST_CITY,              `city = ${TEST_CITY}`);
  assert(!!row.total_amount,                  `total_amount set (${row.total_amount})`);

  // Verify dispatch: our seeded pro should have received an offer
  const assignment = await dbRow('booking_assignments', { booking_id: bookingId, professional_id: proProfileId });
  if (assignment) {
    assert(assignment.status === 'offered',    `assignment.status = offered`);
    assert(!!assignment.response_deadline,     'response_deadline set');
    pass(`Dispatch: booking offered to our test pro (assignment ${assignment.id})`);
  } else {
    // findNextPro runs synchronously inline — if assignment is null, dispatch didn't fire
    const bkRow = await dbRow('bookings', { id: bookingId });
    fail(
      'Dispatch: no booking_assignment row for our test pro',
      `booking.assignment_status = ${bkRow?.assignment_status} — ` +
      'possible cause: findNextPro filtered out our pro (city/sub_role mismatch?)'
    );
  }
}

// ── Test 2: Professional accepts ────────────────────────────────────────────
async function testRespondAccept() {
  section('TEST 2 — POST /api/bookings/:id/respond (accept)');

  if (!bookingId) { fail('Skipped — no booking from Test 1'); return; }

  // Verify there is an offered assignment first
  const assignment = await dbRow('booking_assignments', {
    booking_id:      bookingId,
    professional_id: proProfileId,
  });
  if (!assignment || assignment.status !== 'offered') {
    fail('Skipped — no offered assignment exists (dispatch may have failed in Test 1)');
    return;
  }

  const { status, body } = await api(
    'POST', `/api/bookings/${bookingId}/respond`,
    { action: 'accept' },
    proJWT,
  );

  if (!assert(status === 200, `HTTP 200 (got ${status})`, body.error)) return;
  assert(body.success === true, 'body.success is true');
  assert(body.message?.toLowerCase().includes('accept'), `body.message mentions accept ("${body.message}")`);

  // Verify DB state
  const booking = await dbRow('bookings', { id: bookingId });
  assert(booking.assignment_status === 'confirmed', `booking.assignment_status = confirmed (was: ${booking.assignment_status})`);
  assert(booking.professional_id === proProfileId,  `booking.professional_id set to our pro`);

  const updatedAssignment = await dbRow('booking_assignments', { booking_id: bookingId, professional_id: proProfileId });
  assert(updatedAssignment?.status === 'accepted',  `assignment.status = accepted (was: ${updatedAssignment?.status})`);
}

// ── Test 3: Customer cancels ────────────────────────────────────────────────
async function testCancelBooking() {
  section('TEST 3 — PUT /api/bookings/:id/status (cancel)');

  if (!bookingId) { fail('Skipped — no booking from Test 1'); return; }

  // Fetch current status first — cancel only valid from 'upcoming'
  const preRow = await dbRow('bookings', { id: bookingId });
  if (preRow.status !== 'upcoming') {
    fail(`Skipped — booking.status is '${preRow.status}', not 'upcoming' (cancel not valid)`);
    return;
  }

  const { status, body } = await api(
    'PUT', `/api/bookings/${bookingId}/status`,
    { status: 'cancelled', cancel_reason: 'E2E teardown' },
    custJWT,
  );

  if (!assert(status === 200, `HTTP 200 (got ${status})`, body.error)) return;
  assert(body.success === true, 'body.success is true');

  // Verify DB state
  const booking = await dbRow('bookings', { id: bookingId });
  assert(booking.status === 'cancelled',      `booking.status = cancelled`);
  assert(booking.cancellation_fee !== null,   `cancellation_fee computed (${booking.cancellation_fee})`);
  assert(booking.refund_amount !== null,       `refund_amount computed (${booking.refund_amount})`);

  // cancellation_fee and refund_amount are always set; verify they add up
  assert(
    booking.refund_amount === (booking.total_amount - booking.cancellation_fee),
    `refund_amount = total_amount − cancellation_fee (${booking.total_amount} − ${booking.cancellation_fee} = ${booking.refund_amount})`,
  );
  if (preRow.scheduled_at) {
    const hoursUntil = (new Date(preRow.scheduled_at) - Date.now()) / 3_600_000;
    if (hoursUntil < 2) {
      pass(`Late-cancel: ${hoursUntil.toFixed(1)}h until service — fee=${booking.cancellation_fee}`);
      assert(booking.cancellation_fee > 0, `cancellation_fee > 0 (${booking.cancellation_fee})`);
    } else {
      pass(`Free-cancel: ${hoursUntil.toFixed(1)}h until service — no fee`);
      assert(booking.cancellation_fee === 0, `cancellation_fee = 0 (${booking.cancellation_fee})`);
    }
  } else {
    pass(`No scheduled_at — fee=${booking.cancellation_fee} (server default)`);
  }
}

// ── Test 4: Auth guard — unauthenticated → 401 ─────────────────────────────
async function testAuthGuard() {
  section('TEST 4 — Auth guard sanity checks');

  const { status: s1 } = await api('GET', '/api/users/me');
  assert(s1 === 401, `GET /api/users/me without token → 401 (got ${s1})`);

  const { status: s2 } = await api('POST', '/api/bookings', { terms_accepted: true, service_type: 'Trainer' });
  assert(s2 === 401, `POST /api/bookings without token → 401 (got ${s2})`);

  const { status: s3, body: b3 } = await api('GET', '/api/admin/stats', null, custJWT);
  assert(s3 === 403, `GET /api/admin/stats as customer → 403 (got ${s3})`);
  assert(b3.error?.toLowerCase().includes('admin'), `error mentions admin ("${b3.error}")`);
}

// ── Teardown ────────────────────────────────────────────────────────────────
async function teardown() {
  section('TEARDOWN — removing test data');

  if (bookingId) {
    // Delete in FK-safe order
    const { error: e1 } = await sb.from('booking_assignments').delete().eq('booking_id', bookingId);
    if (e1) fail(`Delete booking_assignments: ${e1.message}`);
    else pass('Deleted booking_assignments');

    const { error: e2 } = await sb.from('loyalty_transactions').delete().eq('booking_id', bookingId);
    if (e2) fail(`Delete loyalty_transactions: ${e2.message}`);
    else pass('Deleted loyalty_transactions');

    const { error: e3 } = await sb.from('bookings').delete().eq('id', bookingId);
    if (e3) fail(`Delete booking: ${e3.message}`);
    else pass(`Deleted booking ${bookingId}`);
  }

  if (proProfileId) {
    const { error: e4 } = await sb.from('professional_profiles').delete().eq('id', proProfileId);
    if (e4) fail(`Delete professional_profile: ${e4.message}`);
    else pass('Deleted professional_profile');
  }

  if (proId) {
    const { error: e5 } = await sb.from('users').delete().eq('id', proId);
    if (e5) fail(`Delete pro user: ${e5.message}`);
    else pass(`Deleted pro user ${proId}`);
  }

  if (custId) {
    const { error: e6 } = await sb.from('users').delete().eq('id', custId);
    if (e6) fail(`Delete customer user: ${e6.message}`);
    else pass(`Deleted customer user ${custId}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  PETclub Backend E2E — Booking Lifecycle`);
  console.log(`  Target:  ${BASE_URL}`);
  console.log(`  DB:      ${SUPABASE_URL}`);
  console.log(`  Run ID:  ${RUN_ID}`);
  console.log('══════════════════════════════════════════════════════════');

  // Verify server is reachable before seeding anything
  try {
    const { status } = await api('GET', '/api/health');
    if (status !== 200) throw new Error(`/api/health returned ${status}`);
    pass('Server health check OK');
  } catch (err) {
    console.error(`\n❌  Cannot reach ${BASE_URL}/api/health — is the server running?`);
    console.error(`    ${err.message}`);
    process.exit(1);
  }

  try {
    await setup();
    await testCreateBooking();
    await testRespondAccept();
    await testCancelBooking();
    await testAuthGuard();
  } finally {
    // Always tear down — even if a test throws
    await teardown().catch(err => console.error('Teardown error:', err));
  }

  console.log('\n══════════════════════════════════════════════════════════\n');
})();
