# PETclub Backend

> Node.js 20 · Express 4 · Supabase Postgres · Firebase Admin · Cloud Run (us-south1)
> Current version: see `package.json`

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- A `.env` file (copy `.env.example` and fill in values — ask the lead for secrets)

```bash
cd petclub-backend
cp .env.example .env      # fill in values
npm install
npm run dev               # nodemon — auto-restarts on save
```

API runs at **http://localhost:5000**

To run the frontend against this local backend:
```bash
# In petclub-app/.env.local — add this line:
VITE_API_URL=http://localhost:5000/api
# Then start the frontend:
cd petclub-app && npm run dev
```

---

## Environment Variables

### Required (server refuses to start without these)

| Variable | What it is |
|----------|-----------|
| `JWT_SECRET` | HS256 signing secret — keep long and random |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS — treat like a password) |

### Auth

| Variable | What it is |
|----------|-----------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK credentials — full JSON as a single-line string |

### Email (Zoho SMTP — production)

| Variable | What it is |
|----------|-----------|
| `ZOHO_SMTP_USER` | Zoho email address |
| `ZOHO_SMTP_PASS` | Zoho app password |
| `ZOHO_SMTP_FROM` | From address shown to users |
| `ADMIN_EMAIL` | Where admin notifications go |
| `SUPPORT_EMAIL` | Shown in emails as reply-to |
| `HR_EMAIL` | Used for professional onboarding emails |

### SMS / WhatsApp (Twilio — optional, no-ops if unset)

| Variable | What it is |
|----------|-----------|
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio secret |
| `TWILIO_PHONE_NUMBER` | E.164 SMS sender number |
| `TWILIO_WHATSAPP_FROM` | E.164 WhatsApp-enabled number (sandbox: `+14155238886`) |

### Payments (Razorpay — inactive until LLC registration)

| Variable | What it is |
|----------|-----------|
| `RAZORPAY_KEY_ID` | Public key (starts `rzp_`) |
| `RAZORPAY_KEY_SECRET` | Private secret — never expose to frontend |

### Maps / Geocoding

| Variable | What it is |
|----------|-----------|
| `MAPPLS_CLIENT_ID` | Mappls (MapmyIndia) OAuth client ID |
| `MAPPLS_CLIENT_SECRET` | Mappls OAuth secret |

### Dispatch Tuning (override without redeploy)

| Variable | Default | What it is |
|----------|---------|-----------|
| `DISPATCH_RADIUS_KM` | `70` | How far to search for a pro |
| `BOOKING_RESPONSE_TIMEOUT_MINS` | `5` | Minutes for pro to accept before passing to next |
| `PROXIMITY_ALERT_KM` | `8` | Distance that triggers the "10 min away" alert |

### Revenue Split (override without redeploy)

| Variable | Default | What it is |
|----------|---------|-----------|
| `PLATFORM_RATE` | `0.30` | PETclub's share (30%) |
| `PROVIDER_RATE` | `0.70` | Professional's share (70%) |

> ⚠️ `server.js` source defaults are `0.55 / 0.45` — env var always wins. Production uses `0.30 / 0.70` via Cloud Run env.

### Dev / Testing

| Variable | What it is |
|----------|-----------|
| `NODE_ENV` | Set to `production` in Cloud Run — controls IS_PROD flag |
| `ALLOW_DEV_TOOLS` | Set in local `.env` to enable dev endpoints and localhost CORS |
| `E2E_TEST_EMAIL_DOMAIN` | e.g. `mailinator.com` — returns fixed OTP `123456`, **non-production only** |
| `ADMIN_SECRET` | One-time secret to bootstrap the first admin user |
| `HEALTH_SECRET` | Required to see full detail in `GET /api/health` |

---

## NPM Scripts

```bash
npm run dev          # nodemon auto-reload (local dev)
npm start            # plain node (production / Cloud Run)
npm test             # Jest unit tests
npm run test:coverage # Jest with coverage report
```

---

## Deploy to Cloud Run

Deployment is **automatic on push to `main`** via Cloud Build:

```
git push origin main
# → Cloud Build triggers → Docker image built → Cloud Run revision deployed
# Takes ~3-4 minutes. Watch progress in Google Cloud Console → Cloud Build.
```

Manual deploy (emergency fallback):
```bash
gcloud run services update petclub-backend \
  --region us-south1 \
  --image gcr.io/YOUR_PROJECT/petclub-backend:latest
```

See `docs/WORKFLOW.md` for full deployment details.

---

## Project Structure

```
petclub-backend/
├── server.js          # Everything — single-file Express app (~4500 lines)
├── services/
│   └── emailService.js  # Zoho SMTP email helpers
├── docs/
│   ├── ARCHITECTURE.md  # System diagrams and infra overview
│   ├── WORKFLOW.md      # Day-to-day dev + deploy operations
│   ├── DEVELOPER.md     # Business rules, RBAC, booking flow (start here!)
│   └── BILLING.md       # Commission model and pricing
├── schema.sql           # DB schema reference (not auto-applied)
├── Dockerfile           # Cloud Run container
├── cloudbuild.yaml      # CI/CD pipeline definition
└── .env.example         # All env vars documented with examples
```

---

## Key Things to Know Before Touching Code

1. **Read `docs/DEVELOPER.md` first** — business rules, security constraints, and the booking state machine are documented there. Violating them (especially the RBAC pricing rules) is a serious issue.

2. **`server.js` is a single file** — all routes, middleware, cron jobs, and helpers live here. Search with `Ctrl+F` for the endpoint path (e.g. `/api/bookings`) to find the handler.

3. **Supabase RLS is enforced at DB level** — but the backend also strips fields based on role (`stripFinancials`). Both layers must agree. If you add a new sensitive column, update `stripFinancials`.

4. **Service providers must never see customer prices** — this is enforced in `stripFinancials()`. Do not bypass this. See `docs/DEVELOPER.md` for the full RBAC rules.

5. **Rate limiters use Postgres** — `PgRateLimitStore` stores counters in Supabase so they survive across multiple Cloud Run instances. Falls back to in-memory if DB is unreachable.

6. **Cron jobs run in-process** — no external queue. They run on a setInterval inside `server.js`. Cloud Run keeps one instance warm; jobs may fire multiple times if Cloud Run scales up.

7. **JWT contains only `{ id, role }`** — no phone number or PII. The `auth` middleware attaches `req.user = { id, role }` to every request.
