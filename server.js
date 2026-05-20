// ═══════════════════════════════════════════════════════════
//  PETclub India — Complete Backend API v1.0
//  Stack: Node.js + Express + Twilio + Nodemailer (Zoho SMTP) + Supabase + JWT
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Trust Cloud Run reverse proxy — needed for rate-limit & real IP
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const WEB_APP_URL = 'https://app.mypetclub.app';
const WEBSITE_URL = 'https://mypetclub.app';

// ── Services ───────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── Zoho SMTP transporter ─────────────────────────────
// Env vars required: ZOHO_SMTP_USER, ZOHO_SMTP_PASS
// ZOHO_SMTP_USER = saikrishna.kolanupaka@mypetclub.app
// ZOHO_SMTP_FROM = support@mypetclub.app  (optional — defaults below)
const zohoTransporter = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 587,
  secure: false,   // STARTTLS on 587
  auth: {
    user: process.env.ZOHO_SMTP_USER,
    pass: process.env.ZOHO_SMTP_PASS,
  },
});

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
const ALLOWED_ORIGINS = [
  'https://app.mypetclub.app',
  'https://mypetclub.app',
  'https://www.mypetclub.app',
  'https://app.mypetclub.app',       // legacy — keep during DNS cutover
  'https://mypetclub.app',   // legacy — keep during DNS cutover
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
  process.env.FRONTEND_URL,
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
// OTP-specific rate limit
const otpLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many OTP requests. Please wait 1 minute and try again.' }),
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

const sendSMS = async (fullPhone, body) => {
  return twilioClient.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: fullPhone });
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

const sendEmail = async (to, subject, html) => {
  if (!process.env.ZOHO_SMTP_USER || !process.env.ZOHO_SMTP_PASS) {
    console.warn(`[Email skipped — ZOHO_SMTP_USER/PASS not set] to=${to}`);
    return;
  }
  const from = process.env.ZOHO_SMTP_FROM
    ? `PETclub <${process.env.ZOHO_SMTP_FROM}>`
    : 'PETclub <support@mypetclub.app>';
  const result = await zohoTransporter.sendMail({ from, to, subject, html });
  console.log(`[Zoho SMTP] Email sent to ${to} (msgId: ${result.messageId})`);
  return result;
};

// ══════════════════════════════════════════════════════
//  STORAGE: init id-documents bucket on startup
// ══════════════════════════════════════════════════════
(async () => {
  try {
    await supabase.storage.createBucket('id-documents', { public: true });
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
//  BOOKING DISPATCH SYSTEM — Round-Robin / Uber-style
// ══════════════════════════════════════════════════════
const RESPONSE_TIMEOUT_MINS = 5; // Pro has 5 mins to Accept/Reject

// Round-robin: find next eligible professional (not already tried for this booking)
const findNextPro = async (city, subRole, excludeProIds = []) => {
  let q = supabase
    .from('professional_profiles')
    .select('id, user_id, last_assigned_at, users(name, phone, email)')
    .eq('verification_status', 'approved')
    .eq('is_available', true)
    .eq('sub_role', subRole);
  if (city) q = q.ilike('city', `%${city}%`);
  // Exclude pros who already got this booking and rejected / timed out
  for (const xid of excludeProIds) q = q.neq('id', xid);
  const { data: pros } = await q;
  if (!pros || pros.length === 0) return null;
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
  const dateStr  = bookingDetails.scheduled_at
    ? new Date(bookingDetails.scheduled_at).toLocaleString('en-IN', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
    : 'TBD';
  const location = bookingDetails.city || bookingDetails.address || 'TBD';
  const proPhone = pro.users?.phone;
  const proEmail = pro.users?.email;

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
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">Pet</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${petName}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">Date & Time</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${dateStr}</td></tr>
          <tr><td style="padding:8px 0;font-size:12px;color:#94a3b8">Location</td><td style="padding:8px 0;font-size:14px;font-weight:700;color:#1e293b">${location}</td></tr>
        </table>
        <div style="text-align:center;margin-bottom:16px;">
          <a href="https://app.mypetclub.app" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;padding:14px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;">✅ Open App to Respond</a>
        </div>
        <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0;">No response in ${RESPONSE_TIMEOUT_MINS} mins → request auto-passes to next professional</p>
      </div>
    </div>`;

  if (proEmail) {
    sendEmail(proEmail, `🐾 New Booking Request — ${svc} · Respond in ${RESPONSE_TIMEOUT_MINS} min`, notifHtml).catch(console.error);
  }
  if (proPhone) {
    sendSMS(
      proPhone.startsWith('+') ? proPhone : `+91${proPhone}`,
      `🐾 PETclub: New ${svc} booking for ${petName}!\n📅 ${dateStr} · 📍 ${location}\n⏰ Accept or Reject within ${RESPONSE_TIMEOUT_MINS} mins in the app.\nhttps://app.mypetclub.app`
    ).catch(console.error);
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
    // Get pet name for notification
    let petName = 'Pet';
    if (bk.pet_id) {
      const { data: pet } = await supabase.from('pets').select('name').eq('id', bk.pet_id).single();
      petName = pet?.name || 'Pet';
    }
    const nextPro = await findNextPro(bk.city || '', bk.service_type || '', excludeIds);
    if (nextPro) {
      await offerBookingToPro(assignment.booking_id, nextPro, { ...bk, pet_name: petName });
    } else {
      await supabase.from('bookings').update({ assignment_status: 'no_pros_available', professional_id: null }).eq('id', assignment.booking_id);
    }
  }
};

// ══════════════════════════════════════════════════════
//  AUTH: SEND OTP  (SMS for US · Email for India)
//
//  Email delivery strategy:
//  1. Always try user's OWN email first (direct delivery)
//  2. Always CC admin (ADMIN_EMAIL env) so admin sees every OTP during beta
//     → Admin can verbally relay code to user if direct delivery fails
//  3. Once Gmail SMTP is configured → direct delivery always works
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-otp', otpLimit, async (req, res) => {
  try {
    const { phone, countryCode = '91', email } = req.body;
    if (!phone || !/^\d{6,15}$/.test(phone))
      return res.status(400).json({ error: 'Valid phone number required' });

    const isIndia = countryCode === '91';
    const fullPhone = `+${countryCode}${phone}`;
    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();
    // Admin email receives a copy of every OTP during beta testing
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;

    // Store OTP in DB
    await supabase.from('otp_tokens').upsert(
      { phone: fullPhone, otp, expires_at: expires, verified: false },
      { onConflict: 'phone' }
    );

    // ── OTP email template (sent to user) ──
    const userOtpHtml = `
      <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:420px;margin:0 auto;text-align:center;padding:40px 20px;background:#fff;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
        <div style="font-size:52px;margin-bottom:12px">🐾</div>
        <h2 style="color:#1e293b;font-size:22px;margin:0 0 6px">Your PETclub OTP</h2>
        <p style="color:#64748b;font-size:14px;margin:0 0 28px">Use this code to sign in or create your account</p>
        <div style="background:#fff7ed;border:2px solid #f97316;border-radius:16px;padding:28px 20px;margin-bottom:24px;">
          <div style="font-size:44px;font-weight:900;color:#f97316;letter-spacing:10px;font-family:monospace">${otp}</div>
        </div>
        <p style="color:#94a3b8;font-size:13px;margin:0">Valid for <strong>10 minutes</strong> · Never share this code</p>
        <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
        <p style="color:#cbd5e1;font-size:11px">© 2025 PETclub · For pets, with love 🐾</p>
      </div>`;

    // ── Admin relay template (always sent to admin during beta) ──
    const adminRelayHtml = (userEmail, userPhone) => `
      <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:460px;margin:0 auto;padding:20px;background:#fff;">
        <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:16px;margin-bottom:20px;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#166534;">🔔 PETclub — OTP Admin Copy</p>
          <p style="margin:6px 0 0;font-size:12px;color:#15803d;">
            User phone: <strong>${userPhone}</strong><br/>
            User email: <strong>${userEmail || 'not provided'}</strong><br/>
            OTP: <strong style="font-size:18px;letter-spacing:4px;font-family:monospace">${otp}</strong>
          </p>
        </div>
        ${userOtpHtml}
      </div>`;

    const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (isIndia) {
      // ── India (+91): Email is the ONLY channel (Twilio SMS unavailable) ──
      if (!validEmail)
        return res.status(400).json({ error: 'Email address is required for India (+91) — your OTP will be sent to it.' });

      // 1️⃣ Send directly to user's own email (works with Gmail SMTP; may be limited on Resend)
      let sentToUser = false;
      sendEmail(email, `🐾 Your PETclub OTP: ${otp}`, userOtpHtml)
        .then(() => { sentToUser = true; console.log(`[OTP] Delivered to user: ${email}`); })
        .catch(e => console.error(`[OTP] User email failed (${email}):`, e.message));

      // 2️⃣ Always send admin copy — ensures OTP is always visible during beta
      if (adminEmail && adminEmail !== email) {
        sendEmail(adminEmail, `🔔 [PETclub OTP Copy] ${fullPhone} → ${email}`, adminRelayHtml(email, fullPhone))
          .catch(e => console.error('[OTP] Admin copy failed:', e.message));
      }

      return res.json({
        success: true,
        message: `OTP sent to ${email} · 🇮🇳 Check your inbox & spam folder`,
      });
    }

    // ── US (+1): SMS + Email fired in parallel (non-blocking) ──
    sendSMS(fullPhone, `Your PETclub OTP is: ${otp}\nValid 10 minutes. Do not share. 🐾`)
      .then(() => console.log(`[OTP] SMS sent to ${fullPhone}`))
      .catch(e => console.error('SMS failed:', e.message));

    if (validEmail) {
      sendEmail(email, `🐾 Your PETclub OTP: ${otp}`, userOtpHtml)
        .then(() => console.log(`[OTP] Email sent to ${email}`))
        .catch(e => console.error(`[OTP] Email failed (${email}):`, e.message));
    }

    // Admin copy
    if (adminEmail && adminEmail !== email) {
      sendEmail(adminEmail, `🔔 [PETclub OTP Copy] ${fullPhone} → ${email || 'SMS only'}`, adminRelayHtml(email, fullPhone))
        .catch(e => console.error('[OTP] Admin copy failed:', e.message));
    }

    res.json({
      success: true,
      message: validEmail
        ? `OTP sent via SMS + email to ${email} · 🇺🇸`
        : `OTP sent via SMS · 🇺🇸`,
    });
  } catch (err) {
    console.error('OTP send error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: VERIFY OTP → JWT LOGIN
// ══════════════════════════════════════════════════════
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, countryCode = '91' } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    const fullPhone = phone.startsWith('+') ? phone : `+${countryCode}${phone}`;
    const { data: rec } = await supabase.from('otp_tokens').select('*').eq('phone', fullPhone).single();
    if (!rec) return res.status(400).json({ error: 'OTP not found. Request a new one.' });
    if (rec.verified) return res.status(400).json({ error: 'OTP already used.' });
    if (new Date() > new Date(rec.expires_at)) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (rec.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP.' });

    await supabase.from('otp_tokens').update({ verified: true }).eq('phone', fullPhone);

    let { data: user } = await supabase.from('users').select('*').eq('phone', fullPhone).single();
    const isNew = !user;
    if (!user) {
      // New user — role defaults to 'pending_role' until they pick one
      const { data: nu } = await supabase.from('users').insert({ phone: fullPhone, role: 'pending_role', is_active: true }).select().single();
      user = nu;
    }

    // Block suspended accounts
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support at support@mypetclub.app' });
    }

    // For professionals, include their verification status and sub_role
    let verificationStatus = null;
    let subRole = null;
    if (user.role === 'professional') {
      const { data: prof } = await supabase.from('professional_profiles').select('verification_status, sub_role').eq('user_id', user.id).single();
      verificationStatus = prof?.verification_status || 'pending';
      subRole = prof?.sub_role || null;
    }

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    console.error('OTP verify error:', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: FIREBASE PHONE AUTH — verify ID token → issue JWT
//  Frontend sends Firebase ID token after successful phone OTP.
//  We verify it with Firebase Admin, then find/create the user
//  in Supabase and return our own JWT (same shape as verify-otp).
// ══════════════════════════════════════════════════════
app.post('/api/auth/firebase-verify', async (req, res) => {
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
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support at support@mypetclub.app' });
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

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    console.log(`[FirebaseVerify] ${isNew ? 'New' : 'Returning'} user: ${phone}`);
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    console.error('[FirebaseVerify] Unexpected error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: SET ROLE (called once for new users)
// ══════════════════════════════════════════════════════
app.post('/api/users/set-role', auth, async (req, res) => {
  try {
    const { role, subRole, name, email, city, address, pet } = req.body;
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
    }

    if (role === 'customer') {
      try {
        await supabase.from('customer_profiles').upsert({
          user_id: req.user.id, address: address || null, city: city || null,
          country: phoneCountry,
        }, { onConflict: 'user_id' });
      } catch (e) { console.error('customer_profiles upsert:', e.message); }
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
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    const verificationStatus = role === 'professional' ? 'pending' : null;
    // subRole already defined above from req.body

    // Send welcome email (non-blocking)
    const fn = (name || 'there').split(' ')[0];
    if (email) {
      const isPro = role === 'professional';
      const roleColors = { Groomer: '#7c3aed', Trainer: '#2563eb', Vet: '#059669' };
      const proColor = roleColors[subRole] || '#f97316';
      const welcomeHtml = `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:${isPro ? `linear-gradient(135deg,${proColor},${proColor}cc)` : 'linear-gradient(135deg,#f97316,#fbbf24)'};padding:40px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">${isPro ? ({ Groomer:'✂️', Trainer:'🎓', Vet:'🏥' }[subRole] || '🌟') : '🐾'}</div>
            <h1 style="color:white;margin:0;font-size:24px;font-weight:800">${isPro ? `${subRole} Application Submitted!` : `Welcome to PETclub, ${fn}!`}</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px">${isPro ? 'Your account is under review' : 'Your account is ready to use'}</p>
          </div>
          <div style="padding:32px;">
            ${isPro ? `
            <div style="background:#fffbeb;border:2px solid #fde68a;border-radius:14px;padding:24px;margin-bottom:24px;text-align:center;">
              <div style="font-size:36px;margin-bottom:12px">⏳</div>
              <h2 style="margin:0 0 8px;color:#92400e;font-size:18px;font-weight:800">Account Under Review</h2>
              <p style="margin:0;color:#78350f;font-size:14px;line-height:1.7">Hi <strong>${fn}</strong>, your <strong>${subRole}</strong> application has been received. Our team will verify your identity and profile details.<br/><br/><strong>You will receive a confirmation email within 24–48 hours</strong> once your account is approved or if we need additional information.</p>
            </div>
            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px;">
              <p style="margin:0 0 12px;font-weight:700;color:#374151;font-size:14px">📋 What happens next:</p>
              <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
                <div style="background:#f97316;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;text-align:center;line-height:24px">1</div>
                <p style="margin:0;color:#64748b;font-size:13px">Our admin team reviews your profile and government ID</p>
              </div>
              <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
                <div style="background:#f97316;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;text-align:center;line-height:24px">2</div>
                <p style="margin:0;color:#64748b;font-size:13px">You get an approval email + SMS within 24–48 hours</p>
              </div>
              <div style="display:flex;align-items:flex-start;gap:12px">
                <div style="background:#f97316;color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;text-align:center;line-height:24px">3</div>
                <p style="margin:0;color:#64748b;font-size:13px">Log back in to access your full professional dashboard</p>
              </div>
            </div>
            ` : `
            <p style="color:#374151;font-size:15px;line-height:1.7;margin-bottom:20px">Hi <strong>${fn}</strong>! Your PETclub account is active. Book grooming, training, vet care &amp; more for your pet.</p>
            ${pet?.name ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:14px;padding:16px;margin-bottom:20px;"><p style="margin:0;font-weight:700;color:#9a3412;font-size:14px">🐾 ${pet.name} is now on PETclub!</p><p style="margin:4px 0 0;color:#c2410c;font-size:13px">${[pet.species, pet.breed, pet.age ? `${pet.age} yr${pet.age > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</p></div>` : ''}
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:20px;margin-bottom:24px;">
              <p style="margin:0 0 10px;font-weight:700;color:#166534;font-size:14px">🌟 What you can do now:</p>
              <ul style="margin:0;padding-left:18px;color:#4b7c5a;font-size:14px;line-height:2.2">
                <li>Add more pet profiles</li>
                <li>Book verified groomers, trainers &amp; vets</li>
                <li>Track health records &amp; vaccinations</li>
                <li>Get appointment reminders</li>
              </ul>
            </div>
            `}
            <div style="text-align:center;margin:28px 0 0;">
              <a href="https://app.mypetclub.app" style="display:inline-block;background:linear-gradient(135deg,#f97316,#fbbf24);color:white;padding:15px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;box-shadow:0 4px 20px rgba(249,115,22,0.3)">Open PETclub App →</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#94a3b8">© 2025 PETclub · For pets, with love 🐾 · <a href="https://mypetclub.app" style="color:#f97316;text-decoration:none">petclub.com</a></p>
          </div>
        </div>`;
      sendEmail(email,
        isPro ? `🐾 ${subRole} Application Received — Review in 24–48 hrs` : `🐾 Welcome to PETclub, ${fn}!`,
        welcomeHtml
      ).catch(e => console.error('Welcome email failed:', e.message));
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

    // SMS (non-blocking — India toll-free restriction handled gracefully)
    sendSMS(fullLeadPhone,
      isInquiry
        ? `Hi ${fn}! 🐾 We received your ${service} inquiry. Our team will reach out to you within 24 hours. – PETclub`
        : `Hi ${fn}! 🐾 Welcome to PETclub!\n\nAccess the app here:\n🌐 ${WEB_APP_URL}\n\nAll pet services in ${city || 'your city'}! 📱 Mobile apps coming soon.`
    ).catch(e => console.error('Lead SMS failed (non-blocking):', e.message));

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
              <p style="color:#c2410c;font-size:14px;margin:0;font-weight:600">⏱ Response within 24 hours<br/>📧 Reach us anytime: <a href="mailto:support@mypetclub.app" style="color:#f97316;">support@mypetclub.app</a></p>
            </div>
            <div style="text-align:center;">
              <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;">Explore PETclub App →</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;">
            © 2025 PETclub · For pets, with love 🐾
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
            © 2025 PETclub · For pets, with love 🐾 · <a href="${WEBSITE_URL}" style="color:#f97316;text-decoration:none;">petclub.in</a>
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
app.post('/api/admin/make-admin', async (req, res) => {
  try {
    const { phone, countryCode = '91', secret } = req.body;
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
  const { name, email, city, area, address, pincode, country } = req.body;
  await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  // Only write address fields to customer_profiles for customers (not professionals)
  if (req.user.role === 'customer') {
    await supabase.from('customer_profiles').upsert({ user_id: req.user.id, city, area, address, pincode, country }, { onConflict: 'user_id' });
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
  const { data } = await supabase.from('pets').insert({ owner_id: req.user.id, ...req.body }).select().single();
  res.json({ success: true, pet: data });
});

app.put('/api/pets/:id', auth, async (req, res) => {
  const { data } = await supabase.from('pets').update(req.body).eq('id', req.params.id).eq('owner_id', req.user.id).select().single();
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
  if (!tbl) return res.status(400).json({ error: 'Invalid type' });
  const { data } = await supabase.from(tbl).insert({ pet_id: req.params.petId, ...req.body }).select().single();
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
  const { name, email, city, area, address, bio, experience, services, service_areas, langs, price_basic, price_full, price_custom } = req.body;
  const { sub_role, certification, license_number, clinic_name } = req.body;
  if (name !== undefined || email !== undefined)
    await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  const updatePayload = {
    city, area, address, bio, experience,
    services: Array.isArray(services) ? JSON.stringify(services) : services,
    service_areas, langs, price_basic, price_full, price_custom,
    certification, license_number, clinic_name,
  };
  // Only update sub_role if explicitly provided (prevents overwriting with undefined)
  if (sub_role && ['Groomer','Trainer','Vet'].includes(sub_role)) {
    updatePayload.sub_role = sub_role;
  }
  const { data } = await supabase.from('professional_profiles').update(updatePayload)
    .eq('user_id', req.user.id).select().single();
  res.json({ success: true, profile: data });
});

// Toggle online/offline availability
app.put('/api/professionals/availability', auth, async (req, res) => {
  const { is_available } = req.body;
  if (typeof is_available !== 'boolean') return res.status(400).json({ error: 'is_available must be true or false' });
  await supabase.from('professional_profiles').update({ is_available }).eq('user_id', req.user.id);
  res.json({ success: true, is_available, message: is_available ? 'You are now Online 🟢' : 'You are now Offline ⏸' });
});

app.post('/api/professionals/apply', auth, async (req, res) => {
  const { data } = await supabase.from('professional_profiles').upsert({ user_id: req.user.id, verification_status: 'pending', ...req.body }, { onConflict: 'user_id' }).select().single();
  await supabase.from('users').update({ role: 'professional' }).eq('id', req.user.id);
  res.json({ success: true, profile: data });
});

app.post('/api/professionals/upload-id', auth, async (req, res) => {
  const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
  if (!prof) return res.status(404).json({ error: 'Apply as professional first' });
  const { data } = await supabase.from('id_documents').upsert({ prof_id: prof.id, ...req.body }, { onConflict: 'prof_id' }).select().single();
  res.json({ success: true, document: data });
});

// ID document photo upload (base64 → Supabase Storage)
app.post('/api/professionals/upload-id-photo', auth, async (req, res) => {
  try {
    const { docType, docNumber, docPhoto } = req.body;
    if (!docType) return res.status(400).json({ error: 'Document type required (Aadhar Card / Passport / Driving License)' });

    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    if (!prof) return res.status(404).json({ error: 'Professional profile not found. Complete signup first.' });

    let photoUrl = null;
    if (docPhoto && docPhoto.length > 100) {
      try {
        const base64Data = docPhoto.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = docPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
        const filename = `${req.user.id}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('id-documents')
          .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });
        if (!upErr) {
          const { data: urlData } = supabase.storage.from('id-documents').getPublicUrl(filename);
          photoUrl = urlData.publicUrl;
        } else { console.error('Storage upload error:', upErr.message); }
      } catch (e) { console.error('Photo processing error:', e.message); }
    }

    await supabase.from('id_documents').upsert({
      prof_id: prof.id,
      doc_type: docType,
      doc_number: docNumber || null,
      photo_url: photoUrl,
    }, { onConflict: 'prof_id' });

    // Also save certification if provided (professionals)
    const { certType, certPhoto } = req.body;
    if (certType || certPhoto) {
      let certUrl = null;
      if (certPhoto && certPhoto.length > 100) {
        try {
          const base64Data = certPhoto.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          const ext = certPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
          const filename = `${req.user.id}/cert-${Date.now()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from('id-documents')
            .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });
          if (!upErr) {
            const { data: urlData } = supabase.storage.from('id-documents').getPublicUrl(filename);
            certUrl = urlData.publicUrl;
          }
        } catch (e) { console.error('Cert photo error:', e.message); }
      }
      await supabase.from('id_documents').update({
        cert_type: certType || null,
        cert_photo_url: certUrl,
      }).eq('prof_id', prof.id);
    }

    res.json({ success: true, photoUrl, message: 'ID document saved' });
  } catch (err) {
    console.error('ID upload error:', err.message);
    res.status(500).json({ error: 'Failed to save document. Try again.' });
  }
});

// Customer government ID upload
app.post('/api/users/upload-id-photo', auth, async (req, res) => {
  try {
    const { docType, docNumber, docPhoto } = req.body;
    if (!docType) return res.status(400).json({ error: 'Document type required' });

    let photoUrl = null;
    if (docPhoto && docPhoto.length > 100) {
      try {
        const base64Data = docPhoto.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = docPhoto.startsWith('data:image/png') ? 'png' : 'jpg';
        const filename = `customers/${req.user.id}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('id-documents')
          .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });
        if (!upErr) {
          const { data: urlData } = supabase.storage.from('id-documents').getPublicUrl(filename);
          photoUrl = urlData.publicUrl;
        }
      } catch (e) { console.error('Customer ID photo error:', e.message); }
    }

    await supabase.from('customer_profiles').upsert({
      user_id: req.user.id,
      id_doc_type: docType,
      id_doc_number: docNumber || null,
      id_photo_url: photoUrl,
    }, { onConflict: 'user_id' });

    res.json({ success: true, photoUrl, message: 'ID document saved' });
  } catch (err) {
    console.error('Customer ID upload error:', err.message);
    res.status(500).json({ error: 'Failed to save document. Try again.' });
  }
});

app.post('/api/professionals/payout', auth, async (req, res) => {
  const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
  const { data } = await supabase.from('payout_details').upsert({ prof_id: prof.id, ...req.body }, { onConflict: 'prof_id' }).select().single();
  res.json({ success: true, payout: data });
});

// ══════════════════════════════════════════════════════
//  BOOKING ROUTES
// ══════════════════════════════════════════════════════
app.get('/api/bookings', auth, async (req, res) => {
  let q;
  if (req.user.role === 'customer')
    q = supabase.from('bookings').select('*, pets(name,species), professional_profiles(sub_role, users(name,phone))').eq('customer_id', req.user.id);
  else if (req.user.role === 'professional') {
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    q = supabase.from('bookings').select('*, pets(name,species), users!customer_id(name,phone)').eq('professional_id', prof?.id);
  } else
    q = supabase.from('bookings').select('*');
  const { data } = await q.order('scheduled_at', { ascending: false });
  res.json({ success: true, bookings: data });
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    processTimedOutAssignments().catch(console.error); // background cleanup
    const { service_type, city, pet_id, service_name, scheduled_at, address, notes, amount } = req.body;
    const { data: booking } = await supabase.from('bookings').insert({
      customer_id: req.user.id, status: 'upcoming',
      assignment_status: 'searching',
      service_type: service_type || null, service_name: service_name || null,
      pet_id: pet_id || null, scheduled_at: scheduled_at || null,
      city: city || null, address: address || null, notes: notes || null,
      amount: amount || null,
    }).select().single();
    if (!booking) return res.status(500).json({ error: 'Failed to create booking' });

    // Confirm SMS to customer
    const { data: custUser } = await supabase.from('users').select('phone, name').eq('id', req.user.id).single();
    if (custUser?.phone) {
      const svcLabel = service_name || service_type || 'Service';
      const dateLabel = scheduled_at ? new Date(scheduled_at).toLocaleString('en-IN', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'TBD';
      sendSMS(custUser.phone.startsWith('+') ? custUser.phone : `+91${custUser.phone}`,
        `🐾 PETclub: Your ${svcLabel} booking is placed!\n📅 ${dateLabel}\n🔍 Finding the best professional for you — you'll hear back shortly.\nTrack: https://app.mypetclub.app`
      ).catch(() => {});
    }

    // Auto-assign round-robin
    if (service_type && ['Groomer', 'Trainer', 'Vet'].includes(service_type)) {
      let petName = 'Pet';
      if (pet_id) {
        const { data: pet } = await supabase.from('pets').select('name').eq('id', pet_id).single();
        petName = pet?.name || 'Pet';
      }
      const nextPro = await findNextPro(city || '', service_type, []);
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

  const { data } = await supabase.from('bookings').update({ status: req.body.status }).eq('id', req.params.id).select().single();
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
      if (custPhone) {
        sendSMS(custPhone.startsWith('+') ? custPhone : `+91${custPhone}`,
          `✅ PETclub: ${svc} booking confirmed!\n👤 ${proName} will arrive on ${dateStr}.\n📱 View in app: https://app.mypetclub.app`
        ).catch(console.error);
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
    const nextPro = await findNextPro(bk?.city || '', bk?.service_type || '', excludeIds);
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
      .select('*, bookings(*, pets(name, species, breed), users!customer_id(name, phone))')
      .eq('professional_id', prof.id)
      .eq('status', 'offered')
      .gt('response_deadline', new Date().toISOString());

    const bookings = (assignments || []).map(a => ({
      ...(a.bookings || {}),
      assignment_id: a.id,
      response_deadline: a.response_deadline,
      offered_at: a.offered_at,
    }));
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
    let petName = 'Pet';
    if (bk.pet_id) {
      const { data: pet } = await supabase.from('pets').select('name').eq('id', bk.pet_id).single();
      petName = pet?.name || 'Pet';
    }
    await offerBookingToPro(req.params.id, prof, { ...bk, pet_name: petName });
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

  // Verify booking belongs to this customer
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, user_id, pro_lat, pro_lng, assignment_status')
    .eq('id', bookingId)
    .single();

  if (!booking || booking.user_id !== userId) return res.status(403).json({ error: 'Booking not found' });

  // SSE handshake
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx / Railway proxy buffering
  res.flushHeaders();

  // Send last known position immediately (if any)
  if (booking.pro_lat && booking.pro_lng) {
    res.write(`data: ${JSON.stringify({ lat: booking.pro_lat, lng: booking.pro_lng })}\n\n`);
  }

  // Keepalive comment every 25 s (prevents Railway/Vercel from closing idle connections)
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

// Professional sends GPS — POST /api/bookings/:id/location { lat, lng }
app.post('/api/bookings/:id/location', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const bookingId = req.params.id;

    // Verify booking is assigned to this professional
    const { data: proProfile } = await supabase
      .from('professional_profiles')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!proProfile) return res.status(403).json({ error: 'Not a professional' });

    const { data: booking } = await supabase
      .from('bookings')
      .select('id, professional_profile_id, assignment_status')
      .eq('id', bookingId)
      .eq('professional_profile_id', proProfile.id)
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

    // Push to all subscribed SSE clients
    const clients = trackingClients.get(bookingId);
    const payload = JSON.stringify({ lat, lng, t: Date.now() });
    let pushed = 0;
    clients?.forEach(client => {
      try { client.write(`data: ${payload}\n\n`); pushed++; }
      catch { clients.delete(client); }
    });

    res.json({ ok: true, pushed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST snapshot fallback — GET /api/bookings/:id/tracking
app.get('/api/bookings/:id/tracking', auth, async (req, res) => {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('pro_lat, pro_lng, pro_location_updated_at, assignment_status')
      .eq('id', req.params.id)
      .single();
    if (!booking) return res.status(404).json({ error: 'Not found' });
    res.json(booking);
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

// Admin OTP lookup — for testing/debugging only
// GET /api/admin/otp?phone=+919876543210  OR  ?phone=9876543210&cc=91
app.get('/api/admin/otp', auth, adminOnly, async (req, res) => {
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
    supabase.from('bookings').select('amount').eq('status', 'completed'),
    supabase.from('website_leads').select('id', { count: 'exact' }),
  ]);
  res.json({ success: true, stats: { users: u.count, verified_pros: p.count, revenue: b.data?.reduce((s,x)=>s+parseFloat(x.amount||0),0), leads: l.count } });
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('*, professional_profiles(sub_role, verification_status, rating, city)').order('created_at', { ascending: false });
  res.json({ success: true, users: data });
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
    const fullPhone = prof.users.phone.startsWith('+') ? prof.users.phone : `+91${prof.users.phone}`;
    sendSMS(fullPhone, sms).catch(console.error);
    if (prof.users.email) sendEmail(prof.users.email, `PETclub Verification ${action==='approve'?'Approved ✅':'Update ❌'}`, `<p>${sms}</p>`).catch(console.error);
  }
  res.json({ success: true, professional: prof });
});

// Admin: set sub_role for a professional (fixes users with null sub_role)
app.put('/api/admin/users/:id/set-role', auth, adminOnly, async (req, res) => {
  const { subRole } = req.body;
  if (!['Groomer','Trainer','Vet'].includes(subRole))
    return res.status(400).json({ error: 'subRole must be Groomer, Trainer, or Vet' });
  await supabase.from('professional_profiles').update({ sub_role: subRole }).eq('user_id', req.params.id);
  res.json({ success: true, subRole });
});

app.put('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
  const { data: u } = await supabase.from('users').select('is_active').eq('id', req.params.id).single();
  await supabase.from('users').update({ is_active: !u.is_active }).eq('id', req.params.id);
  await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: u.is_active ? 'suspend_user' : 'restore_user', target_id: req.params.id, target_type: 'user' });
  res.json({ success: true, is_active: !u.is_active });
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
//  Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in Railway env
// ══════════════════════════════════════════════════════

// Create a Razorpay order (called before payment screen opens)
app.post('/api/payments/create-order', auth, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({
        error: 'Payments not yet active',
        message: 'Razorpay integration is ready — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Railway env to activate.',
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

    // Mark booking as paid
    await supabase.from('bookings').update({
      payment_status: 'paid',
      razorpay_payment_id,
      razorpay_order_id,
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
//  HEALTH CHECK
// ══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({
  status: '🐾 PETclub API running',
  time: new Date(),
  services: {
    supabase: '✅',
    twilio: process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️ not configured',
    zoho_smtp: process.env.ZOHO_SMTP_USER ? '✅' : '⚠️ not configured',
    razorpay: razorpay ? '✅ live' : '⏳ pending (set env vars)',
    fcm: firebaseAdmin ? '✅ live' : '⏳ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)',
  },
}));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

// ── Startup migration: add live-tracking columns to bookings (safe, IF NOT EXISTS) ──
async function runStartupMigrations() {
  const migrations = [
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_lat                  DOUBLE PRECISION`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_lng                  DOUBLE PRECISION`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pro_location_updated_at  TIMESTAMPTZ`,
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

app.listen(PORT, async () => {
  console.log(`🐾 PETclub API → http://localhost:${PORT}`);
  // Run migrations in background — won't block startup
  runStartupMigrations().catch(e => console.warn('[startup migration]', e.message));
});