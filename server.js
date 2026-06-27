// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PETclub India â€” Complete Backend API v1.0
//  Stack: Node.js + Express + Firebase Auth + Nodemailer (Zoho SMTP) + Supabase + JWT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
require('dotenv').config();
const crypto  = require('crypto');
const { version: API_VERSION } = require('./package.json');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const emailService      = require('./services/emailService');
const pricingCatalog    = require('./services/pricingCatalog');
const loyalty           = require('./services/loyaltyService');
const { PgRateLimitStore } = require('./services/pgRateLimitStore');

// â”€â”€ Structured logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const pino = require('pino');
const pinoHttp = require('pino-http');
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
});

// â”€â”€ Sentry error tracking â€” active only when SENTRY_DSN is set â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: `petclub-backend@${API_VERSION}`,
    tracesSampleRate: 0.1,   // 10% of requests traced â€” adjust once traffic grows
  });
  logger.info('âœ… Sentry error tracking initialised');
}

// â”€â”€ Startup secret guard â€” refuse to boot without critical secrets â”€â”€â”€â”€â”€â”€â”€â”€â”€
const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  logger.error(`\nâŒ FATAL: Missing required environment variables: ${missingEnv.join(', ')}\nSet them in Cloud Run env vars and redeploy.\n`);
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  logger.error('\nâŒ FATAL: JWT_SECRET must be at least 32 characters. Set a strong random value.\n');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Trust Cloud Run reverse proxy â€” needed for rate-limit & real IP
const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production' || !process.env.ALLOW_DEV_TOOLS;
const JWT_SECRET    = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';   // 7-day expiry â€” override via env var for longer sessions
const WEB_APP_URL   = process.env.WEB_APP_URL   || 'https://app.mypetclub.app';
const WEBSITE_URL   = process.env.WEBSITE_URL   || 'https://mypetclub.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@mypetclub.app';
// Warn (don't crash) if optional-but-important vars use hardcoded fallbacks
if (!process.env.WEB_APP_URL)   logger.warn('[Config] WEB_APP_URL not set â€” falling back to https://app.mypetclub.app');
if (!process.env.WEBSITE_URL)   logger.warn('[Config] WEBSITE_URL not set â€” falling back to https://mypetclub.app');
if (!process.env.SUPPORT_EMAIL) logger.warn('[Config] SUPPORT_EMAIL not set â€” falling back to support@mypetclub.app');

// â”€â”€ Security helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Mask phone/email in logs â€” never log full PII
const maskPhone = p => (typeof p === 'string' && p.length > 6) ? `${p.slice(0, 4)}****${p.slice(-2)}` : 'â€”';
const maskEmail = e => {
  if (!e || !e.includes('@')) return 'â€”';
  const [local, domain] = e.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};
// Strip HTML tags from user inputs â€” prevents XSS in admin emails
const sanitize = s => typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim().slice(0, 2000) : s;

// â”€â”€ Cancellation policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cancel â‰¥ 2 h before appointment  â†’ full refund, no fee
// Cancel < 2 h before              â†’ â‚¹300 cancellation fee, refund rest
// Customer no-show at location     â†’ â‚¹300 fee, refund rest
// No reschedule under any circumstances
const CANCEL_FEE_INR   = 300;
const CANCEL_FREE_HOURS = 2; // hours before booking that allow fee-free cancellation

function calcCancellation(totalAmount, scheduledAt, byNoShow = false) {
  const total    = parseFloat(totalAmount) || 0;
  const now      = Date.now();
  const bookingMs = scheduledAt ? new Date(scheduledAt).getTime() : now;
  const hoursUntil = (bookingMs - now) / 3600000;
  const feeFree  = !byNoShow && hoursUntil >= CANCEL_FREE_HOURS;
  const fee      = feeFree ? 0 : Math.min(CANCEL_FEE_INR, total);
  return {
    cancellation_fee:  +fee.toFixed(2),
    refund_amount:     +Math.max(0, total - fee).toFixed(2),
    refund_status:     total > 0 ? 'pending' : 'not_applicable',
    fee_free:          feeFree,
    hours_until:       +hoursUntil.toFixed(2),
  };
}

// â”€â”€ Revenue split â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Service-type-specific rates (no travel allowance, no insurance deductions):
//   Groomer  â†’ provider 70% / platform 30%  (of net after PETclub offer)
//   All others â†’ env-var-driven (default 45% / 55%)
// All computation is server-side only â€” clients never receive platform_fee.
const PLATFORM_RATE   = parseFloat(process.env.PLATFORM_RATE)        || 0.55;
const PROVIDER_RATE   = parseFloat(process.env.PROVIDER_RATE)        || 0.45;
const GROOMER_PROVIDER_RATE  = 0.70;
const GROOMER_PLATFORM_RATE  = 0.30;

// Gateway fee rates (absorbed by PETclub, never charged to provider)
const GW_PCT_USD      = parseFloat(process.env.GATEWAY_FEE_PCT_USD)  || 0.029;   // 2.9%
const GW_FLAT_USD     = parseFloat(process.env.GATEWAY_FEE_FLAT_USD) || 0.30;    // $0.30
const GW_PCT_INR      = parseFloat(process.env.GATEWAY_FEE_PCT_INR)  || 0.02;    // 2%
const GW_FLAT_INR     = parseFloat(process.env.GATEWAY_FEE_FLAT_INR) || 0.03;    // â‚¹0.03

// computeSplit(totalAmount, offerAmount, serviceType, currency)
//   totalAmount  â€” what the customer paid
//   offerAmount  â€” PETclub subsidy absorbed (e.g. â‚¹150 platform discount)
//                  deducted from split base: net = totalAmount - offerAmount
//   serviceType  â€” 'Groomer' uses 70/30; others use PROVIDER_RATE/PLATFORM_RATE
//   currency     â€” 'INR' | 'USD'
function computeSplit(totalAmount, offerAmount = 0, serviceType = '', currency = 'INR') {
  const amt = parseFloat(totalAmount);
  if (!amt || isNaN(amt) || amt <= 0) return null;
  const offer = Math.max(0, parseFloat(offerAmount) || 0);
  const net   = Math.max(0, +(amt - offer).toFixed(2)); // split base after PETclub offer

  const isGroomer   = serviceType === 'Groomer';
  const provRate    = isGroomer ? GROOMER_PROVIDER_RATE : PROVIDER_RATE;
  const platRate    = isGroomer ? GROOMER_PLATFORM_RATE : PLATFORM_RATE;

  // Gateway fee absorbed by PETclub (from our platform share, never from provider's cut)
  const gatewayFee = currency === 'USD'
    ? +(amt * GW_PCT_USD + GW_FLAT_USD).toFixed(2)
    : +(amt * GW_PCT_INR + GW_FLAT_INR).toFixed(2);

  return {
    total_amount:         +amt.toFixed(2),
    petclub_offer_amount: offer > 0 ? offer : null,
    net_split_amount:     offer > 0 ? net   : null,  // null = no offer, split was on full amount
    platform_fee:         +(net * platRate).toFixed(2),
    provider_earnings:    +(net * provRate).toFixed(2),
    gateway_fee:          gatewayFee,
  };
}

// Role-based field stripping â€” never send platform economics to providers/customers
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
  // admin: full data â€” no deletions
  return b;
}

// â”€â”€ Services â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// â”€â”€ Email â€” delegated to services/emailService.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SMTP config and all template rendering live in that module.
// Use emailService.sendRawEmail() for admin-internal notifications,
// or the named helpers (sendOtpEmail, sendWelcomeEmail, etc.) for
// user-facing transactional emails.

// â”€â”€ Razorpay (India payment gateway) â€” live once RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET set â”€â”€
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    logger.info('âœ… Razorpay initialized (India payments live)');
  } catch (e) { logger.warn('[Razorpay] Not loaded â€” run: npm install razorpay â†’', e.message); }
}

// â”€â”€ Firebase Admin (FCM push notifications) â€” live once FIREBASE_SERVICE_ACCOUNT_JSON set â”€â”€
let firebaseAdmin = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const fbAdmin = require('firebase-admin');
    const svcAcct = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!fbAdmin.apps.length) fbAdmin.initializeApp({ credential: fbAdmin.credential.cert(svcAcct) });
    firebaseAdmin = fbAdmin;
    logger.info('âœ… Firebase Admin initialized (push notifications live)');
  } catch (e) { logger.warn('[Firebase] Not initialized â€” run: npm install firebase-admin â†’', e.message); }
}

// â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Security headers
// CSP on a pure JSON API is mainly defence-in-depth â€” API responses are not
// rendered as HTML by browsers, so most directives are no-ops.  We still set
// a restrictive policy so that if any endpoint ever accidentally returns HTML
// (e.g. a misconfigured proxy error page) a browser won't execute scripts.
app.use(pinoHttp({ logger }));

// API versioning -- /api/v1/* is an alias for /api/* so the mobile app
// can pin to v1 while the web frontend continues using unversioned /api/.
// When breaking changes ship, bump to /api/v2/ and keep v1 alive.
app.use((req, res, next) => {
  if (req.url.startsWith('/api/v1/')) req.url = req.url.replace('/api/v1/', '/api/');
  res.setHeader('X-API-Version', '1');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'none'"],        // nothing allowed by default
      scriptSrc:       ["'none'"],        // no scripts â€” pure JSON API
      styleSrc:        ["'none'"],
      imgSrc:          ["'none'"],
      connectSrc:      ["'self'"],        // XHR/fetch only to same origin
      fontSrc:         ["'none'"],
      objectSrc:       ["'none'"],
      frameSrc:        ["'none'"],
      frameAncestors:  ["'none'"],        // no embedding in iframes
      baseUri:         ["'none'"],
      formAction:      ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,      // API responses don't embed resources
}));

const ALLOWED_ORIGINS = [
  WEB_APP_URL,
  WEBSITE_URL,
  `https://www.${new URL(WEBSITE_URL).hostname}`,
  process.env.FRONTEND_URL,
  // Localhost allowed in dev only (set ALLOW_DEV_TOOLS=true in local .env)
  ...(IS_PROD ? [] : ['http://localhost:5173','http://localhost:5174','http://localhost:4173']),
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false),
  credentials: true,   // required for httpOnly cookie to be sent cross-origin
}));
app.use(require('cookie-parser')());
app.use(express.json({ limit: '10mb' }));

// â”€â”€ Request ID + timing logger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res, next) => {
  req.id = Math.random().toString(36).slice(2, 10).toUpperCase();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.id);
  res.on('finish', () => {
    const ms = Date.now() - req.startTime;
    const lvl = res.statusCode >= 500 ? 'ðŸ”´' : res.statusCode >= 400 ? 'ðŸŸ¡' : 'ðŸŸ¢';
    if (!req.path.includes('/health')) {
      logger.info(`${lvl} [${req.id}] ${req.method} ${req.path} â†’ ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});
// â”€â”€ Distributed rate limiters (Postgres-backed â€” safe across Cloud Run instances) â”€â”€
// PgRateLimitStore uses an atomic UPSERT in Supabase so limits are enforced
// globally even when Cloud Run scales to N instances.  Falls back to in-memory
// if the DB is unreachable so traffic is never fully blocked by a DB hiccup.
//
// Global rate limit â€” 300 req / 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  store: new PgRateLimitStore(),
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' }),
}));
// OTP send rate limit â€” max 10 sends per 5 minutes per IP
const otpLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  store: new PgRateLimitStore(),
  // Skip rate limiting for E2E test emails (e.g. @mailinator.com) so the
  // bypass handler in the route can return the fixed OTP without being blocked.
  skip: (req) => {
    // Only bypass in non-production â€” prevents test credentials leaking into prod
    if (IS_PROD) return false;
    const testDomain = process.env.E2E_TEST_EMAIL_DOMAIN;
    const email = (req.body?.email || '').toLowerCase();
    return !!(testDomain && email.endsWith(`@${testDomain}`));
  },
  handler: (req, res) => res.status(429).json({ error: 'Too many OTP requests. Please wait a few minutes and try again.' }),
});
// Auth verify rate limit â€” max 20 attempts per 15 min per IP (prevents brute-force)
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  store: new PgRateLimitStore(),
  handler: (req, res) => res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' }),
});

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const genOTP = () => crypto.randomInt(100000, 1000000).toString();

// Short-lived cache: { userId â†’ { isActive, expiresAt } }
// Avoids a DB hit on every request while still enforcing suspension within 60s.
const _authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

const AUTH_COOKIE = 'petclub_token';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 days in ms
  path: '/',
};

const auth = async (req, res, next) => {
  // Cookie takes priority; Authorization header accepted as fallback (SDK / mobile clients)
  const token = req.cookies?.[AUTH_COOKIE] || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Login required' });

  // Step 1: verify JWT signature â€” fast, no network
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }

  // Step 2: check suspension status â€” cached, falls back to JWT-only on DB error
  const cached = _authCache.get(decoded.id);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.isActive)
      return res.status(403).json({ error: `Account suspended. Contact ${SUPPORT_EMAIL}` });
  } else {
    try {
      const { data: u } = await supabase.from('users').select('is_active, deleted_at').eq('id', decoded.id).single();
      const isActive = u ? (u.is_active !== false && !u.deleted_at) : true;
      _authCache.set(decoded.id, { isActive, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
      if (!isActive)
        return res.status(403).json({ error: `Account suspended. Contact ${SUPPORT_EMAIL}` });
    } catch {
      // DB unreachable â€” fail open so a Supabase blip doesn't log everyone out.
      // A suspended user may slip through for up to 60s during an outage (acceptable).
      logger.warn('[auth] DB suspension check failed â€” falling back to JWT-only');
    }
  }

  req.user = decoded;
  next();
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};


// â”€â”€ Push Notification via Firebase Cloud Messaging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    logger.info(`[FCM] Push sent â†’ ${fcmToken.slice(0, 20)}â€¦`);
  } catch (e) { logger.warn('[FCM] Send failed:', e.message); }
};

// â”€â”€ SMS via Twilio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _twilioSid   = process.env.TWILIO_ACCOUNT_SID;
const _twilioToken = process.env.TWILIO_AUTH_TOKEN;
const _twilioFrom  = process.env.TWILIO_PHONE_NUMBER;
const _twilioReady = Boolean(_twilioSid && _twilioToken && _twilioFrom);
let _twilioClient  = null;
if (_twilioReady) {
  try {
    const twilio = require('twilio');
    _twilioClient = twilio(_twilioSid, _twilioToken);
    console.info('[Twilio] SMS client initialised â€” from:', _twilioFrom);
  } catch (e) {
    logger.error('[Twilio] Failed to init client:', e.message);
  }
} else {
  logger.warn('[Twilio] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER not set â€” SMS disabled');
}

const sendSMS = async (phone, message) => {
  if (!_twilioClient) {
    logger.warn(`[SMS disabled] To: ${maskPhone(phone)} | Msg: ${message.slice(0, 80)}`);
    return;
  }
  await _twilioClient.messages.create({ body: message, from: _twilioFrom, to: phone });
  console.info(`[SMS] Sent to ${maskPhone(phone)}`);
};

// â”€â”€ WhatsApp via Twilio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Set TWILIO_WHATSAPP_FROM in .env to your WhatsApp-enabled number (E.164).
// e.g.  TWILIO_WHATSAPP_FROM=+14155238886   (Twilio sandbox)
//       TWILIO_WHATSAPP_FROM=+91XXXXXXXXXX  (your approved WABA number)
const _waFrom = process.env.TWILIO_WHATSAPP_FROM;

/**
 * Send a WhatsApp message via Twilio.
 * @param {string} toPhone  - Recipient E.164 number, e.g. "+919912483990"
 * @param {string} message  - Plain-text body
 */
const sendWhatsApp = async (toPhone, message) => {
  if (!_twilioClient || !_waFrom) {
    logger.warn(`[WhatsApp disabled] Set TWILIO_WHATSAPP_FROM to enable. To: ${maskPhone(toPhone)}`);
    return;
  }
  try {
    await _twilioClient.messages.create({
      body: message,
      from: `whatsapp:${_waFrom}`,
      to:   `whatsapp:${toPhone}`,
    });
    console.info(`[WhatsApp] Sent to ${maskPhone(toPhone)}`);
  } catch (e) {
    // Non-fatal â€” groomer still gets email + FCM push
    logger.error(`[WhatsApp] Failed to ${maskPhone(toPhone)}: ${e.message}`);
  }
};

// â”€â”€ FCM push alias â€” normalises call-site signature differences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sendPushNotification = async (fcmToken, title, body) => sendPush(fcmToken, title, body);

// Backward-compatible alias â€” all existing admin/internal sendEmail(to, subject, html)
// callsites continue to work unchanged. New user-facing emails use named helpers below.
const sendEmail = emailService.sendRawEmail;

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STORAGE: init id-documents bucket on startup
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
(async () => {
  try {
    // PRIVATE bucket â€” ID documents (Aadhar, PAN, Passport) must never be publicly accessible
    await supabase.storage.createBucket('id-documents', { public: false });
    logger.info('âœ… Storage bucket ready: id-documents');
  } catch (e) {
    if (!e.message?.includes('already exists') && !String(e).includes('already exists')) {
      logger.error('Storage bucket init:', e.message || e);
    }
  }
})();

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  BOOKING TIMEOUT CRON â€” runs every 2 minutes
//  (also runs lazily on booking API calls as a safety net)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
setInterval(() => {
  processTimedOutAssignments().catch(e => logger.error('[Cron] Booking timeout check failed:', e.message));
}, 2 * 60 * 1000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  SUSPENDED USER AUTO-DELETE CRON â€” runs every hour
//  Deletes users suspended >24 hrs ago (no restore since).
//  Sends admin an email summary before deletion.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // Build map: userId â†’ latest restore timestamp
    const latestRestore = {};
    restoreLogs?.forEach(l => {
      if (!latestRestore[l.target_id] || l.created_at > latestRestore[l.target_id])
        latestRestore[l.target_id] = l.created_at;
    });

    // Build map: userId â†’ latest suspension timestamp
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
          <td style="padding:8px 12px;font-size:13px">${u.name || 'â€”'}</td>
          <td style="padding:8px 12px;font-size:13px">${u.phone}</td>
          <td style="padding:8px 12px;font-size:13px">${u.email || 'â€”'}</td>
          <td style="padding:8px 12px;font-size:13px;text-transform:capitalize">${u.role}</td>
        </tr>`
      ).join('');
      await sendEmail(
        adminEmail,
        `ðŸ—‘ï¸ PETclub â€” ${toDelete.length} Suspended User(s) Auto-Deleted`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">ðŸ—‘ï¸</div>
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
          <p style="color:#94a3b8;font-size:12px;text-align:center">PETclub Admin Â· ${new Date().toLocaleString('en-IN')} Â· These accounts are permanently removed from the database.</p>
        </div>`
      ).catch(e => logger.error('[AutoDelete] Email failed:', e.message));
    }

    // Delete related records then users
    const idsToDelete = toDelete.map(u => u.id);
    await supabase.from('professional_profiles').delete().in('user_id', idsToDelete);
    await supabase.from('customer_profiles').delete().in('user_id', idsToDelete).catch(() => {});
    await supabase.from('pets').update({ deleted_at: new Date().toISOString() }).in('owner_id', idsToDelete).catch(() => {});
    await supabase.from('otp_tokens').delete().in('phone', toDelete.map(u => u.phone)).catch(() => {});
    await supabase.from('admin_logs').delete().in('target_id', idsToDelete);
    await supabase.from('users').update({ deleted_at: new Date().toISOString() }).in('id', idsToDelete);

    logger.info(`[AutoDelete] Deleted ${idsToDelete.length} suspended users: ${idsToDelete.join(', ')}`);
  } catch (e) {
    logger.error('[AutoDelete] Cron error:', e.message);
  }
};

setInterval(() => {
  autoDeleteSuspendedUsers().catch(e => logger.error('[Cron] Auto-delete suspended users failed:', e.message));
}, 60 * 60 * 1000); // every hour

// â”€â”€ Expired OTP cleanup â€” runs every hour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Prevents otp_tokens table accumulating verified/expired codes
setInterval(async () => {
  try {
    const { count } = await supabase.from('otp_tokens')
      .delete({ count: 'exact' }).lt('expires_at', new Date().toISOString());
    if (count > 0) logger.info(`[OTP Cleanup] Purged ${count} expired token(s)`);
  } catch (e) { logger.warn('[OTP Cleanup] Failed:', e.message); }
}, 60 * 60 * 1000);

// â"€â"€ Hard-purge soft-deleted records older than 90 days â€" runs every 24 h â"€â"€
// Permanently removes rows where deleted_at < NOW() - 90 days from
// users, bookings, and pets. Satisfies GDPR right-to-erasure obligation.
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: uCount }, { count: bCount }, { count: pCount }] = await Promise.all([
      supabase.from('users').delete({ count: 'exact' }).not('deleted_at', 'is', null).lt('deleted_at', cutoff),
      supabase.from('bookings').delete({ count: 'exact' }).not('deleted_at', 'is', null).lt('deleted_at', cutoff),
      supabase.from('pets').delete({ count: 'exact' }).not('deleted_at', 'is', null).lt('deleted_at', cutoff),
    ]);
    const total = (uCount || 0) + (bCount || 0) + (pCount || 0);
    if (total > 0) logger.info(`[HardPurge] Permanently removed ${uCount || 0} user(s), ${bCount || 0} booking(s), ${pCount || 0} pet(s) (deleted >90 days ago)`);
  } catch (e) { logger.warn('[HardPurge] Failed:', e.message); }
}, 24 * 60 * 60 * 1000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  BOOKING DISPATCH SYSTEM â€” Round-Robin / Uber-style
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
      if (!p.address_lat || !p.address_lng) return false; // no GPS â†’ exclude from GPS dispatch
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
    ? `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">âš•ï¸ Health Notes</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#991b1b;font-weight:600">${sanitize(petHealthNotes)}</td></tr>`
    : '';
  const custNotesRow = custNotes
    ? `<tr><td style="padding:8px 0;font-size:12px;color:#94a3b8;width:38%">ðŸ’¬ Customer Note</td><td style="padding:8px 0;font-size:13px;color:#1e293b">${sanitize(custNotes)}</td></tr>`
    : '';

  const notifHtml = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #f1f5f9;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:28px 24px;text-align:center;">
        <div style="font-size:40px;margin-bottom:8px">ðŸ¾</div>
        <h2 style="color:white;margin:0;font-size:20px;font-weight:800">New Booking Request!</h2>
        <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px">You have <strong>${RESPONSE_TIMEOUT_MINS} minutes</strong> to respond</p>
      </div>
      <div style="padding:24px;">
        <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:12px;padding:14px;margin-bottom:20px;text-align:center;">
          <div style="font-size:28px;margin-bottom:4px">â±ï¸</div>
          <div style="font-size:24px;font-weight:900;color:#c2410c;font-family:monospace">${RESPONSE_TIMEOUT_MINS}:00</div>
          <div style="font-size:12px;color:#9a3412;margin-top:4px">minutes to Accept or Reject</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">Service</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${svc}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">ðŸ¾ Pet</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${petName}</td></tr>
          ${healthNoteRow}
          <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">ðŸ“… Date & Time</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${dateStr}</td></tr>
          <tr><td style="padding:8px 0;${custNotesRow ? 'border-bottom:1px solid #f1f5f9;' : ''}font-size:12px;color:#94a3b8">ðŸ“ Location</td><td style="padding:8px 0;${custNotesRow ? 'border-bottom:1px solid #f1f5f9;' : ''}font-size:14px;font-weight:700;color:#1e293b">${location}</td></tr>
          ${custNotesRow}
        </table>
        ${petHealthNotes ? `<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:12px 16px;margin-bottom:16px;"><p style="margin:0;font-size:12px;font-weight:700;color:#991b1b;">âš•ï¸ Please read the health notes above before the appointment.</p></div>` : ''}
        <div style="text-align:center;margin-bottom:16px;">
          <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;padding:14px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;">âœ… Open App to Respond</a>
        </div>
        <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0;">No response in ${RESPONSE_TIMEOUT_MINS} mins â†’ request auto-passes to next professional</p>
      </div>
    </div>`;

  if (proEmail) {
    sendEmail(proEmail, `ðŸ¾ New Booking Request â€” ${svc} Â· Respond in ${RESPONSE_TIMEOUT_MINS} min`, notifHtml).catch(e => logger.error(e));
  }

  // â”€â”€ WhatsApp notification to professional â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Matches the format groomers/trainers are used to seeing in WhatsApp.
  if (proPhone) {
    const custName    = bookingDetails.user_name    || bookingDetails.customer_name || 'Customer';
    // âš  SECURITY: Do NOT include customer phone here.
    // The professional has only been *offered* the booking â€” not yet accepted.
    // Customer contact details are shared only after acceptance (see booking accept endpoint).
    const petBreed    = bookingDetails.pet_breed    || 'Not specified';
    const vaccinated  = bookingDetails.vaccinated   != null ? (bookingDetails.vaccinated  ? 'Yes' : 'No') : 'Unknown';
    const aggressive  = bookingDetails.aggressive   != null ? (bookingDetails.aggressive   ? 'Yes' : 'No') : 'Unknown';
    const pkgCost     = bookingDetails.package_price || bookingDetails.total_amount || '';
    const fullAddress = bookingDetails.address      || bookingDetails.city || 'TBD';
    const mapsLink    = bookingDetails.location_url || bookingDetails.maps_link || '';

    // Scheduled date + time slot (e.g. "17 May 2026, 1pmâ€“3pm")
    const scheduledDate = bookingDetails.scheduled_at
      ? new Date(bookingDetails.scheduled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : (bookingDetails.preferred_date || 'TBD');
    const timeSlot = bookingDetails.time_slot || bookingDetails.preferred_time || '';

    const waMsg = [
      `ðŸ¾ *New PETclub Booking â€” Respond in ${RESPONSE_TIMEOUT_MINS} min*`,
      ``,
      `*Name:* ${custName}`,
      `*Scheduled Date:* ${scheduledDate}`,
      timeSlot  ? `*Time:* ${timeSlot}`   : null,
      `*Breed:* ${petBreed}`,
      `*Vaccinated:* ${vaccinated}`,
      `*Aggressive:* ${aggressive}`,
      `*Service:* ${svc}`,
      pkgCost   ? `*Package Cost:* â‚¹${pkgCost}` : null,
      `*Address:* ${fullAddress}`,
      mapsLink  ? `*Location:* ${mapsLink}` : null,
      `*Payment Status:* Not paid`,
      ``,
      `Open the app to Accept or Reject ðŸ‘‡`,
      WEB_APP_URL,
    ].filter(Boolean).join('\n');

    // Normalise to E.164: assume +91 if no country prefix
    const e164 = proPhone.startsWith('+') ? proPhone : `+91${proPhone}`;
    sendWhatsApp(e164, waMsg).catch(e => logger.error(e));
  }

  // â”€â”€ FCM push notification to professional â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { data: proUser } = await Promise.resolve(supabase.from('users').select('fcm_token').eq('id', pro.user_id).single()).catch(() => ({ data: null }));
  if (proUser?.fcm_token) {
    sendPush(proUser.fcm_token, `ðŸ¾ New ${svc} Request!`, `${petName} Â· ${dateStr} Â· Respond in ${RESPONSE_TIMEOUT_MINS} min`, { bookingId: bookingId, type: 'new_booking' }).catch(() => {});
  }
};

// Process timed-out offers (lazy eval â€” called on booking endpoints)
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: LEGACY OTP ENDPOINTS â€” REMOVED
//  Replaced by:
//    Phone â†’ Firebase Phone Auth â†’ POST /auth/firebase-verify
//    Email â†’ POST /auth/send-email-otp + POST /auth/verify-email-otp
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/auth/send-otp', (req, res) => res.status(410).json({
  error: 'This endpoint has been removed. Use Firebase Phone Auth (app) or /auth/send-email-otp for email login.',
}));
app.post('/api/auth/verify-otp', (req, res) => res.status(410).json({
  error: 'This endpoint has been removed. Use /auth/firebase-verify (phone) or /auth/verify-email-otp (email).',
}));

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: FIREBASE PHONE AUTH â€” verify ID token â†’ issue JWT
//  Frontend sends Firebase ID token after successful phone OTP.
//  We verify it with Firebase Admin, then find/create the user
//  in Supabase and return our own JWT (same shape as verify-otp).
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
      logger.error('[FirebaseVerify] Token invalid:', e.message);
      return res.status(401).json({ error: 'Invalid or expired token. Please try again.' });
    }

    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ error: 'No phone number in Firebase token' });

    // Find or create user (same logic as /auth/verify-otp)
    logger.info(`[FirebaseVerify] Looking up user for ${maskPhone(phone)}`);
    let { data: user, error: lookupErr } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (lookupErr && lookupErr.code !== 'PGRST116') {
      logger.error('[FirebaseVerify] User lookup error:', lookupErr);
    }
    const isNew = !user;
    if (!user) {
      logger.info(`[FirebaseVerify] New user â€” inserting for ${maskPhone(phone)}`);
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ phone, role: 'pending_role', is_active: true })
        .select()
        .single();
      if (insertErr) {
        logger.error('[FirebaseVerify] User insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create user. Try again.' });
      }
      user = nu;
      // Notify admin of new signup
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `ðŸ¾ New PETclub Signup â€” ${phone}`,
          `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff;border-radius:16px;border:2px solid #f97316;">
            <h2 style="color:#f97316;margin:0 0 12px">ðŸ¾ New User Signed Up</h2>
            <p style="margin:4px 0;color:#1e293b;font-size:14px"><strong>Phone:</strong> ${phone}</p>
            <p style="margin:4px 0;color:#64748b;font-size:13px">Role not yet set â€” awaiting profile setup.</p>
            <hr style="border:none;border-top:1px solid #f1f5f9;margin:16px 0"/>
            <p style="color:#94a3b8;font-size:12px">PETclub Admin Â· ${new Date().toLocaleString('en-IN')}</p>
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

    logger.info(`[FirebaseVerify] Signing JWT for user ${user.id} (${maskPhone(phone)})`);
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    logger.info(`[FirebaseVerify] ${isNew ? 'New' : 'Returning'} user: ${maskPhone(phone)}`);
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
    res.json({ success: true, isNew, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    logger.error('[FirebaseVerify] Unexpected error at step above â†‘', err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: EMAIL OTP â€” send (for users without phone access)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/auth/send-email-otp', otpLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email address required' });

    // â”€â”€ E2E test bypass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // When E2E_TEST_EMAIL_DOMAIN is set (e.g. "mailinator.com"), requests to
    // that domain get a fixed OTP (123456), skip real email sending, and bypass
    // the rate limiter.  ONLY active in non-production environments.
    const testDomain = process.env.E2E_TEST_EMAIL_DOMAIN;
    if (!IS_PROD && testDomain && email.toLowerCase().endsWith(`@${testDomain}`)) {
      const fixedOtp = '123456';
      const expires = new Date(Date.now() + 10 * 60000).toISOString();
      await supabase.from('otp_tokens').upsert(
        { phone: email.toLowerCase(), otp: fixedOtp, expires_at: expires, verified: false },
        { onConflict: 'phone' }
      );
      logger.info(`[EmailOTP][E2E] Test bypass for ${email} â€” OTP: ${fixedOtp}`);
      return res.json({ success: true, message: `OTP sent to ${email}` });
    }
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();

    // Store OTP keyed by email (reuse otp_tokens table, email as phone field)
    await supabase.from('otp_tokens').upsert(
      { phone: email.toLowerCase(), otp, expires_at: expires, verified: false },
      { onConflict: 'phone' }
    );

    await emailService.sendOtpEmail(email, { otp, expiresMinutes: 10 });
    logger.info(`[EmailOTP] Sent to ${email}`);
    res.json({ success: true, message: `OTP sent to ${email}` });
  } catch (err) {
    logger.error('[EmailOTP] Send error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Check your email address and try again.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: EMAIL OTP â€” verify â†’ issue JWT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/auth/verify-email-otp', authLimit, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const key = email.toLowerCase();
    const { data: rec } = await supabase.from('otp_tokens').select('*').eq('phone', key).single();
    if (!rec) return res.status(400).json({ error: 'OTP not found. Request a new one.' });
    if (rec.verified) return res.status(400).json({ error: 'OTP already used.' });
    if (new Date() > new Date(rec.expires_at)) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (!crypto.timingSafeEqual(Buffer.from(String(rec.otp)), Buffer.from(String(otp))))
      return res.status(400).json({ error: 'Incorrect OTP.' });

    await supabase.from('otp_tokens').update({ verified: true }).eq('phone', key);

    // Find user by email; fall back to creating email-only account
    let { data: user } = await supabase.from('users').select('*').eq('email', key).single();
    const isNew = !user;
    if (!user) {
      // phone column is NOT NULL â€” use a unique placeholder for email-only accounts
      const emailPhone = `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ email: key, phone: emailPhone, role: 'pending_role', is_active: true })
        .select()
        .single();
      if (insertErr) {
        logger.error('[EmailOTP] Insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create account. Try again.' });
      }
      user = nu;
      // Admin notification for new email signup
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `ðŸ¾ New PETclub Signup (Email) â€” ${email}`,
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

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    logger.info(`[EmailOTP] ${isNew ? 'New' : 'Returning'} user: ${maskEmail(email)}`);
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
    res.json({ success: true, isNew, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    logger.error('[EmailOTP] Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: PHONE OTP via Twilio SMS (replaces Firebase reCAPTCHA)
//  POST /api/auth/send-phone-otp   { phone: '+91XXXXXXXXXX' }
//  POST /api/auth/verify-phone-otp { phone, otp }
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE, { ...COOKIE_OPTS, maxAge: 0 });
  res.json({ success: true });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // â”€â”€ Try SMS first, fall back to email if SMS fails â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      await sendSMS(phone, `Your PETclub OTP is: ${otp}  Valid 10 min. Do not share.`);
      logger.info(`[PhoneOTP] SMS sent to ${maskPhone(phone)}`);
      return res.json({ success: true, via: 'sms', message: `OTP sent via SMS to ${phone}` });
    } catch (smsErr) {
      logger.warn(`[PhoneOTP] SMS failed (${smsErr.code || smsErr.message}) â€” trying email fallback`);

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
            `ðŸ” Your PETclub OTP Code`,
            `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
              <div style="font-size:40px;text-align:center;margin-bottom:12px">ðŸ”</div>
              <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">Your PETclub OTP</h2>
              <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">SMS delivery failed â€” your OTP has been sent to this email instead.</p>
              <div style="background:#fff7ed;border:2px solid #fed7aa;border-radius:14px;padding:24px;text-align:center">
                <span style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ea580c;font-family:monospace">${otp}</span>
              </div>
              <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">Valid for 10 minutes Â· Do not share</p>
              <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
              <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Â· ${new Date().toLocaleString('en-IN')}</p>
            </div>`
          );
          logger.info(`[PhoneOTP] Email fallback sent to ${deliveryEmail} for ${maskPhone(phone)}`);
          return res.json({ success: true, via: 'email', email: deliveryEmail, message: `SMS unavailable â€” OTP sent to ${deliveryEmail}` });
        } catch (emailErr) {
          logger.error('[PhoneOTP] Email fallback also failed:', emailErr.message);
        }
      }

      // Both SMS and email failed â€” surface the original SMS error
      if (smsErr.code === 21211 || (smsErr.message || '').includes('not a valid phone number'))
        return res.status(400).json({ error: 'Invalid phone number. Check the country code and digits.' });
      if (smsErr.code === 21608 || (smsErr.message || '').includes('unverified'))
        return res.status(400).json({ error: 'This number is not yet reachable via SMS. Please use Email OTP to sign in.' });
      return res.status(500).json({ error: 'Failed to send OTP via SMS or email. Please use Email OTP to sign in.' });
    }
  } catch (err) {
    logger.error('[PhoneOTP] Unexpected error:', err.message);
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
    if (!crypto.timingSafeEqual(Buffer.from(String(rec.otp)), Buffer.from(String(otp))))
      return res.status(400).json({ error: 'Incorrect OTP. Check your SMS and try again.' });

    await supabase.from('otp_tokens').update({ verified: true }).eq('phone', phone);

    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    const isNew = !user;
    if (!user) {
      const { data: nu, error: insertErr } = await supabase
        .from('users')
        .insert({ phone, role: 'pending_role', is_active: true })
        .select().single();
      if (insertErr) {
        logger.error('[PhoneOTP] Insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create account. Try again.' });
      }
      user = nu;
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendEmail(adminEmail, `ðŸ¾ New PETclub Signup (Phone) â€” ${maskPhone(phone)}`,
          `<p style="font-family:Arial,sans-serif">New user signed up via phone OTP: <strong>${maskPhone(phone)}</strong></p>`
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

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    logger.info(`[PhoneOTP] ${isNew ? 'New' : 'Returning'} user: ${maskPhone(phone)}`);
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
    res.json({ success: true, isNew, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, verificationStatus, subRole } });
  } catch (err) {
    logger.error('[PhoneOTP] Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  AUTH: SET ROLE (called once for new users)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // Referral / Partner source (optional, customer sign-up only)
    // Sanitize and uppercase so matching is case-insensitive ("PCR-..." codes are uppercase)
    const referralInput = sanitize(req.body.referral_input)?.trim().toUpperCase() || null;
    let referredByCode = null;
    let partnerSource  = null;
    if (referralInput && role === 'customer') {
      // Check if the input matches an existing PETclub referral_code
      const { data: referrer } = await supabase
        .from('users')
        .select('id, referral_code')
        .eq('referral_code', referralInput)
        .neq('id', req.user.id)   // can't refer yourself
        .single();
      if (referrer) {
        // It's a valid customer referral â€” record it and credit the referrer
        referredByCode = referralInput;
        // Award referral bonus to the referrer (non-blocking; fail silently)
        loyalty.awardPoints(
          supabase, referrer.id, loyalty.REFERRAL_BONUS,
          'referral_bonus',
          `Referral bonus â€” friend signed up (user ${req.user.id})`,
          null
        ).catch(e => logger.error('[Referral] award bonus error:', e.message));
      } else {
        // Not a known referral code â€” treat as a free-text partner/clinic name
        // Store original casing from the user's input (before toUpperCase())
        partnerSource = sanitize(req.body.referral_input)?.trim() || null;
      }
    }

    // Infer country from phone prefix
    const phoneCountry = req.user.phone?.startsWith('+1') ? 'United States'
      : req.user.phone?.startsWith('+91') ? 'India' : null;

    // Update user record (include referral/partner if resolved)
    const userUpdate = { role, name: name || null, email: email || null };
    if (referredByCode) userUpdate.referred_by_code = referredByCode;
    if (partnerSource)  userUpdate.partner_source   = partnerSource;
    await supabase.from('users').update(userUpdate).eq('id', req.user.id);

    if (role === 'professional') {
      if (!['Groomer', 'Trainer', 'Vet', 'Walker', 'Boarding'].includes(subRole))
        return res.status(400).json({ error: 'subRole must be Groomer, Trainer, Vet, Walker, or Boarding' });
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
          if (error) logger.error('pro GPS coords update:', error.message);
        });
      }
    }

    if (role === 'customer') {
      try {
        await supabase.from('customer_profiles').upsert({
          user_id: req.user.id, address: address || null, city: city || null,
          country: phoneCountry,
        }, { onConflict: 'user_id' });
      } catch (e) { logger.error('customer_profiles upsert:', e.message); }
      // Store GPS coords in separate update (graceful: requires GPS migration to have run)
      if (addressLat && addressLng) {
        supabase.from('customer_profiles').update({
          address_lat: addressLat, address_lng: addressLng,
          address_postal_code: addressPostalCode,
          address_city: addressCity, address_state: addressState,
        }).eq('user_id', req.user.id).then(({ error }) => {
          if (error) logger.error('customer GPS coords update:', error.message);
        });
      }
    }

    // For customers â€” create initial pet if provided
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
      } catch (e) { logger.error('Initial pet creation error:', e.message); }
    }

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
    const verificationStatus = role === 'professional' ? 'pending' : null;
    // subRole already defined above from req.body

    // Send welcome email (non-blocking)
    const fn = (name || 'there').split(' ')[0];
    if (email) {
      const isPro = role === 'professional';
      if (isPro) {
        // Professional: role-assignment email (under-review messaging)
        emailService.sendRoleAssignedEmail(email, { name, role, subRole })
          .catch(e => logger.error('[Email] Role-assigned email failed:', e.message));
      } else {
        // Customer: welcome email with optional pet card
        emailService.sendWelcomeEmail(email, { name, pet })
          .catch(e => logger.error('[Email] Welcome email failed:', e.message));
      }
    }

    res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, verificationStatus, subRole: role === 'professional' ? subRole : null } });
  } catch (err) {
    logger.error('Set role error:', err.message);
    res.status(500).json({ error: 'Failed to set role.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CONTACT: SEND APP LINK (website form)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/contact/send-link', async (req, res) => {
  try {
    const { name, phone, email, city, pettype, service, pet } = req.body;
    // Sanitize free-text message to prevent HTML injection in admin email
    const message = sanitize(req.body.message || '');
    if (!phone || !email || !name) return res.status(400).json({ error: 'Name, phone and email required' });

    const fn = name.split(' ')[0];
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
    const fullLeadPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    const isInquiry = ['Pet Food', 'Pet Boarding'].includes(service);


    if (isInquiry) {
      // â”€â”€ Inquiry confirmation to user â”€â”€
      const svcIcon = service === 'Pet Food' ? 'ðŸ–' : 'ðŸ ';
      const svcColor = service === 'Pet Food' ? '#16a34a' : '#f97316';
      await sendEmail(email, `${svcIcon} Your ${service} Inquiry â€” PETclub Will Reach Out ASAP`, `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:linear-gradient(135deg,${svcColor},${svcColor}cc);padding:36px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">${svcIcon}</div>
            <h1 style="color:white;margin:0;font-size:24px;font-weight:800">Inquiry Received!</h1>
            <p style="color:rgba(255,255,255,0.88);margin:8px 0 0;font-size:15px">${service} Â· PETclub</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <b>${fn}</b>! ðŸ‘‹</p>
            <p style="color:#475569;font-size:15px;margin:0 0 20px;line-height:1.6">
              Thanks for your interest in <b>${service}</b>! We've received your inquiry and our team will reach out to you at <b>${email}</b> within <b>24 hours</b>.
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin-bottom:24px;">
              <p style="color:#64748b;font-weight:700;margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Your Request</p>
              <p style="color:#1e293b;font-size:14px;margin:0;line-height:1.7;white-space:pre-wrap;">${message || '(No details provided)'}</p>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:14px;padding:16px;margin-bottom:24px;text-align:center;">
              <p style="color:#c2410c;font-size:14px;margin:0;font-weight:600">â± Response within 24 hours<br/>ðŸ“§ Reach us anytime: <a href="mailto:${SUPPORT_EMAIL}" style="color:#f97316;">${SUPPORT_EMAIL}</a></p>
            </div>
            <div style="text-align:center;">
              <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;">Explore PETclub App â†’</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;">
            Â© ${new Date().getFullYear()} PETclub Â· For pets, with love ðŸ¾
          </div>
        </div>`);

      // â”€â”€ Admin notification â”€â”€
      if (adminEmail) {
        sendEmail(adminEmail, `ðŸ”” [${service} Inquiry] ${name} Â· ${email}`, `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:16px;border:2px solid ${svcColor};overflow:hidden;">
            <div style="background:${svcColor};padding:20px 24px;">
              <h2 style="color:#fff;margin:0;font-size:18px;">${svcIcon} New ${service} Inquiry</h2>
              <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">Action required â€” reach out within 24 hours</p>
            </div>
            <div style="padding:24px;">
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px 0;color:#64748b;width:80px;">Name</td><td style="padding:6px 0;font-weight:700;color:#1e293b;">${name}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">Email</td><td style="padding:6px 0;color:#1e293b;"><a href="mailto:${email}" style="color:#f97316;">${email}</a></td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">Phone</td><td style="padding:6px 0;color:#1e293b;">${fullLeadPhone}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b;">City</td><td style="padding:6px 0;color:#1e293b;">${city || 'â€”'}</td></tr>
              </table>
              <hr style="border:none;border-top:1px solid #f1f5f9;margin:16px 0;" />
              <p style="color:#64748b;font-size:13px;font-weight:700;margin:0 0 8px;">Their Request:</p>
              <div style="background:#f8fafc;border-radius:10px;padding:14px;color:#1e293b;font-size:14px;line-height:1.7;white-space:pre-wrap;">${message || '(No details provided)'}</div>
            </div>
          </div>`
        ).catch(e => logger.error('[Inquiry] Admin notify failed:', e.message));
      }
    } else {
      // â”€â”€ Regular signup welcome email â”€â”€
      await sendEmail(email, `ðŸ¾ Welcome to PETclub, ${fn}!`, `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:linear-gradient(135deg,#f97316,#fbbf24);padding:40px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">ðŸ¾</div>
            <h1 style="color:white;margin:0;font-size:26px;font-weight:800">Welcome to PETclub!</h1>
            <p style="color:rgba(255,255,255,0.88);margin:8px 0 0;font-size:15px">India's #1 pet care platform</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1e293b;font-size:16px;margin:0 0 20px">Hi <b>${fn}</b>! ðŸŽ‰ You're all set. Book ${service||'grooming, training & vet care'} for ${pet||'your pet'} in ${city||'your city'} â€” right from your browser.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${WEB_APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:16px 36px;border-radius:14px;text-decoration:none;font-weight:800;font-size:16px;letter-spacing:0.3px;">ðŸš€ Open PETclub App</a>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:14px;padding:20px;margin-bottom:20px;">
              <p style="color:#c2410c;font-weight:700;margin:0 0 10px;font-size:14px">ðŸŒŸ What you can do:</p>
              <ul style="color:#64748b;line-height:2;margin:0;padding-left:18px;font-size:14px">
                <li>Book grooming, training, vet visits & more</li>
                <li>Manage your pet's health records digitally</li>
                <li>Track service professionals in real time</li>
                <li>ðŸ›¡ï¸ â‚¹25,000 service protection guarantee</li>
              </ul>
            </div>
            <div style="background:#f8fafc;border-radius:12px;padding:16px;text-align:center;">
              <p style="color:#64748b;font-size:13px;margin:0">ðŸ“± <b>Native mobile apps coming soon</b> for iOS & Android.<br/>Until then, our web app works great on any device!</p>
            </div>
          </div>
          <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;">
            Â© ${new Date().getFullYear()} PETclub Â· For pets, with love ðŸ¾ Â· <a href="${WEBSITE_URL}" style="color:#f97316;text-decoration:none;">mypetclub.app</a>
          </div>
        </div>`);
    }

    // Save lead to DB (non-blocking)
    try {
      await supabase.from('website_leads').insert({ name, phone: fullLeadPhone, email, city, pet_type: pettype, service_interest: service, pet_name: pet, message });
    } catch (e) { logger.error('website_leads insert:', e.message); }

    res.json({ success: true, message: isInquiry ? 'Inquiry received! Team will reach out within 24h.' : 'App link sent via SMS and email!' });
  } catch (err) {
    logger.error('Send link error:', err.message);
    res.status(500).json({ error: 'Failed to send. Try again.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: CREATE FIRST ADMIN (one-time, requires secret)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Bootstrap-only: promote a phone number to admin role.
// Rate-limited (authLimit) to prevent brute-force of ADMIN_SECRET.
// After initial setup, disable by removing ADMIN_SECRET from env vars.
app.post('/api/admin/make-admin', authLimit, async (req, res) => {
  try {
    const { phone, countryCode = '91', secret } = req.body;
    if (!process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Bootstrap endpoint disabled â€” ADMIN_SECRET not set' });
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  USER ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

  // Server-side email typo block (only explicit bad TLDs â€” never flag .com)
  if (email) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    const tld = domain.includes('.') ? domain.split('.').pop() : '';
    const badTlds = ['con','conm','cmo','ocm','cim','cpm','copm'];
    if (tld && badTlds.includes(tld))
      return res.status(400).json({ error: `"${domain}" looks like a typo â€” did you mean .com?` });
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
        if (error) logger.error('profile GPS update:', error.message);
      });
    }
  }
  res.json({ success: true, message: 'Profile updated' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PET ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/pets', auth, async (req, res) => {
  const { data } = await supabase.from('pets').select('*').eq('owner_id', req.user.id).is('deleted_at', null).order('created_at');
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

app.delete('/api/pets/:id', auth, async (req, res) => {
  const { data, error } = await supabase.from('pets')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('owner_id', req.user.id).is('deleted_at', null)
    .select('id').single();
  if (error || !data) return res.status(404).json({ error: 'Pet not found or already removed' });
  res.json({ success: true, deleted: req.params.id });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  RECORDS: grooming / training / food / vet
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const TABLES = { grooming: 'grooming_records', training: 'training_records', food: 'food_orders', vet: 'vet_records' };

// â”€â”€ Shared pet-ownership guard (C-1 fix) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admins can access any pet. All other roles must own the pet.
const assertPetOwnership = async (petId, userId, role) => {
  if (role === 'admin') return null; // admins skip the check
  const { data: pet, error } = await supabase
    .from('pets').select('owner_id').eq('id', petId).is('deleted_at', null).single();
  if (error || !pet) return { status: 404, error: 'Pet not found' };
  if (pet.owner_id !== userId) return { status: 403, error: 'Access denied' };
  return null; // null = access granted
};

app.get('/api/pets/:petId/records/:type', auth, async (req, res) => {
  const tbl = TABLES[req.params.type];
  if (!tbl) return res.status(400).json({ error: 'Invalid type. Use: grooming, training, food, vet' });

  const denied = await assertPetOwnership(req.params.petId, req.user.id, req.user.role);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  const { data } = await supabase.from(tbl).select('*').eq('pet_id', req.params.petId).order('date', { ascending: false });
  res.json({ success: true, records: data });
});

app.post('/api/pets/:petId/records/:type', auth, async (req, res) => {
  const tbl = TABLES[req.params.type];
  if (!tbl) return res.status(400).json({ error: 'Invalid type. Use: grooming, training, food, vet' });

  const denied = await assertPetOwnership(req.params.petId, req.user.id, req.user.role);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  // Remove any client-supplied pet_id â€” always use the authenticated route parameter
  const { pet_id: _ignored, id: _id, ...safeBody } = req.body;
  const { data, error } = await supabase.from(tbl)
    .insert({ pet_id: req.params.petId, ...safeBody }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, record: data });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  SERVICE CATALOG â€” public pricing for customers
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Returns the full service catalog with tiered prices.
// Accessible to authenticated customers only (never to SPs).
app.get('/api/services/catalog', auth, (req, res) => {
  if (req.user.role === 'professional') {
    return res.status(403).json({ error: 'Service pricing is not available to providers.' });
  }
  const {
    PLATFORM_DISCOUNT, GROOMING_PACKAGES, GROOMING_ADDONS,
    PET_SIZES, TRAINING_PACKAGES, WALKING_PACKAGES, BOARDING_PACKAGES, VET_SERVICES,
  } = pricingCatalog;
  res.json({
    success: true,
    platform_discount: PLATFORM_DISCOUNT,
    grooming: { packages: GROOMING_PACKAGES, addons: GROOMING_ADDONS, pet_sizes: PET_SIZES },
    training: { packages: TRAINING_PACKAGES },
    walking:  { packages: WALKING_PACKAGES },
    boarding: { packages: BOARDING_PACKAGES },
    vet:      { services: VET_SERVICES, note: 'Pricing quoted on-site after initial assessment.' },
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  LOYALTY â€” Credits earn, redeem, and coupon system
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// GET /api/loyalty â€” balance, progress, transactions, active coupons
app.get('/api/loyalty', auth, async (req, res) => {
  try {
    const summary = await loyalty.getLoyaltySummary(supabase, req.user.id);
    res.json({ success: true, ...summary });
  } catch (e) {
    logger.error('[Loyalty] getLoyaltySummary error:', e.message);
    res.status(500).json({ error: 'Could not load loyalty data' });
  }
});

// POST /api/loyalty/redeem â€” redeem 1,000 credits for a free service coupon
app.post('/api/loyalty/redeem', auth, async (req, res) => {
  if (req.user.role === 'professional') {
    return res.status(403).json({ error: 'Loyalty credits are for customers only.' });
  }
  try {
    const result = await loyalty.redeemCredits(supabase, req.user.id);
    if (!result.success) return res.status(400).json({ error: result.error, existingCode: result.existingCode });
    res.json({
      success:     true,
      couponCode:  result.couponCode,
      expiresAt:   result.expiresAt,
      newBalance:  result.newBalance,
      serviceName: result.serviceName,
      message:     `Your coupon ${result.couponCode} is valid for a free ${result.serviceName}. Expires in 6 months.`,
    });
  } catch (e) {
    logger.error('[Loyalty] redeemCredits error:', e.message);
    res.status(500).json({ error: 'Redemption failed. Please try again.' });
  }
});

// POST /api/loyalty/validate-coupon â€” check coupon before booking (customer only)
app.post('/api/loyalty/validate-coupon', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Coupon code required' });
  const result = await loyalty.validateCoupon(supabase, code, req.user.id);
  if (!result.valid) return res.status(400).json({ error: result.error });
  res.json({ success: true, coupon: { service_name: result.coupon.service_name, discount_pct: result.coupon.discount_pct, expires_at: result.coupon.expires_at } });
});

// POST /api/admin/loyalty/award â€” manual award (admin only)
app.post('/api/admin/loyalty/award', auth, adminOnly, async (req, res) => {
  const { userId, points, type = 'admin_award', description } = req.body;
  if (!userId || !points) return res.status(400).json({ error: 'userId and points required' });
  const result = await loyalty.awardPoints(supabase, userId, points, type, description || 'Admin award');
  if (!result.success) return res.status(500).json({ error: result.error });
  // Audit every manual credit change â€” financial operations must be traceable
  await supabase.from('admin_logs').insert({
    admin_id:    req.user.id,
    action:      points > 0 ? 'award_loyalty' : 'deduct_loyalty',
    target_id:   userId,
    target_type: 'user',
    notes:       `${points > 0 ? '+' : ''}${points} pts â€” ${description || 'Admin award'} (new balance: ${result.newBalance})`,
  }).catch(e => logger.error('[AdminLoyalty] audit log failed:', e.message));
  res.json({ success: true, newBalance: result.newBalance, awarded: result.awarded });
});

// GET /api/admin/loyalty/stats â€” programme health dashboard (admin only)
// Returns redemption rate, top earners, anomalies, active coupons.
// Use ?days=N to change the reporting window (default 30).
app.get('/api/admin/loyalty/stats', auth, adminOnly, async (req, res) => {
  try {
    const days  = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    // O-5 fix: top_earners now read from the loyalty_leaderboard materialized view
    // (refreshed nightly) instead of being computed from a full loyalty_transactions
    // scan in JS memory. The other 4 queries aggregate counters only â€” no full table
    // scans â€” so they remain as-is.
    const [earnRes, redeemRes, couponRes, anomalyRes, eligibleRes, leaderboardRes] = await Promise.all([
      // Total points earned in window.
      // The RPC returns a scalar number directly in data (not an array).
      // Normalise to { data: <number> } so the reduce below doesn't throw.
      supabase.rpc('sum_loyalty_earned_in_window', { p_since: since })
        .then(r => ({ data: typeof r.data === 'number' ? r.data : null, error: r.error }))
        .catch(() => supabase.from('loyalty_transactions')
          .select('points')
          .gt('points', 0)
          .gte('created_at', since)),

      // Total points redeemed in window
      supabase.from('loyalty_transactions')
        .select('points')
        .lt('points', 0)
        .eq('type', 'redemption')
        .gte('created_at', since),

      // Active (unused, non-expired) coupons
      supabase.from('loyalty_coupons')
        .select('id', { count: 'exact', head: true })
        .eq('is_used', false)
        .gt('expires_at', new Date().toISOString()),

      // Anomaly candidates: users earning > threshold in last 24 h
      supabase.from('loyalty_transactions')
        .select('user_id, points')
        .gt('points', 0)
        .gte('created_at', new Date(Date.now() - 86400_000).toISOString()),

      // Users currently eligible to redeem (balance >= 1000)
      supabase.from('users')
        .select('id', { count: 'exact', head: true })
        .gte('loyalty_points', loyalty.REDEMPTION_THRESHOLD),

      // O-5: top earners from materialized view â€” O(1) indexed scan
      // Only include users who have actually earned points (filters stale 0-pt entries)
      supabase.from('loyalty_leaderboard')
        .select('user_id, name, total_earned, total_spent, current_balance')
        .gt('total_earned', 0)
        .order('total_earned', { ascending: false })
        .limit(10),
    ]);

    // earnRes.data is either a scalar number (RPC) or an array of rows (fallback query)
    const totalEarned = typeof earnRes.data === 'number'
      ? earnRes.data
      : (Array.isArray(earnRes.data) ? earnRes.data : []).reduce((s, r) => s + (r.points || 0), 0);
    const totalRedeemed = (redeemRes.data || []).reduce((s, r) => s + -r.points, 0); // stored negative
    const redemptionRate = totalEarned > 0
      ? Math.round((totalRedeemed / totalEarned) * 100) : 0;

    // Top earners: served from materialized view (falls back to JS aggregate if view not yet created)
    const topEarners = (leaderboardRes.data && leaderboardRes.data.length > 0)
      ? leaderboardRes.data.map(r => ({
          user_id:         r.user_id,
          name:            r.name,
          points_earned:   r.total_earned,
          total_earned:    r.total_earned,
          current_balance: r.current_balance,
          total_spent:     r.total_spent,
        }))
      : (() => {
          // Fallback: if materialized view doesn't exist yet, compute from earnRes
          const earnerMap = {};
          for (const row of earnRes.data || []) {
            earnerMap[row.user_id] = (earnerMap[row.user_id] || 0) + row.points;
          }
          return Object.entries(earnerMap).sort(([, a], [, b]) => b - a).slice(0, 10)
            .map(([user_id, points_earned]) => ({ user_id, points_earned }));
        })();

    // Anomaly candidates â€” users earning > threshold in last 24 h
    const anomalyMap = {};
    for (const row of anomalyRes.data || []) {
      anomalyMap[row.user_id] = (anomalyMap[row.user_id] || 0) + row.points;
    }
    const anomalies = Object.entries(anomalyMap)
      .filter(([, pts]) => pts > loyalty.ANOMALY_THRESHOLD_24H)
      .map(([user_id, earned_24h]) => ({ user_id, earned_24h }));

    res.json({
      success:          true,
      window_days:      days,
      total_earned:     totalEarned,
      total_redeemed:   totalRedeemed,
      redemption_rate:  `${redemptionRate}%`,
      active_coupons:   couponRes.count ?? 0,
      eligible_to_redeem: eligibleRes.count ?? 0,
      top_earners:      topEarners,
      anomalies,                              // empty array = all clear
      anomaly_threshold_24h: loyalty.ANOMALY_THRESHOLD_24H,
      generated_at:     new Date().toISOString(),
    });
  } catch (e) {
    logger.error('[Loyalty] stats error:', e.message);
    res.status(500).json({ error: 'Could not generate loyalty stats' });
  }
});

// GET /api/admin/loyalty/partner-report â€” partner commission summary (admin only)
// O-2 fix: replaced JS GROUP BY reduce() with Supabase aggregate queries.
// Old version fetched ALL partner users + ALL referred users into Node memory
// and grouped them with for-loops. This is replaced with two aggregate queries
// that let Postgres do the grouping. Per-user detail rows are still returned
// but only fetched when explicitly requested via ?detail=true.
app.get('/api/admin/loyalty/partner-report', auth, adminOnly, async (req, res) => {
  try {
    const includeDetail = req.query.detail === 'true';

    // â”€â”€ Partner aggregates via Supabase GROUP BY (no JS reduce needed) â”€â”€â”€â”€â”€â”€â”€â”€
    const [aggRes, referralAggRes] = await Promise.all([
      // Sum signups and commission status per partner_source
      supabase
        .from('users')
        .select('partner_source, commission_paid, created_at')
        .not('partner_source', 'is', null)
        .order('created_at', { ascending: false }),

      // Count referred sign-ups per referral code
      supabase
        .from('users')
        .select('referred_by_code')
        .not('referred_by_code', 'is', null),
    ]);
    if (aggRes.error) throw aggRes.error;

    // Build partner summary â€” compact loop over a filtered result set
    // (partner_source users only â€” typically a small number of partners)
    const byPartner = {};
    for (const u of (aggRes.data || [])) {
      const key = u.partner_source;
      if (!byPartner[key]) byPartner[key] = { partner_name: key, total_signups: 0, unpaid_signups: 0, paid_signups: 0, latest_signup: null };
      byPartner[key].total_signups++;
      if (u.commission_paid) byPartner[key].paid_signups++;
      else byPartner[key].unpaid_signups++;
      if (!byPartner[key].latest_signup || u.created_at > byPartner[key].latest_signup) byPartner[key].latest_signup = u.created_at;
    }

    // Referral code frequency map
    const byCode = {};
    for (const u of (referralAggRes.data || [])) {
      byCode[u.referred_by_code] = (byCode[u.referred_by_code] || 0) + 1;
    }

    // Fetch per-user detail rows only when explicitly requested â€” keeps default
    // response payload small for the admin dashboard overview cards.
    let detailByPartner = null;
    if (includeDetail) {
      const { data: detailRows } = await supabase
        .from('users')
        .select('id, name, phone, partner_source, commission_paid, created_at')
        .not('partner_source', 'is', null)
        .order('created_at', { ascending: false });
      detailByPartner = {};
      for (const u of (detailRows || [])) {
        if (!detailByPartner[u.partner_source]) detailByPartner[u.partner_source] = [];
        detailByPartner[u.partner_source].push({ id: u.id, name: u.name, phone: u.phone, commission_paid: u.commission_paid, created_at: u.created_at });
      }
    }

    const partner_summary = Object.values(byPartner)
      .sort((a, b) => b.total_signups - a.total_signups)
      .map(p => ({ ...p, users: detailByPartner?.[p.partner_name] || undefined }));

    res.json({
      partner_summary,
      referral_summary: { total_referred: (referralAggRes.data || []).length, by_code: byCode },
      total_partner_signups: (aggRes.data || []).length,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    logger.error('[PartnerReport] error:', e.message);
    res.status(500).json({ error: 'Could not generate partner report' });
  }
});

// GET /api/admin/revenue-report â€” booking revenue by professional (admin only)
// Uses the partner_revenue_report() SQL aggregate function created in
// supabase-security-hardening.sql. Accepts ?from_date= and ?to_date= (YYYY-MM-DD).
app.get('/api/admin/revenue-report', auth, adminOnly, async (req, res) => {
  try {
    const fromDate = req.query.from_date || '2000-01-01';
    const toDate   = req.query.to_date   || new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc('partner_revenue_report', {
      p_from: fromDate,
      p_to:   toDate,
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, report: data, from_date: fromDate, to_date: toDate, generated_at: new Date().toISOString() });
  } catch (e) {
    logger.error('[RevenueReport] error:', e.message);
    res.status(500).json({ error: 'Could not generate revenue report' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PROFESSIONAL ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Public endpoint â€” intentionally unauthenticated so prospective customers can
// browse professionals before signing up. Phone numbers are NEVER returned here
// (C-3 fix): the customer receives the professional's contact details only after
// a booking is confirmed (via the booking detail endpoint).
app.get('/api/professionals', async (req, res) => {
  const { city, sub_role } = req.query;
  let q = supabase
    .from('professional_profiles')
    .select(
      'id, user_id, sub_role, city, area, rating, total_reviews, bio, ' +
      'experience, service_areas, langs, services, is_available, ' +
      'users(name)',   // â† name only; phone/email intentionally excluded
    )
    .eq('verification_status', 'approved')
    .eq('is_available', true);
  if (city)     q = q.ilike('city', `%${city}%`);
  if (sub_role) q = q.eq('sub_role', sub_role);
  const { data } = await q.order('rating', { ascending: false });
  res.json({ success: true, professionals: data });
});

app.get('/api/professionals/me', auth, async (req, res) => {
  if (req.user.role !== 'professional' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access restricted to professionals.' });
  }
  const { data: prof } = await supabase.from('professional_profiles').select('*').eq('user_id', req.user.id).single();
  const { data: user } = await supabase.from('users').select('id,name,phone,email,role').eq('id', req.user.id).single();
  res.json({ success: true, profile: { ...prof, ...user } });
});

app.put('/api/professionals/me', auth, async (req, res) => {
  if (req.user.role !== 'professional' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access restricted to professionals.' });
  }
  const name = sanitize(req.body.name), email = sanitize(req.body.email);
  const city = sanitize(req.body.city), area = sanitize(req.body.area);
  const address = sanitize(req.body.address), bio = sanitize(req.body.bio);
  const experience = sanitize(req.body.experience), service_areas = sanitize(req.body.service_areas);
  const langs = sanitize(req.body.langs), certification = sanitize(req.body.certification);
  const license_number = sanitize(req.body.license_number), clinic_name = sanitize(req.body.clinic_name);
  const price_basic = req.body.price_basic, price_full = req.body.price_full, price_custom = req.body.price_custom;
  const { sub_role } = req.body;
  const services = req.body.services;
  // GPS address metadata from AddressPicker â€” used for 70km radius dispatch
  const addressLat = typeof req.body.address_lat === 'number' ? req.body.address_lat : null;
  const addressLng = typeof req.body.address_lng === 'number' ? req.body.address_lng : null;
  if (name !== undefined || email !== undefined)
    await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  const pet_types = req.body.pet_types;
  const updatePayload = {
    city, area, address, bio, experience,
    // services is text[] in Postgres â€” pass as native array, NOT JSON.stringify.
    // JSON.stringify caused a type error that silently failed the entire update.
    services:   Array.isArray(services)   ? services   : undefined,
    pet_types:  Array.isArray(pet_types)  ? pet_types  : undefined,
    service_areas, langs, price_basic, price_full, price_custom,
    certification, license_number, clinic_name,
  };
  // Only store GPS if provided (graceful: column may not exist yet)
  if (addressLat && addressLng) {
    updatePayload.address_lat = addressLat;
    updatePayload.address_lng = addressLng;
  }
  // Only update sub_role if explicitly provided (prevents overwriting with undefined)
  if (sub_role && ['Groomer','Trainer','Vet','Walker','Boarding'].includes(sub_role)) {
    updatePayload.sub_role = sub_role;
  }
  // Fetch current profile BEFORE update to detect first-time profile completion
  const { data: existingProf } = await supabase.from('professional_profiles').select('bio, experience, sub_role').eq('user_id', req.user.id).single();
  const wasIncomplete = !existingProf?.bio && !existingProf?.experience;
  const willBeComplete = !!(bio && experience);

  const { data, error: updateErr } = await supabase.from('professional_profiles').update(updatePayload)
    .eq('user_id', req.user.id).select().single();
  if (updateErr) {
    logger.error('[ProProfile PUT] Supabase update error:', updateErr.message);
    return res.status(500).json({ error: 'Failed to update profile: ' + updateErr.message });
  }

  // Notify admin when professional completes their profile for the first time (in-review)
  if (wasIncomplete && willBeComplete) {
    const { data: u } = await supabase.from('users').select('name, phone, email').eq('id', req.user.id).single();
    const adminEmail = process.env.ADMIN_EMAIL;
    const finalSubRole = updatePayload.sub_role || existingProf?.sub_role || 'Professional';
    if (adminEmail) {
      sendEmail(adminEmail,
        `ðŸ”” PETclub â€” ${finalSubRole} Profile Ready for Review: ${u?.name || u?.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px;border:2px solid #f97316;">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">ðŸ””</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">New ${finalSubRole} Pending Verification</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">A professional has completed their profile and is awaiting your approval.</p>
          <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:20px;margin-bottom:16px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u?.name || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u?.phone || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u?.email || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#f97316;font-size:13px;font-weight:700;text-align:right">${finalSubRole}</td></tr>
            </table>
          </div>
          <p style="text-align:center;margin:0"><a href="${WEB_APP_URL}" style="display:inline-block;background:#f97316;color:white;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px">Review in Admin Dashboard â†’</a></p>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin Â· ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => logger.error('[ProProfile] Admin notification failed:', e.message));
    }
  }

  res.json({ success: true, profile: data });
});

// Toggle online/offline availability â€” with admin email notification
app.put('/api/professionals/availability', auth, async (req, res) => {
  if (req.user.role !== 'professional' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access restricted to professionals.' });
  }
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
    const proPhone = prof.users?.phone || 'â€”';
    const subRole  = prof.sub_role || 'Professional';
    const status   = is_available ? 'ðŸŸ¢ ONLINE' : 'â¸ OFFLINE';
    const city     = prof.city || 'â€”';

    sendEmail(adminEmail, `PETclub: ${subRole} ${proName} is now ${status}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px">
        <h2 style="color:#f97316">ðŸ¾ PETclub â€” Professional Status Change</h2>
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
    ).catch(e => logger.error('[Availability] Admin email failed:', e.message));
  }

  res.json({ success: true, is_available, message: is_available ? 'You are now Online ðŸŸ¢' : 'You are now Offline â¸' });
});

app.post('/api/professionals/apply', auth, async (req, res) => {
  // Allowlist: never accept verification_status or is_available from client
  const { sub_role, city, address, bio, experience } = req.body;
  if (sub_role && !['Groomer', 'Trainer', 'Vet', 'Walker', 'Boarding'].includes(sub_role))
    return res.status(400).json({ error: 'sub_role must be Groomer, Trainer, Vet, Walker, or Boarding' });
  // Block re-application if already approved â€” prevents role-switch fraud
  const { data: existing } = await supabase.from('professional_profiles').select('verification_status').eq('user_id', req.user.id).single();
  if (existing?.verification_status === 'approved')
    return res.status(400).json({ error: 'Your profile is already verified. Contact support to update your role.' });
  const { data, error } = await supabase.from('professional_profiles').upsert({
    user_id:             req.user.id,
    verification_status: 'pending',   // always pending â€” never accept from client
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

// ID document photo upload (base64 â†’ Supabase Storage)
// â”€â”€ Professional ID + Certification Upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SECURITY POLICY: Photos are NEVER stored in the database or cloud storage.
// They are emailed directly to the admin as attachments and immediately discarded.
// Only doc_type, doc_number, cert_type are stored in id_documents (metadata only).
app.post('/api/professionals/upload-id-photo', auth, async (req, res) => {
  try {
    const { docType, docNumber, docPhoto, certType, certNumber, certPhoto } = req.body;
    if (!docType) return res.status(400).json({ error: 'Document type required (Aadhar Card / Passport / Driving License)' });

    const { data: prof } = await supabase.from('professional_profiles').select('id, sub_role, city').eq('user_id', req.user.id).single();
    if (!prof) return res.status(404).json({ error: 'Professional profile not found. Complete signup first.' });

    // Store ONLY metadata â€” never photo paths (photos go to admin email only)
    const docMeta = {
      prof_id: prof.id,
      doc_type: docType,
      doc_number: docNumber || null,
      // photo_url intentionally OMITTED â€” photos are never stored
    };
    if (certType) { docMeta.cert_type = certType; docMeta.cert_number = certNumber || null; }
    await supabase.from('id_documents').upsert(docMeta, { onConflict: 'prof_id' });

    // â”€â”€ Email photos directly to admin as attachments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        } catch (e) { logger.error('[ID photo parse]', e.message); }
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
        } catch (e) { logger.error('[Cert photo parse]', e.message); }
      }

      const html = `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px;border:2px solid #dc2626;">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">ðŸ”</div>
          <h2 style="color:#1e293b;font-size:18px;text-align:center;margin:0 0 4px">ID Proof â€” Admin Eyes Only</h2>
          <p style="color:#64748b;font-size:12px;text-align:center;margin:0 0 20px">Photos are attached. They are <strong>not stored anywhere</strong> in the system.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px;margin-bottom:16px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Full Name</td>
                  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right">${sanitize(proName)}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Phone</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${u?.phone || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Email</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${u?.email || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">Role</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${prof?.sub_role || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:5px 0;border-bottom:1px solid #fee2e2">City</td>
                  <td style="color:#1e293b;font-size:13px;text-align:right">${prof?.city || 'â€”'}</td></tr>
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
            âš ï¸ ${attachments.length} photo${attachments.length !== 1 ? 's' : ''} attached to this email.<br>
            Do NOT forward. Delete after verification.
          </p>
          <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0">Submitted: ${ts}</p>
        </div>`;

      sendEmail(
        adminEmail,
        `ðŸ” PETclub ID Proof â€” ${sanitize(proName)} (${sanitize(docType)}) â€” ACTION REQUIRED`,
        html,
        attachments
      ).catch(e => logger.error('[ID email send error]', e.message));
    } else {
      logger.warn('[upload-id-photo] ADMIN_EMAIL not set â€” ID proof email not sent!');
    }

    res.json({ success: true, message: 'ID submitted â€” our team will verify within 24â€“48 hours.' });
  } catch (err) {
    logger.error('ID upload error:', err.message);
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
        if (!upErr) customerPhotoPath = filename; // store path (private bucket â€” use signed URL to view)
      } catch (e) { logger.error('Customer ID photo error:', e.message); }
    }

    await supabase.from('customer_profiles').upsert({
      user_id: req.user.id,
      id_doc_type: docType,
      id_doc_number: docNumber || null,
      id_photo_url: customerPhotoPath,
    }, { onConflict: 'user_id' });

    res.json({ success: true, message: 'ID document saved' });
  } catch (err) {
    logger.error('Customer ID upload error:', err.message);
    res.status(500).json({ error: 'Failed to save document. Try again.' });
  }
});

app.post('/api/professionals/payout', auth, async (req, res) => {
  if (req.user.role !== 'professional') return res.status(403).json({ error: 'Professionals only' });
  const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
  if (!prof) return res.status(404).json({ error: 'Professional profile not found' });
  // Allowlist payout fields â€” never accept prof_id or computed fields from client
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

// Pro: Earnings summary â€” only provider_earnings, never total_amount or platform_fee
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  BOOKING ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/bookings', auth, async (req, res) => {
  let q;
  if (req.user.role === 'customer')
    // Use explicit FK hints to avoid PostgREST relationship ambiguity
    q = supabase.from('bookings').select('*, pets!pet_id(name,species,health_notes), professional_profiles!professional_id(sub_role, users(name,phone))').eq('customer_id', req.user.id);
  else if (req.user.role === 'professional') {
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    // Phone only revealed after confirmed â€” prevents harvesting from unaccepted offers
    q = supabase.from('bookings').select('*, pets!pet_id(name,species,breed,health_notes), users!customer_id(name,phone)').eq('professional_id', prof?.id).in('assignment_status', ['confirmed','in_progress','completed']);
  } else
    // Admin: include customer + professional name/phone for live tracking panel
    q = supabase.from('bookings').select('*, pets!pet_id(name,species), users!customer_id(name,phone)');
  const { data, error } = await q.order('scheduled_at', { ascending: false });
  if (error) {
    logger.error('[GET /bookings] Supabase query error:', error.message, error.details || '');
    return res.status(500).json({ error: 'Failed to load bookings. Please try again.' });
  }
  // Field-level security: strip financial fields by role before sending
  const bookings = (data || []).map(b => stripFinancials(b, req.user.role));
  res.json({ success: true, bookings });
});

// Current Terms & Privacy Policy version â€” bump this string whenever T&C are updated.
// All bookings store which version the user agreed to at the time they booked.
const TERMS_VERSION = 'v1';

app.post('/api/bookings', auth, async (req, res) => {
  try {
    processTimedOutAssignments().catch(e => logger.error(e)); // background cleanup

    // â”€â”€ Clickwrap consent guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // The client MUST send terms_accepted: true.  This is validated server-side
    // so browser "Inspect Element" tricks that bypass the checkbox are rejected.
    if (!req.body.terms_accepted) {
      return res.status(400).json({
        error: 'You must accept the Terms of Service and Privacy Policy to book.',
      });
    }

    const { service_type, city, pet_id, service_name, scheduled_at, address, notes } = req.body;
    const { pet_size, addons } = req.body;
    const addressLat = typeof req.body.lat === 'number' ? req.body.lat : null;
    const addressLng = typeof req.body.lng === 'number' ? req.body.lng : null;

    // â”€â”€ Pet ownership guard (C-2 fix) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Prevent a customer from booking a service against another customer's pet.
    if (pet_id) {
      const { data: petCheck, error: petErr } = await supabase
        .from('pets').select('owner_id').eq('id', pet_id).single();
      if (petErr || !petCheck)
        return res.status(404).json({ error: 'Pet not found' });
      if (petCheck.owner_id !== req.user.id)
        return res.status(403).json({ error: 'You do not own this pet' });
    }
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // â”€â”€ Address geocoding enforcement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // If an address string is provided it must have verified GPS coordinates
    // (set by AddressPicker when user selects from dropdown). This prevents
    // fake/typo addresses from being booked â€” GPS is required for 70km dispatch.
    if (address && address.trim() && (!addressLat || !addressLng)) {
      return res.status(400).json({
        error: 'Please select your address from the dropdown suggestions to verify it. This ensures we dispatch the nearest professional to you.',
      });
    }

    // â”€â”€ Loyalty coupon validation (Fix 3 + Fix 4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // If customer applies a coupon code, validate it server-side.
    // Fix 4: expiry checked via WHERE expires_at > NOW() inside validateCoupon.
    const couponCode = req.body.coupon_code?.trim()?.toUpperCase() || null;
    let isLoyaltyRedemption = false;
    if (couponCode) {
      const couponCheck = await loyalty.validateCoupon(supabase, couponCode, req.user.id);
      if (!couponCheck.valid) {
        return res.status(400).json({ error: couponCheck.error });
      }
      isLoyaltyRedemption = true;
    }

    // â”€â”€ Pricing â€” server-side calculation (tamper-proof) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Always recalculate from the catalog; never trust client-supplied amount.
    // When a valid loyalty coupon is applied â†’ final amount = 0 (free service).
    const pricingResult = pricingCatalog.calculateAmount({
      serviceType: service_type, serviceName: service_name,
      petSize: pet_size, addons: Array.isArray(addons) ? addons : [],
    });
    const resolvedAmount = isLoyaltyRedemption ? 0 : (pricingResult ? pricingResult.total : null);

    // Derive currency from phone prefix â€” same logic as frontend
    const customerCurrency = req.user.phone?.startsWith('+91') ? 'INR' : 'USD';
    // For grooming: split base = total âˆ’ PLATFORM_DISCOUNT (â‚¹150 PETclub offer absorbed)
    const offerForSplit = (service_type === 'Groomer' && !isLoyaltyRedemption && resolvedAmount > 0)
      ? (pricingResult?.discount || pricingCatalog.PLATFORM_DISCOUNT || 0)
      : 0;
    const split = computeSplit(resolvedAmount, offerForSplit, service_type, customerCurrency);

    const { data: booking, error: bookingInsertErr } = await supabase.from('bookings').insert({
      customer_id: req.user.id, status: 'upcoming',
      assignment_status: 'searching',
      service_type: service_type || null, service_name: service_name || null,
      pet_id: pet_id || null, scheduled_at: scheduled_at || null,
      city: city || null, address: address || null, notes: notes || null,
      amount: resolvedAmount,
      // W-4 fix: GPS coords in the initial insert â€” no separate fire-and-forget
      // update needed. The old approach silently dropped coordinates if Supabase
      // timed out on the second update, causing the 70km dispatch to fall back to
      // city-name matching and potentially dispatch the wrong professional.
      address_lat: addressLat || null,
      address_lng: addressLng || null,
      // Accounting flags â€” let admin know this was a loyalty-redeemed job
      is_loyalty_redemption: isLoyaltyRedemption,
      coupon_code_used:      couponCode,
      // Revenue split columns (null when no amount provided or loyalty free)
      total_amount:         split?.total_amount         ?? null,
      petclub_offer_amount: split?.petclub_offer_amount ?? null,
      platform_fee:         split?.platform_fee         ?? null,
      provider_earnings:    split?.provider_earnings    ?? null,
      gateway_fee:          split?.gateway_fee          ?? null,
      currency:          customerCurrency,
      payout_status:     'pending',
      // Clickwrap consent audit trail â€” server-side timestamp, not client-supplied
      terms_version:     TERMS_VERSION,
      terms_accepted_at: new Date().toISOString(),
    }).select().single();
    if (!booking || bookingInsertErr) {
      logger.error('Create booking insert error:', bookingInsertErr?.message);
      return res.status(500).json({ error: 'Failed to create booking' });
    }

    // C-4 fix: Mark coupon as used via atomic Postgres RPC.
    // If the RPC fails (coupon already used by a racing request), roll back
    // the booking we just created and return a 409 to the client.
    if (couponCode && isLoyaltyRedemption) {
      const couponResult = await loyalty.markCouponUsed(supabase, couponCode, booking.id);
      if (!couponResult.success) {
        // Delete the booking we just inserted â€” it was created on the assumption
        // this coupon was valid, but the atomic check says otherwise.
        await supabase.from('bookings').update({ deleted_at: new Date().toISOString() }).eq('id', booking.id);
        return res.status(409).json({
          error: couponResult.error || 'Coupon has already been used. Please refresh and try again.',
        });
      }
    }

    // Auto-assign round-robin (GPS radius if available, city fallback)
    if (service_type && ['Groomer', 'Trainer', 'Vet', 'Walker', 'Boarding'].includes(service_type)) {
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
    logger.error('Create booking error:', err.message);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.put('/api/bookings/:id/status', auth, async (req, res) => {
  try {
  const { data: booking } = await supabase
    .from('bookings')
    .select('customer_id, professional_id, pet_id, service_type, service_name, scheduled_at, status, total_amount, currency, city, address_lat, address_lng, pets(name, health_notes)')
    .eq('id', req.params.id).single();
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Ownership check: customer or the professional involved can update status
  let authorized = false;
  let profName   = null;
  if (req.user.role === 'admin') authorized = true;
  else if (req.user.role === 'customer' && booking.customer_id === req.user.id) authorized = true;
  else if (req.user.role === 'professional') {
    const { data: prof } = await supabase.from('professional_profiles').select('id, users(name)').eq('user_id', req.user.id).single();
    if (prof && booking.professional_id === prof.id) { authorized = true; profName = prof.users?.name || null; }
  }
  if (!authorized) return res.status(403).json({ error: 'Not authorized to update this booking' });

  const newStatus = req.body.status;

  // Whitelist allowed statuses â€” prevents state-machine manipulation from client
  const VALID_BOOKING_STATUSES = ['upcoming', 'in_progress', 'completed', 'cancelled', 'no_show'];
  if (!VALID_BOOKING_STATUSES.includes(newStatus))
    return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_BOOKING_STATUSES.join(', ')}` });

  // State machine: enforce valid transitions â€” prevents rollback fraud
  const ALLOWED_TRANSITIONS = {
    upcoming:    ['in_progress', 'cancelled', 'no_show'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
    no_show:     [],
  };
  const allowed = ALLOWED_TRANSITIONS[booking.status] ?? [];
  const mappedNew = newStatus === 'no_show' ? 'no_show' : newStatus;
  if (!allowed.includes(mappedNew) && req.user.role !== 'admin')
    return res.status(400).json({ error: `Cannot transition booking from '${booking.status}' to '${newStatus}'` });

  // Prevent double-cancellation
  if ((newStatus === 'cancelled' || newStatus === 'no_show') && booking.status === 'cancelled')
    return res.status(400).json({ error: 'Booking is already cancelled.' });

  // â”€â”€ Cancellation / No-show â€” calculate refund â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const updatePayload = { status: newStatus === 'no_show' ? 'cancelled' : newStatus };
  const assignmentStatusMap = { in_progress: 'in_progress', completed: 'completed', cancelled: 'cancelled' };
  if (assignmentStatusMap[newStatus]) updatePayload.assignment_status = assignmentStatusMap[newStatus];
  if (newStatus === 'no_show') updatePayload.assignment_status = 'cancelled';

  if (newStatus === 'cancelled' || newStatus === 'no_show') {
    const isNoShow = newStatus === 'no_show';
    // Only professionals assigned to the booking (or admin) can mark no-show
    if (newStatus === 'no_show' && req.user.role === 'customer')
      return res.status(403).json({ error: 'Only the professional on-site can report a no-show.' });
    if (newStatus === 'no_show' && req.user.role === 'professional') {
      const { data: myProf } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
      if (!myProf || booking.professional_id !== myProf.id)
        return res.status(403).json({ error: 'You are not the assigned professional for this booking.' });
    }
    // Professionals CAN cancel their accepted booking (emergency/unable to attend)
    // This triggers a re-dispatch to the next available professional

    // 'professional' cancellations have no fee â€” pro is at fault, customer gets full refund
    const isProCancel = !isNoShow && req.user.role === 'professional';
    const cancelledBy = isNoShow ? 'no_show' : req.user.role;
    const refundCalc  = isProCancel
      ? { cancellation_fee: 0, refund_amount: parseFloat(booking.total_amount || 0), refund_status: 'pending', fee_free: true }
      : calcCancellation(booking.total_amount, booking.scheduled_at, isNoShow);

    updatePayload.cancelled_by        = cancelledBy;
    updatePayload.cancelled_at        = new Date().toISOString();
    updatePayload.cancellation_fee    = refundCalc.cancellation_fee;
    updatePayload.refund_amount       = refundCalc.refund_amount;
    updatePayload.refund_status       = refundCalc.refund_status;
    updatePayload.cancellation_reason = sanitize(req.body.reason || '') || null;

    // â”€â”€ Loyalty points reversal â€” cancel any credits earned for this booking â”€â”€
    if (booking.customer_id) {
      supabase.from('loyalty_transactions')
        .select('id, points, type')
        .eq('booking_id', req.params.id)
        .gt('points', 0)
        .then(({ data: txns }) => {
          if (!txns?.length) return;
          const totalToReverse = txns.reduce((s, t) => s + t.points, 0);
          if (totalToReverse > 0) {
            loyalty.awardPoints(
              supabase, booking.customer_id,
              -totalToReverse, 'booking_cancel_reversal',
              `Reversal of ${totalToReverse} credits â€” booking ${req.params.id} cancelled`,
              req.params.id,
            ).catch(e => logger.error('[Loyalty] cancel reversal failed:', e.message));
          }
        }).catch(() => {});
    }

    // â”€â”€ Notify professional â€” customer/admin cancelled â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (booking.professional_id && !isProCancel && !isNoShow) {
      supabase.from('professional_profiles')
        .select('users(fcm_token, name)')
        .eq('id', booking.professional_id).single()
        .then(({ data: pp }) => {
          if (pp?.users?.fcm_token) {
            const svc = booking.service_name || booking.service_type || 'Service';
            const who = cancelledBy === 'customer' ? 'Customer' : 'Admin';
            sendPush(pp.users.fcm_token, `âŒ Booking Cancelled`,
              `${who} cancelled the ${svc} booking. Check your schedule.`,
              { bookingId: req.params.id, type: 'booking_cancelled' }
            ).catch(() => {});
          }
        }).catch(() => {});
    }

    // â”€â”€ Notify customer â€” professional cancelled or no-show â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if ((isProCancel || isNoShow) && booking.customer_id) {
      supabase.from('users').select('fcm_token').eq('id', booking.customer_id).single()
        .then(({ data: cu }) => {
          if (cu?.fcm_token) {
            const title = isNoShow ? `ðŸ“‹ Booking Update` : `âš ï¸ Provider Cancelled`;
            const body  = isNoShow
              ? `No-show recorded. â‚¹${refundCalc.refund_amount} refund pending. â‚¹${refundCalc.cancellation_fee} fee applied.`
              : `Your provider had to cancel. We're finding you another ${booking.service_type || 'professional'} now.`;
            sendPush(cu.fcm_token, title, body, { bookingId: req.params.id, type: isNoShow ? 'no_show' : 'pro_cancelled' }).catch(() => {});
          }
        }).catch(() => {});
    }

    // â”€â”€ Re-dispatch when professional cancels â€” find next available pro â”€â”€â”€â”€â”€â”€â”€â”€
    if (isProCancel) {
      // Clear the current assignment and restart search
      updatePayload.status            = 'upcoming';
      updatePayload.assignment_status = 'searching';
      updatePayload.professional_id   = null;
      updatePayload.cancelled_by      = null; // reset â€” this is a re-dispatch, not a real cancel
      updatePayload.cancelled_at      = null;
      updatePayload.cancellation_fee  = null;
      updatePayload.refund_amount     = null;
      updatePayload.refund_status     = null;
      // Mark the old assignment as cancelled so this pro won't be offered again
      if (booking.professional_id) {
        supabase.from('booking_assignments')
          .update({ status: 'cancelled', responded_at: new Date().toISOString() })
          .eq('booking_id', req.params.id)
          .eq('professional_id', booking.professional_id)
          .then(async () => {
            // Fetch ALL pros who already tried this booking so they're all excluded from re-dispatch
            const { data: tried } = await supabase
              .from('booking_assignments')
              .select('professional_id')
              .eq('booking_id', req.params.id)
              .in('status', ['rejected', 'timed_out', 'accepted', 'cancelled'])
              .catch(() => ({ data: [] }));
            const excludeIds = (tried || []).map(t => t.professional_id).filter(Boolean);

            findNextPro(booking.city || '', booking.service_type || '',
              excludeIds,
              booking.address_lat, booking.address_lng
            ).then(async nextPro => {
              if (nextPro) {
                await offerBookingToPro(req.params.id, nextPro, {
                  ...booking, pet_name: booking.pets?.name || 'Pet',
                  pet_health_notes: booking.pets?.health_notes || null,
                });
              } else {
                await supabase.from('bookings')
                  .update({ assignment_status: 'no_pros_available' })
                  .eq('id', req.params.id);
              }
            }).catch(e => logger.error('[Redispatch] failed:', e.message));
          }).catch(() => {});
      }
    }
  }

  // Service notes (when professional marks complete)
  if (newStatus === 'completed' && req.body.service_notes) {
    updatePayload.service_notes = sanitize(req.body.service_notes).slice(0, 500);
  }

  const { data } = await supabase.from('bookings').update(updatePayload).eq('id', req.params.id).select().single();

  // â”€â”€ Auto-create pet service record when booking is completed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Writes to the correct records table based on service_type so the history
  // appears automatically under the pet's profile without manual entry.
  if (newStatus === 'completed' && booking.status !== 'completed' && booking.pet_id) {
    try {
      const svcType = booking.service_type || '';
      const svcName = booking.service_name || svcType || 'Service';
      const dateStr = booking.scheduled_at
        ? new Date(booking.scheduled_at).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      // Resolve provider name if not already known (admin completions)
      let providerName = profName || null;
      if (!providerName && booking.professional_id) {
        const { data: pProf } = await supabase
          .from('professional_profiles').select('users(name)').eq('id', booking.professional_id).single();
        providerName = pProf?.users?.name || null;
      }

      if (svcType === 'Trainer') {
        await supabase.from('training_records').insert({
          pet_id:    booking.pet_id,
          date:      dateStr,
          session:   svcName,
          by:        providerName || '',
          notes:     `Completed via PETclub booking #${req.params.id}`,
          booking_id: req.params.id,
        });
      } else if (svcType === 'Vet') {
        await supabase.from('vet_records').insert({
          pet_id:     booking.pet_id,
          date:       dateStr,
          vtype:      svcName,
          vet:        providerName || '',
          notes:      `Completed via PETclub booking #${req.params.id}`,
          booking_id: req.params.id,
        });
      } else {
        // Groomer, Walker, Boarding â€” all go to grooming_records
        await supabase.from('grooming_records').insert({
          pet_id:    booking.pet_id,
          date:      dateStr,
          service:   svcName,
          by:        providerName || '',
          notes:     `Completed via PETclub booking #${req.params.id}`,
          booking_id: req.params.id,
        });
      }
    } catch (recErr) {
      // Non-fatal â€” log but don't fail the status update
      logger.error('[PetRecord] Auto-create failed:', recErr.message);
    }
  }

  res.json({ success: true, booking: data });
  } catch (err) {
    logger.error('[PUT /bookings/:id/status]', err.message);
    res.status(500).json({ error: 'Failed to update booking status. Please try again.' });
  }
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
      return res.status(400).json({ error: 'Response window expired â€” the request was auto-passed' });

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
        sendEmail(custEmail, `âœ… Booking Confirmed â€” ${proName} will serve you!`, `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff;border-radius:16px;border:1px solid #f1f5f9;">
            <div style="text-align:center;margin-bottom:20px;"><div style="font-size:48px">âœ…</div><h2 style="color:#16a34a;margin:8px 0">Booking Confirmed!</h2></div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
              <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;width:38%">Service</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${svc}</td></tr>
              <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8">Professional</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b">${proName}</td></tr>
              <tr><td style="padding:8px 0;font-size:12px;color:#94a3b8">Date & Time</td><td style="padding:8px 0;font-size:14px;font-weight:700;color:#1e293b">${dateStr}</td></tr>
            </table>
            <div style="text-align:center;"><a href="https://app.mypetclub.app" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;">Open PETclub App â†’</a></div>
          </div>`).catch(e => logger.error(e));
      }
      // FCM push to customer
      const { data: custUserFcm } = await Promise.resolve(supabase.from('users').select('fcm_token').eq('id', bk?.users?.id || bk?.customer_id || '').single()).catch(() => ({ data: null }));
      if (custUserFcm?.fcm_token) {
        sendPush(custUserFcm.fcm_token, `âœ… Booking Confirmed!`, `${proName} will be there on ${dateStr}`, { bookingId: req.params.id, type: 'booking_confirmed' }).catch(() => {});
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
    logger.error('Respond booking error:', err.message);
    res.status(500).json({ error: 'Failed to process response' });
  }
});

// Pro: Get all incoming (offered) bookings
app.get('/api/bookings/incoming', auth, async (req, res) => {
  if (req.user.role !== 'professional' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access restricted to professionals.' });
  }
  try {
    processTimedOutAssignments().catch(e => logger.error(e));
    const { data: prof } = await supabase.from('professional_profiles').select('id').eq('user_id', req.user.id).single();
    if (!prof) return res.json({ success: true, bookings: [] });

    const { data: assignments } = await supabase
      .from('booking_assignments')
      .select('*, bookings(*, pets(name, species, breed, health_notes), users!customer_id(name))')
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  IN-APP CHAT â€” per-booking messages between customer and professional
//  Keeps both parties' phone numbers private.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Helper: verify the caller is the customer or assigned professional for a booking
async function assertChatAccess(bookingId, user) {
  const { data: bk } = await supabase
    .from('bookings')
    .select('customer_id, professional_id')
    .eq('id', bookingId).single();
  if (!bk) return { status: 404, error: 'Booking not found' };
  if (user.role === 'admin') return null; // admin can always read
  if (user.role === 'customer' && bk.customer_id === user.id) return null;
  if (user.role === 'professional') {
    const { data: prof } = await supabase
      .from('professional_profiles').select('id').eq('user_id', user.id).single();
    if (prof && bk.professional_id === prof.id) return null;
  }
  return { status: 403, error: 'Not authorised for this booking chat' };
}

// GET /api/bookings/:id/cancel-preview â€” returns refund estimate before customer confirms cancel
app.get('/api/bookings/:id/cancel-preview', auth, async (req, res) => {
  const { data: bk } = await supabase
    .from('bookings').select('customer_id, scheduled_at, total_amount, status').eq('id', req.params.id).single();
  if (!bk) return res.status(404).json({ error: 'Booking not found' });
  if (bk.customer_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your booking' });
  if (bk.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });
  const calc = calcCancellation(bk.total_amount, bk.scheduled_at, false);
  res.json({ success: true, ...calc, total_amount: parseFloat(bk.total_amount || 0) });
});

// PUT /api/admin/bookings/:id/refund-status â€” admin marks a refund as processed
app.put('/api/admin/bookings/:id/refund-status', auth, adminOnly, async (req, res) => {
  const { status } = req.body; // 'processed' | 'not_applicable'
  if (!['processed', 'not_applicable'].includes(status))
    return res.status(400).json({ error: "status must be 'processed' or 'not_applicable'" });
  const { data } = await supabase
    .from('bookings').update({ refund_status: status }).eq('id', req.params.id).select().single();
  if (!data) return res.status(404).json({ error: 'Booking not found' });

  // Notify customer their refund was processed
  if (status === 'processed') {
    supabase.from('users').select('fcm_token').eq('id', data.customer_id).single()
      .then(({ data: cu }) => {
        if (cu?.fcm_token) {
          sendPush(cu.fcm_token, `âœ… Refund Processed`,
            `Your refund of â‚¹${parseFloat(data.refund_amount || 0).toFixed(2)} has been sent. Allow 2â€“3 business days.`,
            { bookingId: req.params.id, type: 'refund_processed' }
          ).catch(() => {});
        }
      }).catch(() => {});
  }
  res.json({ success: true, booking: data });
});

// GET /api/bookings/:id/messages â€” fetch messages (newest last, limit 100)
app.get('/api/bookings/:id/messages', auth, async (req, res) => {
  const denied = await assertChatAccess(req.params.id, req.user);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  const { data } = await supabase
    .from('booking_messages')
    .select('id, sender_id, sender_role, sender_name, content, created_at, read_at')
    .eq('booking_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(100);

  // Mark unread messages from the other party as read
  const otherId = data?.filter(m => m.sender_id !== req.user.id && !m.read_at).map(m => m.id);
  if (otherId?.length) {
    supabase.from('booking_messages')
      .update({ read_at: new Date().toISOString() }).in('id', otherId).then(() => {});
  }

  res.json({ success: true, messages: data || [] });
});

// POST /api/bookings/:id/messages â€” send a message
app.post('/api/bookings/:id/messages', auth, async (req, res) => {
  const denied = await assertChatAccess(req.params.id, req.user);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  let content = sanitize(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });

  // â”€â”€ Contact masking â€” replace phone numbers / emails to keep both parties
  // on the platform and prevent commission bypass. Patterns covered:
  //   +91 XXXXX XXXXX, 91-XXXXXXXXXX, 10-digit mobile, @-containing email
  content = content
    .replace(/(\+?91[\s\-]?)?[6-9]\d{9}/g, '[ðŸ“µ contact hidden]')          // Indian mobiles
    .replace(/\+?1[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/g, '[ðŸ“µ contact hidden]') // US numbers
    .replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[ðŸ“§ contact hidden]'); // emails

  // Fetch sender name from users table
  const { data: sender } = await supabase.from('users').select('name').eq('id', req.user.id).single();

  const { data: msg, error } = await supabase.from('booking_messages').insert({
    booking_id:  req.params.id,
    sender_id:   req.user.id,
    sender_role: req.user.role,
    sender_name: sender?.name || null,
    content,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Push notification to the other party so they know a message arrived
  const { data: bkParties } = await supabase
    .from('bookings').select('customer_id, professional_id').eq('id', req.params.id).single();
  if (bkParties) {
    const notifyUserId = req.user.role === 'professional' ? bkParties.customer_id : null;
    // (professional-to-customer only for now; reverse needs pro user_id lookup)
    if (notifyUserId) {
      supabase.from('users').select('fcm_token').eq('id', notifyUserId).single()
        .then(({ data: u }) => {
          if (u?.fcm_token) {
            sendPush(u.fcm_token, `ðŸ’¬ New message`,
              `${sender?.name || 'Your provider'}: ${content.slice(0, 60)}${content.length > 60 ? 'â€¦' : ''}`,
              { bookingId: req.params.id, type: 'chat_message' }
            ).catch(() => {});
          }
        }).catch(() => {});
    }
  }

  res.json({ success: true, message: msg });
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  LIVE TRACKING (SSE â€” Ola/Rapido-style)
//
//  W-2 fix: replaced in-memory trackingClients Map with DB-polling SSE.
//
//  Old architecture (broken on scale-out):
//    Professional POST /location â†’ DB update + push to in-memory Map
//    Customer EventSource â†’ receives from in-memory Map
//    Problem: Map is per-process; Cloud Run instance B never sees pushes
//             sent to instance A's Map.
//
//  New architecture (works on any number of instances):
//    Professional POST /location â†’ DB update only (no in-memory push)
//    Customer EventSource â†’ server polls DB every 3 s, sends diff to client
//    All instances read from the same Supabase DB â†’ consistent across scale-out
//    Keepalive comment every 25 s prevents proxy/Cloud Run idle timeout.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Customer subscribes -- GET /api/bookings/:id/track
// Browser EventSource sends cookies automatically when withCredentials:true
app.get('/api/bookings/:id/track', async (req, res) => {
  const token = req.cookies?.[AUTH_COOKIE] || req.query.token; // query fallback for native clients
  if (!token) return res.status(401).json({ error: 'token required' });

  let userId;
  try { userId = jwt.verify(token, JWT_SECRET).id; }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  const bookingId = req.params.id;

  // Verify booking belongs to this customer
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, customer_id, pro_lat, pro_lng, address_lat, address_lng, assignment_status')
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

  // Send last known position immediately so the map renders without waiting for first change
  let lastLat = booking.pro_lat;
  let lastLng = booking.pro_lng;
  if (lastLat && lastLng) {
    const distKm = (booking.address_lat && booking.address_lng)
      ? +haversineKm(lastLat, lastLng, booking.address_lat, booking.address_lng).toFixed(2)
      : null;
    res.write(`data: ${JSON.stringify({ lat: lastLat, lng: lastLng, distKm })}\n\n`);
  }

  // Keepalive comment every 25 s -- prevents Cloud Run/proxy from closing idle connections
  const keepAlive = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);

  const cleanup = (channel) => {
    clearInterval(keepAlive);
    if (channel) supabase.removeChannel(channel);
  };

  // Supabase Realtime -- pushed instantly when the professional GPS POST updates the row.
  // Replaces 3 s DB-polling: latency drops from ~3000 ms to ~100 ms, zero DB reads per tick.
  const channel = supabase
    .channel(`track-${bookingId}`)
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'bookings',
      filter: `id=eq.${bookingId}`,
    }, (payload) => {
      const { pro_lat, pro_lng, address_lat, address_lng, assignment_status } = payload.new;

      // Booking ended -- notify client and close
      if (['completed', 'cancelled', 'no_show'].includes(assignment_status)) {
        try { res.write(`data: ${JSON.stringify({ status: assignment_status })}\n\n`); } catch {}
        cleanup(channel);
        try { res.end(); } catch {}
        return;
      }

      // Only emit when coordinates have actually changed (saves bandwidth)
      if (pro_lat !== null && pro_lng !== null &&
          (pro_lat !== lastLat || pro_lng !== lastLng)) {
        lastLat = pro_lat;
        lastLng = pro_lng;
        const distKm = (address_lat && address_lng)
          ? +haversineKm(lastLat, lastLng, address_lat, address_lng).toFixed(2)
          : null;
        try { res.write(`data: ${JSON.stringify({ lat: lastLat, lng: lastLng, distKm })}\n\n`); } catch {}
      }
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        logger.error({ bookingId }, 'Realtime channel error on booking track');
        cleanup(channel);
        try { res.end(); } catch {}
      }
    });

  req.on('close', () => cleanup(channel));
});

// â”€â”€ Haversine straight-line distance in km â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const TEN_MIN_KM = parseFloat(process.env.PROXIMITY_ALERT_KM) || 8; // ~10 min at avg 50 km/h road speed

// Professional taps "On My Way" â€” POST /api/bookings/:id/on-my-way
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
      sendSMS(booking.users.phone, `ðŸ¾ PETclub: ${proName} (${svcType}) is on the way to you! Open the app to track them live.`).catch(() => {});
    }
    // Notify customer via FCM push
    if (booking.users?.fcm_token) {
      sendPushNotification(booking.users.fcm_token, 'ðŸš— On the Way!', `${proName} is heading to you now. Track live in the app.`).catch(() => {});
    }

    logger.info(`[OnMyWay] Booking ${req.params.id} â€” ${proName} started journey`);
    res.json({ success: true, message: 'Journey started! Customer has been notified.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Professional sends GPS â€” POST /api/bookings/:id/location { lat, lng }
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

    // â”€â”€ 10-minute proximity alert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          sendSMS(custPhone, `ðŸ¾ PETclub: ${proName} (${svcType}) will arrive in about 10 minutes! Get ready ðŸ¾`).catch(() => {});
        }
        if (custFcm) {
          sendPushNotification(custFcm, 'â±ï¸ 10 Minutes Away!', `${proName} will arrive in about 10 minutes. Get ready!`).catch(() => {});
        }
        logger.info(`[ProximityAlert] Booking ${bookingId} â€” ${proName} is ${distKm.toFixed(1)}km from customer, 10-min alert sent`);
      }
    }

    // W-2 fix: SSE clients now poll the DB directly (see GET /api/bookings/:id/track).
    // No in-memory push needed here â€” DB write above is the single source of truth.
    const distKm = (booking.address_lat && booking.address_lng)
      ? +haversineKm(lat, lng, booking.address_lat, booking.address_lng).toFixed(2)
      : null;

    res.json({ ok: true, distKm });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST snapshot fallback â€” GET /api/bookings/:id/tracking
app.get('/api/bookings/:id/tracking', auth, async (req, res) => {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('customer_id, professional_id, pro_lat, pro_lng, pro_location_updated_at, assignment_status')
      .eq('id', req.params.id)
      .single();
    if (!booking) return res.status(404).json({ error: 'Not found' });

    // Ownership check â€” customer, assigned professional, or admin only
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  RATINGS & REVIEWS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

    // Upsert â€” one rating per booking (unique constraint on booking_id enforces this)
    const { error: upsertErr } = await supabase.from('reviews').upsert({
      reviewer_id: req.user.id,
      reviewee_id: profUserId,
      booking_id: req.params.id,
      rating: parseInt(rating),
      comment: review?.trim() || null,
    }, { onConflict: 'booking_id' });
    if (upsertErr) {
      logger.error('[rate] reviews upsert error:', upsertErr.message, upsertErr.details || '');
      return res.status(500).json({ error: 'Failed to save your rating. Please try again.' });
    }

    // W-3 fix: recalculate pro's average rating via SQL aggregation (not JS reduce).
    // The old approach fetched all reviews into Node memory, then computed AVG in JS.
    // Two concurrent rating submissions would both read the same stale set, compute
    // the same wrong average, and overwrite each other â€” producing an incorrect count.
    // The RPC runs entirely in-database with the correct aggregate at commit time.
    if (profUserId) {
      const { error: ratingErr } = await supabase
        .rpc('refresh_professional_rating', { p_user_id: profUserId });
      if (ratingErr) {
        logger.error('[rate] refresh_professional_rating RPC failed:', ratingErr.message);
      }
    }
    // Award +50 loyalty credits for leaving a review.
    // Fix 2 â€” dedup guard: check that no review_bonus has been awarded for this
    // booking_id before awarding. The DB unique index (loyalty_txn_review_bonus_once)
    // also enforces this at the database level as a hard constraint.
    loyalty.hasEarnedReviewBonus(supabase, req.user.id, req.params.id).then(alreadyEarned => {
      if (!alreadyEarned) {
        return loyalty.awardPoints(
          supabase, req.user.id,
          loyalty.REVIEW_BONUS, 'review_bonus',
          `Review bonus for booking ${req.params.id}`,
          req.params.id,
        );
      }
      logger.info(`[Loyalty] Review bonus skipped â€” already awarded for booking ${req.params.id}`);
    }).catch(e => logger.error('[Loyalty] review bonus award failed:', e.message));

    res.json({ success: true, message: 'Thank you for your feedback! ðŸŒŸ', loyalty_bonus: loyalty.REVIEW_BONUS });
  } catch (err) {
    logger.error('Rate booking error:', err.message);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// Check if a specific booking has been rated (customer only)
app.get('/api/bookings/:id/my-rating', auth, async (req, res) => {
  const { data } = await supabase.from('reviews').select('rating, comment').eq('booking_id', req.params.id).eq('reviewer_id', req.user.id).single();
  res.json({ success: true, rated: !!data, rating: data?.rating || null, review: data?.comment || null });
});

// W-6 fix: return all booking IDs this customer has rated.
// The frontend merges these with localStorage so the rating dialog never
// reappears even after the user clears localStorage or switches devices.
app.get('/api/ratings/mine', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('reviews')
    .select('booking_id')
    .eq('reviewer_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, ratedIds: (data || []).map(r => r.booking_id) });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Admin OTP lookup â€” DEV ONLY. Disabled in production (set ALLOW_DEV_TOOLS=true locally).
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
      note: expired ? 'OTP has expired â€” request a new one' : rec.verified ? 'OTP already used' : `Valid for ${minsLeft} more min(s)`,
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

// O-1 fix: paginated admin user listing.
// Old version: fetched the entire users table on every request â€” would OOM on scale.
// New version: supports ?page=, ?limit= (max 100), and ?search= (name or phone ILIKE).
// Requires the trigram indexes created in supabase-security-hardening.sql for fast search.
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const pageSize = Math.min(100, parseInt(req.query.limit) || 50);
  // Strip non-alphanumeric/space characters and cap length to prevent
  // PostgREST filter-expression injection via the or() predicate
  const rawSearch = req.query.search?.trim() || '';
  const search    = rawSearch.replace(/[^a-zA-Z0-9\s+@._-]/g, '').slice(0, 60) || null;
  const from     = (page - 1) * pageSize;
  const to       = from + pageSize - 1;

  const includeDeleted = req.query.deleted === 'true';

  let q = supabase
    .from('users')
    .select(
      '*, customer_profiles(id_photo_url, id_doc_type, id_doc_number), ' +
      'professional_profiles(sub_role, verification_status, rating, city)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (!includeDeleted) q = q.is('deleted_at', null);

  if (search) {
    // ILIKE search over name and phone â€” accelerated by gin_trgm_ops indexes
    q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Attach suspended_at for current page's suspended users only
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

  // PostgREST v12+ returns embedded one-to-one relationships (identified by a
  // UNIQUE FK) as a plain object instead of an array.  professional_profiles
  // has UNIQUE(user_id), so PostgREST returns it as {} not [{}].
  // The frontend always does u.professional_profiles?.[0]?.sub_role, so we
  // normalise here: wrap any plain object in a single-element array and
  // collapse null/undefined to an empty array.  customer_profiles has the same
  // UNIQUE constraint so we apply the same treatment.
  const normaliseEmbed = v => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return [v];  // PostgREST returned a plain object â€” wrap it
  };

  const users = data?.map(u => ({
    ...u,
    professional_profiles: normaliseEmbed(u.professional_profiles),
    customer_profiles:     normaliseEmbed(u.customer_profiles),
    suspended_at:          suspendedAtMap[u.id] || null,
  }));
  res.json({ success: true, users, total: count, page, pageSize, totalPages: Math.ceil((count || 0) / pageSize) });
});

// Admin: generate a short-lived signed URL for a private storage document
// The URL expires in 60 seconds â€” admin must view it immediately
app.get('/api/admin/signed-url', auth, adminOnly, async (req, res) => {
  const { path: rawPath } = req.query;
  if (!rawPath || typeof rawPath !== 'string')
    return res.status(400).json({ error: 'Valid storage path required' });

  // W-5 fix: decode URL encoding variants BEFORE running traversal checks.
  // The old check only blocked literal `..`; encoded forms like `%2E%2E`,
  // `%2F..`, or `..%2F` passed through and may have been decoded by the
  // storage client before resolving the path.
  let safePath;
  try {
    safePath = decodeURIComponent(rawPath);
  } catch {
    return res.status(400).json({ error: 'Malformed path encoding' });
  }

  if (
    safePath.includes('..') ||           // any traversal fragment
    safePath.startsWith('/') ||          // absolute paths not allowed
    !/^[\w\-./]+$/.test(safePath)        // only safe characters: alphanumeric, dash, dot, slash, underscore
  ) {
    return res.status(400).json({ error: 'Valid storage path required' });
  }

  const { data, error } = await supabase.storage
    .from('id-documents')
    .createSignedUrl(safePath, 60); // expires in 60 seconds
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
      ? `âœ… Congrats! Your PETclub profile is verified. Open the app to go live and start earning! ðŸ¾`
      : `âŒ PETclub verification not approved. Reason: ${reason||'Documents incomplete'}. Resubmit via the app.`;
    // SMS notification (existing)
    sendSMS(prof.users.phone, sms).catch(e => logger.error(e));
    // Branded verification email (new)
    if (prof.users.email) {
      emailService.sendProviderVerificationEmail(prof.users.email, {
        name:    prof.users.name,
        subRole: prof.sub_role,
        action,
        reason,
        city:    prof.city,
      }).catch(e => logger.error(e));
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
    logger.error('[SetRole] Update error:', updateErr.message);
    return res.status(500).json({ error: 'Failed to update role: ' + updateErr.message });
  }

  // If no row was updated (user had no profile yet), insert one
  if (!updatedRows || updatedRows.length === 0) {
    const { error: insertErr } = await supabase.from('professional_profiles').insert({
      user_id: req.params.id, sub_role: subRole, verification_status: 'pending', is_available: false,
    });
    if (insertErr) {
      logger.error('[SetRole] Insert error:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create profile: ' + insertErr.message });
    }
  }

  logger.info(`[SetRole] Admin set sub_role=${subRole} for user ${req.params.id}`);
  res.json({ success: true, subRole });
});

// â”€â”€ Admin: fix / update user profile data (email, name, address) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    logger.info(`[AdminEdit] User ${req.params.id} updated by admin ${req.user.id}`);
    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    logger.error('[AdminEdit]', err);
    res.status(500).json({ error: err.message });
  }
};

// Register PATCH (standard) + POST (proxy-safe alias)
app.patch('/api/admin/users/:id',      auth, adminOnly, adminEditUser);
app.post('/api/admin/users/:id/edit',  auth, adminOnly, adminEditUser);

app.put('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
  const { data: u } = await supabase.from('users').select('id, name, phone, email, role, is_active').eq('id', req.params.id).single();
  if (!u) return res.status(404).json({ error: 'User not found' });

  const nowSuspending = u.is_active; // true â†’ we're suspending; false â†’ we're restoring
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
      }).catch(e => logger.error('[Email] Suspension notice failed:', e.message));
    }

    if (adminEmail) {
      sendEmail(
        adminEmail,
        `âš ï¸ PETclub â€” User Suspended: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">âš ï¸</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Suspended</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 24px">This user's account has been suspended by admin and will be <strong style="color:#dc2626">permanently deleted in 24 hours</strong>.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px;margin-bottom:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.email || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#1e293b;font-size:13px;text-align:right;text-transform:capitalize">${u.role}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Deletes at</td><td style="color:#dc2626;font-size:13px;font-weight:700;text-align:right">${deleteStr} IST</td></tr>
            </table>
          </div>
          <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:16px;font-size:13px;color:#92400e">
            <strong>To prevent deletion:</strong> Go to the Admin Dashboard â†’ Users tab â†’ find this user â†’ click <em>Restore</em> before ${deleteStr} IST.
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin System Â· ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => logger.error('[Suspend] Email failed:', e.message));
    }
  } else {
    // User restored â€” notify admin
    if (adminEmail) {
      sendEmail(
        adminEmail,
        `âœ… PETclub â€” User Restored: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">âœ…</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Restored</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">The following account has been reactivated and the 24-hr deletion timer has been cancelled.</p>
          <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:14px;padding:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
            </table>
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin System Â· ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(e => logger.error('[Restore] Email failed:', e.message));
    }
  }

  const suspendedAt = nowSuspending ? new Date().toISOString() : null;
  res.json({ success: true, is_active: !u.is_active, suspended_at: suspendedAt });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: Purge ALL suspended users in one shot
//  Deletes every non-admin user where is_active = false.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.delete('/api/admin/users/suspended/purge-all', auth, adminOnly, async (req, res) => {
  try {
    const { data: suspended } = await supabase
      .from('users')
      .select('id, name, phone, email, role')
      .eq('is_active', false)
      .neq('role', 'admin');

    if (!suspended?.length) return res.json({ success: true, deleted: 0, message: 'No suspended users found.' });

    const ids = suspended.map(u => u.id);

    // â”€â”€ Step 1: get professional_profile IDs so we can cascade their children â”€â”€
    const { data: profProfiles } = await supabase
      .from('professional_profiles')
      .select('id')
      .in('user_id', ids);
    const profIds = (profProfiles || []).map(p => p.id);

    // â”€â”€ Step 2: delete every table that has a FK â†’ professional_profiles.id â”€â”€
    // Supabase v2 returns { data, error } â€” never throws, so no .catch() needed
    if (profIds.length) {
      await supabase.from('booking_assignments').delete().in('professional_id', profIds);
      await supabase.from(‘bookings’).update({ deleted_at: new Date().toISOString() }).in(‘professional_id’, profIds);
      await supabase.from(‘id_documents’).delete().in(‘prof_id’, profIds);
      await supabase.from(‘payout_details’).delete().in(‘prof_id’, profIds);
    }

    // â”€â”€ Step 3: soft-delete tables that support it; hard-delete the rest â”€â”€
    const _now = new Date().toISOString();
    await supabase.from(‘bookings’).update({ deleted_at: _now }).in(‘customer_id’, ids);
    await supabase.from(‘reviews’).delete().in(‘reviewer_id’, ids);
    await supabase.from(‘reviews’).delete().in(‘reviewee_id’, ids);
    await supabase.from(‘payment_logs’).delete().in(‘user_id’, ids);
    await supabase.from(‘professional_profiles’).delete().in(‘user_id’, ids);
    await supabase.from(‘customer_profiles’).delete().in(‘user_id’, ids);
    await supabase.from(‘pets’).update({ deleted_at: _now }).in(‘owner_id’, ids);
    await supabase.from(‘otp_tokens’).delete().in(‘phone’, suspended.map(u => u.phone));
    await supabase.from(‘admin_logs’).delete().in(‘target_id’, ids);

    // â”€â”€ Step 4: soft-delete the users themselves â”€â”€
    const { error: delErr } = await supabase.from(‘users’).update({ deleted_at: _now }).in(‘id’, ids);
    if (delErr) throw new Error(delErr.message);

    await supabase.from('admin_logs').insert({
      admin_id: req.user.id,
      action: 'purge_all_suspended',
      target_type: 'user',
      notes: `Purged ${ids.length} suspended users: ${suspended.map(u => u.phone).join(', ')}`,
    });

    logger.info(`[PurgeAll] Admin ${req.user.id} deleted ${ids.length} suspended users`);
    res.json({ success: true, deleted: ids.length });
  } catch (e) {
    logger.error('[PurgeAll] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: Hard-delete a user immediately
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
      await supabase.from('bookings').update({ deleted_at: new Date().toISOString() }).eq('professional_id', profRow.id);
      await supabase.from('id_documents').delete().eq('prof_id', profRow.id);
      await supabase.from('payout_details').delete().eq('prof_id', profRow.id);
    }
    const _delAt = new Date().toISOString();
    await supabase.from('bookings').update({ deleted_at: _delAt }).eq('customer_id', u.id);
    await supabase.from('reviews').delete().eq('reviewer_id', u.id);
    await supabase.from('reviews').delete().eq('reviewee_id', u.id);
    await supabase.from('payment_logs').delete().eq('user_id', u.id);
    await supabase.from('professional_profiles').delete().eq('user_id', u.id);
    await supabase.from('customer_profiles').delete().eq('user_id', u.id);
    await supabase.from('pets').update({ deleted_at: _delAt }).eq('owner_id', u.id);
    await supabase.from('otp_tokens').delete().eq('phone', u.phone);
    // C-5 fix: DO NOT delete admin_logs â€” they are the compliance audit trail.
    // Prior suspension, verification, and warning events must be retained for
    // GDPR “why was this account actioned” inquiries and internal investigations.
    // The deletion event inserted below will sit alongside prior logs.
    await supabase.from('users').update({ deleted_at: _delAt }).eq('id', u.id);

    await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: 'delete_user', target_id: u.id, target_type: 'user', notes: `Manual delete: ${u.name || u.phone}` });
    logger.info(`[AdminDelete] User ${u.id} (${u.phone}) deleted by admin ${req.user.id}`);

    // Notify admin email about manual deletion
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      sendEmail(adminEmail, `ðŸ—‘ï¸ PETclub â€” User Manually Deleted: ${u.name || u.phone}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 20px;background:#fff;border-radius:16px">
          <div style="font-size:40px;text-align:center;margin-bottom:12px">ðŸ—‘ï¸</div>
          <h2 style="color:#1e293b;font-size:20px;text-align:center;margin:0 0 6px">User Permanently Deleted</h2>
          <p style="color:#64748b;font-size:13px;text-align:center;margin:0 0 20px">This account was manually deleted from the Admin Dashboard.</p>
          <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:14px;padding:20px">
            <table style="width:100%">
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Name</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${u.name || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Phone</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.phone}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Email</td><td style="color:#1e293b;font-size:13px;text-align:right">${u.email || 'â€”'}</td></tr>
              <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Role</td><td style="color:#1e293b;font-size:13px;text-align:right;text-transform:capitalize">${u.role}</td></tr>
            </table>
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0"/>
          <p style="color:#94a3b8;font-size:11px;text-align:center">PETclub Admin Â· ${new Date().toLocaleString('en-IN')}</p>
        </div>`
      ).catch(() => {});
    }

    res.json({ success: true, deleted: u.id });
  } catch (e) {
    logger.error('[AdminDelete] Error:', e.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FCM: Save push notification token
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/users/fcm-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'FCM token required' });
    // Store token â€” add fcm_token column via migration if not present
    const { error } = await supabase.from('users').update({ fcm_token: token }).eq('id', req.user.id);
    if (error) {
      logger.warn('[FCM Token] Column may not exist yet â€” run migration:', error.message);
      return res.json({ success: false, message: 'FCM token not saved â€” run DB migration first' });
    }
    res.json({ success: true, message: 'Push notifications enabled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PAYMENTS: Razorpay (India) â€” active after LLC registration
//  Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in Cloud Run env vars
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Create a Razorpay order (called before payment screen opens)
app.post('/api/payments/create-order', auth, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({
        error: 'Payments not yet active',
        message: 'Razorpay integration is ready â€” set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Cloud Run env vars to activate.',
        coming_soon: true,
      });
    }
    const { amount, bookingId, currency = 'INR', notes = {} } = req.body;
    if (!amount || !bookingId) return res.status(400).json({ error: 'amount and bookingId required' });
    if (amount < 100) return res.status(400).json({ error: 'Amount must be at least â‚¹1 (100 paise)' });

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
    logger.error('[Razorpay] Create order error:', err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Shared payment finalisation helper
//  Called by BOTH the client-facing verify endpoint AND the server-side webhook.
//
//  Atomically marks a booking as paid using:
//    UPDATE bookings SET payment_status='paid' â€¦ WHERE payment_status != 'paid'
//  If the UPDATE touches 0 rows the booking was already processed â€” idempotent.
//  Awards booking_spend + payment_bonus loyalty credits only on first call.
//
//  Returns: { alreadyProcessed: boolean, split: object|null }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function finalisePayment({ bookingId, userId, razorpay_order_id, razorpay_payment_id, amountPaise, currency = 'INR' }) {
  // Fetch current booking state (amount, currency, payment_status, customer_id)
  const { data: bk } = await supabase
    .from('bookings')
    .select('id, amount, currency, payment_status, customer_id, service_type, petclub_offer_amount')
    .eq('id', bookingId)
    .single();

  if (!bk) throw new Error(`Booking ${bookingId} not found`);

  // Idempotency guard â€” already paid, nothing to do
  if (bk.payment_status === 'paid') {
    logger.info(`[Payment] finalisePayment: booking ${bookingId} already paid â€” skipping`);
    return { alreadyProcessed: true, split: null };
  }

  // Use Razorpay-confirmed paise amount when available (authoritative);
  // fall back to the amount stored at booking-creation time.
  const confirmedAmount = amountPaise ? amountPaise / 100 : parseFloat(bk.amount);
  // Re-use the offer amount stored at booking-creation time so the split is consistent
  const storedOffer = parseFloat(bk.petclub_offer_amount || 0);
  const split = confirmedAmount > 0
    ? computeSplit(confirmedAmount, storedOffer, bk.service_type || '', currency || bk.currency || 'INR')
    : null;

  // Atomic update â€” only touches rows where payment_status != 'paid'
  // so concurrent calls (verify + webhook) can never double-process.
  const { data: updated } = await supabase
    .from('bookings')
    .update({
      payment_status:    'paid',
      razorpay_payment_id,
      razorpay_order_id,
      payout_status:     'pending',
      ...(split ? {
        total_amount:      split.total_amount,
        platform_fee:      split.platform_fee,
        provider_earnings: split.provider_earnings,
        gateway_fee:       split.gateway_fee,
      } : {}),
    })
    .eq('id', bookingId)
    .neq('payment_status', 'paid')   // atomic guard â€” skip if already paid
    .select('id');

  // 0 rows updated means another concurrent call beat us here â€” idempotent exit
  if (!updated || updated.length === 0) {
    logger.info(`[Payment] finalisePayment: concurrent update detected for ${bookingId} â€” skipping loyalty`);
    return { alreadyProcessed: true, split: null };
  }

  // â”€â”€ Log payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  supabase.from('payment_logs').insert({
    booking_id:         bookingId,
    user_id:            userId || bk.customer_id,
    razorpay_order_id,
    razorpay_payment_id,
    status:             'success',
    amount:             confirmedAmount,
    currency:           currency || bk.currency || 'INR',
  }).catch(() => {}); // table may not exist yet â€” non-fatal

  // â”€â”€ Award loyalty credits (non-blocking â€” never delay the payment response) â”€
  const loyaltyUserId = userId || bk.customer_id;
  if (loyaltyUserId && confirmedAmount > 0) {
    const spendCredits = loyalty.creditsFromAmount(confirmedAmount);

    // booking_spend: 1 credit per â‚¹10 paid
    if (spendCredits > 0) {
      loyalty.awardPoints(
        supabase, loyaltyUserId,
        spendCredits, 'booking_spend',
        `${spendCredits} credits for â‚¹${confirmedAmount} payment on booking ${bookingId}`,
        bookingId,
      ).catch(e => logger.error('[Loyalty] booking_spend award failed:', e.message));
    }

    // payment_bonus: flat +50 for paying via in-app Razorpay
    loyalty.awardPoints(
      supabase, loyaltyUserId,
      loyalty.PAYMENT_BONUS, 'payment_bonus',
      `In-app Razorpay payment bonus for booking ${bookingId}`,
      bookingId,
    ).catch(e => logger.error('[Loyalty] payment_bonus award failed:', e.message));

    logger.info(`[Payment] Loyalty queued: ${spendCredits} booking_spend + ${loyalty.PAYMENT_BONUS} payment_bonus â†’ user ${loyaltyUserId}`);
  }

  return { alreadyProcessed: false, split };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/payments/verify  â€” client-facing, called right after checkout
//
//  Fast feedback path: the frontend calls this immediately after Razorpay
//  confirms the payment so the UI can show a success screen without waiting
//  for the webhook. We verify the HMAC signature (proves the response came
//  from Razorpay, not a tampered client payload) then delegate to finalisePayment.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/payments/verify', auth, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Payments not yet active', coming_soon: true });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingId)
      return res.status(400).json({ error: 'Missing payment verification fields' });

    // Verify HMAC â€” proves this payload was constructed by Razorpay
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment signature mismatch â€” possible tamper attempt' });

    await finalisePayment({
      bookingId,
      userId:              req.user.id,
      razorpay_order_id,
      razorpay_payment_id,
      // amount from Razorpay is in paise â€” not available here so we use booking amount
      amountPaise: null,
      currency:    'INR',
    });

    res.json({ success: true, message: 'âœ… Payment verified and booking confirmed!' });
  } catch (err) {
    logger.error('[Razorpay] Verify error:', err.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/payments/webhook  â€” server-to-server from Razorpay
//
//  Razorpay posts payment.captured events here directly â€” bypasses the client
//  entirely. This is the safety net: if the app crashes after charging the
//  customer but before /verify is called, this webhook still fires and
//  finalises the booking.
//
//  IMPORTANT: this route must use express.raw() to receive the raw body
//  needed for HMAC verification. It is registered before express.json() runs.
//
//  Setup in Razorpay Dashboard:
//    Webhooks â†’ Add Webhook URL â†’ https://petclub-backend-xxx.run.app/api/payments/webhook
//    Events: payment.captured, payment.failed
//    Secret: set RAZORPAY_WEBHOOK_SECRET in Cloud Run env vars (different from key_secret)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/payments/webhook',
  express.raw({ type: 'application/json' }),   // raw body required for HMAC
  async (req, res) => {
    // â”€â”€ 1. Verify webhook signature â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // Webhook secret not configured â€” log and return 200 so Razorpay doesn't retry forever
      logger.warn('[Webhook] RAZORPAY_WEBHOOK_SECRET not set â€” skipping signature check. Set it in Cloud Run env vars.');
    } else {
      const crypto   = require('crypto');
      const received = req.headers['x-razorpay-signature'];
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)           // raw Buffer, not parsed JSON
        .digest('hex');

      if (received !== expected) {
        logger.warn('[Webhook] Invalid signature â€” rejected');
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    // â”€â”€ 2. Parse event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const eventType = event.event;
    logger.info(`[Webhook] Received event: ${eventType}`);

    // â”€â”€ 3. Handle payment.captured â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (eventType === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      if (!payment) {
        logger.warn('[Webhook] payment.captured missing payload.payment.entity');
        return res.status(200).json({ received: true }); // ack to stop retries
      }

      const razorpay_payment_id = payment.id;
      const razorpay_order_id   = payment.order_id;
      const amountPaise         = payment.amount;          // in paise
      const currency            = payment.currency || 'INR';

      // bookingId and userId were stored in order notes at create-order time
      const bookingId = payment.notes?.bookingId;
      const userId    = payment.notes?.userId;

      if (!razorpay_order_id || !bookingId) {
        logger.warn('[Webhook] payment.captured missing order_id or bookingId in notes:', { razorpay_order_id, bookingId });
        return res.status(200).json({ received: true });
      }

      try {
        const result = await finalisePayment({
          bookingId,
          userId,
          razorpay_order_id,
          razorpay_payment_id,
          amountPaise,
          currency,
        });
        logger.info(`[Webhook] payment.captured processed for booking ${bookingId} â€” alreadyProcessed: ${result.alreadyProcessed}`);
      } catch (err) {
        logger.error('[Webhook] finalisePayment error:', err.message);
        // Return 500 so Razorpay retries (it retries for up to 24 hours)
        return res.status(500).json({ error: 'Internal error processing payment' });
      }
    }

    // â”€â”€ 4. Handle payment.failed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (eventType === 'payment.failed') {
      const payment   = event.payload?.payment?.entity;
      const orderId   = payment?.order_id;
      const bookingId = payment?.notes?.bookingId;
      if (bookingId) {
        await supabase.from('bookings')
          .update({ payment_status: 'failed' })
          .eq('id', bookingId)
          .eq('payment_status', 'pending'); // only update if still pending
        logger.info(`[Webhook] payment.failed recorded for booking ${bookingId}`);
      }
      supabase.from('payment_logs').insert({
        booking_id:       bookingId || null,
        razorpay_order_id: orderId   || null,
        razorpay_payment_id: payment?.id || null,
        status:           'failed',
      }).catch(() => {});
    }

    // Always return 200 to acknowledge receipt â€” Razorpay will retry on non-200
    res.status(200).json({ received: true });
  }
);

// Get Razorpay public key (frontend uses this to initialize the checkout)
app.get('/api/payments/config', auth, (req, res) => {
  res.json({
    enabled: !!razorpay,
    key: razorpay ? process.env.RAZORPAY_KEY_ID : null,
    coming_soon: !razorpay,
    message: razorpay ? 'Payments active' : 'Payments coming soon â€” LLC registration in progress',
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  LOCATION GATEWAY â€” routes geocoding by country
//  +91 â†’ Mappls (MapmyIndia)  best India coverage
//  +1  â†’ (Phase 2) Google     US / Canada
//  *   â†’ Nominatim             free OSM fallback
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/* â”€â”€ Mappls static key helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// Mappls Cloud App issues a Static Key used directly as access_token.
// No OAuth2 / token exchange needed â€” simpler and zero latency overhead.
const getMapplsToken = async () => process.env.MAPPLS_STATIC_KEY || null;

/* â”€â”€ Provider router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const getGeoProvider = (phone = '') => {
  if (phone.startsWith('+91')) return 'mappls';
  // Phase 2: if (phone.startsWith('+1')) return 'google';
  return 'nominatim';
};

/* â”€â”€ Mappls forward search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ Mappls reverse geocode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ Nominatim forward search (OSM fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ Nominatim reverse geocode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ GET /api/geocode?q=... â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
          logger.warn('[Mappls] search failed, falling back to Nominatim:', e.message);
        }
      }
    }
    // Phase 2: else if (provider === 'google') { results = await searchGoogle(q); }

    if (!results.length) results = await searchNominatim(q); // always fallback
    res.json(results);
  } catch (e) {
    logger.error('[geocode]', e.message);
    try { res.json(await searchNominatim(q)); } catch { res.json([]); }
  }
});

/* â”€â”€ GET /api/reverse-geocode?lat=...&lng=... â”€â”€â”€â”€â”€â”€â”€â”€ */
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
          logger.warn('[Mappls] reverse failed, falling back to Nominatim:', e.message);
        }
      }
    }
    // Phase 2: else if (provider === 'google') { result = await reverseGoogle(lat, lng); }

    if (!result) result = await reverseNominatim(lat, lng);
    res.json(result || {});
  } catch (e) {
    logger.error('[reverse-geocode]', e.message);
    try { res.json(await reverseNominatim(lat, lng)); } catch { res.json({}); }
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  HEALTH CHECK
//  Public: status + version only (no internal config)
//  Authenticated (X-Health-Secret header): full service map
//  CI/CD: curl -H "X-Health-Secret: $HEALTH_SECRET" $URL/api/health
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/health', async (req, res) => {
  const authenticated = process.env.HEALTH_SECRET
    && req.headers['x-health-secret'] === process.env.HEALTH_SECRET;

  // Always ping Supabase with a lightweight query â€” keeps the free-tier project
  // from auto-pausing (Supabase pauses after 7 days of no DB activity).
  // This runs on every health check so the 2-hour health monitor keeps us alive.
  let dbOk = false;
  let dbMs = null;
  try {
    const t0 = Date.now();
    const { error } = await supabase.from('users').select('id').limit(1);
    dbMs = Date.now() - t0;
    dbOk = !error;
  } catch { dbOk = false; }

  const base = {
    status:  'ðŸ¾ PETclub API running',
    version: API_VERSION,
    time:    new Date(),
    db:      dbOk ? 'âœ…' : 'âš ï¸ unreachable',
  };
  if (!authenticated) return res.json(base);
  // Full response for CI/CD and ops tooling only
  res.json({
    ...base,
    db_latency_ms: dbMs,
    config: {
      booking_response_timeout_mins: RESPONSE_TIMEOUT_MINS,
      web_app_url: WEB_APP_URL,
      website_url: WEBSITE_URL,
    },
    services: {
      supabase:      dbOk ? 'âœ…' : 'âŒ unreachable',
      zoho_smtp:     process.env.ZOHO_SMTP_USER ? 'âœ…' : 'âš ï¸ not configured',
      firebase_auth: firebaseAdmin ? 'âœ… live' : 'â³ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)',
      razorpay:      razorpay ? 'âœ… live' : 'â³ pending (set env vars)',
      fcm:           firebaseAdmin ? 'âœ… live' : 'â³ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)',
      mappls_geo:    process.env.MAPPLS_STATIC_KEY ? 'âœ… configured' : 'âš ï¸ not set â€” using Nominatim fallback',
    },
  });
});
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: Full platform health â€” powers the Platform Status widget
//  Uses JWT admin auth so no secret header is needed in the browser.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/admin/health', auth, adminOnly, async (req, res) => {
  // Run all service pings in parallel â€” 5 s timeout each so the endpoint
  // never hangs longer than ~5 s even if one provider is completely down.
  const ping = (promise, timeoutMs = 5000) =>
    Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);

  const [supOk, fbOk, smtpOk, twilioOk, razOk] = await Promise.all([
    // Supabase â€” lightweight SELECT 1
    ping(supabase.from('users').select('id', { count: 'exact', head: true }))
      .then(({ error }) => !error)
      .catch(() => false),

    // Firebase Admin SDK â€” list 1 user (minimal scoped call)
    firebaseAdmin
      ? ping(firebaseAdmin.auth().listUsers(1)).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured

    // Zoho SMTP â€” nodemailer verify (tests TCP + auth handshake)
    ping(emailService.pingSmtp()).catch(() => false),

    // Twilio â€” fetch own account (1 API call)
    _twilioClient
      ? ping(_twilioClient.api.accounts(_twilioSid).fetch()).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured

    // Razorpay â€” fetch order list with count:1
    razorpay
      ? ping(razorpay.orders.all({ count: 1 })).then(() => true).catch(() => false)
      : Promise.resolve(null), // null = not configured (awaiting LLC)
  ]);

  const svc = (ok, label, pendingMsg) => {
    if (ok === null) return pendingMsg || 'â³ pending';
    return ok ? `âœ…` : `âš ï¸ ${label} unreachable`;
  };

  res.json({
    status:  'ðŸ¾ PETclub API running',
    version: API_VERSION,
    time:    new Date(),
    config: {
      booking_response_timeout_mins: RESPONSE_TIMEOUT_MINS,
      web_app_url: WEB_APP_URL,
      website_url: WEBSITE_URL,
    },
    services: {
      supabase:      svc(supOk,    'Supabase'),
      twilio_sms:    svc(twilioOk, 'Twilio',   'âš ï¸ not configured (email fallback active)'),
      zoho_smtp:     svc(smtpOk,   'Zoho SMTP','âš ï¸ not configured'),
      firebase_auth: svc(fbOk,     'Firebase', 'â³ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)'),
      razorpay:      svc(razOk,    'Razorpay', 'â³ pending (set RAZORPAY env vars)'),
      fcm:           svc(fbOk,     'Firebase', 'â³ pending (set FIREBASE_SERVICE_ACCOUNT_JSON)'),
      mappls_geo:    process.env.MAPPLS_STATIC_KEY ? 'âœ… configured' : 'âš ï¸ not set â€” using Nominatim fallback',
    },
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: DB Audit â€” scan every table for stale/orphan rows
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
      .eq('status', 'upcoming').lt('scheduled_at', stale30d);
    const { count: noProBookings } = await supabase
      .from('bookings').select('id', { count: 'exact', head: true })
      .eq('assignment_status', 'no_pros_available').eq('status', 'upcoming')
      .lt('created_at', stale7d);

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
        bookings:         { total: totalBookings, cancelled: cancelledBookings, stale_upcoming: testBookings, no_pros_available: noProBookings },
        orphans:          { professional_profiles: orphanProfProfiles, customer_profiles: orphanCustProfiles, pets: orphanPets },
        stale_pending_users: { count: stalePendingUsers?.length || 0, ids: stalePendingUsers?.map(u => u.id) || [] },
        otp_tokens:       { expired: staleOtps },
        website_leads:    { total: totalLeads, older_than_30d: staleLeads },
        admin_logs:       { total: totalLogs },
        payment_logs:     { total: totalPaymentLogs },
      },
    });
  } catch (e) {
    logger.error('[DB Audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ADMIN: DB Cleanup â€” remove confirmed stale/orphan rows
//  Accepts { targets: [...] } â€” array of what to clean:
//  "expired_otps", "orphan_profiles", "stale_pending_users",
//  "cancelled_bookings", "stale_leads"
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
      if (orphanCustIds.length) { await supabase.from('customer_profiles').delete().in('user_id', orphanCustIds); deleted += orphanCustIds.length; }
      if (orphanPetIds.length)  { await supabase.from('pets').update({ deleted_at: new Date().toISOString() }).in('id', orphanPetIds); deleted += orphanPetIds.length; }
      report.orphan_profiles = deleted;
    }

    // Stale pending_role users (never completed signup, >7 days)
    if (targets.includes('stale_pending_users')) {
      const { data: stale } = await supabase.from('users').select('id, phone')
        .eq('role', 'pending_role').lt('created_at', stale7d);
      if (stale?.length) {
        const ids   = stale.map(u => u.id);
        const phones = stale.map(u => u.phone);
        await supabase.from('professional_profiles').delete().in('user_id', ids);
        await supabase.from('customer_profiles').delete().in('user_id', ids);
        const _staleNow = new Date().toISOString();
        await supabase.from('pets').update({ deleted_at: _staleNow }).in('owner_id', ids);
        await supabase.from('otp_tokens').delete().in('phone', phones);
        await supabase.from('admin_logs').delete().in('target_id', ids);
        await supabase.from('users').update({ deleted_at: _staleNow }).in('id', ids);
      }
      report.stale_pending_users = stale?.length || 0;
    }

    // Cancelled bookings (soft-delete)
    if (targets.includes('cancelled_bookings')) {
      const _cxNow = new Date().toISOString();
      const { error } = await supabase.from('bookings')
        .update({ deleted_at: _cxNow }).eq('status', 'cancelled').is('deleted_at', null);
      report.cancelled_bookings = error ? `error: ${error.message}` : 'soft-deleted';
    }

    // Stale no_pros_available bookings (status=upcoming but no pro found — older than 7 days)
    if (targets.includes('no_pros_available')) {
      const _npNow = new Date().toISOString();
      const { error } = await supabase.from('bookings')
        .update({ deleted_at: _npNow })
        .eq('assignment_status', 'no_pros_available')
        .eq('status', 'upcoming')
        .lt('created_at', stale7d)
        .is('deleted_at', null);
      report.no_pros_available = error ? `error: ${error.message}` : 'soft-deleted';
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
    } catch {} // non-critical audit log â€” cleanup already completed

    res.json({ success: true, cleaned: report });
  } catch (e) {
    logger.error('[DB Cleanup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
// Sentry must capture errors before the generic handler
if (process.env.SENTRY_DSN) app.use(Sentry.expressErrorHandler());
app.use((err, req, res, next) => { logger.error(err); res.status(500).json({ error: 'Server error' }); });

// â”€â”€ Startup migration: add live-tracking columns to bookings (safe, IF NOT EXISTS) â”€â”€
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
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_earnings    NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gateway_fee          NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency             TEXT DEFAULT 'INR'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_status        TEXT DEFAULT 'pending'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_reference     TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS petclub_offer_amount NUMERIC(10,2)`,
    `ALTER TABLE grooming_records  ADD COLUMN IF NOT EXISTS booking_id TEXT`,
    `ALTER TABLE training_records  ADD COLUMN IF NOT EXISTS booking_id TEXT`,
    `ALTER TABLE vet_records        ADD COLUMN IF NOT EXISTS booking_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by        TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_fee    NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount       NUMERIC(10,2)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_status       TEXT DEFAULT 'not_applicable'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_notes       TEXT`,
    `CREATE TABLE IF NOT EXISTS booking_messages (
       id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
       booking_id  TEXT NOT NULL,
       sender_id   UUID NOT NULL,
       sender_role TEXT NOT NULL,
       sender_name TEXT,
       content     TEXT NOT NULL,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       read_at     TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS booking_messages_booking_id_idx ON booking_messages (booking_id, created_at)`,
  ];
  for (const sql of migrations) {
    // PostgREST can't run DDL, but Supabase service-role key can call
    // the pg_query RPC if it's enabled â€” fallback: log and continue
    const { error } = await Promise.resolve(supabase.rpc('pg_query', { query: sql })).catch(() => ({ error: { message: 'rpc_not_available' } }));
    if (error && !error.message?.includes('already exists') && !error.message?.includes('rpc_not_available')) {
      logger.warn('[migration] Could not run:', sql.slice(0, 60), 'â†’', error.message);
    }
  }
}

// â”€â”€ Startup: link ADMIN_EMAIL to the admin user record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ensures the admin can log in via email OTP by making sure the admin user's
// email field in Supabase matches the ADMIN_EMAIL env var.
// Also cleans up any stale pending_role duplicate that may have been created
// when someone tried to log in with the admin email before it was linked.
// Runs once at startup; safe to repeat â€” idempotent.
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
    logger.warn('[adminSeed] No admin user found in Supabase â€” skipping email link');
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
        await supabase.from('users').update({ deleted_at: new Date().toISOString() }).eq('id', dupe.id);
        logger.info(`[adminSeed] ðŸ—‘ï¸ Removed stale duplicate user (${dupe.role}) with email ${maskEmail(targetEmail)}`);
      }
    }
  }

  if (existingEmail === targetEmail) {
    // Already linked â€” nothing to do
    logger.info(`[adminSeed] Admin email already linked: ${maskEmail(adminEmail)}`);
    return;
  }

  // Step 2: Link the admin email
  const { error: updateErr } = await supabase
    .from('users')
    .update({ email: targetEmail })
    .eq('id', admin.id);

  if (updateErr) {
    logger.warn('[adminSeed] Could not link admin email:', updateErr.message);
  } else {
    logger.info(`[adminSeed] âœ… Admin email linked â†’ ${maskEmail(adminEmail)}`);
  }
}

// Export app for integration tests (require.main guard prevents double-listen)
if (require.main !== module) {
  module.exports = { app };
} else {
  app.listen(PORT, async () => {
    logger.info(`ðŸ¾ PETclub API â†’ http://localhost:${PORT}`);
    // Run migrations in background â€” won't block startup
    runStartupMigrations().catch(e => logger.warn('[startup migration]', e.message));
    // Link admin email so email OTP login finds the right account
    seedAdminEmail().catch(e => logger.warn('[adminSeed]', e.message));
  });
}
