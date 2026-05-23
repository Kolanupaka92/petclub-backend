// ═══════════════════════════════════════════════════════════
//  PETclub India — Complete Backend API v1.0
//  Stack: Node.js + Express + Firebase Auth + Nodemailer (Zoho SMTP) + Supabase + JWT
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
const { version: API_VERSION } = require('./package.json');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const emailService = require('./services/emailService');

// ── Startup secret guard — refuse to boot without critical secrets ─────────
const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`\n❌ FATAL: Missing required environment variables: ${missingEnv.join(', ')}\nSet them in Cloud Run env vars and redeploy.\n`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Trust Cloud Run reverse proxy — needed for rate-limit & real IP
const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production' || !process.env.ALLOW_DEV_TOOLS;
const JWT_SECRET    = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';  // centralised — change via env var, not code
const WEB_APP_URL   = process.env.WEB_APP_URL   || 'https://app.mypetclub.app';
const WEBSITE_URL   = process.env.WEBSITE_URL   || 'https://mypetclub.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';
// Warn (don't crash) if optional-but-important vars use hardcoded fallbacks
if (!process.env.WEB_APP_URL)   console.warn('[Config] WEB_APP_URL not set — falling back to https://app.mypetclub.app');
if (!process.env.WEBSITE_URL)   console.warn('[Config] WEBSITE_URL not set — falling back to https://mypetclub.app');
if (!process.env.SUPPORT_EMAIL) console.warn('[Config] SUPPORT_EMAIL not set — falling back to support@mypetclub.app');

// ── Security helpers ───────────────────────────────────────
// Mask phone/email in logs — never log full PII
const maskPhone = p => (typeof p === 'string' && p.length > 6) ? `${p.slice(0, 4)}****${p.slice(-2)}` : '—';
const maskEmail = e => {
  if (!e || !e.includes('@')) return '—';
  const [local, domain] = e.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};
// Strip HTML tags from user inputs — prevents XSS in admin emails
const sanitize = s => typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim().slice(0, 2000) : s;

// ── Revenue split ─────────────────────────────────────────────────────────────
// PETclub takes 30%; provider earns 70%. Gateway fees are absorbed from our 30%.
// All computation is server-side only — clients never receive platform_fee.
// Override via env vars — no code change needed for business model adjustments.
const PLATFORM_RATE   = parseFloat(process.env.PLATFORM_RATE)        || 0.30;
const PROVIDER_RATE   = parseFloat(process.env.PROVIDER_RATE)        || 0.70;
// Gateway fee rates (absorbed by PETclub, never charged to provider)
const GW_PCT_USD      = parseFloat(process.env.GATEWAY_FEE_PCT_USD)  || 0.029;   // 2.9%
const GW_FLAT_USD     = parseFloat(process.env.GATEWAY_FEE_FLAT_USD) || 0.30;    // $0.30
const GW_PCT_INR      = parseFloat(process.env.GATEWAY_FEE_PCT_INR)  || 0.02;    // 2%
const GW_FLAT_INR     = parseFloat(process.env.GATEWAY_FEE_FLAT_INR) || 0.03;    // ₹0.03

function computeSplit(totalAmount, currency = 'INR') {
  const amt = parseFloat(totalAmount);
  if (!amt || isNaN(amt) || amt <= 0) return null;
  // Gateway fee absorbed by PETclub (comes out of our 30%, never from provider's cut)
  const gatewayFee = currency === 'USD'
    ? +(amt * GW_PCT_USD + GW_FLAT_USD).toFixed(2)
    : +(amt * GW_PCT_INR + GW_FLAT_INR).toFixed(2);
  return {
    total_amount:      +amt.toFixed(2),
    platform_fee:      +(amt * PLATFORM_RATE).toFixed(2),
    provider_earnings: +(amt * PROVIDER_RATE).toFixed(2),
    gateway_fee:       gatewayFee,
  };
}

// Role-based field stripping — never send platform economics to providers/customers
function stripFinancials(booking, role) {
  const b = { ...booking };
  if (role === 'professional') {
    // Provider sees their cut + payout status; nothing else
    delete b.total_amount;
    delete b.platform_fee;
    delete b.gateway_fee;
  } else if (role === 'customer') {
    // Customer sees what they paid; internal split is hidden
    delete b.platform_fee;
    delete b.provider_earnings;
    delete b.gateway_fee;
    delete b.payout_status;
    delete b.payout_reference;
  }
  // admin: full data — no deletions
  return b;
}

// ── Services ───────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Email — delegated to services/emailService.js ─────────────────────────
// SMTP config and all template rendering live in that module.
// Use emailService.sendRawEmail() for admin-internal notifications,
// or the named helpers (sendOtpEmail, sendWelcomeEmail, etc.) for
// user-facing transactional emails.

// ── Razorpay (India payment gateway) — live once RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET set ──
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    console.log('✅ Razorpay initialized (India payments live)');
  } catch (e) { console.warn('[Razorpay] Not loaded — run: npm install razorpay →', e.message); }
}

// ── Firebase Admin (FCM push notifications) — live once FIREBASE_SERVICE_ACCOUNT_JSON set ──
let firebaseAdmin = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const fbAdmin = require('firebase-admin');
    const svcAcct = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!fbAdmin.apps.length) fbAdmin.initializeApp({ credential: fbAdmin.credential.cert(svcAcct) });
    firebaseAdmin = fbAdmin;
    console.log('✅ Firebase Admin initialized (push notifications live)');
  } catch (e) { console.warn('[Firebase] Not initialized — run: npm install firebase-admin →', e.message); }
}

// ── Middleware ─────────────────────────────────────────
// Security headers — disable CSP so JSON API clients aren't affected
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

const ALLOWED_ORIGINS = [
  WEB_APP_URL,
  WEBSITE_URL,
  `https://www.${new URL(WEBSITE_URL).hostname}`,
  process.env.FRONTEND_URL,
  // Localhost allowed in dev only (set ALLOW_DEV_TOOLS=true in local .env)
  ...(IS_PROD ? [] : ['http://localhost:5173','http://localhost:5174','http://localhost:4173']),
].filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false) }));
app.use(express.json({ limit: '10mb' }));

// ── Request ID + timing logger ─────────────────────────────
app.use((req, res, next) => {
  req.id = Math.random().toString(36).slice(2, 10).toUpperCase();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.id);
  res.on('finish', () => {
    const ms = Date.now() - req.startTime;
    const lvl = res.statusCode >= 500 ? '🔴' : res.statusCode >= 400 ? '🟡' : '🟢';
    if (!req.path.includes('/health')) {
      console.log(`${lvl} [${req.id}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});
// Global rate limit — returns proper JSON
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' }),
}));
// OTP send rate limit — max 5 sends per minute per IP
const otpLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many OTP requests. Please wait 1 minute and try again.' }),
});
// Auth verify rate limit — max 10 attempts per 15 min per IP (prevents brute-force)
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' }),
});

// ── Helpers ────────────────────────────────────────────
const genOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Login required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired. Please login again.' }); }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};


// ── Push Notification via Firebase Cloud Messaging ────────────────────────────
const sendPush = async (fcmToken, title, body, data = {}) => {
  if (!firebaseAdmin || !fcmToken) return;
  try {
    await firebaseAdmin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'default', channelId: 'petclub_bookings' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    console.log(`[FCM] Push sent → ${fcmToken.slice(0, 20)}…`);
  } catch (e) { console.warn('[FCM] Send failed:', e.message); }
};

// ── SMS via Twilio ────────────────────────────────────────────────────────────
const _twilioSid   = process.env.TWILIO_ACCOUNT_SID;
const _twilioToken = process.env.TWILIO_AUTH_TOKEN;
const _twilioFrom  = process.env.TWILIO_PHONE_NUMBER;
const _twilioReady = Boolean(_twilioSid && _twilioToken && _twilioFrom);
let _twilioClient  = null;
if (_twilioReady) {
  try {
    const twilio = require('twilio');
    _twilioClient = twilio(_twilioSid, _twilioToken);
    console.info('[Twilio] SMS client initialised — from:', _twilioFrom);
  } catch (e) {
    console.error('[Twilio] Failed to init client:', e.message);
  }
} else {
  console.warn('[Twilio] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER not set — SMS disabled');
}

const sendSMS = async (phone, message) => {
  if (!_twilioClient) {
    console.warn(`[SMS disabled] To: ${maskPhone(phone)} | Msg: ${message.slice(0, 80)}`);
    return;
  }
  await _twilioClient.messages.create({ body: message, from: _twilioFrom, to: phone });
  console.info(`[SMS] Sent to ${maskPhone(phone)}`);
};

// ── FCM push alias — normalises call-site signature differences ───────────────
const sendPushNotification = async (fcmToken, title, body) => sendPush(fcmToken, title, body);

// Backward-compatible alias — all existing admin/internal sendEmail(to, subject, html)
// callsites continue to work unchanged. New user-facing emails use named helpers below.
const sendEmail = emailService.sendRawEmail;

// ══════════════════════════════════════════════════════
//  STORAGE: init id-documents bucket on startup
// ══════════════════════════════════════════════════════
(async () => {
  try {
    // PRIVATE bucket — ID documents (Aadhar, PAN, Passport) must never be publicly accessible
    await supabase.storage.createBucket('id-documents', { public: false });
    console.log('✅ Storage bucket ready: id-documents');
  } catch (e) {
    if (!e.message?.includes('already exists') && !String(e).includes('already exists')) {
      console.error('Storage bucket init:', e.message || e);
    }
  }
})();

// ══════════════════════════════════════════════════════
//  BOOKING TIMEOUT CRON — runs every 2 minutes
//  (also runs lazily on booking API calls as a safety net)
// ══════════════════════════════════════════════════════
setInterval(() => {
  processTimedOutAssignments().catch(e => console.error('[Cron] Booking timeout check failed:', e.message));
}, 2 * 60 * 1000);

// ══════════════════════════════════════════════════════
//  SUSPENDED USER AUTO-DELETE CRON — runs every hour
//  Deletes users suspended >24 hrs ago (no restore since).
//  Sends admin an email summary before deletion.
// ══════════════════════════════════════════════════════
const autoDeleteSuspendedUsers = async () => {
  try {
    // Find the latest suspend_user log per user
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: logs } = await supabase
      .from('admin_logs')
      .select('target_id, created_at')
      .eq('action', 'suspend_user')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: false });

    if (!logs?.length) return;

    // Unique user IDs with a suspension older than 24 hr
    const candidateIds = [...new Set(logs.map(l => l.target_id))];

    // Exclude any that have been restored after the suspension
    const { data: restoreLogs } = await supabase
      .from('admin_logs')
      .select('target_id, created_at')
      .eq('action', 'restore_user')
      .in('target_id', candidateIds);

    // Build map: userId → latest restore timestamp
    const latestRestore = {};
    restoreLogs?.forEach(l => {
      if (!latestRestore[l.target_id] || l.created_at > latestRestore[l.target_id])
        latestRestore[l.target_id] = l.created_at;
    });

    // Build map: userId → latest suspension timestamp
    const latestSuspend = {};
    logs.forEach(l => {
      if (!latestSuspend[l.target_id] || l.created_at > latestSuspend[l.target_id])
        latestSuspend[l.target_id] = l.created_at;
    });

    // Only delete if latest suspension > 24hr ago AND no restore after it
    const toDeleteIds = candidateIds.filter(id => {
      const suspended = latestSuspend[id];
      const restored  = latestRestore[id];
      if (!suspended) return false;
      if (suspended >= cutoff) return false;        // suspended < 24hr ago
      if (restored && restored > suspended) return false; // restored after suspension
      return true;
    });

    if (!toDeleteIds.length) return;

    // Fetch user details for the email
    const { data: toDelete } = await supabase
      .from('users')
      .select('id, name, phone, email, role')
      .in('id', toDeleteIds)
      .eq('is_active', false);

    if (!toDelete?.length) return;

    // Send admin email BEFORE deletion
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const rows = toDelete.map(u =>
        `<tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 12px;font-size:13px">${u.name || '—'}</td>
          <td style="padding:8px 12px;font-size:13px">${u.phone}</td>
          <td style="padding:8px 12px;font-size:13px">${u.email || '—'}</td>
          <td style="padding:8px 12px;font-size:13px;text-transform:capitalize">${u.role}</td>
        </tr>`
      ).join('');
      await sendEmail(
        adminEmail,
        `🗑️ PETclub — ${toDelete.length} Suspended User(s) Auto-Deleted`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">🗑️</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">Auto-Deletion Complete</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 24px">The following user(s) were suspended &gt;24 hours ago and have been permanently deleted.</p>
          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden">
            <thead><tr style="background:#fee2e2">
              <th style="padding:10px 12px;font-size:12px;color:#991b1b;text-align:left">Name</th>
              <th style="padding:10px 12px;font-size:12px;color:#991b1b;text-align:left">Phone</th>
              <th style="padding:10px 12px;font-size:12px;color:#991b1b;text-align:left">Email</th>
              <th style="padding:10px 12px;font-size:12px;color:#991b1b;text-align:left">Role</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:12px;text-align:center">PETclub Admin · ${new Date().toLocaleString('en-IN')} · These accounts are permanently removed from the database.</p>
        </div>`
      ).catch(e => console.error('[AutoDelete] Email failed:', e.message));
    }

    // Delete related records then users
    const idsToDelete = toDelete.map(u => u.id);
    await supabase.from('professional_profiles').delete().in('user_id', idsToDelete);
    await supabase.from('customer_profiles').delete().in('user_id', idsToDelete).catch(() => {});
    await supabase.from('pets').delete().in('owner_id', idsToDelete).catch(() => {});
    await supabase.from('otp_tokens').delete().in('phone', toDelete.map(u => u.phone)).catch(() => {});
    await supabase.from('admin_logs').delete().in('target_id', idsToDelete);
    await supabase.from('users').delete().in('id', idsToDelete);

    console.log(`[AutoDelete] Deleted ${idsToDelete.length} suspended users: ${idsToDelete.join(', ')}`);
  } catch (e) {
    console.error('[AutoDelete] Cron error:', e.message);
  }
};

setInterval(() => {
  autoDeleteSuspendedUsers().catch(e => console.error('[Cron] Auto-delete suspended users failed:', e.message));
}, 60 * 60 * 1000); // every hour

// ── Expired OTP cleanup — runs every hour ─────────────────
// Prevents otp_tokens table accumulating verified/expired codes
setInterval(async () => {
  try {
    const { count } = await supabase.from('otp_tokens')
      .delete({ count: 'exact' }).lt('expires_at', new Date().toISOString());
    if (count > 0) console.log(`[OTP Cleanup] Purged ${count} expired token(s)`);
  } catch (e) { console.warn('[OTP Cleanup] Failed:', e.message); }
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════
//  BOOKING DISPATCH SYSTEM — Round-Robin / Uber-style
// ══════════════════════════════════════════════════════
const RESPONSE_TIMEOUT_MINS = parseInt(process.env.BOOKING_RESPONSE_TIMEOUT_MINS) || 5;

// Round-robin: find next eligible professional (not already tried for this booking)
const DISPATCH_RADIUS_KM = parseFloat(process.env.DISPATCH_RADIUS_KM) || 70; // Max dispatch radius

const findNextPro = async (city, subRole, excludeProIds = [], bookingLat = null, bookingLng = null) => {
  let q = supabase
    .from('professional_profiles')
    .select('id, user_id, last_assigned_at, address_lat, address_lng, users(name, phone, email)')
    .eq('verification_status', 'approved')
    .eq('is_available', true)
    .eq('sub_role', subRole);

  // If booking has GPS coords, fetch broader pool for GPS radius filter.
  // Otherwise fall back to city-name match.
  if (!bookingLat || !bookingLng) {
    if (city) q = q.ilike('city', `%${city}%`);
  }
  // Exclude pros who already got this booking and rejected / timed out
  for (const xid of excludeProIds) q = q.neq('id', xid);
  const { data: allPros } = await q;
  if (!allPros || allPros.length === 0) return null;

  let pros = allPros;
  // GPS radius filter: keep pros within 70km of booking address
  if (bookingLat && bookingLng) {
    const inRadius = allPros.filter(p => {
      if (!p.address_lat || !p.address_lng) return false; // no GPS → exclude from GPS dispatch
      return haversineKm(bookingLat, bookingLng, p.address_lat, p.address_lng) <= DISPATCH_RADIUS_KM;
    });
    // Fall back to city-name match if no GPS-verified pros in radius
    pros = inRadius.length > 0 ? inRadius
      : allPros.filter(p => !city || (p.city && p.city.toLowerCase().includes(city.toLowerCase())));
  }
  if (!pros.length) return null;

  // Sort: never-assigned first (null last_assigned_at), then oldest assignment = fair rotation
  pros.sort((a, b) => {
    if (!a.last_assigned_at && !b.last_assigned_at) return 0;
    if (!a.last_assigned_at) return -1;
    if (!b.last_assigned_at) return 1;
    return new Date(a.last_assigned_at) - new Date(b.last_assigned_at);
  });
  return pros[0];
};

// Offer a booking to a specific professional + send email/SMS notification
const offerBookingToPro = async (bookingId, pro, bookingDetails) => {
  const deadline = new Date(Date.now() + RESPONSE_TIMEOUT_MINS * 60 * 1000).toISOString();
  await supabase.from('booking_assignments').upsert({
    booking_id: bookingId, professional_id: pro.id,
    status: 'offered', offered_at: new Date().toISOString(), response_deadline: deadline,
  }, { onConflict: 'booking_id, professional_id' });
  await supabase.from('bookings').update({
    professional_id: pro.id, assignment_status: 'offered', response_deadline: deadline,
  }).eq('id', bookingId);
  await supabase.from('professional_profiles').update({ last_assigned_at: new Date().toISOString() }).eq('id', pro.id);

  const svc      = bookingDetails.service_name || bookingDetails.service_type || 'Service';
  const petName  = bookingDetails.pet_name || 'Pet';
  const petHealthNotes = bookingDetails.pet_health_notes || null;
  const dateStr  = bookingDetails.scheduled_at
    ? new Date(bookingDetails.scheduled_at).toLocaleString('en-IN', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
    : 'TBD';
  const location = bookingDetails.city || bookingDetails.address || 'TBD';
  const custNotes = bookingDetails.notes || null;
  const proPhone = pro.users?.phone;
  const proEmail = pro.users?.email;

  const healthNoteRow = petHealthNotes
    ? `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">⚕️ Health Notes</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#991b1b;font-weight:600">${sanitize(petHealthNotes)}</td></tr>`
    : '';
  const custNotesRow = custNotes
    ? `<tr><td style="padding:8px 0;font-size:12px;color:#94a3b8;width:38%">💬 Customer Note</td><td style="padding:8px 0;font-size:13px;color:#1e293b">${sanitize(custNotes)}</td></tr>`
    : '';

  const notifHtml = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #f1f5f9;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:28px 24px;text-align:center;">
        <div style="font-size:40px;margin-bottom:8px">🐾</div>
        <h2 style="color:white;margin:0;font-size:20px;font-weight:800">New Booking Request!</h2>
        <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px">You have <strong>${RESPONSE_TIMEOUT_MINS} minutes</strong> to respond</p>
      </div>
      <div style="padding:24px;">
        <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:12px;padding:14px;margin-bottom:20px;text-align:center;">
          <div style="font-size:28px;margin-bottom:4px">⏱️</div>
          <div style="font-size:24px;font-weight:900;color:#c2410c;font-family:monospace">${RESPONSE_TIMEOUT_MINS}:00</div>
          <div style="font-size:12px;color:#9a3412;margin-top:4px">minutes to Accept or Reject</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">Service</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${svc}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">🐾 Pet</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${petName}</td></tr>
          ${healthNoteRow}
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">📅 Date & Time</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${dateStr}</td></tr>
          <tr><td style="padding:8px 0;${custNotesRow ? 'border-bottom:1px solid #f1f5f9;' : ''}font-size:12px;color:#94a3b8">📍 Location</td><td style="padding:8px 0;${custNotesRow ? 'border-bottom:1px solid #f1f5f9;' : ''}font-size:14px;font-weight:700;color:#1e293b">${location}</td></tr>
          ${custNotesRow}
        </table>
        ${petHealthNotes ? `<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:12px 16px;margin-bottom:16px;"><p style="margin:0;font-size:12px;font-weight:700;color:#991b1b;">⚕️ Please read the health notes above before the appointment.</p></div>` : ''}
        <div style="text-align:center;margin-bottom:16px;">
          <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;padding:14px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;">✅ Open App to Respond</a>
        </div>
        <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0;">No response in ${RESPONSE_TIMEOUT_MINS} mins → request auto-passes to next professional</p>
      </div>
    </div>`;

  if (proEmail) {
    sendEmail(proEmail, `🐾 New Booking Request — ${svc} · Respond in ${RESPONSE_TIMEOUT_MINS} min`, notifHtml).catch(console.error);
  }
  // FCM push notification to professional
  const { data: proUser } = await Promise.resolve(supabase.from('users').select('fcm_token').eq('id', pro.user_id).single()).catch(() => ({ data: null }));
  if (proUser?.fcm_token) {
    sendPush(proUser.fcm_token, `🐾 New ${svc} Request!`, `${petName} · ${dateStr} · Respond in ${RESPONSE_TIMEOUT_MINS} min`, { bookingId: bookingId, type: 'new_booking' }).catch(() => {});
  }
};

// Process timed-out offers (lazy eval — called on booking endpoints)
const processTimedOutAssignments = async () => {
  const { data: timedOut } = await supabase
    .from('booking_assignments')
    .select('*, bookings(*)')
    .eq('status', 'offered')
    .lt('response_deadline', new Date().toISOString());
  if (!timedOut?.length) return;

  for (const assignment of timedOut) {
    await supabase.from('booking_assignments')
      .update({ status: 'timed_out', responded_at: new Date().toISOString() }).eq('id', assignment.id);
    const bk = assignment.bookings;
    if (!bk || bk.assignment_status === 'confirmed') continue;
    // Fetch all previously tried pros for this booking
    const { data: tried } = await supabase.from('booking_assignments').select('professional_id')
      .eq('booking_id', assignment.booking_id).in('status', ['rejected', 'timed_out', 'accepted']);
    const excludeIds = tried?.map(r => r.professional_id) || [];
    // Get pet name + health notes for notification
    let petName = 'Pet', petHealthNotes = null;
    if (bk.pet_id) {
      const { data: pet } = await supabase.from('pets').select('name, health_notes').eq('id', bk.pet_id).single();
      petName = pet?.name || 'Pet';
      petHealthNotes = pet?.health_notes || null;
    }
    const nextPro = await findNextPro(bk.city || '', bk.service_type || '', excludeIds, bk.address_lat, bk.address_lng);
    if (nextPro) {
      await offerBookingToPro(assignment.booking_id, nextPro, { ...bk, pet_name: petName, pet_health_notes: petHealthNotes });
    } else {
      await supabase.from('bookings').update({ assignment_status: 'no_pros_available', professional_id: null }).eq('id', assignment.booking_id);
    }
  }
};

// ══════════════════════════════════════════════════════
//  AUTH: LEGACY OTP ENDPOINTS — REMOVED
//  Replaced by:
//    Phone → Firebase Phone Auth → POST /auth/firebase-verify
//    Email → POST /auth/send-email-otp + POST /auth/verify-email-otp
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-otp', (req, res) => res.status(410).json({
  error: 'This endpoint has been removed. Use Firebase Phone Auth (app) or /auth/send-email-otp for email login.',
}));
app.post('/api/auth/verify-otp', (req, res) => res.status(410).json({
  error: 'This endpoint has been removed. Use /auth/firebase-verify (phone) or /auth/verify-email-otp (email).',
}));

// ══════════════════════════════════════════════════════
//  AUTH: FIREBASE PHONE AUTH — verify ID token → issue JWT
//  Frontend sends Firebase ID token after successful phone OTP.
//  We verify it with Firebase Admin, then find/create the user
//  in Supabase and return our own JWT (same shape as verify-otp).
// ══════════════════════════════════════════════════════
app.post('/api/auth/firebase-verify', authLimit, async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Firebase ID token required' });
    if (!firebaseAdmin) return res.status(503).json({ error: 'Firebase not configured on server' });

    // Verify token with Firebase Admin SDK
    let decoded;
    try {
      decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      console.error('[FirebaseVerify] Token invalid:', e.message);
      return res.status(401).json({ error: 'Invalid or expired token. Please try again.' });
    }

    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ error: 'No phone number in Firebase token' });

    // Find or create user (same logic as /auth/verify-otp)
    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    const isNew = !user;
    if (!user) {
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ phone, role: 'pending_role', is_active: true })
        .select()
        .single();
      if (insertErr) {
        console.error('[FirebaseVerify] User insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create user. Try again.' });
      }
      user = nu;
      // Notify admin of new signup
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `🐾 New PETclub Signup — ${phone}`,
          `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff;border-radius:16px;border:2px solid #f97316;">
            <h2 style="color:#f97316;margin:0 0 12px">🐾 New User Signed Up</h2>
            <p style="margin:4px 0;color:#1e293b;font-size:14px"><strong>Phone:</strong> ${phone}</p>
            <p style="margin:4px 0;color:#64748b;font-size:13px">Role not yet set — awaiting profile setup.</p>
            <hr style="border:none;border-top:1px solid #f1f5f9;margin:16px 0"/>
            <p style="color:#94a3b8;font-size:12px">PETclub Admin · ${new Date().toLocaleString('en-IN')}</p>
          </div>`
        ).catch(() => {});
      }
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: `Your account has been suspended. Contact ${SUPPORT_EMAIL}` });
    }

    // For professionals, include verification status + sub_role
    let verificationStatus = null;
    let subRole = null;
    if (user.role === 'professional') {
      const { data: prof } = await supabase
        .from('professional_profiles')
        .select('verification_status, sub_role')
        .eq('user_id', user.id)
        .single();
      verificationStatus = prof?.verification_status || 'pending';
      subRole = prof?.sub_role || null;
    }

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    console.log(`[FirebaseVerify] ${isNew ? 'New' : 'Returning'} user: ${maskPhone(phone)}`);
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    console.error('[FirebaseVerify] Unexpected error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: EMAIL OTP — send (for users without phone access)
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-email-otp', otpLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email address required' });

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();

    // Store OTP keyed by email (reuse otp_tokens table, email as phone field)
    await supabase.from('otp_tokens').upsert(
      { phone: email.toLowerCase(), otp, expires_at: expires, verified: false },
      { onConflict: 'phone' }
    );

    await emailService.sendOtpEmail(email, { otp, expiresMinutes: 10 });
    console.log(`[EmailOTP] Sent to ${email}`);
    res.json({ success: true, message: `OTP sent to ${email}` });
  } catch (err) {
    console.error('[EmailOTP] Send error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Check your email address and try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: EMAIL OTP — verify → issue JWT
// ══════════════════════════════════════════════════════
app.post('/api/auth/verify-email-otp', authLimit, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const key = email.toLowerCase();
    const { data: rec } = await supabase.from('otp_tokens').select('*').eq('phone', key).single();
    if (!rec) return res.status(400).json({ error: 'OTP not found. Request a new one.' });
    if (rec.verified) return res.status(400).json({ error: 'OTP already used.' });
    if (new Date() > new Date(rec.expires_at)) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (rec.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP.' });

    await supabase.from('otp_tokens').update({ verified: true }).eq('phone', key);

    // Find user by email; fall back to creating email-only account
    let { data: user } = await supabase.from('users').select('*').eq('email', key).single();
    const isNew = !user;
    if (!user) {
      // phone column is NOT NULL — use a unique placeholder for email-only accounts
      const emailPhone = `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ email: key, phone: emailPhone, role: 'pending_role', is_active: true })
        .select()
        .single();
      if (insertErr) {
        console.error('[EmailOTP] Insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create account. Try again.' });
      }
      user = nu;
      // Admin notification for new email signup
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `🐾 New PETclub Signup (Email) — ${email}`,
          `<p style="font-family:Arial,sans-serif">New user signed up via email OTP: <strong>${email}</strong><br/>Role not yet set.</p>`
        ).catch(() => {});
      }
    }

    if (user.is_active === false)
      return res.status(403).json({ error: `Your account has been suspended. Contact ${SUPPORT_EMAIL}` });

    let verificationStatus = null;
    let subRole = null;
    if (user.role === 'professional') {
      const { data: prof } = await supabase
        .from('professional_profiles').select('verification_status, sub_role').eq('user_id', user.id).single();
      verificationStatus = prof?.verification_status || 'pending';
      subRole = prof?.sub_role || null;
    }

    const token = jwt.sign({ id: user.id, phone: user.phone || null, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    console.log(`[EmailOTP] ${isNew ? 'New' : 'Returning'} user: ${maskEmail(email)}`);
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    console.error('[EmailOTP] Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: PHONE OTP via Twilio SMS (replaces Firebase reCAPTCHA)
//  POST /api/auth/send-phone-otp   { phone: '+91XXXXXXXXXX' }
//  POST /api/auth/verify-phone-otp { phone, otp }
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-phone-otp', otpLimit, async (req, res) => {
  try {
    const { phone, email: fallbackEmail } = req.body;
    if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone))
      return res.status(400).json({ error: 'Valid E.164 phone number required (e.g. +14155552671)' });

    if (!_twilioClient)
      return res.status(503).json({ error: 'SMS service not configured. Please use Email OTP to sign in.' });

    const otp  = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();

    await supabase.from('otp_tokens').upsert(
      { phone: phone, otp, expires_at: expires, verified: false },
      { onConflict: 'phone' }
    );

    // ── Try SMS first, fall back to email if SMS fails ──────────────────────
    try {
      await sendSMS(phone, `Your PETclub OTP is: ${otp}  Valid 10 min. Do not share.`);
      console.log(`[PhoneOTP] SMS sent to ${maskPhone(phone)}`);
      return res.json({ success: true, via: 'sms', message: `OTP sent via SMS to ${phone}` });
    } catch (smsErr) {
      console.warn(`[PhoneOTP] SMS failed (${smsErr.code || smsErr.message}) — trying email fallback`);

      // Resolve email: use request-provided email, or look up from existing user record
      let deliveryEmail = fallbackEmail;
      if (!deliveryEmail) {
        const { data: existing } = await supabase.from('users').select('email').eq('phone', phone).maybeSingle();
        deliveryEmail = existing?.email || null;
      }

      if (deliveryEmail && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(deliveryEmail)) {
        try {
          await emailService.sendRawEmail(
            deliveryEmail,
            `🔐 Your PETclub OTP Code`,
            `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
              <div style="font-size:40px;text-align:center;margin-bottom:12px">🔐</div>
              <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">Your PETclub OTP</h2>
              <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">SMS delivery failed — your OTP has been sent to this email instead.</p>
              <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:14px;padding:24px;text-align:center">
                <span style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ea580c;font-family:monospace">${otp}</span>
              </div>
              <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">Valid for 10 minutes · Do not share</p>
              <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
              <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub · ${new Date().toLocaleString('en-IN')}</p>
            </div>`
          );
          console.log(`[PhoneOTP] Email fallback sent to ${deliveryEmail} for ${maskPhone(phone)}`);
          return res.json({ success: true, via: 'email', email: deliveryEmail, message: `SMS unavailable — OTP sent to ${deliveryEmail}` });
        } catch (emailErr) {
          console.error('[PhoneOTP] Email fallback also failed:', emailErr.message);
        }
      }

      // Both SMS and email failed — surface the original SMS error
      if (smsErr.code === 21211 || (smsErr.message || '').includes('not a valid phone number'))
        return res.status(400).json({ error: 'Invalid phone number. Check the country code and digits.' });
      if (smsErr.code === 21608 || (smsErr.message || '').includes('unverified'))
        return res.status(400).json({ error: 'This number is not yet reachable via SMS. Please use Email OTP to sign in.' });
      return res.status(500).json({ error: 'Failed to send OTP via SMS or email. Please use Email OTP to sign in.' });
    }
  } catch (err) {
    console.error('[PhoneOTP] Unexpected error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Try Email OTP instead.' });
  }
});

app.post('/api/auth/verify-phone-otp', authLimit, async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    const { data: rec } = await supabase.from('otp_tokens').select('*').eq('phone', phone).single();
    if (!rec)           return res.status(400).json({ error: 'OTP not found. Request a new one.' });
    if (rec.verified)   return res.status(400).json({ error: 'OTP already used.' });
    if (new Date() > new Date(rec.expires_at)) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (rec.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP. Check your SMS and try again.' });

    await supabase.from('otp_tokens').update({ verified: true }).eq('phone', phone);

    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    const isNew = !user;
    if (!user) {
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ phone, role: 'pending_role', is_active: true })
        .select().single();
      if (insertErr) {
        console.error('[PhoneOTP] Insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create account. Try again.' });
      }
      user = nu;
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `🐾 New PETclub Signup (Phone) — ${maskPhone(phone)}`,
          `<p style="font-family:Arial,sans-serif">New user signed up via phone OTP: <strong>${phone}</strong></p>`
        ).catch(() => {});
      }
    }

    if (user.is_active === false)
      return res.status(403).json({ error: `Your account has been suspended. Contact ${SUPPORT_EMAIL}` });

    let verificationStatus = null;
    let subRole = null;
    if (user.role === 'professional') {
      const { data: prof } = await supabase
        .from('professional_profiles').select('verification_status, sub_role').eq('user_id', user.id).single();
      verificationStatus = prof?.verification_status || 'pending';
      subRole = prof?.sub_role || null;
    }

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    console.log(`[PhoneOTP] ${isNew ? 'New' : 'Returning'} user: ${maskPhone(phone)}`);
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    console.error('[PhoneOTP] Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: SET ROLE (called once for new users)
// ══════════════════════════════════════════════════════
app.post('/api/users/set-role', auth, async (req, res) => {
  try {
    const { role, subRole } = req.body;
    // Sanitize all text inputs to strip HTML and limit length
    const name    = sanitize(req.body.name);
    const email   = sanitize(req.body.email);
    const city    = sanitize(req.body.city);
    const address = sanitize(req.body.address);
    const pet     = req.body.pet ? { ...req.body.pet, name: sanitize(req.body.pet.name), breed: sanitize(req.body.pet.breed) } : undefined;
    // GPS address metadata (from AddressPicker)
    const addressLat        = typeof req.body.addressLat  === 'number' ? req.body.addressLat  : null;
    const addressLng        = typeof req.body.addressLng  === 'number' ? req.body.addressLng  : null;
    const addressPostalCode = sanitize(req.body.addressPostalCode) || null;
    const addressCity       = sanitize(req.body.addressCity)       || null;
    const addressState      = sanitize(req.body.addressState)      || null;
    const validRoles = ['customer', 'professional'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Role must be customer or professional' });

    // Infer country from phone prefix
    const phoneCountry = req.user.phone?.startsWith('+1') ? 'United States'
      : req.user.phone?.startsWith('+91') ? 'India' : null;

    // Update user record
    await supabase.from('users').update({ role, name: name || null, email: email || null }).eq('id', req.user.id);

    if (role === 'professional') {
      if (!['Groomer', 'Trainer', 'Vet'].includes(subRole))
        return res.status(400).json({ error: 'subRole must be Groomer, Trainer, or Vet' });
      await supabase.from('professional_profiles').upsert({
        user_id: req.user.id, sub_role: subRole, verification_status: 'pending',
        is_available: false, city: city || null, address: address || null,
      }, { onConflict: 'user_id' });
      // Store GPS coords in separate update (graceful: requires GPS migration to have run)
      if (addressLat && addressLng) {
        supabase.from('professional_profiles').update({
          address_lat: addressLat, address_lng: addressLng,
          address_postal_code: addressPostalCode,
          address_city: addressCity, address_state: addressState,
        }).eq('user_id', req.user.id).then(({ error }) => {
          if (error) console.error('pro GPS coords update:', error.message);
        });
      }
    }

    if (role === 'customer') {
      try {
        await supabase.from('customer_profiles').upsert({
          user_id: req.user.id, address: address || null, city: city || null,
          country: phoneCountry,
        }, { onConflict: 'user_id' });
      } catch (e) { console.error('customer_profiles upsert:', e.message); }
      // Store GPS coords in separate update (graceful: requires GPS migration to have run)
      if (addressLat && addressLng) {
        supabase.from('customer_profiles').update({
          address_lat: addressLat, address_lng: addressLng,
          address_postal_code: addressPostalCode,
          address_city: addressCity, address_state: addressState,
        }).eq('user_id', req.user.id).then(({ error }) => {
          if (error) console.error('customer GPS coords update:', error.message);
        });
      }
    }

    // For customers — create initial pet if provided
    if (role === 'customer' && pet?.name) {
      try {
        await supabase.from('pets').insert({
          owner_id: req.user.id,
          name: pet.name,
          species: pet.species || null,
          breed: pet.breed || null,
          age: pet.age ? parseInt(pet.age) : null,
          gender: pet.gender || null,
          dob: pet.dob || null,
        });
      } catch (e) { console.error('Initial pet creation error:', e.message); }
    }

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const verificationStatus = role === 'professional' ? 'pending' : null;
    // subRole already defined above from req.body

    // Send welcome email (non-blocking)
    const fn = (name || 'there').split(' ')[0];
    if (email) {
      const isPro = role === 'professional';
      if (isPro) {
        // Professional: role-assignment email (under-review messaging)
        emailService.sendRoleAssignedEmail(email, { name, role, subRole })
          .catch(e => console.error('[Email] Role-assigned email failed:', e.message));
      } else {
        // Customer: welcome email with optional pet card
        emailService.sendWelcomeEmail(email, { name, pet })
          .catch(e => console.error('[Email] Welcome email failed:', e.message));
      }
    }

    res.json({ success: true, token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus, subRole: role === 'professional' ? subRole : null } });
  } catch (err) {
    console.error('Set role error:', err.message);
    res.status(500).json({ error: 'Failed to set role.' });
  }
});

// ══════════════════════════════════════════════════════
//  CONTACT: SEND APP LINK (website form)
// ══════════════════════════════════════════════════════
app.post('/api/contact/send-link', async (req, res) => {
  try {
    const { name, phone, email, city, pettype, service, pet, message } = req.body;
    if (!phone || !email || !name) return res.status(400).json({ error: 'Name, phone and email required' });

    const fn = name.split(' ')[0];
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
    const fullLeadPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    const isInquiry = ['Pet Food', 'Pet Boarding'].includes(service);


    if (isInquiry) {
      // ── Inquiry confirmation to user ──
      const svcIcon = service === 'Pet Food' ? '🍖' : '🏠';
      const svcColor = service === 'Pet Food' ? '#16a34a' : '#f97316';
      await sendEmail(email, `${svcIcon} Your ${service} Inquiry — PETclub Will Reach Out ASAP`, `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:linear-gradient(135deg,${svcColor},${svcColor}cc);padding:36px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">${svcIcon}</div>
            <h1 style="color:white;margin:0;font-size:24px;font-weight:800">Inquiry Received!</h1>
            <p style="color:rgba(255,255,255,0.88);margin:8px 0 0;font-size:15px">${service} · PETclub</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <b>${fn}</b>! 👋</p>
            <p style="color:#475569;font-size:15px;margin:0 0 20px;line-height:1.6">
              Thanks for your interest in <b>${service}</b>! We've received your inquiry and our team will reach out to you at <b>${email}</b> within <b>24 hours</b>.
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin-bottom:24px;">
              <p style="color:#64748b;font-weight:700;margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Your Request</p>
              <p style="color:#1e293b;font-size:14px;margin:0;line-height:1.7;white-space:pre-wrap;">${message || '(No details provided)'}</p>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:14px;padding:16px;margin-bottom:24px;text-align:center;">
              <p style="color:#c2410c;font-size:14px;margin:0;font-weight:600">⏱ Response within 24 hours<br/>📧 Reach us anytime: <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;">${SUPPORT_EMAIL}</a></p>
            </div>
            <div style="text-align:center;">
              <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;">Explore PETclub App →</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;">
            © ${new Date().getFullYear()} PETclub · For pets, with love 🐾
          </div>
        </div>`);

      // ── Admin notification ──
      if (adminEmail) {
        sendEmail(adminEmail, `🔔 [${service} Inquiry] ${name} · ${email}`, `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:16px;border:2px solid ${svcColor};overflow:hidden;">
            <div style="background:${svcColor};padding:20px 24px;">
              <h2 style="color:#fff;margin:0;font-size:18px;">${svcIcon} New ${service} Inquiry</h2>
              <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">Action required — reach out within 24 hours</p>
            </div>
            <div style="padding:24px;">
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px 0;color:#64748b;width:80px;">Name</td><td style="padding:6px 0;font-weight:700;color:#1e293b;">${name}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">Email</td><td style="padding:6px 0;color:#1e293b;"><a href="mailto:${email}" style="color:#f97316;">${email}</a></td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">Phone</td><td style="padding:6px 0;color:#1e293b;">${fullLeadPhone}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">City</td><td style="padding:6px 0;color:#1e293b;">${city || '—'}</td></tr>
              </table>
              <hr style="border:none;border-top:1px solid #f1f5f9;margin:16px 0;" />
              <p style="color:#64748b;font-size:13px;font-weight:700;margin:0 0 8px;">Their Request:</p>
              <div style="background:#f8fafc;border-radius:10px;padding:14px;color:#1e293b;font-size:14px;line-height:1.7;white-space:pre-wrap;">${message || '(No details provided)'}</div>
            </div>
          </div>`
        ).catch(e => console.error('[Inquiry] Admin notify failed:', e.message));
      }
    } else {
      // ── Regular signup welcome email ──
      await sendEmail(email, `🐾 Welcome to PETclub, ${fn}!`, `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:linear-gradient(135deg,#f97316,#fbbf24);padding:40px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">🐾</div>
            <h1 style="color:white;margin:0;font-size:26px;font-weight:800">Welcome to PETclub!</h1>
            <p style="color:rgba(255,255,255,0.88);margin:8px 0 0;font-size:15px">India's #1 pet care platform</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1e293b;font-size:16px;margin:0 0 20px">Hi <b>${fn}</b>! 🎉 You're all set. Book ${service||'grooming, training & vet care'} for ${pet||'your pet'} in ${city||'your city'} — right from your browser.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:16px 36px;border-radius:14px;text-decoration:none;font-weight:800;font-size:16px;letter-spacing:0.3px;">🚀 Open PETclub App</a>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:14px;padding:20px;margin-bottom:20px;">
              <p style="color:#c2410c;font-weight:700;margin:0 0 10px;font-size:14px">🌟 What you can do:</p>
              <ul style="color:#64748b;line-height:2;margin:0;padding-left:18px;font-size:14px">
                <li>Book grooming, training, vet visits & more</li>
                <li>Manage your pet's health records digitally</li>
                <li>Track service professionals in real time</li>
                <li>🛡️ ₹25,000 service protection guarantee</li>
              </ul>
            </div>
            <div style="background:#f8fafc;border-radius:12px;padding:16px;text-align:center;">
              <p style="color:#64748b;font-size:13px;margin:0">📱 <b>Native mobile apps coming soon</b> for iOS & Android.<br/>Until then, our web app works great on any device!</p>
            </div>
          </div>
          <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;">
            © ${new Date().getFullYear()} PETclub · For pets, with love 🐾 · <a href="${WEBSITE_URL}" style="color:#f97316;text-decoration:none;">mypetclub.app</a>
          </div>
        </div>`);
    }

    // Save lead to DB (non-blocking)
    try {
      await supabase.from('website_leads').insert({ name, phone: fullLeadPhone, email, city, pet_type: pettype, service_interest: service, pet_name: pet, message });
    } catch (e) { console.error('website_leads insert:', e.message); }

    res.json({ success: true, message: isInquiry ? 'Inquiry received! Team will reach out within 24h.' : 'App link sent via SMS and email!' });
  } catch (err) {
    console.error('Send link error:', err.message);
    res.status(500).json({ error: 'Failed to send. Try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  ADMIN: CREATE FIRST ADMIN (one-time, requires secret)
// ══════════════════════════════════════════════════════
// Bootstrap-only: promote a phone number to admin role.
// Rate-limited (authLimit) to prevent brute-force of ADMIN_SECRET.
// After initial setup, disable by removing ADMIN_SECRET from env vars.
app.post('/api/admin/make-admin', authLimit, async (req, res) => {
  try {
    const { phone, countryCode = '91', secret } = req.body;
    if (!process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Bootstrap endpoint disabled — ADMIN_SECRET not set' });
    if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Invalid secret' });
    const fullPhone = `+${countryCode}${phone}`;
    const { data: user } = await supabase.from('users').select('*').eq('phone', fullPhone).single();
    if (!user) return res.status(404).json({ error: 'User not found. Sign in first, then call this endpoint.' });
    await supabase.from('users').update({ role: 'admin' }).eq('id', user.id);
    res.json({ success: true, message: `${fullPhone} is now admin` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  USER ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/users/me', auth, async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('*, customer_profiles(*), professional_profiles(verification_status, sub_role, city, bio, is_available)')
    .eq('id', req.user.id)
    .single();
  // Flatten professional profile fields for easier consumption on the client
  const prof = data?.professional_profiles?.[0] || data?.professional_profiles || null;
  const user = {
    ...data,
    verificationStatus: prof?.verification_status || null,
    subRole: prof?.sub_role || null,
  };
  res.json({ success: true, user });
});

app.put('/api/users/me', auth, async (req, res) => {
  const name = sanitize(req.body.name), email = sanitize(req.body.email);
  const city = sanitize(req.body.city), area = sanitize(req.body.area);
  const address = sanitize(req.body.address), pincode = sanitize(req.body.pincode);
  const country = sanitize(req.body.country);
  // GPS address metadata from AddressPicker (optional)
  const addressLat        = typeof req.body.addressLat  === 'number' ? req.body.addressLat  : null;
  const addressLng        = typeof req.body.addressLng  === 'number' ? req.body.addressLng  : null;
  const addressPostalCode = sanitize(req.body.addressPostalCode) || null;
  const addressCity       = sanitize(req.body.addressCity)       || null;
  const addressState      = sanitize(req.body.addressState)      || null;

  // Server-side email typo block (only explicit bad TLDs — never flag .com)
  if (email) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    const tld = domain.includes('.') ? domain.split('.').pop() : '';
    const badTlds = ['con','conm','cmo','ocm','cim','cpm','copm'];
    if (tld && badTlds.includes(tld))
      return res.status(400).json({ error: `"${domain}" looks like a typo — did you mean .com?` });
  }

  await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  // Only write address fields to customer_profiles for customers (not professionals)
  if (req.user.role === 'customer') {
    await supabase.from('customer_profiles').upsert({ user_id: req.user.id, city, area, address, pincode, country }, { onConflict: 'user_id' });
    // Store GPS coords separately (migration-safe)
    if (addressLat && addressLng) {
      supabase.from('customer_profiles').update({
        address_lat: addressLat, address_lng: addressLng,
        address_postal_code: addressPostalCode,
        address_city: addressCity, address_state: addressState,
      }).eq('user_id', req.user.id).then(({ error }) => {
        if (error) console.error('profile GPS update:', error.message);
      });
    }
  }
  res.json({ success: true, message: 'Profile updated' });
});

// ══════════════════════════════════════════════════════
//  PET ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/pets', auth, async (req, res) => {
  const { data } = await supabase.from('pets').select('*').eq('owner_id', req.user.id).order('created_at');
  res.json({ success: true, pets: data });
});

app.post('/api/pets', auth, async (req, res) => {
  // Allowlist: never accept owner_id, id, or any computed field from the client
  const { name, species, breed, age, gender, dob, weight, health_notes, photo_url } = req.body;
  if (!name || !species) return res.status(400).json({ error: 'Pet name and species are required' });
  const { data, error } = await supabase.from('pets').insert({
    owner_id:     req.user.id,
    name:         sanitize(name),
    species:      sanitize(species),
    breed:        sanitize(breed)        || null,
    age:          age != null ? parseInt(age) : null,
    gender:       gender                 || null,
    dob:          dob                    || null,
    weight:       weight != null ? parseFloat(weight) : null,
    health_notes: sanitize(health_notes) || null,
    photo_url:    photo_url              || null,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, pet: data });
});

app.put('/api/pets/:id', auth, async (req, res) => {
  const { name, species, breed, age, gender, dob, weight, health_notes, photo_url } = req.body;
  const updates = {};
  if (name         !== undefined) updates.name         = sanitize(name);
  if (species      !== undefined) updates.species      = sanitize(species);
  if (breed        !== undefined) updates.breed        = sanitize(breed) || null;
  if (age          !== undefined) updates.age          = age != null ? parseInt(age) : null;
  if (gender       !== undefined) updates.gender       = gender || null;
  if (dob          !== undefined) updates.dob          = dob || null;
  if (weight       !== undefined) updates.weight       = weight != null ? parseFloat(weight) : null;
  if (health_notes !== undefined) updates.health_notes = sanitize(health_notes) || null;
  if (photo_url    !== undefined) updates.photo_url    = photo_url || null;
  const { data, error } = await supabase.from('pets').update(updates)
    .eq('id', req.params.id).eq('owner_id', req.user.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, pet: data });
});

// ══════════════════════════════════════════════════════
//  RECORDS: grooming / training / food / vet
// ══════════════════════════════════════════════════════
const TABLES = { grooming: 'grooming_records', training: 'training_records', food: 'food_orders', vet: 'vet_records' };

app.get('/api/pets/:petId/records/:type', auth, async (req, res) => {
  const tbl = TABLES[req.params.type];
  if (!tbl) return res.status(400).json({ error: 'Invalid type. Use: grooming, training, food, vet' });
  const { data } = await supabase.from(tbl).select('*').eq('pet_id', req.params.petId).order('date', { ascending: false });
  res.json({ success: true, records: data });
});

app.post('/api/pets/:petId/records/:type', auth, async (req, res) => {
  const tbl = TABLES[req.params.type];
  if (!tbl) return res.status(400).json({ error: 'Invalid type. Use: grooming, training, food, vet' });
  // Remove any client-supplied pet_id — always use the authenticated route parameter
  const { pet_id: _ignored, id: _id, ...safeBody } = req.body;
  const { data, error } = await supabase.from(tbl)
    .insert({ pet_id: req.params.petId, ...safeBody }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, record: data });
});

// ══════════════════════════════════════════════════════
//  PROFESSIONAL ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/professionals', async (req, res) => {
  const { city, sub_role } = req.query;
  let q = supabase.from('professional_profiles').select('*, users(name,phone)').eq('verification_status', 'approved').eq('is_available', true);
  if (city) q = q.ilike('city', `%${city}%`);
  if (sub_role) q = q.eq('sub_role', sub_role);
  const { data } = await q.order('rating', { ascending: false });
  res.json({ success: true, professionals: data });
});

app.get('/api/professionals/me', auth, async (req, res) => {
  const { data: prof } = await supabase.from('professional_profiles').select('*').eq('user_id', req.user.id).single();
  const { data: user } = await supabase.from('users').select('id,name,phone,email,role').eq('id', req.user.id).single();
  res.json({ success: true, profile: { ...prof, ...user } });
});

app.put('/api/professionals/me', auth, async (req, res) => {
  const name = sanitize(req.body.name), email = sanitize(req.body.email);
  const city = sanitize(req.body.city), area = sanitize(req.body.area);
  const address = sanitize(req.body.address), bio = sanitize(req.body.bio);
  const experience = sanitize(req.body.experience), service_areas = sanitize(req.body.service_areas);
  const langs = sanitize(req.body.langs), certification = sanitize(req.body.certification);
  const license_number = sanitize(req.body.license_number), clinic_name = sanitize(req.body.clinic_name);
  const price_basic = req.body.price_basic, price_full = req.body.price_full, price_custom = req.body.price_custom;
  const { sub_role } = req.body;
  const services = req.body.services;
  // GPS address metadata from AddressPicker — used for 70km radius dispatch
  const addressLat = typeof req.body.address_lat === 'number' ? req.body.address_lat : null;
  const addressLng = typeof req.body.address_lng === 'number' ? req.body.address_lng : null;
  if (name !== undefined || email !== undefined)
    await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  const pet_types = req.body.pet_types;
  const updatePayload = {
    city, area, address, bio, experience,
    services: Array.isArray(services) ? JSON.stringify(services) : services,
    pet_types: Array.isArray(pet_types) ? JSON.stringify(pet_types) : pet_types,
    service_areas, langs, price_basic, price_full, price_custom,
    certification, license_number, clinic_name,
  };
  // Only store GPS if provided (graceful: column may not exist yet)
  if (addressLat && addressLng) {
    updatePayload.address_lat = addressLat;
    updatePayload.address_lng = addressLng;
  }
  // Only update sub_role if explicitly provided (prevents overwriting with undefined)
  if (sub_role && ['Groomer','Trainer','Vet'].includes(sub_role)) {
    updatePayload.sub_role = sub_role;
  }
  // Fetch current profile BEFORE update to detect first-time profile completion
  const { data: existingProf } = await supabase.from('professional_profiles').select('bio, experience, sub_role').eq('user_id', req.user.id).single();
  const wasIncomplete = !existingProf?.bio && !existingProf?.experience;
  const willBeComplete = !!(bio && experience);

  const { data } = await supabase.from('professional_profiles').update(updatePayload)
    .eq('user_id', req.user.id).select().single();

  // Notify admin when professional completes their profile for the first time (in-review)
  if (wasIncomplete && willBeComplete) {
    const { data: u } = await supabase.from('users').select('name, phone, email').eq('id', req.user.id).single();
    const adminEmail = process.env.ADMIN_EMAIL;
    const finalSubRole = updatePayload.sub_role || existingProf?.sub_role || 'Professional';
    if (adminEmail) {
      sendEmail(adminEmail,
        `🔔 PETclub — ${finalSubRole} Profile Ready for Review: ${u?.name || u?.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px;border:2px solid #f97316;">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">🔔</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">New ${finalSubRole} Pending Verification</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">A professional has completed their profile and is awaiting your approval.</p>
          <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:20px;margin-bottom:16px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u?.name || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u?.phone || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u?.email || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#f97316;font-size:13px;font-weight:700;text-align:right">${finalSubRole}</td></tr>
            </table>
          </div>
          <p style="text-align:center;margin:0"><a href="${WEB_APP_URL}" style="display:inline-block;background:#f97316;color:white;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px">Review in Admin Dashboard →</a></p>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin · ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => console.error('[ProProfile] Admin notification failed:', e.message));
    }
  }

  res.json({ success: true, profile: data });
});

// Toggle online/offline availability — with admin email notification
app.put('/api/professionals/availability', auth, async (req, res) => {
  const { is_available } = req.body;
  if (typeof is_available !== 'boolean') return res.status(400).json({ error: 'is_available must be true or false' });

  const { data: prof } = await supabase
    .from('professional_profiles')
    .update({ is_available })
    .eq('user_id', req.user.id)
    .select('sub_role, city, users(name, phone)')
    .single();

  // Notify admin of status change
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail && prof) {
    const proName  = prof.users?.name || 'Unknown';
    const proPhone = prof.users?.phone || '—';
    const subRole  = prof.sub_role || 'Professional';
    const status   = is_available ? '🟢 ONLINE' : '⏸ OFFLINE';
    const city     = prof.city || '—';

    sendEmail(adminEmail, `PETclub: ${subRole} ${proName} is now ${status}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px">
        <h2 style="color:#f97316">🐾 PETclub — Professional Status Change</h2>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">Name</td><td style="padding:8px;font-weight:600">${proName}</td></tr>
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">Phone</td><td style="padding:8px;font-weight:600">${proPhone}</td></tr>
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">Role</td><td style="padding:8px;font-weight:600">${subRole}</td></tr>
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">City</td><td style="padding:8px;font-weight:600">${city}</td></tr>
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">New Status</td>
            <td style="padding:8px;font-weight:700;color:${is_available ? '#16a34a' : '#6b7280'}">${status}</td></tr>
          <tr><td style="padding:8px;color:#6b7280;font-size:13px">Time</td><td style="padding:8px">${new Date().toLocaleString('en-IN')}</td></tr>
        </table>
        <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:20px">PETclub Admin Notification</p>
      </div>`
    ).catch(e => console.error('[Availability] Admin email failed:', e.message));
  }

  res.json({ success: true, is_available, message: is_available ? 'You are now Online 🟢' : 'You are now Offline ⏸' });
});

app.post('/api/professionals/apply', auth, async (req, res) => {
  // Allowlist: never accept verification_status or is_available from client
  const { sub_role, city, address, bio, experience } = req.body;
  if (sub_role && !['Groomer', 'Trainer', 'Vet'].includes(sub_role))
    return res.status(400).json({ error: 'sub_role must be Groomer, Trainer, or Vet' });
  const { data, error } = await supabase.from('professional_profiles').upsert({
    user_id:             req.user.id,
    verification_status: 'pending',   // always pending — never accept from client
    is_available:        false,        // always offline until approved
    sub_role:            sub_role    || null,
    city:                sanitize(city)       || null,
    address:             sanitize(address)    || null,
    bio:                 sanitize(bio)        || null,
    experience:          sanitize(experience) || null,
  }, { onConflict: 'user_id' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('users').update({ role: 'professional' }).eq('id', req.user.id);
  res.json({ success: true, profile: data });
});

app.post('/api/professionals/upload-id', auth, async (req, res) => {
  const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
  if (!prof) return res.status(404).json({ error: 'Apply as professional first' });
  const { doc_type, doc_number, cert_type, cert_number } = req.body;
  const { data } = await supabase.from('id_documents').upsert({
    prof_id:     prof.id,
    doc_type:    sanitize(doc_type)    || null,
    doc_number:  sanitize(doc_number)  || null,
    cert_type:   sanitize(cert_type)   || null,
    cert_number: sanitize(cert_number) || null,
  }, { onConflict: 'prof_id' }).select().single();
  res.json({ success: true, document: data });
});

// ID document photo upload (base64 → Supabase Storage)
// ── Professional ID + Certification Upload ──────────────────────────────────
// SECURITY POLICY: Photos are NEVER stored in the database or cloud storage.
// They are emailed directly to the admin as attachments and immediately discarded.
// Only doc_type, doc_number, cert_type are stored in id_documents (metadata only).
app.post('/api/professionals/upload-id-photo', auth, async (req, res) => {
  try {
    const { docType, docNumber, docPhoto, certType, certNumber, certPhoto } = req.body;
    if (!docType) return res.status(400).json({ error: 'Document type required (Aadhar Card / Passport / Driving License)' });

    const { data: prof } = await supabase.from('professional_profiles').select('id, sub_role, city').eq('user_id', req.user.id).single();
    if (!prof) return res.status(404).json({ error: 'Professional profile not found. Complete signup first.' });

    // Store ONLY metadata — never photo paths (photos go to admin email only)
    const docMeta = {
      prof_id: prof.id,
      doc_type: docType,
      doc_number: docNumber || null,
      // photo_url intentionally OMITTED — photos are never stored
    };
    if (certType) { docMeta.cert_type = certType; docMeta.cert_number = certNumber || null; }
    await supabase.from('id_documents').upsert(docMeta, { onConflict: 'prof_id' });

    // ── Email photos directly to admin as attachments ─────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const { data: u } = await supabase.from('users').select('name, phone, email').eq('id', req.user.id).single();
      const proName = u?.name || u?.phone || `User#${req.user.id}`;
      const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      // Build email attachments from base64 photos (never touch DB/Storage)
      const attachments = [];
      if (docPhoto && docPhoto.length > 100) {
        try {
          const b64 = docPhoto.replace(/^data:image\/\w+;base64,/, '');
          const ext  = docPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
          attachments.push({
            filename:    `ID_${docType.replace(/\s+/g,'_')}_${req.user.id}.${ext}`,
            content:     Buffer.from(b64, 'base64'),
            contentType: `image/${ext}`,
          });
        } catch (e) { console.error('[ID photo parse]', e.message); }
      }
      if (certPhoto && certPhoto.length > 100) {
        try {
          const b64 = certPhoto.replace(/^data:image\/\w+;base64,/, '');
          const ext  = certPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
          attachments.push({
            filename:    `CERT_${(certType||'cert').replace(/\s+/g,'_')}_${req.user.id}.${ext}`,
            content:     Buffer.from(b64, 'base64'),
            contentType: `image/${ext}`,
          });
        } catch (e) { console.error('[Cert photo parse]', e.message); }
      }

      const html = `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px;border:2px solid #dc2626;">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">🔐</div>
          <h2 style="color:#1e293b;font-size:18px;text-align:center;margin:0 0 4px">ID Proof — Admin Eyes Only</h2>
          <p style="color:#64748b;font-size:12px;text-align:center;margin:0 0 20px">Photos are attached. They are <strong>not stored anywhere</strong> in the system.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px;margin-bottom:16px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Full Name</td>
                  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right">${sanitize(proName)}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Phone</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${u?.phone || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Email</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${u?.email || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Role</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${prof?.sub_role || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">City</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${prof?.city || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">ID Type</td>
                  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right">${sanitize(docType)}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:${certType ? '1px solid #fee2e2' : 'none'}">ID Number</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${sanitize(docNumber || '(not provided)')}</td></tr>
              ${certType ? `
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Certification</td>
                  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right">${sanitize(certType)}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0">Cert / Licence No.</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${sanitize(certNumber || '(not provided)')}</td></tr>
              ` : ''}
            </table>
          </div>
          <p style="color:#dc2626;font-size:12px;text-align:center;font-weight:700;margin:0 0 16px">
            ⚠️ ${attachments.length} photo${attachments.length !== 1 ? 's' : ''} attached to this email.<br>
            Do NOT forward. Delete after verification.
          </p>
          <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0">Submitted: ${ts}</p>
        </div>`;

      sendEmail(
        adminEmail,
        `🔐 PETclub ID Proof — ${sanitize(proName)} (${sanitize(docType)}) — ACTION REQUIRED`,
        html,
        attachments
      ).catch(e => console.error('[ID email send error]', e.message));
    } else {
      console.warn('[upload-id-photo] ADMIN_EMAIL not set — ID proof email not sent!');
    }

    res.json({ success: true, message: 'ID submitted — our team will verify within 24–48 hours.' });
  } catch (err) {
    console.error('ID upload error:', err.message);
    res.status(500).json({ error: 'Failed to submit document. Try again.' });
  }
});

// Customer government ID upload
app.post('/api/users/upload-id-photo', auth, async (req, res) => {
  try {
    const { docType, docNumber, docPhoto } = req.body;
    if (!docType) return res.status(400).json({ error: 'Document type required' });

    let customerPhotoPath = null;
    if (docPhoto && docPhoto.length > 100) {
      try {
        const base64Data = docPhoto.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = docPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
        const filename = `customers/${req.user.id}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('id-documents')
          .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });
        if (!upErr) customerPhotoPath = filename; // store path (private bucket — use signed URL to view)
      } catch (e) { console.error('Customer ID photo error:', e.message); }
    }

    await supabase.from('customer_profiles').upsert({
      user_id: req.user.id,
      id_doc_type: docType,
      id_doc_number: docNumber || null,
      id_photo_url: customerPhotoPath,
    }, { onConflict: 'user_id' });

    res.json({ success: true, message: 'ID document saved' });
  } catch (err) {
    console.error('Customer ID upload error:', err.message);
    res.status(500).json({ error: 'Failed to save document. Try again.' });
  }
});

app.post('/api/professionals/payout', auth, async (req, res) => {
  if (req.user.role !== 'professional') return res.status(403).json({ error: 'Professionals only' });
  const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
  if (!prof) return res.status(404).json({ error: 'Professional profile not found' });
  // Allowlist payout fields — never accept prof_id or computed fields from client
  const { bank_name, account_number, account_holder, ifsc_code, upi_id, payment_type } = req.body;
  const { data } = await supabase.from('payout_details').upsert({
    prof_id:        prof.id,
    bank_name:      sanitize(bank_name)       || null,
    account_number: sanitize(account_number)  || null,
    account_holder: sanitize(account_holder)  || null,
    ifsc_code:      sanitize(ifsc_code)       || null,
    upi_id:         sanitize(upi_id)          || null,
    payment_type:   payment_type              || null,
  }, { onConflict: 'prof_id' }).select().single();
  res.json({ success: true, payout: data });
});

// Pro: Earnings summary — only provider_earnings, never total_amount or platform_fee
app.get('/api/professionals/earnings', auth, async (req, res) => {
  try {
    if (req.user.role !== 'professional') return res.status(403).json({ error: 'Forbidden' });
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    if (!prof) return res.json({ success: true, earnings: { total: 0, paid: 0, pending: 0, bookings: [] } });

    const { data } = await supabase
      .from('bookings')
      .select('id, service_name, scheduled_at, status, provider_earnings, payout_status, currency')
      .eq('professional_id', prof.id)
      .in('status', ['upcoming', 'completed'])
      .order('scheduled_at', { ascending: false });

    const bookings = data || [];
    const completed = bookings.filter(b => b.status === 'completed');
    const total   = +completed.reduce((s, b) => s + parseFloat(b.provider_earnings || 0), 0).toFixed(2);
    const paid    = +completed.filter(b => b.payout_status === 'paid').reduce((s, b) => s + parseFloat(b.provider_earnings || 0), 0).toFixed(2);
    const pending = +(total - paid).toFixed(2);

    res.json({ success: true, earnings: { total, paid, pending, bookings } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  BOOKING ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/bookings', auth, async (req, res) => {
  let q;
  if (req.user.role === 'customer')
    // Use explicit FK hints to avoid PostgREST relationship ambiguity
    q = supabase.from('bookings').select('*, pets!pet_id(name,species,health_notes), professional_profiles!professional_id(sub_role, users(name,phone))').eq('customer_id', req.user.id);
  else if (req.user.role === 'professional') {
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    q = supabase.from('bookings').select('*, pets!pet_id(name,species,breed,health_notes), users!customer_id(name,phone)').eq('professional_id', prof?.id);
  } else
    // Admin: include customer + professional name/phone for live tracking panel
    q = supabase.from('bookings').select('*, pets!pet_id(name,species), users!customer_id(name,phone)');
  const { data, error } = await q.order('scheduled_at', { ascending: false });
  if (error) {
    console.error('[GET /bookings] Supabase query error:', error.message, error.details || '');
    return res.status(500).json({ error: 'Failed to load bookings. Please try again.' });
  }
  // Field-level security: strip financial fields by role before sending
  const bookings = (data || []).map(b => stripFinancials(b, req.user.role));
  res.json({ success: true, bookings });
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    processTimedOutAssignments().catch(console.error); // background cleanup
    const { service_type, city, pet_id, service_name, scheduled_at, address, notes, amount } = req.body;
    const addressLat = typeof req.body.lat === 'number' ? req.body.lat : null;
    const addressLng = typeof req.body.lng === 'number' ? req.body.lng : null;

    // ── Address geocoding enforcement ──────────────────────────────────────────
    // If an address string is provided it must have verified GPS coordinates
    // (set by AddressPicker when user selects from dropdown). This prevents
    // fake/typo addresses from being booked — GPS is required for 70km dispatch.
    if (address && address.trim() && (!addressLat || !addressLng)) {
      return res.status(400).json({
        error: 'Please select your address from the dropdown suggestions to verify it. This ensures we dispatch the nearest professional to you.',
      });
    }
    // Derive currency from phone prefix — same logic as frontend
    const customerCurrency = req.user.phone?.startsWith('+91') ? 'INR' : 'USD';
    const split = computeSplit(amount, customerCurrency);

    const { data: booking } = await supabase.from('bookings').insert({
      customer_id: req.user.id, status: 'upcoming',
      assignment_status: 'searching',
      service_type: service_type || null, service_name: service_name || null,
      pet_id: pet_id || null, scheduled_at: scheduled_at || null,
      city: city || null, address: address || null, notes: notes || null,
      amount: amount || null,
      // Revenue split columns (null when no amount provided)
      total_amount:      split?.total_amount      ?? null,
      platform_fee:      split?.platform_fee      ?? null,
      provider_earnings: split?.provider_earnings ?? null,
      gateway_fee:       split?.gateway_fee       ?? null,
      currency:          customerCurrency,
      payout_status:     'pending',
    }).select().single();
    // Store GPS coords separately (graceful: requires GPS migration to have run)
    if (booking && addressLat && addressLng) {
      supabase.from('bookings').update({ address_lat: addressLat, address_lng: addressLng })
        .eq('id', booking.id).then(({ error }) => {
          if (error) console.error('booking GPS coords update:', error.message);
        });
    }
    if (!booking) return res.status(500).json({ error: 'Failed to create booking' });


    // Auto-assign round-robin (GPS radius if available, city fallback)
    if (service_type && ['Groomer', 'Trainer', 'Vet'].includes(service_type)) {
      let petName = 'Pet';
      if (pet_id) {
        const { data: pet } = await supabase.from('pets').select('name, health_notes').eq('id', pet_id).single();
        petName = pet?.name || 'Pet';
        if (pet?.health_notes) booking.pet_health_notes = pet.health_notes;
      }
      const nextPro = await findNextPro(city || '', service_type, [], addressLat, addressLng);
      if (nextPro) {
        await offerBookingToPro(booking.id, nextPro, { ...booking, pet_name: petName });
      } else {
        await supabase.from('bookings').update({ assignment_status: 'no_pros_available' }).eq('id', booking.id);
      }
    }

    const { data: updated } = await supabase.from('bookings').select('*').eq('id', booking.id).single();
    res.json({ success: true, booking: updated });
  } catch (err) {
    console.error('Create booking error:', err.message);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.put('/api/bookings/:id/status', auth, async (req, res) => {
  const { data: booking } = await supabase.from('bookings').select('customer_id, professional_id').eq('id', req.params.id).single();
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Ownership check: customer or the professional involved can update status
  let authorized = false;
  if (req.user.role === 'admin') authorized = true;
  else if (req.user.role === 'customer' && booking.customer_id === req.user.id) authorized = true;
  else if (req.user.role === 'professional') {
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    if (prof && booking.professional_id === prof.id) authorized = true;
  }
  if (!authorized) return res.status(403).json({ error: 'Not authorized to update this booking' });

  // Whitelist allowed statuses — prevents state-machine manipulation from client
  const VALID_BOOKING_STATUSES = ['upcoming', 'in_progress', 'completed', 'cancelled'];
  if (!VALID_BOOKING_STATUSES.includes(req.body.status))
    return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_BOOKING_STATUSES.join(', ')}` });

  // Keep assignment_status in sync with the operational status transitions
  const assignmentStatusMap = { in_progress: 'in_progress', completed: 'completed', cancelled: 'cancelled' };
  const updatePayload = { status: req.body.status };
  if (assignmentStatusMap[req.body.status]) updatePayload.assignment_status = assignmentStatusMap[req.body.status];

  const { data } = await supabase.from('bookings').update(updatePayload).eq('id', req.params.id).select().single();
  res.json({ success: true, booking: data });
});

// Pro: Accept or Reject a booking offer
app.post('/api/bookings/:id/respond', auth, async (req, res) => {
  try {
    const { action } = req.body; // 'accept' | 'reject'
    if (!['accept','reject'].includes(action)) return res.status(400).json({ error: "action must be 'accept' or 'reject'" });

    const { data: prof } = await supabase.from('professional_profiles').select('id, users(name, phone, email)').eq('user_id', req.user.id).single();
    if (!prof) return res.status(403).json({ error: 'Professional profile not found' });

    const { data: assignment } = await supabase.from('booking_assignments')
      .select('*').eq('booking_id', req.params.id).eq('professional_id', prof.id).eq('status', 'offered').single();
    if (!assignment) return res.status(404).json({ error: 'No active offer found for this booking' });
    if (new Date() > new Date(assignment.response_deadline))
      return res.status(400).json({ error: 'Response window expired — the request was auto-passed' });

    await supabase.from('booking_assignments').update({ status: action === 'accept' ? 'accepted' : 'rejected', responded_at: new Date().toISOString() }).eq('id', assignment.id);

    if (action === 'accept') {
      await supabase.from('bookings').update({ assignment_status: 'confirmed', professional_id: prof.id, status: 'upcoming' }).eq('id', req.params.id);

      // Notify customer
      const { data: bk } = await supabase.from('bookings').select('*, users!customer_id(name,phone,email)').eq('id', req.params.id).single();
      const custEmail = bk?.users?.email;
      const custPhone = bk?.users?.phone;
      const proName = prof.users?.name || 'Your professional';
      const svc = bk?.service_name || bk?.service_type || 'Service';
      const dateStr = bk?.scheduled_at ? new Date(bk.scheduled_at).toLocaleString('en-IN', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'TBD';

      if (custEmail) {
        sendEmail(custEmail, `✅ Booking Confirmed — ${proName} will serve you!`, `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff;border-radius:16px;border:1px solid #f1f5f9;">
            <div style="text-align:center;margin-bottom:20px;"><div style="font-size:48px">✅</div><h2 style="color:#16a34a;margin:8px 0">Booking Confirmed!</h2></div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
              <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">Service</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${svc}</td></tr>
              <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">Professional</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${proName}</td></tr>
              <tr><td style="padding:8px 0;font-size:12px;color:#94a3b8">Date & Time</td><td style="padding:8px 0;font-size:14px;font-weight:700;color:#1e293b">${dateStr}</td></tr>
            </table>
            <div style="text-align:center;"><a href="https://app.mypetclub.app" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">Open PETclub App →</a></div>
          </div>`).catch(console.error);
      }
      // FCM push to customer
      const { data: custUserFcm } = await Promise.resolve(supabase.from('users').select('fcm_token').eq('id', bk?.users?.id || bk?.customer_id || '').single()).catch(() => ({ data: null }));
      if (custUserFcm?.fcm_token) {
        sendPush(custUserFcm.fcm_token, `✅ Booking Confirmed!`, `${proName} will be there on ${dateStr}`, { bookingId: req.params.id, type: 'booking_confirmed' }).catch(() => {});
      }
      return res.json({ success: true, message: `Booking accepted! Customer has been notified.` });
    }

    // Reject: find next pro (round-robin)
    const { data: tried } = await supabase.from('booking_assignments').select('professional_id')
      .eq('booking_id', req.params.id).in('status', ['rejected', 'timed_out', 'accepted']);
    const excludeIds = tried?.map(r => r.professional_id) || [];
    const { data: bk } = await supabase.from('bookings').select('*').eq('id', req.params.id).single();
    let petName = 'Pet';
    if (bk?.pet_id) {
      const { data: pet } = await supabase.from('pets').select('name').eq('id', bk.pet_id).single();
      petName = pet?.name || 'Pet';
    }
    const nextPro = await findNextPro(bk?.city || '', bk?.service_type || '', excludeIds, bk?.address_lat, bk?.address_lng);
    if (nextPro) {
      await offerBookingToPro(req.params.id, nextPro, { ...bk, pet_name: petName });
      return res.json({ success: true, message: 'Passed to next available professional' });
    }
    await supabase.from('bookings').update({ assignment_status: 'no_pros_available', professional_id: null }).eq('id', req.params.id);
    res.json({ success: true, message: 'No other professionals available right now' });
  } catch (err) {
    console.error('Respond booking error:', err.message);
    res.status(500).json({ error: 'Failed to process response' });
  }
});

// Pro: Get all incoming (offered) bookings
app.get('/api/bookings/incoming', auth, async (req, res) => {
  try {
    processTimedOutAssignments().catch(console.error);
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    if (!prof) return res.json({ success: true, bookings: [] });

    const { data: assignments } = await supabase
      .from('booking_assignments')
      .select('*, bookings(*, pets(name, species, breed, health_notes), users!customer_id(name, phone))')
      .eq('professional_id', prof.id)
      .eq('status', 'offered')
      .gt('response_deadline', new Date().toISOString());

    const bookings = (assignments || []).map(a => stripFinancials({
      ...(a.bookings || {}),
      assignment_id: a.id,
      response_deadline: a.response_deadline,
      offered_at: a.offered_at,
    }, 'professional'));
    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Manually assign a booking to a specific professional
app.put('/api/bookings/:id/assign', auth, adminOnly, async (req, res) => {
  try {
    const { professionalId } = req.body;
    const { data: prof } = await supabase.from('professional_profiles').select('id, users(name, phone, email)').eq('id', professionalId).single();
    if (!prof) return res.status(404).json({ error: 'Professional not found' });
    const { data: bk } = await supabase.from('bookings').select('*').eq('id', req.params.id).single();
    if (!bk) return res.status(404).json({ error: 'Booking not found' });
    let petName = 'Pet', petHealthNotes = null;
    if (bk.pet_id) {
      const { data: pet } = await supabase.from('pets').select('name, health_notes').eq('id', bk.pet_id).single();
      petName = pet?.name || 'Pet';
      petHealthNotes = pet?.health_notes || null;
    }
    await offerBookingToPro(req.params.id, prof, { ...bk, pet_name: petName, pet_health_notes: petHealthNotes });
    await supabase.from('bookings').update({ assignment_status: 'offered' }).eq('id', req.params.id);
    res.json({ success: true, message: `Assigned to ${prof.users?.name || professionalId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  LIVE TRACKING (SSE — Ola/Rapido-style)
// ══════════════════════════════════════════════════════

// In-memory SSE client registry: bookingId → Set<res>
const trackingClients = new Map();

// Customer subscribes — GET /api/bookings/:id/track?token=<jwt>
// Uses query-param token because EventSource doesn't support custom headers
app.get('/api/bookings/:id/track', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });

  let userId;
  try { userId = jwt.verify(token, JWT_SECRET).id; }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  const bookingId = req.params.id;

  // Verify booking belongs to this customer (customer_id, not user_id — see schema)
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, customer_id, pro_lat, pro_lng, assignment_status')
    .eq('id', bookingId)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.customer_id !== userId) return res.status(403).json({ error: 'Not your booking' });

  // SSE handshake
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx / Cloud Run proxy buffering
  res.flushHeaders();

  // Send last known position immediately (if any)
  if (booking.pro_lat && booking.pro_lng) {
    res.write(`data: ${JSON.stringify({ lat: booking.pro_lat, lng: booking.pro_lng })}\n\n`);
  }

  // Keepalive comment every 25 s (prevents Cloud Run/Vercel from closing idle connections)
  const keepAlive = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);

  // Register
  if (!trackingClients.has(bookingId)) trackingClients.set(bookingId, new Set());
  trackingClients.get(bookingId).add(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    trackingClients.get(bookingId)?.delete(res);
    if (trackingClients.get(bookingId)?.size === 0) trackingClients.delete(bookingId);
  });
});

// ── Haversine straight-line distance in km ──────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const TEN_MIN_KM = parseFloat(process.env.PROXIMITY_ALERT_KM) || 8; // ~10 min at avg 50 km/h road speed

// Professional taps "On My Way" — POST /api/bookings/:id/on-my-way
app.post('/api/bookings/:id/on-my-way', auth, async (req, res) => {
  try {
    const { data: proProfile } = await supabase.from('professional_profiles').select('id, sub_role, users(name, phone, fcm_token)').eq('user_id', req.user.id).single();
    if (!proProfile) return res.status(403).json({ error: 'Not a professional' });

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, professional_id, assignment_status, customer_id, service_name, service_type, users!customer_id(name, phone, email, fcm_token)')
      .eq('id', req.params.id)
      .eq('professional_id', proProfile.id)
      .single();

    if (!booking) return res.status(403).json({ error: 'Booking not found or not yours' });
    if (!['confirmed'].includes(booking.assignment_status)) {
      return res.status(400).json({ error: 'Booking must be confirmed before starting journey' });
    }

    await supabase.from('bookings').update({ assignment_status: 'on_the_way' }).eq('id', req.params.id);

    const proName = proProfile.users?.name || 'Your professional';
    const svcType = booking.service_type || 'professional';

    // Notify customer via SMS
    if (booking.users?.phone) {
      sendSMS(booking.users.phone, `🐾 PETclub: ${proName} (${svcType}) is on the way to you! Open the app to track them live.`).catch(() => {});
    }
    // Notify customer via FCM push
    if (booking.users?.fcm_token) {
      sendPushNotification(booking.users.fcm_token, '🚗 On the Way!', `${proName} is heading to you now. Track live in the app.`).catch(() => {});
    }

    console.log(`[OnMyWay] Booking ${req.params.id} — ${proName} started journey`);
    res.json({ success: true, message: 'Journey started! Customer has been notified.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Professional sends GPS — POST /api/bookings/:id/location { lat, lng }
app.post('/api/bookings/:id/location', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const bookingId = req.params.id;

    // Verify booking is assigned to this professional
    const { data: proProfile } = await supabase
      .from('professional_profiles')
      .select('id, sub_role, users(name, fcm_token)')
      .eq('user_id', req.user.id)
      .single();

    if (!proProfile) return res.status(403).json({ error: 'Not a professional' });

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, professional_id, assignment_status, address_lat, address_lng, ten_min_notified, customer_id, service_type, users!customer_id(name, phone, fcm_token)')
      .eq('id', bookingId)
      .eq('professional_id', proProfile.id)
      .single();

    if (!booking) return res.status(403).json({ error: 'Booking not found or not yours' });
    if (!['confirmed','on_the_way','in_progress'].includes(booking.assignment_status)) {
      return res.status(400).json({ error: 'Booking is not in an active state' });
    }

    // Persist latest position to DB (customers polling REST will get this too)
    await supabase.from('bookings').update({
      pro_lat: lat,
      pro_lng: lng,
      pro_location_updated_at: new Date().toISOString(),
    }).eq('id', bookingId);

    // ── 10-minute proximity alert ────────────────────────────
    if (!booking.ten_min_notified && booking.address_lat && booking.address_lng) {
      const distKm = haversineKm(lat, lng, booking.address_lat, booking.address_lng);
      if (distKm <= TEN_MIN_KM) {
        // Mark as notified first to prevent duplicate sends
        await supabase.from('bookings').update({ ten_min_notified: true }).eq('id', bookingId);

        const proName  = proProfile.users?.name || 'Your professional';
        const svcType  = booking.service_type || 'professional';
        const custPhone = booking.users?.phone;
        const custFcm   = booking.users?.fcm_token;

        if (custPhone) {
          sendSMS(custPhone, `🐾 PETclub: ${proName} (${svcType}) will arrive in about 10 minutes! Get ready 🐾`).catch(() => {});
        }
        if (custFcm) {
          sendPushNotification(custFcm, '⏱️ 10 Minutes Away!', `${proName} will arrive in about 10 minutes. Get ready!`).catch(() => {});
        }
        console.log(`[ProximityAlert] Booking ${bookingId} — ${proName} is ${distKm.toFixed(1)}km from customer, 10-min alert sent`);
      }
    }

    // Push to all subscribed SSE clients
    const clients = trackingClients.get(bookingId);
    const distKm = (booking.address_lat && booking.address_lng)
      ? haversineKm(lat, lng, booking.address_lat, booking.address_lng)
      : null;
    const payload = JSON.stringify({ lat, lng, t: Date.now(), distKm: distKm ? +distKm.toFixed(2) : null });
    let pushed = 0;
    clients?.forEach(client => {
      try { client.write(`data: ${payload}\n\n`); pushed++; }
      catch { clients.delete(client); }
    });

    res.json({ ok: true, pushed, distKm: distKm ? +distKm.toFixed(2) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST snapshot fallback — GET /api/bookings/:id/tracking
app.get('/api/bookings/:id/tracking', auth, async (req, res) => {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('customer_id, professional_id, pro_lat, pro_lng, pro_location_updated_at, assignment_status')
      .eq('id', req.params.id)
      .single();
    if (!booking) return res.status(404).json({ error: 'Not found' });

    // Ownership check — customer, assigned professional, or admin only
    let proProfileId = null;
    if (req.user.role === 'professional') {
      const { data: pp } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
      proProfileId = pp?.id || null;
    }
    const isOwner = req.user.role === 'admin'
      || booking.customer_id === req.user.id
      || (proProfileId && booking.professional_id === proProfileId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    // Strip internal FK fields from response
    const { customer_id, professional_id, ...safeData } = booking;
    res.json(safeData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  RATINGS & REVIEWS
// ══════════════════════════════════════════════════════

// Rate a completed booking (customer only, one rating per booking)
app.post('/api/bookings/:id/rate', auth, async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only customers can rate bookings' });

    const { data: booking } = await supabase.from('bookings')
      .select('*, professional_profiles(id, user_id)')
      .eq('id', req.params.id).eq('customer_id', req.user.id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'completed') return res.status(400).json({ error: 'Can only rate completed bookings' });
    if (!booking.professional_id) return res.status(400).json({ error: 'No professional assigned to this booking' });

    const profUserId = booking.professional_profiles?.user_id;

    // Upsert — one rating per booking
    await supabase.from('reviews').upsert({
      reviewer_id: req.user.id,
      reviewee_id: profUserId,
      booking_id: req.params.id,
      rating: parseInt(rating),
      review: review?.trim() || null,
    }, { onConflict: 'booking_id' });

    // Recalculate pro's average rating
    if (profUserId) {
      const { data: allRatings } = await supabase.from('reviews').select('rating').eq('reviewee_id', profUserId);
      if (allRatings?.length) {
        const avg = (allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length).toFixed(2);
        await supabase.from('professional_profiles').update({ rating: parseFloat(avg), total_reviews: allRatings.length }).eq('user_id', profUserId);
      }
    }
    res.json({ success: true, message: 'Thank you for your feedback! 🌟' });
  } catch (err) {
    console.error('Rate booking error:', err.message);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// Check if a booking has been rated (customer only)
app.get('/api/bookings/:id/my-rating', auth, async (req, res) => {
  const { data } = await supabase.from('reviews').select('rating, review').eq('booking_id', req.params.id).eq('reviewer_id', req.user.id).single();
  res.json({ success: true, rated: !!data, rating: data?.rating || null, review: data?.review || null });
});

// ══════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════

// Admin OTP lookup — DEV ONLY. Disabled in production (set ALLOW_DEV_TOOLS=true locally).
// GET /api/admin/otp?phone=+919876543210  OR  ?phone=9876543210&cc=91
app.get('/api/admin/otp', auth, adminOnly, async (req, res) => {
  if (IS_PROD) return res.status(403).json({ error: 'This debug endpoint is disabled in production. Set ALLOW_DEV_TOOLS=true in local .env to use it.' });
  try {
    let { phone, cc = '91' } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone query param required' });
    const fullPhone = phone.startsWith('+') ? phone : `+${cc}${phone}`;
    const { data: rec } = await supabase
      .from('otp_tokens')
      .select('otp, expires_at, verified, phone')
      .eq('phone', fullPhone)
      .single();
    if (!rec) return res.status(404).json({ error: `No OTP found for ${fullPhone}` });
    const expired = new Date() > new Date(rec.expires_at);
    const minsLeft = Math.max(0, Math.ceil((new Date(rec.expires_at) - Date.now()) / 60000));
    res.json({
      success: true,
      phone: rec.phone,
      otp: rec.otp,
      verified: rec.verified,
      expired,
      expires_at: rec.expires_at,
      mins_left: minsLeft,
      note: expired ? 'OTP has expired — request a new one' : rec.verified ? 'OTP already used' : `Valid for ${minsLeft} more min(s)`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  const [u, p, b, l] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact' }),
    supabase.from('professional_profiles').select('id', { count: 'exact' }).eq('verification_status', 'approved'),
    supabase.from('bookings').select('total_amount, platform_fee, provider_earnings, gateway_fee, amount').eq('status', 'completed'),
    supabase.from('website_leads').select('id', { count: 'exact' }),
  ]);
  const completedBookings = b.data || [];
  // Use total_amount when available (new bookings); fall back to legacy amount column
  const revenue         = +completedBookings.reduce((s, x) => s + parseFloat(x.total_amount    || x.amount || 0), 0).toFixed(2);
  const platform_net    = +completedBookings.reduce((s, x) => s + parseFloat((x.platform_fee   || 0) - (x.gateway_fee || 0)), 0).toFixed(2);
  const provider_total  = +completedBookings.reduce((s, x) => s + parseFloat(x.provider_earnings || 0), 0).toFixed(2);
  res.json({ success: true, stats: { users: u.count, verified_pros: p.count, revenue, platform_net, provider_total, leads: l.count } });
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('*, customer_profiles(id_photo_url, id_doc_type, id_doc_number), professional_profiles(sub_role, verification_status, rating, city)').order('created_at', { ascending: false });

  // Attach suspended_at: latest 'suspend_user' log timestamp per suspended user
  const suspendedIds = data?.filter(u => !u.is_active && u.role !== 'admin').map(u => u.id) || [];
  let suspendedAtMap = {};
  if (suspendedIds.length) {
    const { data: logs } = await supabase
      .from('admin_logs')
      .select('target_id, created_at')
      .eq('action', 'suspend_user')
      .in('target_id', suspendedIds)
      .order('created_at', { ascending: false });
    logs?.forEach(l => { if (!suspendedAtMap[l.target_id]) suspendedAtMap[l.target_id] = l.created_at; });
  }

  const users = data?.map(u => ({ ...u, suspended_at: suspendedAtMap[u.id] || null }));
  res.json({ success: true, users });
});

// Admin: generate a short-lived signed URL for a private storage document
// The URL expires in 60 seconds — admin must view it immediately
app.get('/api/admin/signed-url', auth, adminOnly, async (req, res) => {
  const { path } = req.query;
  if (!path || typeof path !== 'string' || path.includes('..'))
    return res.status(400).json({ error: 'Valid storage path required' });
  const { data, error } = await supabase.storage
    .from('id-documents')
    .createSignedUrl(path, 60); // expires in 60 seconds
  if (error) return res.status(404).json({ error: 'Document not found' });
  res.json({ success: true, url: data.signedUrl, expiresIn: 60 });
});

app.get('/api/admin/pending-verifications', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('professional_profiles').select('*, users(name,phone,email), id_documents(*)').eq('verification_status', 'pending');
  res.json({ success: true, pending: data });
});

app.put('/api/admin/verify/:id', auth, adminOnly, async (req, res) => {
  const { action, reason } = req.body;
  const status = action === 'approve' ? 'approved' : 'rejected';
  const profileUpdate = { verification_status: status };
  // When approving, set is_available: true so the professional appears in search results
  if (action === 'approve') profileUpdate.is_available = true;
  const { data: prof } = await supabase.from('professional_profiles').update(profileUpdate).eq('id', req.params.id).select('*, users(name,phone,email)').single();
  await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: `${action}_professional`, target_id: req.params.id, target_type: 'professional', notes: reason });
  if (prof?.users?.phone) {
    const sms = action === 'approve'
      ? `✅ Congrats! Your PETclub profile is verified. Open the app to go live and start earning! 🐾`
      : `❌ PETclub verification not approved. Reason: ${reason||'Documents incomplete'}. Resubmit via the app.`;
    // SMS notification (existing)
    sendSMS(prof.users.phone, sms).catch(console.error);
    // Branded verification email (new)
    if (prof.users.email) {
      emailService.sendProviderVerificationEmail(prof.users.email, {
        name:    prof.users.name,
        subRole: prof.sub_role,
        action,
        reason,
        city:    prof.city,
      }).catch(console.error);
    }
  }
  res.json({ success: true, professional: prof });
});

// Admin: set sub_role for a professional (creates profile row if missing)
app.put('/api/admin/users/:id/set-role', auth, adminOnly, async (req, res) => {
  const { subRole } = req.body;
  if (!['Groomer','Trainer','Vet'].includes(subRole))
    return res.status(400).json({ error: 'subRole must be Groomer, Trainer, or Vet' });

  // Ensure the user's role is 'professional' (in case they were still pending_role)
  await supabase.from('users').update({ role: 'professional' }).eq('id', req.params.id);

  // Try to update existing row first (preserves verification_status, is_available, etc.)
  const { data: updatedRows, error: updateErr } = await supabase
    .from('professional_profiles')
    .update({ sub_role: subRole })
    .eq('user_id', req.params.id)
    .select();

  if (updateErr) {
    console.error('[SetRole] Update error:', updateErr.message);
    return res.status(500).json({ error: 'Failed to update role: ' + updateErr.message });
  }

  // If no row was updated (user had no profile yet), insert one
  if (!updatedRows || updatedRows.length === 0) {
    const { error: insertErr } = await supabase.from('professional_profiles').insert({
      user_id: req.params.id, sub_role: subRole, verification_status: 'pending', is_available: false,
    });
    if (insertErr) {
      console.error('[SetRole] Insert error:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create profile: ' + insertErr.message });
    }
  }

  console.log(`[SetRole] Admin set sub_role=${subRole} for user ${req.params.id}`);
  res.json({ success: true, subRole });
});

// ── Admin: fix / update user profile data (email, name, address) ──────────
const adminEditUser = async (req, res) => {
  try {
    const { data: u } = await supabase.from('users').select('id, name, phone, email, role').eq('id', req.params.id).single();
    if (!u) return res.status(404).json({ error: 'User not found' });

    const { name, email, address, city, area, pincode } = req.body;

    // Validate email if provided
    if (email !== undefined && email !== null && email !== '') {
      const em = email.toLowerCase().trim();
      const domain = em.includes('@') ? em.split('@').pop() : '';
      const tld = domain.includes('.') ? domain.split('.').pop() : '';
      const badTlds = ['con','conm','cmo','ocm','cim','cpm','copm'];
      if (badTlds.includes(tld)) {
        return res.status(400).json({ error: `"${email}" has an invalid domain. Please use the correct email.` });
      }
    }

    // Update user record
    const userUpdate = {};
    if (name !== undefined) userUpdate.name = sanitize(name) || null;
    if (email !== undefined) userUpdate.email = email ? email.toLowerCase().trim() : null;
    if (Object.keys(userUpdate).length) {
      await supabase.from('users').update(userUpdate).eq('id', req.params.id);
    }

    // Update address in the right profile table
    if (address !== undefined || city !== undefined || area !== undefined || pincode !== undefined) {
      const addrPayload = {};
      if (address !== undefined) addrPayload.address = sanitize(address) || null;
      if (city    !== undefined) addrPayload.city    = sanitize(city) || null;
      if (area    !== undefined) addrPayload.area    = sanitize(area) || null;
      if (pincode !== undefined) addrPayload.pincode = sanitize(pincode) || null;

      const table = u.role === 'professional' ? 'professional_profiles' : 'customer_profiles';
      await supabase.from(table).update(addrPayload).eq('user_id', req.params.id);
    }

    await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: 'edit_user', target_id: req.params.id, target_type: 'user', notes: `Admin corrected user data` });
    console.log(`[AdminEdit] User ${req.params.id} updated by admin ${req.user.id}`);
    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('[AdminEdit]', err);
    res.status(500).json({ error: err.message });
  }
};

// Register PATCH (standard) + POST (proxy-safe alias)
app.patch('/api/admin/users/:id',      auth, adminOnly, adminEditUser);
app.post('/api/admin/users/:id/edit',  auth, adminOnly, adminEditUser);

app.put('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
  const { data: u } = await supabase.from('users').select('id, name, phone, email, role, is_active').eq('id', req.params.id).single();
  if (!u) return res.status(404).json({ error: 'User not found' });

  const nowSuspending = u.is_active; // true → we're suspending; false → we're restoring
  await supabase.from('users').update({ is_active: !u.is_active }).eq('id', req.params.id);
  await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: nowSuspending ? 'suspend_user' : 'restore_user', target_id: req.params.id, target_type: 'user' });

  const adminEmail = process.env.ADMIN_EMAIL;

  if (nowSuspending) {
    // Compute deletion time (24 hr from now)
    const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const deleteStr = deleteAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

    // Notify the user themselves (branded suspension template)
    if (u.email) {
      emailService.sendAccountSuspendedEmail(u.email, {
        name:   u.name,
        reason: req.body?.reason || null,
      }).catch(e => console.error('[Email] Suspension notice failed:', e.message));
    }

    if (adminEmail) {
      sendEmail(
        adminEmail,
        `⚠️ PETclub — User Suspended: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">⚠️</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Suspended</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 24px">This user's account has been suspended by admin and will be <strong style="color:#dc2626">permanently deleted in 24 hours</strong>.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px;margin-bottom:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.email || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#1e293b;font-size:13px;text-align:right;text-transform:capitalize">${u.role}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Deletes at</td><td style="color:#dc2626;font-size:13px;font-weight:700;text-align:right">${deleteStr} IST</td></tr>
            </table>
          </div>
          <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:16px;font-size:13px;color:#92400e">
            <strong>To prevent deletion:</strong> Go to the Admin Dashboard → Users tab → find this user → click <em>Restore</em> before ${deleteStr} IST.
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin System · ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => console.error('[Suspend] Email failed:', e.message));
    }
  } else {
    // User restored — notify admin
    if (adminEmail) {
      sendEmail(
        adminEmail,
        `✅ PETclub — User Restored: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">✅</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Restored</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">The following account has been reactivated and the 24-hr deletion timer has been cancelled.</p>
          <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:14px;padding:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
            </table>
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin System · ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => console.error('[Restore] Email failed:', e.message));
    }
  }

  const suspendedAt = nowSuspending ? new Date().toISOString() : null;
  res.json({ success: true, is_active: !u.is_active, suspended_at: suspendedAt });
});

// ══════════════════════════════════════════════════════
//  ADMIN: Purge ALL suspended users in one shot
//  Deletes every non-admin user where is_active = false.
// ══════════════════════════════════════════════════════
app.delete('/api/admin/users/suspended/purge-all', auth, adminOnly, async (req, res) => {
  try {
    const { data: suspended } = await supabase
      .from('users')
      .select('id, name, phone, email, role')
      .eq('is_active', false)
      .neq('role', 'admin');

    if (!suspended?.length) return res.json({ success: true, deleted: 0, message: 'No suspended users found.' });

    const ids = suspended.map(u => u.id);

    // ── Step 1: get professional_profile IDs so we can cascade their children ──
    const { data: profProfiles } = await supabase
      .from('professional_profiles')
      .select('id')
      .in('user_id', ids);
    const profIds = (profProfiles || []).map(p => p.id);

    // ── Step 2: delete every table that has a FK → professional_profiles.id ──
    // Supabase v2 returns { data, error } — never throws, so no .catch() needed
    if (profIds.length) {
      await supabase.from('booking_assignments').delete().in('professional_id', profIds);
      await supabase.from('bookings').delete().in('professional_id', profIds);
      await supabase.from('id_documents').delete().in('prof_id', profIds);
      await supabase.from('payout_details').delete().in('prof_id', profIds);
    }

    // ── Step 3: delete every table that has a FK → users.id ──
    await supabase.from('bookings').delete().in('customer_id', ids);
    await supabase.from('reviews').delete().in('reviewer_id', ids);
    await supabase.from('reviews').delete().in('reviewee_id', ids);
    await supabase.from('payment_logs').delete().in('user_id', ids);
    await supabase.from('professional_profiles').delete().in('user_id', ids);
    await supabase.from('customer_profiles').delete().in('user_id', ids);
    await supabase.from('pets').delete().in('owner_id', ids);
    await supabase.from('otp_tokens').delete().in('phone', suspended.map(u => u.phone));
    await supabase.from('admin_logs').delete().in('target_id', ids);

    // ── Step 4: now it's safe to delete the users themselves ──
    const { error: delErr } = await supabase.from('users').delete().in('id', ids);
    if (delErr) throw new Error(delErr.message);

    await supabase.from('admin_logs').insert({
      admin_id: req.user.id,
      action: 'purge_all_suspended',
      target_type: 'user',
      notes: `Purged ${ids.length} suspended users: ${suspended.map(u => u.phone).join(', ')}`,
    });

    console.log(`[PurgeAll] Admin ${req.user.id} deleted ${ids.length} suspended users`);
    res.json({ success: true, deleted: ids.length });
  } catch (e) {
    console.error('[PurgeAll] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
//  ADMIN: Hard-delete a user immediately
// ══════════════════════════════════════════════════════
app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const { data: u } = await supabase.from('users').select('id, name, phone, email, role').eq('id', req.params.id).single();
    if (!u) return res.status(404).json({ error: 'User not found' });

    // Cascade: resolve professional_profile FK children first
    const { data: profRow } = await supabase
      .from('professional_profiles')
      .select('id')
      .eq('user_id', u.id)
      .maybeSingle();
    if (profRow?.id) {
      await supabase.from('booking_assignments').delete().eq('professional_id', profRow.id);
      await supabase.from('bookings').delete().eq('professional_id', profRow.id);
      await supabase.from('id_documents').delete().eq('prof_id', profRow.id);
      await supabase.from('payout_details').delete().eq('prof_id', profRow.id);
    }
    await supabase.from('bookings').delete().eq('customer_id', u.id);
    await supabase.from('reviews').delete().eq('reviewer_id', u.id);
    await supabase.from('reviews').delete().eq('reviewee_id', u.id);
    await supabase.from('payment_logs').delete().eq('user_id', u.id);
    await supabase.from('professional_profiles').delete().eq('user_id', u.id);
    await supabase.from('customer_profiles').delete().eq('user_id', u.id);
    await supabase.from('pets').delete().eq('owner_id', u.id);
    await supabase.from('otp_tokens').delete().eq('phone', u.phone);
    await supabase.from('admin_logs').delete().eq('target_id', u.id);
    await supabase.from('users').delete().eq('id', u.id);

    await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: 'delete_user', target_id: u.id, target_type: 'user', notes: `Manual delete: ${u.name || u.phone}` });
    console.log(`[AdminDelete] User ${u.id} (${u.phone}) deleted by admin ${req.user.id}`);

    // Notify admin email about manual deletion
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      sendEmail(adminEmail, `🗑️ PETclub — User Manually Deleted: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">🗑️</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Permanently Deleted</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">This account was manually deleted from the Admin Dashboard.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.email || '—'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#1e293b;font-size:13px;text-align:right;text-transform:capitalize">${u.role}</td></tr>
            </table>
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin · ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(() => {});
    }

    res.json({ success: true, deleted: u.id });
  } catch (e) {
    console.error('[AdminDelete] Error:', e.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// ══════════════════════════════════════════════════════
//  FCM: Save push notification token
// ══════════════════════════════════════════════════════
app.post('/api/users/fcm-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'FCM token required' });
    // Store token — add fcm_token column via migration if not present
    const { error } = await supabase.from('users').update({ fcm_token: token }).eq('id', req.user.id);
    if (error) {
      console.warn('[FCM Token] Column may not exist yet — run migration:', error.message);
      return res.json({ success: false, message: 'FCM token not saved — run DB migration first' });
    }
    res.json({ success: true, message: 'Push notifications enabled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  PAYMENTS: Razorpay (India) — active after LLC registration
//  Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in Cloud Run env vars
// ══════════════════════════════════════════════════════

// Create a Razorpay order (called before payment screen opens)
app.post('/api/payments/create-order', auth, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({
        error: 'Payments not yet active',
        message: 'Razorpay integration is ready — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Cloud Run env vars to activate.',
        coming_soon: true,
      });
    }
    const { amount, bookingId, currency = 'INR', notes = {} } = req.body;
    if (!amount || !bookingId) return res.status(400).json({ error: 'amount and bookingId required' });
    if (amount < 100) return res.status(400).json({ error: 'Amount must be at least ₹1 (100 paise)' });

    // Verify booking belongs to this customer
    const { data: booking } = await supabase.from('bookings').select('id, status, assignment_status').eq('id', bookingId).eq('customer_id', req.user.id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found or not yours' });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay works in paise
      currency,
      receipt: `pclub_${bookingId.slice(0, 12)}`,
      notes: { bookingId, userId: req.user.id, ...notes },
    });

    // Save order ID to booking for reference
    await supabase.from('bookings').update({ razorpay_order_id: order.id }).eq('id', bookingId);
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('[Razorpay] Create order error:', err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// Verify Razorpay payment signature (called after payment success)
app.post('/api/payments/verify', auth, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Payments not yet active', coming_soon: true });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment verification fields' });

    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment signature mismatch — possible tamper attempt' });

    // Compute authoritative split from the confirmed payment amount
    // This overwrites the estimate stored at booking-creation time with the
    // real paid amount, then locks it — historical splits must never change.
    const { data: bk } = await supabase.from('bookings').select('amount, currency').eq('id', bookingId).single();
    const split = bk?.amount ? computeSplit(bk.amount, bk.currency || 'INR') : {};

    // Mark booking as paid + persist final revenue split
    await supabase.from('bookings').update({
      payment_status: 'paid',
      razorpay_payment_id,
      razorpay_order_id,
      payout_status: 'pending',
      ...(split ? {
        total_amount:      split.total_amount,
        platform_fee:      split.platform_fee,
        provider_earnings: split.provider_earnings,
        gateway_fee:       split.gateway_fee,
      } : {}),
    }).eq('id', bookingId).eq('customer_id', req.user.id);

    // Log payment
    try {
      await supabase.from('payment_logs').insert({
        booking_id: bookingId,
        user_id: req.user.id,
        razorpay_order_id,
        razorpay_payment_id,
        status: 'success',
      });
    } catch {} // table may not exist yet

    res.json({ success: true, message: '✅ Payment verified and booking confirmed!' });
  } catch (err) {
    console.error('[Razorpay] Verify error:', err.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// Get Razorpay public key (frontend uses this to initialize the checkout)
app.get('/api/payments/config', auth, (req, res) => {
  res.json({
    enabled: !!razorpay,
    key: razorpay ? process.env.RAZORPAY_KEY_ID : null,
    coming_soon: !razorpay,
    message: razorpay ? 'Payments active' : 'Payments coming soon — LLC registration in progress',
  });
});

// ══════════════════════════════════════════════════════
//  LOCATION GATEWAY — routes geocoding by country
//  +91 → Mappls (MapmyIndia)  best India coverage
//  +1  → (Phase 2) Google     US / Canada
//  *   → Nominatim             free OSM fallback
// ══════════════════════════════════════════════════════

/* ── Mappls static key helper ──────────────────────── */
// Mappls Cloud App issues a Static Key used directly as access_token.
// No OAuth2 / token exchange needed — simpler and zero latency overhead.
const getMapplsToken = async () => process.env.MAPPLS_STATIC_KEY || null;

/* ── Provider router ───────────────────────────────── */
const getGeoProvider = (phone = '') => {
  if (phone.startsWith('+91')) return 'mappls';
  // Phase 2: if (phone.startsWith('+1')) return 'google';
  return 'nominatim';
};

/* ── Mappls forward search ─────────────────────────── */
const searchMappls = async (q, token) => {
  const url = `https://atlas.mappls.com/api/places/search/json`
    + `?query=${encodeURIComponent(q)}&region=IND&access_token=${token}`;
  const d = await fetch(url).then(r => r.json());
  return (d.suggestedLocations || []).map((f, i) => ({
    id:         f.eLoc || i,
    short:      f.placeName  || '',
    full:       [f.placeName, f.placeAddress].filter(Boolean).join(', '),
    lat:        parseFloat(f.latitude)  || null,
    lng:        parseFloat(f.longitude) || null,
    postalCode: f.pincode || '',
    city:       f.city    || '',
    state:      f.state   || '',
  }));
};

/* ── Mappls reverse geocode ────────────────────────── */
const reverseMappls = async (lat, lng, token) => {
  const url = `https://atlas.mappls.com/api/places/geo_code`
    + `?lat=${lat}&lng=${lng}&access_token=${token}`;
  const d = await fetch(url).then(r => r.json());
  const r = d.results?.[0] || d.copResults || null;
  if (!r) return null;
  const full = r.formattedAddress
    || [r.houseNumber, r.houseName, r.street, r.subLocality,
        r.locality, r.city, r.state, r.pincode].filter(Boolean).join(', ');
  return { full, postalCode: r.pincode || '', city: r.city || r.district || '', state: r.state || '' };
};

/* ── Nominatim forward search (OSM fallback) ───────── */
const searchNominatim = async (q) => {
  const url = `https://nominatim.openstreetmap.org/search`
    + `?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6&accept-language=en`;
  const d = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': `PETclub/1.0 ${process.env.NOMINATIM_CONTACT || SUPPORT_EMAIL}` },
  }).then(r => r.json());
  return (d || []).map((f, i) => {
    const a = f.address || {};
    return {
      id:         f.place_id || i,
      short:      (f.display_name || '').split(', ')[0],
      full:       f.display_name,
      lat:        parseFloat(f.lat),
      lng:        parseFloat(f.lon),
      postalCode: a.postcode || '',
      city:       a.city || a.town || a.village || a.county || '',
      state:      a.state || '',
    };
  });
};

/* ── Nominatim reverse geocode ─────────────────────── */
const reverseNominatim = async (lat, lng) => {
  const url = `https://nominatim.openstreetmap.org/reverse`
    + `?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&accept-language=en`;
  const d = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': `PETclub/1.0 ${process.env.NOMINATIM_CONTACT || SUPPORT_EMAIL}` },
  }).then(r => r.json());
  const a = d.address || {};
  return {
    full:       d.display_name || '',
    postalCode: a.postcode || '',
    city:       a.city || a.town || a.village || a.county || '',
    state:      a.state || '',
  };
};

/* ── GET /api/geocode?q=... ────────────────────────── */
app.get('/api/geocode', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 3) return res.json([]);
  try {
    const { data: u } = await supabase.from('users').select('phone').eq('id', req.user.id).single();
    const provider = getGeoProvider(u?.phone || '');
    let results = [];

    if (provider === 'mappls') {
      const token = await getMapplsToken();
      if (token) {
        try { results = await searchMappls(q, token); } catch (e) {
          console.warn('[Mappls] search failed, falling back to Nominatim:', e.message);
        }
      }
    }
    // Phase 2: else if (provider === 'google') { results = await searchGoogle(q); }

    if (!results.length) results = await searchNominatim(q); // always fallback
    res.json(results);
  } catch (e) {
    console.error('[geocode]', e.message);
    try { res.json(await searchNominatim(q)); } catch { res.json([]); }
  }
});

/* ── GET /api/reverse-geocode?lat=...&lng=... ──────── */
app.get('/api/reverse-geocode', auth, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
  try {
    const { data: u } = await supabase.from('users').select('phone').eq('id', req.user.id).single();
    const provider = getGeoProvider(u?.phone || '');
    let result = null;

    if (provider === 'mappls') {
      const token = await getMapplsToken();
      if (token) {
        try { result = await reverseMappls(lat, lng, token); } catch (e) {
          console.warn('[Mappls] reverse failed, falling back to Nominatim:', e.message);
        }
      }
    }
    // Phase 2: else if (provider === 'google') { result = await reverseGoogle(lat, lng); }

    if (!result) result = await reverseNominatim(lat, lng);
    res.json(result || {});
  } catch (e) {
    console.error('[reverse-geocode]', e.message);
    try { res.json(await reverseNominatim(lat, lng)); } catch { res.json({}); }
  }
});

// ══════════════════════════════════════════════════════
//  HEALTH CHECK
//  Public: status + version only (no internal config)
//  Authenticated (X-Health-Secret header): full service map
//  CI/CD: curl -H "X-Health-Secret: $HEALTH_SECRET" $URL/api/health
// ══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  const authenticated = process.env.HEALTH_SECRET
    && req.headers['x-health-secret'] === process.env.HEALTH_SECRET;
  const base = {
    status:  '🐾 PETclub API running',
    version: API_VERSION,
    time:    new Date(),
  };
  if (!authenticated) return res.json(base);
  // Full response for CI/CD and ops tooling only
  res.json({
    ...base,
    config: {
      booking_response_timeout_mins: RESPONSE_TIMEOUT_MINS,
      web_app_url: WEB_APP_URL,
      website_url: WEBSITE_URL,
    },
    services: {
      supabase:      '✅',
      zoho_smtp:     process.env.ZOHO_SMTP_USER ? '✅' : '⚠️ not configured',
      firebase_auth: firebaseAdmin ? '✅ live' : '⏳ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)',
      razorpay:      razorpay ? '✅ live' : '⏳ pending (set env vars)',
      fcm:           firebaseAdmin ? '✅ live' : '⏳ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)',
      mappls_geo:    process.env.MAPPLS_STATIC_KEY ? '✅ configured' : '⚠️ not set — using Nominatim fallback',
    },
  });
});
// ══════════════════════════════════════════════════════
//  ADMIN: Full platform health — powers the Platform Status widget
//  Uses JWT admin auth so no secret header is needed in the browser.
// ══════════════════════════════════════════════════════
app.get('/api/admin/health', auth, adminOnly, async (req, res) => {
  // Run all service pings in parallel — 5 s timeout each so the endpoint
  // never hangs longer than ~5 s even if one provider is completely down.
  const ping = (promise, timeoutMs = 5000) =>
    Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);

  const [supOk, fbOk, smtpOk, twilioOk, razOk] = await Promise.all([
    // Supabase — lightweight SELECT 1
    ping(supabase.from('users').select('id', { count: 'exact', head: true }))
      .then(({ error }) => !error)
      .catch(() => false),

    // Firebase Admin SDK — list 1 user (minimal scoped call)
    firebaseAdmin
      ? ping(firebaseAdmin.auth().listUsers(1)).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured

    // Zoho SMTP — nodemailer verify (tests TCP + auth handshake)
    ping(emailService.pingSmtp()).catch(() => false),

    // Twilio — fetch own account (1 API call)
    _twilioClient
      ? ping(_twilioClient.api.accounts(_twilioSid).fetch()).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured

    // Razorpay — fetch order list with count:1
    razorpay
      ? ping(razorpay.orders.all({ count: 1 })).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured (awaiting LLC)
  ]);

  const svc = (ok, label, pendingMsg) => {
    if (ok === null) return pendingMsg || '⏳ pending';
    return ok ? `✅` : `⚠️ ${label} unreachable`;
  };

  res.json({
    status:  '🐾 PETclub API running',
    version: API_VERSION,
    time:    new Date(),
    config: {
      booking_response_timeout_mins: RESPONSE_TIMEOUT_MINS,
      web_app_url: WEB_APP_URL,
      website_url: WEBSITE_URL,
    },
    services: {
      supabase:      svc(supOk,    'Supabase'),
      twilio_sms:    svc(twilioOk, 'Twilio',   '⚠️ not configured (email fallback active)'),
      zoho_smtp:     svc(smtpOk,   'Zoho SMTP','⚠️ not configured'),
      firebase_auth: svc(fbOk,     'Firebase', '⏳ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)'),
      razorpay:      svc(razOk,    'Razorpay', '⏳ pending (set RAZORPAY env vars)'),
      fcm:           svc(fbOk,     'Firebase', '⏳ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)'),
      mappls_geo:    process.env.MAPPLS_STATIC_KEY ? '✅ configured' : '⚠️ not set — using Nominatim fallback',
    },
  });
});

// ══════════════════════════════════════════════════════
//  ADMIN: DB Audit — scan every table for stale/orphan rows
// ══════════════════════════════════════════════════════
app.get('/api/admin/db-audit', auth, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const stale7d  = new Date(now - 7  * 86400e3).toISOString();
    const stale30d = new Date(now - 30 * 86400e3).toISOString();

    // 1. Counts per table
    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: suspendedUsers },
      { count: pendingRoleUsers },
      { count: totalPros },
      { count: pendingPros },
      { count: totalCusts },
      { count: totalPets },
      { count: totalBookings },
      { count: staleOtps },
      { count: totalLeads },
      { count: totalLogs },
      { count: totalPaymentLogs },
    ] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', false).neq('role', 'admin'),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'pending_role'),
      supabase.from('professional_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('professional_profiles').select('id', { count: 'exact', head: true }).eq('verification_status', 'pending'),
      supabase.from('customer_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('pets').select('id', { count: 'exact', head: true }),
      supabase.from('bookings').select('id', { count: 'exact', head: true }),
      supabase.from('otp_tokens').select('id', { count: 'exact', head: true }).lt('expires_at', now.toISOString()),
      supabase.from('website_leads').select('id', { count: 'exact', head: true }),
      supabase.from('admin_logs').select('id', { count: 'exact', head: true }),
      Promise.resolve(supabase.from('payment_logs').select('id', { count: 'exact', head: true })).catch(() => ({ count: 0 })),
    ]);

    // 2. Orphaned profiles (user_id missing from users)
    const { data: allProfProfiles } = await supabase.from('professional_profiles').select('user_id');
    const { data: allCustProfiles  } = await supabase.from('customer_profiles').select('user_id');
    const { data: allPets          } = await supabase.from('pets').select('owner_id');
    const { data: allUsers         } = await supabase.from('users').select('id');
    const userIdSet = new Set((allUsers || []).map(u => u.id));
    const orphanProfProfiles = (allProfProfiles || []).filter(p => !userIdSet.has(p.user_id)).length;
    const orphanCustProfiles = (allCustProfiles || []).filter(p => !userIdSet.has(p.user_id)).length;
    const orphanPets         = (allPets         || []).filter(p => !userIdSet.has(p.owner_id)).length;

    // 3. Stale pending_role users (signed up but never completed profile, >7 days old)
    const { data: stalePendingUsers } = await supabase
      .from('users').select('id, phone, created_at')
      .eq('role', 'pending_role').lt('created_at', stale7d);

    // 4. Bookings in stale states
    const { count: cancelledBookings } = await supabase
      .from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'cancelled');
    const { count: testBookings } = await supabase
      .from('bookings').select('id', { count: 'exact', head: true })
      .eq('status', 'upcoming').lt('service_date', stale30d);

    // 5. Website leads older than 30 days
    const { count: staleLeads } = await supabase
      .from('website_leads').select('id', { count: 'exact', head: true }).lt('created_at', stale30d);

    res.json({
      success: true,
      audit: {
        users:            { total: totalUsers, active: activeUsers, suspended: suspendedUsers, pending_role: pendingRoleUsers },
        professionals:    { total: totalPros, pending_verification: pendingPros },
        customers:        { total: totalCusts },
        pets:             { total: totalPets },
        bookings:         { total: totalBookings, cancelled: cancelledBookings, stale_upcoming: testBookings },
        orphans:          { professional_profiles: orphanProfProfiles, customer_profiles: orphanCustProfiles, pets: orphanPets },
        stale_pending_users: { count: stalePendingUsers?.length || 0, ids: stalePendingUsers?.map(u => u.id) || [] },
        otp_tokens:       { expired: staleOtps },
        website_leads:    { total: totalLeads, older_than_30d: staleLeads },
        admin_logs:       { total: totalLogs },
        payment_logs:     { total: totalPaymentLogs },
      },
    });
  } catch (e) {
    console.error('[DB Audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
//  ADMIN: DB Cleanup — remove confirmed stale/orphan rows
//  Accepts { targets: [...] } — array of what to clean:
//  "expired_otps", "orphan_profiles", "stale_pending_users",
//  "cancelled_bookings", "stale_leads"
// ══════════════════════════════════════════════════════
app.delete('/api/admin/db-cleanup', auth, adminOnly, async (req, res) => {
  const { targets = [] } = req.body;
  const report = {};
  const now = new Date();
  const stale7d  = new Date(now - 7  * 86400e3).toISOString();
  const stale30d = new Date(now - 30 * 86400e3).toISOString();

  try {
    // Expired OTP tokens
    if (targets.includes('expired_otps')) {
      const { error, count } = await supabase.from('otp_tokens')
        .delete({ count: 'exact' }).lt('expires_at', now.toISOString());
      report.expired_otps = error ? `error: ${error.message}` : (count || 0);
    }

    // Orphaned professional_profiles (no matching user)
    if (targets.includes('orphan_profiles')) {
      const { data: allUsers } = await supabase.from('users').select('id');
      const userIds = (allUsers || []).map(u => u.id);
      const { data: profProfiles } = await supabase.from('professional_profiles').select('user_id');
      const { data: custProfiles  } = await supabase.from('customer_profiles').select('user_id');
      const { data: allPets       } = await supabase.from('pets').select('id, owner_id');
      const userIdSet = new Set(userIds);

      const orphanProfIds = (profProfiles || []).filter(p => !userIdSet.has(p.user_id)).map(p => p.user_id);
      const orphanCustIds = (custProfiles  || []).filter(p => !userIdSet.has(p.user_id)).map(p => p.user_id);
      const orphanPetIds  = (allPets       || []).filter(p => !userIdSet.has(p.owner_id)).map(p => p.id);

      let deleted = 0;
      if (orphanProfIds.length) { await supabase.from('professional_profiles').delete().in('user_id', orphanProfIds); deleted += orphanProfIds.length; }
      if (orphanCustIds.length) { await supabase.from('customer_profiles').delete().in('user_id', orphanCustIds).catch(() => {}); deleted += orphanCustIds.length; }
      if (orphanPetIds.length)  { await supabase.from('pets').delete().in('id', orphanPetIds).catch(() => {}); deleted += orphanPetIds.length; }
      report.orphan_profiles = deleted;
    }

    // Stale pending_role users (never completed signup, >7 days)
    if (targets.includes('stale_pending_users')) {
      const { data: stale } = await supabase.from('users').select('id, phone')
        .eq('role', 'pending_role').lt('created_at', stale7d);
      if (stale?.length) {
        const ids   = stale.map(u => u.id);
        const phones = stale.map(u => u.phone);
        await supabase.from('professional_profiles').delete().in('user_id', ids).catch(() => {});
        await supabase.from('customer_profiles').delete().in('user_id', ids).catch(() => {});
        await supabase.from('pets').delete().in('owner_id', ids).catch(() => {});
        await supabase.from('otp_tokens').delete().in('phone', phones).catch(() => {});
        await supabase.from('admin_logs').delete().in('target_id', ids).catch(() => {});
        await supabase.from('users').delete().in('id', ids);
      }
      report.stale_pending_users = stale?.length || 0;
    }

    // Cancelled bookings
    if (targets.includes('cancelled_bookings')) {
      const { error, count } = await supabase.from('bookings')
        .delete({ count: 'exact' }).eq('status', 'cancelled');
      report.cancelled_bookings = error ? `error: ${error.message}` : (count || 0);
    }

    // Website leads older than 30 days
    if (targets.includes('stale_leads')) {
      const { error, count } = await supabase.from('website_leads')
        .delete({ count: 'exact' }).lt('created_at', stale30d);
      report.stale_leads = error ? `error: ${error.message}` : (count || 0);
    }

    try {
      await supabase.from('admin_logs').insert({
        admin_id: req.user.id, action: 'db_cleanup', target_type: 'system',
        notes: `Cleaned: ${JSON.stringify(report)}`,
      });
    } catch {} // non-critical audit log — cleanup already completed

    res.json({ success: true, cleaned: report });
  } catch (e) {
    console.error('[DB Cleanup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

// ── Startup migration: add live-tracking columns to bookings (safe, IF NOT EXISTS) ──
async function runStartupMigrations() {
  const migrations = [
    // Bookings: live tracking + GPS coords
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_lat                  DOUBLE PRECISION`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_lng                  DOUBLE PRECISION`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_location_updated_at  TIMESTAMPTZ`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ten_min_notified         BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address_lat              DOUBLE PRECISION`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address_lng              DOUBLE PRECISION`,
    // Professional profiles: GPS address for 70km radius dispatch + pet type specializations
    `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_lat DOUBLE PRECISION`,
    `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS address_lng DOUBLE PRECISION`,
    `ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS pet_types   JSONB`,
    // Pets: health notes visible to assigned professionals
    `ALTER TABLE pets ADD COLUMN IF NOT EXISTS health_notes TEXT`,
    // Bookings: revenue split (30/70) + payment/payout tracking
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount      NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee      NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_earnings NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gateway_fee       NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency          TEXT DEFAULT 'INR'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_status     TEXT DEFAULT 'pending'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_reference  TEXT`,
  ];
  for (const sql of migrations) {
    // PostgREST can't run DDL, but Supabase service-role key can call
    // the pg_query RPC if it's enabled — fallback: log and continue
    const { error } = await Promise.resolve(supabase.rpc('pg_query', { query: sql })).catch(() => ({ error: { message: 'rpc_not_available' } }));
    if (error && !error.message?.includes('already exists') && !error.message?.includes('rpc_not_available')) {
      console.warn('[migration] Could not run:', sql.slice(0, 60), '→', error.message);
    }
  }
}

// ── Startup: link ADMIN_EMAIL to the admin user record ────────────────────────
// Ensures the admin can log in via email OTP by making sure the admin user's
// email field in Supabase matches the ADMIN_EMAIL env var.
// Also cleans up any stale pending_role duplicate that may have been created
// when someone tried to log in with the admin email before it was linked.
// Runs once at startup; safe to repeat — idempotent.
async function seedAdminEmail() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return; // nothing to do without ADMIN_EMAIL env var

  const targetEmail = adminEmail.toLowerCase().trim();

  // Find the real admin user (role = 'admin')
  const { data: admins, error } = await supabase
    .from('users')
    .select('id, email')
    .eq('role', 'admin')
    .limit(1);

  if (error || !admins?.length) {
    console.warn('[adminSeed] No admin user found in Supabase — skipping email link');
    return;
  }

  const admin = admins[0];
  const existingEmail = (admin.email || '').toLowerCase().trim();

  // Step 1: ALWAYS delete any stale pending_role/customer duplicate that has
  // the target email (created when admin tried logging in before email was linked).
  // Run this check regardless of whether admin email already matches.
  const { data: dupes } = await supabase
    .from('users')
    .select('id, role')
    .eq('email', targetEmail)
    .neq('id', admin.id);

  if (dupes?.length) {
    for (const dupe of dupes) {
      if (dupe.role === 'pending_role' || dupe.role === 'customer') {
        await supabase.from('users').delete().eq('id', dupe.id);
        console.log(`[adminSeed] 🗑️ Removed stale duplicate user (${dupe.role}) with email ${maskEmail(targetEmail)}`);
      }
    }
  }

  if (existingEmail === targetEmail) {
    // Already linked — nothing to do
    console.log(`[adminSeed] Admin email already linked: ${maskEmail(adminEmail)}`);
    return;
  }

  // Step 2: Link the admin email
  const { error: updateErr } = await supabase
    .from('users')
    .update({ email: targetEmail })
    .eq('id', admin.id);

  if (updateErr) {
    console.warn('[adminSeed] Could not link admin email:', updateErr.message);
  } else {
    console.log(`[adminSeed] ✅ Admin email linked → ${maskEmail(adminEmail)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 🧪  TEST MOVEMENT — POST /api/test/move-seed-provider
//
// Simulates the seed provider sending a GPS update.
// Secured by X-Test-Key header matching the SEED_TEST_KEY env var —
// works in ANY environment (including production) as long as the key is set.
// Also broadcasts to any open SSE connections so the Mappls marker moves live.
//
// Usage:
//   curl -X POST https://api.mypetclub.app/api/test/move-seed-provider \
//        -H "Content-Type: application/json" \
//        -H "X-Test-Key: <SEED_TEST_KEY value>" \
//        -d '{"lat":12.9325,"lng":77.6185}'
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/test/move-seed-provider', async (req, res) => {
  const testKey = process.env.SEED_TEST_KEY;
  if (!testKey) {
    return res.status(503).json({ error: 'SEED_TEST_KEY env var not set — add it to Cloud Run env vars to enable this endpoint.' });
  }
  if (req.headers['x-test-key'] !== testKey) {
    return res.status(403).json({ error: 'Invalid X-Test-Key header.' });
  }

  try {
    const DEFAULT_BOOKING_ID = '9dc0d859-7ded-41b3-83d7-7b570be7ceee';
    const { lat, lng, bookingId = DEFAULT_BOOKING_ID } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng must be numbers.' });
    }

    // Persist to DB (REST-polling clients and SSE reconnects pick this up)
    await supabase.from('bookings').update({
      pro_lat:                 lat,
      pro_lng:                 lng,
      pro_location_updated_at: new Date().toISOString(),
    }).eq('id', bookingId);

    // Push immediately to all open SSE connections for this booking
    const clients = trackingClients.get(bookingId);
    const pushed  = clients?.size || 0;
    if (clients && pushed > 0) {
      const payload = JSON.stringify({ lat, lng });
      clients.forEach(clientRes => {
        try { clientRes.write(`data: ${payload}\n\n`); } catch (_) {}
      });
    }

    console.log(`[seed-move] Booking ${bookingId} → (${lat}, ${lng}) — pushed to ${pushed} SSE client(s)`);
    return res.json({ ok: true, lat, lng, bookingId, sseClientsPushed: pushed });
  } catch (err) {
    console.error('[seed-move] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 🧪  TEST SEED — /api/test/seed-active-provider
//
// DEV ONLY — blocked in production (ALLOW_DEV_TOOLS must be set to bypass).
// Creates/upserts a mock Groomer, approves their profile, and forces an
// "on_the_way" trip so TrackingMapMappls renders with real live-tracking data.
//
// POST /api/test/seed-active-provider
//   body (optional): { bookingId: "<uuid>" }   — defaults to latest test-customer booking
//   Returns: { ok, seed: { provider, booking, instructions } }
//
// DELETE /api/test/seed-active-provider       — teardown / clean up seed data
// ═══════════════════════════════════════════════════════════════════════

const SEED_PROVIDER_EMAIL = 'test-provider@mailinator.com';
const SEED_PROVIDER_PHONE = '+919000009001';   // +91 → Mappls map engine
const SEED_PROVIDER_NAME  = 'Sai Groomer (Test)';
// Default test-customer ID — user created during E2E customer registration
const SEED_CUSTOMER_ID    = 'b8a8947c-226f-4bc4-ab79-6deec8b11c03';

app.post('/api/test/seed-active-provider', async (req, res) => {
  if (IS_PROD) {
    return res.status(403).json({
      error: 'Seed endpoints are disabled in production. Set ALLOW_DEV_TOOLS=true in your local .env to use this.',
    });
  }

  try {
    // ── 1. Upsert mock provider user ──────────────────────────────────
    let { data: providerUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', SEED_PROVIDER_EMAIL)
      .maybeSingle();

    if (!providerUser) {
      const { data: newUser, error: userErr } = await supabase
        .from('users')
        .insert({
          phone:     SEED_PROVIDER_PHONE,
          name:      SEED_PROVIDER_NAME,
          email:     SEED_PROVIDER_EMAIL,
          role:      'provider',
          is_active: true,
        })
        .select('id')
        .single();
      if (userErr) throw new Error('Failed to create provider user: ' + userErr.message);
      providerUser = newUser;
      console.log('[seed] Created provider user:', providerUser.id);
    } else {
      await supabase.from('users').update({
        phone:     SEED_PROVIDER_PHONE,
        name:      SEED_PROVIDER_NAME,
        role:      'provider',
        is_active: true,
      }).eq('id', providerUser.id);
      console.log('[seed] Updated existing provider user:', providerUser.id);
    }

    // ── 2. Upsert professional profile (approved groomer) ─────────────
    // Home base: Koramangala Sector 6 — pin 560095
    const PROFILE_LAT = 12.9279;
    const PROFILE_LNG = 77.6100;

    let { data: profile } = await supabase
      .from('professional_profiles')
      .select('id')
      .eq('user_id', providerUser.id)
      .maybeSingle();

    if (!profile) {
      const { data: newProf, error: profErr } = await supabase
        .from('professional_profiles')
        .insert({
          user_id:             providerUser.id,
          sub_role:            'groomer',
          city:                'Bengaluru',
          area:                'Koramangala',
          services:            ['bath_brush', 'haircut', 'nail_trim'],
          experience:          '5 years',
          bio:                 'Test groomer seeded for E2E map tracking tests.',
          service_areas:       'Koramangala, BTM Layout, HSR Layout',
          verification_status: 'approved',
          is_available:        true,
          rating:              4.8,
          total_reviews:       12,
          address_lat:         PROFILE_LAT,
          address_lng:         PROFILE_LNG,
          address_postal_code: '560095',
          address_city:        'Bengaluru',
          address_state:       'Karnataka',
        })
        .select('id')
        .single();
      if (profErr) throw new Error('Failed to create professional profile: ' + profErr.message);
      profile = newProf;
      console.log('[seed] Created professional profile:', profile.id);
    } else {
      await supabase.from('professional_profiles').update({
        sub_role:            'groomer',
        verification_status: 'approved',
        is_available:        true,
        address_lat:         PROFILE_LAT,
        address_lng:         PROFILE_LNG,
        address_postal_code: '560095',
        address_city:        'Bengaluru',
        address_state:       'Karnataka',
      }).eq('id', profile.id);
      console.log('[seed] Updated existing professional profile:', profile.id);
    }

    // ── 3. Resolve target booking ─────────────────────────────────────
    const { bookingId } = req.body || {};
    let targetBooking;

    if (bookingId) {
      const { data: bk } = await supabase
        .from('bookings')
        .select('id, customer_id, address_lat, address_lng, service_type, service_name')
        .eq('id', bookingId)
        .maybeSingle();
      targetBooking = bk;
    }

    if (!targetBooking) {
      // Default: most-recent open booking for the E2E test customer
      const { data: bk } = await supabase
        .from('bookings')
        .select('id, customer_id, address_lat, address_lng, service_type, service_name')
        .eq('customer_id', SEED_CUSTOMER_ID)
        .not('assignment_status', 'in', '("completed","cancelled")')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      targetBooking = bk;
    }

    if (!targetBooking) {
      return res.status(404).json({
        error: 'No eligible booking found. Create a booking via the customer flow first, or pass bookingId in the request body.',
      });
    }

    // Pro start position: ~1.8 km west of customer pin (realistic en-route offset)
    const custLat = targetBooking.address_lat ?? 12.9357;
    const custLng = targetBooking.address_lng ?? 77.6241;
    const proStartLat = +(custLat - 0.006).toFixed(6);   // ~660m south
    const proStartLng = +(custLng - 0.014).toFixed(6);   // ~1.2km west  → combined ~1.6km

    // ── 4. Force booking into "on_the_way" active state ──────────────
    await supabase.from('bookings').update({
      professional_id:         profile.id,
      assignment_status:       'on_the_way',
      status:                  'upcoming',
      pro_lat:                 proStartLat,
      pro_lng:                 proStartLng,
      pro_location_updated_at: new Date().toISOString(),
    }).eq('id', targetBooking.id);

    // Insert/upsert a booking_assignments row so the state is fully consistent
    // (status='confirmed' matches what a normal accept flow would have left)
    await supabase.from('booking_assignments').upsert({
      booking_id:        targetBooking.id,
      professional_id:   profile.id,
      status:            'confirmed',
      offered_at:        new Date().toISOString(),
      responded_at:      new Date().toISOString(),
    }, { onConflict: 'booking_id, professional_id', ignoreDuplicates: false });

    console.log(`[seed] Booking ${targetBooking.id} → on_the_way, pro @ (${proStartLat}, ${proStartLng})`);

    // ── 5. Issue a 24-hour provider JWT ──────────────────────────────
    const providerToken = jwt.sign(
      { id: providerUser.id, role: 'provider', phone: SEED_PROVIDER_PHONE },
      JWT_SECRET,
      { expiresIn: '24h' },
    );

    // ── 6. Return seed manifest ───────────────────────────────────────
    return res.json({
      ok:   true,
      seed: {
        provider: {
          id:           providerUser.id,
          email:        SEED_PROVIDER_EMAIL,
          phone:        SEED_PROVIDER_PHONE,
          name:         SEED_PROVIDER_NAME,
          role:         'provider',
          profile_id:   profile.id,
          sub_role:     'groomer',
          verification: 'approved',
          location: { lat: proStartLat, lng: proStartLng },
          token:        providerToken,
        },
        booking: {
          id:                targetBooking.id,
          customer_id:       targetBooking.customer_id,
          professional_id:   profile.id,
          assignment_status: 'on_the_way',
          service_name:      targetBooking.service_name,
          customer_pin:      { lat: custLat, lng: custLng },
          pro_start:         { lat: proStartLat, lng: proStartLng },
        },
        instructions: [
          '─── How to run TrackingMapMappls E2E test ───',
          '1. Open the customer app (app.mypetclub.app) and log in as petclub-cust2@mailinator.com',
          '2. Go to My Bookings — the booking should show assignment_status = on_the_way',
          '3. Tap the booking → the Mappls map opens with an animated pro marker ~1.6 km away',
          '4. Simulate pro movement (call this repeatedly to animate the marker):',
          `   curl -X POST https://api.mypetclub.app/api/test/move-seed-provider \\`,
          `        -H "Content-Type: application/json" \\`,
          `        -H "X-Test-Key: <SEED_TEST_KEY value>" \\`,
          `        -d '{"lat":${(proStartLat + 0.002).toFixed(6)},"lng":${(proStartLng + 0.003).toFixed(6)}}'`,
          '5. When done: DELETE /api/test/seed-active-provider  (tears everything down)',
          '',
          'Pro JWT (valid 24h — use as Authorization: Bearer <token>):',
          providerToken,
        ],
      },
    });
  } catch (err) {
    console.error('[seed-active-provider] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Teardown: remove all seed data ────────────────────────────────────
app.delete('/api/test/seed-active-provider', async (req, res) => {
  if (IS_PROD) {
    return res.status(403).json({ error: 'Seed endpoints are disabled in production.' });
  }
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', SEED_PROVIDER_EMAIL)
      .maybeSingle();

    if (!user) return res.json({ ok: true, message: 'Nothing to clean up — seed provider not found.' });

    const { data: profile } = await supabase
      .from('professional_profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profile) {
      // Reset bookings that were assigned to this seed pro
      await supabase.from('bookings').update({
        professional_id:         null,
        assignment_status:       'no_pros_available',
        pro_lat:                 null,
        pro_lng:                 null,
        pro_location_updated_at: null,
      }).eq('professional_id', profile.id);

      // Remove assignment rows
      await supabase.from('booking_assignments').delete().eq('professional_id', profile.id);
      // Remove professional profile
      await supabase.from('professional_profiles').delete().eq('id', profile.id);
    }

    // Remove user
    await supabase.from('users').delete().eq('id', user.id);

    console.log('[seed] Teardown complete — seed provider removed.');
    return res.json({ ok: true, message: 'Seed provider cleaned up successfully.' });
  } catch (err) {
    console.error('[seed-active-provider teardown] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🐾 PETclub API → http://localhost:${PORT}`);
  // Run migrations in background — won't block startup
  runStartupMigrations().catch(e => console.warn('[startup migration]', e.message));
  // Link admin email so email OTP login finds the right account
  seedAdminEmail().catch(e => console.warn('[adminSeed]', e.message));
});