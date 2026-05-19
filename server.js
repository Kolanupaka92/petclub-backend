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
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
  process.env.FRONTEND_URL,
].filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false) }));
app.use(express.json({ limit: '10mb' }));
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

const sendEmail = async (to, subject, html) => {
  if (!resend) { console.log(`[Email skipped — no Resend key] to=${to} subject=${subject}`); return; }
  return resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || 'PETclub <onboarding@resend.dev>', to, subject, html });
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
//  AUTH: SEND OTP  (SMS + email fallback)
// ══════════════════════════════════════════════════════
app.post('/api/auth/send-otp', otpLimit, async (req, res) => {
  try {
    const { phone, countryCode = '91', email } = req.body;
    if (!phone || !/^\d{6,15}$/.test(phone))
      return res.status(400).json({ error: 'Valid phone number required' });

    const fullPhone = `+${countryCode}${phone}`;
    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60000).toISOString();

    await supabase.from('otp_tokens').upsert(
      { phone: fullPhone, otp, expires_at: expires, verified: false },
      { onConflict: 'phone' }
    );

    // Send SMS (primary — may fail for unregistered toll-free in US)
    sendSMS(fullPhone, `Your PETclub OTP is: ${otp}\nValid 10 minutes. Do not share. 🐾`)
      .catch(e => console.error('SMS failed:', e.message));

    // Send via email (fallback — always try if email provided)
    const otpEmailHtml = `
      <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:420px;margin:0 auto;text-align:center;padding:40px 20px;background:#fff;border-radius:20px;">
        <div style="font-size:52px;margin-bottom:12px">🐾</div>
        <h2 style="color:#1e293b;font-size:22px;margin:0 0 6px">Your PETclub OTP</h2>
        <p style="color:#64748b;font-size:14px;margin:0 0 28px">Use this code to sign in or create your account</p>
        <div style="background:#fff7ed;border:2px solid #f97316;border-radius:16px;padding:28px 20px;margin-bottom:24px;display:inline-block;min-width:200px;">
          <div style="font-size:44px;font-weight:900;color:#f97316;letter-spacing:10px;font-family:monospace">${otp}</div>
        </div>
        <p style="color:#94a3b8;font-size:13px;margin:0">Valid for <strong>10 minutes</strong> · Never share this code</p>
        <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0"/>
        <p style="color:#cbd5e1;font-size:11px">© 2025 PETclub · For pets, with love 🐾</p>
      </div>`;

    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendEmail(email, `🐾 PETclub OTP: ${otp}`, otpEmailHtml)
        .catch(e => console.error('Email OTP failed:', e.message));
    }

    const flag = countryCode === '1' ? '🇺🇸' : '🇮🇳';
    const emailNote = email ? ' and email' : '';
    res.json({ success: true, message: `OTP sent via SMS${emailNote} to ${flag} +${countryCode} ${phone.slice(0,2)}XXXXXX${phone.slice(-2)}` });
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
    const { role, subRole, name, email, city, pet } = req.body;
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

    // For customers — create initial pet if provided
    if (role === 'customer' && pet?.name) {
      await supabase.from('pets').insert({
        owner_id: req.user.id,
        name: pet.name,
        species: pet.species || null,
        breed: pet.breed || null,
        age: pet.age ? parseInt(pet.age) : null,
        gender: pet.gender || null,
        dob: pet.dob || null,
      }).catch(e => console.error('Initial pet creation error:', e.message));
    }

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    const verificationStatus = role === 'professional' ? 'pending' : null;

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
              <a href="https://petclub-app.vercel.app" style="display:inline-block;background:linear-gradient(135deg,#f97316,#fbbf24);color:white;padding:15px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;box-shadow:0 4px 20px rgba(249,115,22,0.3)">Open PETclub App →</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#94a3b8">© 2025 PETclub · For pets, with love 🐾 · <a href="https://petclub-website.vercel.app" style="color:#f97316;text-decoration:none">petclub.com</a></p>
          </div>
        </div>`;
      sendEmail(email,
        isPro ? `🐾 ${subRole} Application Received — Review in 24–48 hrs` : `🐾 Welcome to PETclub, ${fn}!`,
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

    res.json({ success: true, photoUrl, message: 'ID document saved' });
  } catch (err) {
    console.error('ID upload error:', err.message);
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