# PETclub — Product Requirements Document (PRD)

**Status:** Living document. Reflects the product as of 2026-07-27.
**Owner:** Saikrishna Kolanupaka (Founder & CEO)

---

## 1. Product Vision

PETclub is the operating system for pet ownership: one app where a pet owner
books grooming, veterinary care, training, walking, and boarding — with live
GPS tracking, verified professionals, and a permanent digital record for
every pet — across both India and the USA.

**The problem:** pet care today is fragmented (Google, Instagram DMs, phone
calls to find a provider), manual (phone-call/WhatsApp/paper-diary booking,
prone to no-shows and double-bookings), and opaque (no visibility once you
hand your pet over — no live location, no service history, no proof of
verification).

**The bet:** the same wedge that made Urban Company a category winner in
Indian home services — trust infrastructure (verification, live tracking,
loyalty) layered over a fragmented offline service category — works for pet
care, and nobody has built it as a single cross-service platform in either
market yet.

## 2. Target Users

| Persona | Need |
|---|---|
| **Pet owner (customer)** | Book a trustworthy provider fast, know their pet is safe in real time, not re-explain their pet's history every time. |
| **Service professional** | Steady bookings without paying for leads, fair/transparent payout, tools that beat a paper diary. |
| **Platform admin (founder today)** | Verify professionals, resolve disputes, see revenue and health of the marketplace in one place. |

## 3. Current State — What's Live Today

Live in production at `mypetclub.app` (marketing), `app.mypetclub.app`
(product, React PWA), `api.mypetclub.app` (backend), across India and the USA
with region-aware currency/pricing.

### 3.1 Core features (shipped)
- **5 services**: Grooming, Vet Care, Training, Dog Walking, Pet Boarding.
- **Booking engine**: atomic creation (single DB transaction — a booking and
  any coupon redemption succeed or fail together, no partial state), fair
  round-robin dispatch to nearby available professionals (haversine distance
  + city fallback), 5-minute accept/reject window with auto-reassignment.
- **Live GPS tracking**: Server-Sent Events, DB-diff based (professional
  posts location → DB update → customer's open SSE connection gets the diff
  within ~3s). Styled as "Ola/Rapido-style" live tracking.
- **Loyalty program**: "PETclub Credits" — 1 credit per $1 (or ₹10) spent,
  +50 for a review, +200 for a referral, 1,000 credits = 1 free Essential
  Bath, redeemed as an auto-applied coupon.
  Anti-abuse: server-side anomaly detection flags any user earning >600
  points in 24h for admin review.
- **Pet profiles**: per-pet digital record (breed, age, health notes, photo)
  plus service-specific history (grooming/training/vet records) that
  persists across every booking, regardless of provider.
- **Dual-market pricing**: every service has an India (₹) and USA ($) price,
  chosen automatically by the customer's phone country code, overridable via
  a region toggle. Region-aware copy elsewhere (support hours in customer's
  timezone, "Dallas" vs "Hyderabad" address placeholders, etc.).
- **Professional tools**: online/offline availability toggle, incoming
  request queue, earnings dashboard, weekly payout requests, in-app chat
  with the customer per booking.
- **Admin dashboard**: user management, professional verification queue,
  revenue reports (platform take split by service type), DB audit/cleanup
  tools, loyalty anomaly review, payout processing.
- **WhatsApp AI concierge**: Claude-powered assistant answering pricing,
  policy, and service questions over WhatsApp, backed by a static fallback
  menu when unconfigured. Env-gated (see §7, Tier 0 — shipped).
- **Notifications**: push (FCM) + email, booking-lifecycle reminders (24h,
  5h, 2h, 1h before service) delivered on every channel the customer has on
  file, with claim-based idempotency so no reminder ever sends twice.
- **Pet care reminders**: proactive vaccination/checkup nudges based on
  `vet_records.next_due`.

### 3.2 Revenue model (current)
- **Booking commission**: 70/30 provider/platform split for Groomers,
  45/55 for all other service types (env-configurable).
- **Payments**: Razorpay (India) + Stripe (USA) integration is built and
  tested but **not yet activated in production** — pending US entity (LLC)
  registration. Bookings currently flow with "payment collected at service."

### 3.3 Policy (current, as of this session)
- Free cancellation up to **1 hour** before the appointment; flat fee after
  (₹300 India / $5 USA), capped at the booking total.
- Free reschedule up to **2 hours** before the appointment; not available
  after that (enforced server-side).
- Professional-initiated cancellation: always a full refund, no fee, and the
  booking is automatically re-dispatched to the next available professional.

## 4. Future Enhancements — Prioritized

Ranked by leverage at the current stage (pre-scale, solo-founder-built).
Full technical detail in `TRD.md`; phased timeline in
`IMPLEMENTATION_PLAN.md`.

### Tier 0 — AI Concierge Activation — **SHIPPED 2026-07-27**
Turn on the already-built WhatsApp AI concierge with proper guardrails
(cost-capped rate limiting, prompt-accuracy regression tests, SLO metric).
Caught and fixed a real pricing-accuracy bug before it reached customers.

### Tier 1 — Deliver on the stated ML scope (next)
- **Smart pro-matching**: rank the eligible pro pool (rating, response
  rate, service-specialty fit) instead of pure round-robin, measured against
  the existing `dispatch_offer` SLO.
- **Personalized recommendations v1**: beyond "Book Again," rank multiple
  pros per customer once there's enough interaction data.

### Tier 2 — Ops efficiency (trigger: real pro-application volume)
- **Automated document pre-screening**: vision-model pass on ID/certification
  uploads to speed up the 48-hour manual review — pre-screen, not replace,
  human approval.

### Tier 3 — Strategic, longer horizon
- **Pet insurance referral partnership**: distribute a licensed partner's
  pet insurance product through the app (referral/commission model, not
  underwriting) — targets the fast-growing, underpenetrated urban-India
  pet-insurance market. Uses the pet health-record data already collected as
  the targeting signal. Second revenue line beyond marketplace take-rate.
- **Payments activation**: flip on Razorpay/Stripe once the US entity is
  registered — infra is built and tested, this is a business/legal gate,
  not an engineering one.
- **Native mobile** (Expo/React Native): repo exists (`petclub-mobile`),
  web PWA is the primary surface today.

### Explicitly out of scope (do not build)
- **Dynamic/surge pricing** — contradicts the "transparent pricing, no
  hidden fees" claim already made in-product and in marketing copy.
- **Autonomous AI booking** — the concierge may inform and link to the app;
  it must never create, confirm, or modify a booking on a customer's behalf.
  Every booking must go through the atomic-transaction path with explicit
  terms acceptance.
- **Predictive health-risk modeling** — needs longitudinal pet-health data
  the platform doesn't have yet at any meaningful volume.

## 5. Success Metrics (SLOs)

Instrumented today via `services/metrics.js`, exposed at
`GET /api/metrics` (see `docs/OBSERVABILITY.md` for full detail):

| Metric | Target |
|---|---|
| Booking success rate | ≥ 99% |
| Dispatch accept rate | ≥ 60% (tune with data) |
| Notification delivery rate | ≥ 98% |
| Concierge reply success rate | tracked, no hard target yet — new metric |

## 6. Non-Goals

- Not a pet e-commerce/marketplace (food delivery exists as a stubbed
  category, not a build priority).
- Not competing on price — competing on trust (verification, tracking) and
  breadth (one app, five services, one pet profile).
- Not building enterprise/B2B features (SSO, multi-tenancy, SCIM) at this
  stage — this is a consumer marketplace; revisit only if a real B2B channel
  (e.g., vet clinic SaaS) becomes concrete.

## 7. Open Questions

- Exact go-to-market sequencing: which single metro launches first in each
  market (liquidity strategy explicitly favors depth over breadth pre-scale).
- Whether the insurance referral partnership requires PoSP/Corporate Agent
  registration in India, or can launch as a pure marketing referral —
  needs a compliance consult before building (see `IMPLEMENTATION_PLAN.md`).
- Timing of native mobile investment vs. continued PWA-only.
