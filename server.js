// ═══════════════════════════════════════════════════════════
//  PETclub India — Complete Backend API v1.0
//  Stack: Node.js + Express + Twilio + SendGrid + Supabase + JWT
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const IOS_LINK = 'https://apps.apple.com/in/app/petclub';
const ANDROID_LINK = 'https://play.google.com/store/apps/details?id=in.petclub';

// ── Services ───────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Middleware ─────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://petclub-app.vercel.app',
  'https://petclub-website.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false) }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
const otpLimit = rateLimit({ windowMs: 60000, max: 3, message: { error: 'Too many OTP requests. Wait 1 minute.' } });

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

const sendEmail = async (to, subject, html) => {
  if (!resend) { console.log(`[Email skipped — no Resend key] to=${to} subject=${subject}`); return; }
  return resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || 'PETclub <onboarding@resend.dev>', to, subject, html });
};

// ══════════════════════════════════════════════════════
//  AUTH: SEND OTP
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-otp', otpLimit, async (req, res) => {
  try {
    const { phone, countryCode = '91' } = req.body;
    if (!phone || !/^\d{6,15}$/.test(phone))
      return res.status(400).json({ error: 'Valid phone number required' });

    const fullPhone = `+${countryCode}${phone}`;
    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();

    await supabase.from('otp_tokens').upsert({ phone: fullPhone, otp, expires_at: expires, verified: false }, { onConflict: 'phone' });

    sendSMS(fullPhone, `Your PETclub OTP is: ${otp}\nValid 10 minutes. Do not share. 🐾`).catch(e =>
      console.error('SMS delivery failed (OTP stored in DB):', e.message)
    );

    const flag = countryCode === '1' ? '🇺🇸' : '🇮🇳';
    res.json({ success: true, message: `OTP sent to ${flag} +${countryCode} ${phone.slice(0,2)}XXXXXX${phone.slice(-2)}` });
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

    // For professionals, include their verification status
    let verificationStatus = null;
    if (user.role === 'professional') {
      const { data: prof } = await supabase.from('professional_profiles').select('verification_status, sub_role').eq('user_id', user.id).single();
      verificationStatus = prof?.verification_status || 'pending';
    }

    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, isNew, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus } });
  } catch (err) {
    console.error('OTP verify error:', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH: SET ROLE (called once for new users)
// ══════════════════════════════════════════════════════
app.post('/api/users/set-role', auth, async (req, res) => {
  try {
    const { role, subRole, name, email, city } = req.body;
    const validRoles = ['customer', 'professional'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Role must be customer or professional' });

    // Update user record
    await supabase.from('users').update({ role, name: name || null, email: email || null }).eq('id', req.user.id);

    if (role === 'professional') {
      if (!['Groomer', 'Trainer', 'Vet'].includes(subRole))
        return res.status(400).json({ error: 'subRole must be Groomer, Trainer, or Vet' });
      await supabase.from('professional_profiles').upsert({
        user_id: req.user.id, sub_role: subRole, verification_status: 'pending',
        is_available: false, city: city || null,
      }, { onConflict: 'user_id' });
    }

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    const verificationStatus = role === 'professional' ? 'pending' : null;

    // Send welcome email (non-blocking)
    const fn = (name || 'there').split(' ')[0];
    if (email) {
      const isPro = role === 'professional';
      const welcomeHtml = `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #f1f5f9;">
          <div style="background:linear-gradient(135deg,#f97316 0%,#fb923c 50%,#fbbf24 100%);padding:40px 32px;text-align:center;">
            <div style="font-size:52px;margin-bottom:8px">🐾</div>
            <h1 style="color:white;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px">Welcome to PETclub!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:15px">Hi ${fn}, your account is ready</p>
          </div>
          <div style="padding:32px;">
            ${isPro ? `
            <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:20px;margin-bottom:24px;">
              <h2 style="margin:0 0 8px;color:#92400e;font-size:17px;">⏳ Application Under Review</h2>
              <p style="margin:0;color:#78350f;font-size:14px;line-height:1.6">Your <strong>${subRole}</strong> profile has been submitted and is being reviewed by our team. You'll be notified within <strong>24–48 hours</strong>.</p>
            </div>
            <p style="color:#64748b;font-size:14px;line-height:1.7">While you wait, complete your profile in the app to boost your chances of approval — pros with complete profiles get approved faster!</p>
            ` : `
            <p style="color:#374151;font-size:15px;line-height:1.7;margin-bottom:20px">You can now book grooming, training, vet care, and pet food delivery — all in one place.</p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:20px;margin-bottom:24px;">
              <p style="margin:0 0 10px;font-weight:700;color:#166534;font-size:14px">🌟 What you can do:</p>
              <ul style="margin:0;padding-left:18px;color:#4b7c5a;font-size:14px;line-height:2">
                <li>Add your pet profiles</li>
                <li>Book verified groomers, trainers & vets</li>
                <li>Track appointments & health records</li>
                <li>Get reminders & progress updates</li>
              </ul>
            </div>
            `}
            <div style="text-align:center;margin:24px 0;">
              <a href="https://petclub-app.vercel.app" style="display:inline-block;background:linear-gradient(135deg,#f97316,#fbbf24);color:white;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;box-shadow:0 4px 20px rgba(249,115,22,0.3)">Open PETclub App →</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#94a3b8">© 2025 PETclub · For pets, with love 🐾</p>
          </div>
        </div>`;
      sendEmail(email,
        isPro ? `🐾 PETclub — ${subRole} Application Received` : `🐾 Welcome to PETclub, ${fn}!`,
        welcomeHtml
      ).catch(e => console.error('Welcome email failed:', e.message));
    }

    res.json({ success: true, token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, verificationStatus } });
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

    // SMS via Twilio (non-blocking — India toll-free restriction handled gracefully)
    const fullLeadPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    sendSMS(fullLeadPhone,
      `Hi ${fn}! 🐾 Welcome to PETclub!\n\nDownload the app:\n📱 iOS: ${IOS_LINK}\n▶️ Android: ${ANDROID_LINK}\n\nAll pet services in ${city || 'your city'}!`
    ).catch(e => console.error('Lead SMS failed (non-blocking):', e.message));

    // Email via SendGrid
    await sendEmail(email, `🐾 Your PETclub App Link, ${fn}!`, `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#f97316,#f59e0b);padding:40px;text-align:center;color:white;border-radius:20px 20px 0 0;">
          <div style="font-size:48px">🐾</div>
          <h1 style="margin:10px 0 4px">Welcome to PETclub India!</h1>
          <p style="opacity:.9">Your app download link is ready</p>
        </div>
        <div style="background:white;padding:32px;border:1px solid #f1f5f9;">
          <p>Hi <b>${fn}</b>! Book ${service||'grooming, training & vet care'} for ${pet||'your pet'} in ${city||'your city'}.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${IOS_LINK}" style="display:inline-block;background:#0f172a;color:white;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;margin:6px;">🍎 App Store</a><br/>
            <a href="${ANDROID_LINK}" style="display:inline-block;background:#0f172a;color:white;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;margin:6px;">▶️ Google Play</a>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;">
            <b style="color:#16a34a">🌟 What's on the app:</b>
            <ul style="color:#64748b;line-height:2;margin-top:8px">
              <li>Grooming, Training, Vet & Pet Food</li><li>Live GPS tracking & progress reports</li>
              <li>🛡️ ₹25,000 service protection</li><li>Digital health records for 3 years</li>
            </ul>
          </div>
        </div>
        <div style="background:#f8fafc;padding:16px;text-align:center;border-radius:0 0 20px 20px;font-size:12px;color:#94a3b8;">
          © 2025 PETclub India
        </div>
      </div>`);

    // Save lead to DB
    await supabase.from('website_leads').insert({ name, phone, email, city, pet_type: pettype, service_interest: service, pet_name: pet, message });

    res.json({ success: true, message: 'App link sent via SMS and email!' });
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
  const { data } = await supabase.from('users').select('*, customer_profiles(*)').eq('id', req.user.id).single();
  res.json({ success: true, user: data });
});

app.put('/api/users/me', auth, async (req, res) => {
  const { name, email, city, area, address, pincode } = req.body;
  await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  await supabase.from('customer_profiles').upsert({ user_id: req.user.id, city, area, address, pincode }, { onConflict: 'user_id' });
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
  if (name !== undefined || email !== undefined)
    await supabase.from('users').update({ name, email }).eq('id', req.user.id);
  const { data } = await supabase.from('professional_profiles').update({
    city, area, address, bio, experience,
    services: Array.isArray(services) ? JSON.stringify(services) : services,
    service_areas, langs, price_basic, price_full, price_custom,
  }).eq('user_id', req.user.id).select().single();
  res.json({ success: true, profile: data });
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
  const { data: booking } = await supabase.from('bookings').insert({ customer_id: req.user.id, status: 'upcoming', payment_status: 'pending', ...req.body }).select().single();
  // Notify professional via SMS
  if (req.body.professional_id) {
    const { data: p } = await supabase.from('professional_profiles').select('users(phone)').eq('id', req.body.professional_id).single();
    if (p?.users?.phone) sendSMS(p.users.phone.startsWith('+') ? p.users.phone : `+91${p.users.phone}`, `🐾 New PETclub booking: ${req.body.service_name || req.body.service_type}. Check the app! `).catch(console.error);
  }
  res.json({ success: true, booking });
});

app.put('/api/bookings/:id/status', auth, async (req, res) => {
  const { data } = await supabase.from('bookings').update({ status: req.body.status }).eq('id', req.params.id).select().single();
  res.json({ success: true, booking: data });
});

// ══════════════════════════════════════════════════════
//  REVIEWS
// ══════════════════════════════════════════════════════
app.post('/api/reviews', auth, async (req, res) => {
  const { data: review } = await supabase.from('reviews').insert({ reviewer_id: req.user.id, ...req.body }).select().single();
  if (req.body.reviewee_id) {
    const { data: reviews } = await supabase.from('reviews').select('rating').eq('reviewee_id', req.body.reviewee_id);
    const avg = (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1);
    await supabase.from('professional_profiles').update({ rating: parseFloat(avg), total_reviews: reviews.length }).eq('user_id', req.body.reviewee_id);
  }
  res.json({ success: true, review });
});

// ══════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════
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
  const { data: prof } = await supabase.from('professional_profiles').update({ verification_status: status }).eq('id', req.params.id).select('*, users(name,phone,email)').single();
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

app.put('/api/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
  const { data: u } = await supabase.from('users').select('is_active').eq('id', req.params.id).single();
  await supabase.from('users').update({ is_active: !u.is_active }).eq('id', req.params.id);
  await supabase.from('admin_logs').insert({ admin_id: req.user.id, action: u.is_active ? 'suspend_user' : 'restore_user', target_id: req.params.id, target_type: 'user' });
  res.json({ success: true, is_active: !u.is_active });
});

// ══════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: '🐾 PETclub API running', time: new Date() }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`🐾 PETclub API → http://localhost:${PORT}`));