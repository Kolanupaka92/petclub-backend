# PETclub — Developer Guide

> Start here before writing any code. This covers the business rules, security constraints,
> booking flow, and role system that every developer must understand.

---

## Table of Contents

1. [Role System](#1-role-system)
2. [RBAC — Who Sees What](#2-rbac--who-sees-what)
3. [Booking State Machine](#3-booking-state-machine)
4. [Authentication Flow](#4-authentication-flow)
5. [Financial Rules](#5-financial-rules)
6. [Security Constraints](#6-security-constraints)
7. [API Reference](#7-api-reference)
8. [Background Jobs](#8-background-jobs)
9. [Common Mistakes](#9-common-mistakes)

---

## 1. Role System

Every user has a `role` field stored in the `users` table. Roles are set once via `POST /api/users/set-role` and cannot be changed without admin intervention.

| Role | Description | Can Do |
|------|-------------|--------|
| `customer` | Pet owner | Book services, manage pets, view own bookings |
| `professional` | Service provider (SP) | Receive bookings, update availability, view earnings |
| `admin` | Platform operator | Full access — all users, all bookings, verify pros |

Professionals also have a `sub_role` (set in `professional_profiles`):

| Sub-role | Service |
|----------|---------|
| `Groomer` | Dog/cat grooming |
| `Trainer` | Pet training |
| `Vet` | Veterinary care |
| `Walker` | Dog walking |
| `Boarding` | Pet boarding |

The `auth` middleware in `server.js` attaches `req.user = { id, role }` on every authenticated request. Use `adminOnly` middleware for admin-only routes.

---

## 2. RBAC — Who Sees What

### 🔴 Critical Rule: Service Providers NEVER See Customer Prices

The function `stripFinancials(booking, role)` in `server.js` enforces this on every booking response:

| Field | Customer sees | Professional sees | Admin sees |
|-------|:---:|:---:|:---:|
| `total_amount` | ✅ | ❌ stripped | ✅ |
| `platform_fee` | ❌ stripped | ❌ stripped | ✅ |
| `provider_earnings` | ❌ stripped | ✅ | ✅ |
| `gateway_fee` | ❌ stripped | ❌ stripped | ✅ |
| `payout_status` | ❌ stripped | ✅ | ✅ |

**If you add a new financial column to the bookings table, you must update `stripFinancials`.**

### Customer Contact Details

- **Before booking acceptance**: Professional receives pet name, breed, service, date/time, and address area — but NOT the customer's phone number.
- **After booking acceptance**: Full address and contact details are shared so the professional can navigate.

### Admin Routes

- Admin dashboard is accessible only via `adminOnly` middleware.
- Client-side `localStorage` role manipulation (e.g. setting `role: 'admin'`) is ignored — the JWT is verified server-side on every request.
- Never return admin-only fields (internal notes, financial totals, full addresses) to `customer` or `professional` roles.

---

## 3. Booking State Machine

```
Customer creates booking
         │
         ▼
  [searching] ←──────────────────────────────────────┐
         │                                             │
         │  findNextPro() — round-robin within 70km   │
         ▼                                             │
    [offered] ─── response_deadline set (5 min) ──────┤
         │                                             │
    Pro responds:                                      │
    ├── accept → [confirmed]                           │
    └── reject ────────────────────────────────────────┘
         │         (try next professional)
         │  (if all pros exhausted → [no_pros_available])
         │
         ▼
   [confirmed]
         │
         │  Pro: POST /bookings/:id/on-my-way
         ▼
   [on_the_way] ← GPS streaming (POST /bookings/:id/location)
         │
         │  Service begins
         ▼
  [in_progress]
         │
         │  Service ends
         ▼
   [completed]
         │
         │  Customer rates (optional)
         │  → +50 loyalty points awarded
         ▼
      (done)

Other terminal states:
  [cancelled]          — customer or admin cancelled
  [no_pros_available]  — dispatch exhausted all pros
```

### Dispatch Algorithm

`findNextPro()` selects professionals using:
1. Sub-role matches the service type
2. `is_available = true`
3. `verification_status = 'approved'`
4. Distance from booking address ≤ `DISPATCH_RADIUS_KM` (default 70 km)
5. Ordered by `last_assigned_at` ascending (round-robin — least recently assigned first)
6. Skips pros who already rejected this booking

Each offer gives the pro `BOOKING_RESPONSE_TIMEOUT_MINS` (default 5 min) to accept. The cron job runs every 2 min to advance timed-out offers.

---

## 4. Authentication Flow

### Phone OTP (Primary — Indian +91 users)

```
Frontend                     Backend                      Firebase
   │                             │                            │
   │── POST /auth/send-phone-otp ─►                           │
   │                          India? ──── signInWithPhoneNumber ──►
   │                          USA?   ── Twilio SMS ──────────────►
   │                             │                            │
   │◄── { success: true } ───────│                            │
   │                             │                            │
   │── POST /auth/verify-phone-otp ►                          │
   │      { phone, otp }         │                            │
   │                          verify OTP against otp_tokens   │
   │                          create/find user in users table  │
   │◄── { token, user, isNew } ──│                            │
   │   (JWT: { id, role })       │                            │
```

### Email OTP (Alternative — users without phone access)

```
Frontend                     Backend                      Zoho SMTP
   │                             │                            │
   │── POST /auth/send-email-otp ─►                           │
   │                          generate 6-digit OTP            │
   │                          store in otp_tokens table       │
   │                          send email ─────────────────────►
   │◄── { success: true } ───────│                            │
   │                             │                            │
   │── POST /auth/verify-email-otp ►                          │
   │      { email, otp }         │                            │
   │                          verify OTP                       │
   │                          create/find user                │
   │◄── { token, user, isNew } ──│                            │
```

### JWT

- Payload: `{ id: uuid, role: string }`
- Signed with `JWT_SECRET` using HS256
- Default expiry: 7 days (override with `JWT_EXPIRES_IN`)
- **Does not contain phone number or any PII**
- Sent in `Authorization: Bearer <token>` header
- On 401 response, frontend fires `petclub:unauthorized` CustomEvent → auto-logout

---

## 5. Financial Rules

### Commission Split

```
Customer pays total_amount
    ├── platform_fee    = total_amount × PLATFORM_RATE  (default 30%)
    └── provider_earnings = total_amount × PROVIDER_RATE (default 70%)

gateway_fee is deducted from total before split (Razorpay charges ~2% + ₹3)
```

### Loyalty Points

| Event | Points |
|-------|--------|
| Booking completed (rated) | +50 |
| Admin manual award | Custom |
| Referral (referred user completes first booking) | +100 |

### Redemption
- 1,000 points → 1 free Basic Bath coupon
- Coupons are single-use, expire after 30 days
- Customer sees points balance in profile tab

---

## 6. Security Constraints

These were established after a full security audit (May 2026). **Do not regress any of these.**

| Rule | Where enforced |
|------|---------------|
| SP never sees `total_amount` or `platform_fee` | `stripFinancials()` in `server.js` |
| Customer phone not in WhatsApp notification until booking accepted | `offerBookingToPro()` |
| JWT contains only `{ id, role }` — no phone/PII | All 4 auth verify endpoints |
| E2E test OTP bypass only in `NODE_ENV !== production` | `otpLimit.skip()` + route handler |
| Admin personal email not in frontend source | `VITE_PARTNER_CONTACT_EMAIL` env var |
| Admin search input stripped of special chars | `rawSearch.replace(/[^a-zA-Z0-9\s+@._-]/g, '')` |
| Contact form `message` sanitized before HTML email | `sanitize()` applied at route entry |
| Map marker uses `textContent` not `innerHTML` | `TrackingMapMapbox.jsx` — DOM API |
| Seed credentials in env vars, not source code | `SEED_PROVIDER_EMAIL` etc. |

### Known Deferred Issue (post-Razorpay)

**Finding 9**: JWT is stored in `localStorage` — stealable via XSS. Must be moved to `httpOnly` cookie after Razorpay integration. Affects `petclub-app/src/api.js` (lines 14, 175) and all auth endpoints in `server.js`.

---

## 7. API Reference

### Rate Limiters

| Name | Window | Max | Applied to |
|------|--------|-----|-----------|
| Global | 15 min | 300/IP | All routes |
| `otpLimit` | 1 min | 5/IP | Send OTP routes |
| `authLimit` | 15 min | 10/IP | Verify OTP + make-admin |

All use Postgres-backed storage (`PgRateLimitStore`) for correctness across Cloud Run instances.

### Endpoint Summary

#### Public (no auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/professionals` | List available professionals |
| POST | `/api/auth/firebase-verify` | Phone login via Firebase |
| POST | `/api/auth/send-email-otp` | Send email OTP |
| POST | `/api/auth/verify-email-otp` | Verify email OTP → JWT |
| POST | `/api/auth/send-phone-otp` | Send phone OTP via Twilio |
| POST | `/api/auth/verify-phone-otp` | Verify phone OTP → JWT |
| POST | `/api/contact/send-link` | Website lead form |

#### Customer (JWT required, role: customer)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/me` | Get own profile |
| PUT | `/api/users/me` | Update profile |
| POST | `/api/users/set-role` | One-time role assignment |
| POST | `/api/users/fcm-token` | Save push notification token |
| GET | `/api/pets` | List own pets |
| POST | `/api/pets` | Create pet |
| PUT | `/api/pets/:id` | Update pet |
| GET | `/api/pets/:petId/records/:type` | Get health records |
| POST | `/api/pets/:petId/records/:type` | Add health record |
| GET | `/api/bookings` | List own bookings |
| POST | `/api/bookings` | Create booking (triggers dispatch) |
| PUT | `/api/bookings/:id/status` | Cancel booking |
| POST | `/api/bookings/:id/rate` | Rate completed booking (+50 pts) |
| GET | `/api/bookings/:id/tracking` | Live tracking data |
| GET | `/api/loyalty` | Loyalty balance + transactions |
| POST | `/api/loyalty/redeem` | Redeem 1,000 pts for coupon |
| GET | `/api/services/catalog` | Live pricing catalog |
| GET | `/api/payments/config` | Razorpay key (inactive until LLC) |

#### Professional (JWT required, role: professional)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/professionals/me` | Own professional profile |
| PUT | `/api/professionals/me` | Update profile |
| PUT | `/api/professionals/availability` | Set available true/false |
| GET | `/api/bookings/incoming` | Offered bookings awaiting response |
| POST | `/api/bookings/:id/respond` | Accept or reject a booking |
| POST | `/api/bookings/:id/on-my-way` | Start journey → status: on_the_way |
| POST | `/api/bookings/:id/location` | Stream GPS position |
| GET | `/api/professionals/earnings` | Own earnings summary |

#### Admin (JWT required, role: admin)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/stats` | Platform-wide stats |
| GET | `/api/admin/users` | Paginated user list with search |
| GET | `/api/admin/pending-verifications` | Pros awaiting review |
| PUT | `/api/admin/verify/:id` | Approve / reject professional |
| PUT | `/api/admin/users/:id/suspend` | Suspend a user |
| DELETE | `/api/admin/users/:id` | Delete a user |
| GET | `/api/admin/health` | Full internal health check |
| GET | `/api/admin/db-audit` | DB consistency audit |
| GET | `/api/admin/revenue-report` | Revenue by professional |

---

## 8. Background Jobs

All cron jobs run in-process via `setInterval` in `server.js`.

| Job | Interval | What it does |
|-----|----------|-------------|
| Booking timeout | 2 min | Advances timed-out `offered` bookings to next professional |
| Suspended user cleanup | 1 hour | Deletes users suspended >24 hours (emails admin first) |
| OTP cleanup | 1 hour | Deletes expired/verified rows from `otp_tokens` |

> ⚠️ If Cloud Run scales to multiple instances, cron jobs will run on each instance simultaneously. This is idempotent for cleanup jobs but may cause double-dispatch in edge cases for the booking timeout job. Solution: use a distributed lock (future work).

---

## 9. Common Mistakes

| Mistake | Consequence | Rule |
|---------|-------------|------|
| Using `select('*')` on a table then returning the response directly | PII / internal fields leak to client | Always select only needed columns, or run through `stripFinancials` |
| Adding a new financial column without updating `stripFinancials` | SPs see customer pricing | Update `stripFinancials` for every new financial field |
| Returning customer phone to professional before booking is accepted | RBAC violation, enables off-platform contact | See `offerBookingToPro` — phone only shared post-acceptance |
| Setting `E2E_TEST_EMAIL_DOMAIN` in production Cloud Run | Anyone can login with `123456` OTP | Guarded by `IS_PROD` but still — never set it in prod |
| Using `innerHTML` with any server-supplied value | XSS | Use `textContent` or DOM API — see `TrackingMapMapbox.jsx` for the pattern |
| Hard-coding UUIDs, phone numbers, or emails in source | Real data in public repo | Use env vars for all test credentials |
| Calling admin endpoints without `adminOnly` middleware | Any logged-in user can reach admin data | Every `/api/admin/*` route must have `auth, adminOnly` |
