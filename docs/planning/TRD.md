# PETclub — Technical Requirements Document (TRD)

**Status:** Living document. Reflects the codebase as of 2026-07-27.
**Companion docs:** `PRD.md` (what/why), `APP_FLOW.md` (user/system flows),
`DATABASE_SCHEMA.md` (data model), `IMPLEMENTATION_PLAN.md` (sequencing),
`OBSERVABILITY.md` (SLOs/metrics in detail).

---

## 1. Architecture Overview

```
┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ petclub-website      │   │ petclub-app            │   │ petclub-mobile       │
│ Vite + React          │   │ React PWA               │   │ Expo (React Native)  │
│ Vercel · mypetclub.app│   │ Vercel · app.mypetclub. │   │ repo exists, PWA is   │
│ marketing/SEO         │   │ app · booking, tracking,│   │ primary surface today│
│                        │   │ loyalty, admin, pro UI  │   │                       │
└───────────┬───────────┘   └───────────┬────────────┘   └──────────────────────┘
            │                            │
            │        HTTPS / REST + SSE  │
            └────────────┬───────────────┘
                          ▼
              ┌───────────────────────────┐
              │ petclub-backend             │
              │ Express (Node.js)            │
              │ Cloud Run · api.mypetclub.app│
              │ us-west1 (co-located with    │
              │ Supabase for latency)        │
              └──────────────┬────────────────┘
                              │
              ┌───────────────┼────────────────┬─────────────┬──────────────┐
              ▼               ▼                ▼             ▼              ▼
        ┌──────────┐   ┌────────────┐   ┌────────────┐ ┌──────────┐ ┌─────────────┐
        │ Supabase  │   │ Anthropic   │   │ Twilio      │ │ Firebase │ │ Razorpay /   │
        │ Postgres  │   │ Claude       │   │ SMS/WhatsApp│ │ FCM push │ │ Stripe       │
        │ (+RLS,    │   │ (concierge)  │   │             │ │          │ │ (built, not  │
        │ Realtime) │   │              │   │             │ │          │ │ activated)   │
        └──────────┘   └────────────┘   └────────────┘ └──────────┘ └─────────────┘
```

### 1.1 Backend module structure (in progress: modular-monolith decomposition)
- `server.js` — still the dominant file (~5,500+ lines); route handlers not
  yet extracted are here. **Do not grow this further** — new endpoints
  should be added as router-factory modules (see `routes/README.md`).
- `routes/` — extracted domains, dependency-injected router factories.
  Currently: `geo.js`, `services.js`. Extraction is incremental and
  behavior-preserving (tests green at every step) — continue this pattern
  for any new domain of >3 related endpoints.
- `services/` — business logic, no HTTP concerns:
  `revenueService.js` (split/cancellation math), `loyaltyService.js`,
  `pricingCatalog.js` (single source of truth for prices),
  `conciergeService.js` (AI concierge), `retry.js` (transient-failure
  backoff), `metrics.js` (SLO instrumentation), `pgRateLimitStore.js`
  (Postgres-backed rate limiting, works across Cloud Run's multiple
  instances), `refreshTokenService.js`, `emailService.js`,
  `stripeService.js`, `db.js` (soft-delete-safe query helpers).

### 1.2 Why these specific choices (don't relitigate without new evidence)
- **Cloud Run over Kubernetes**: right-sized for current scale; `min-instances=1`
  keeps SSE tracking connections warm without cold-start penalty.
- **SSE over WebSockets for live tracking**: survives Cloud Run's
  multi-instance scaling because state lives in Postgres (DB-diff polling),
  not in-instance memory — a prior WebSocket-based design would have broken
  under horizontal scaling. Ceiling: hundreds of concurrent tracking
  sessions before DB poll load becomes a bottleneck; upgrade path is
  Supabase Realtime (near-zero new infra, already on Supabase).
- **Modular monolith over microservices**: solo-founder team; microservices
  would add distributed-systems complexity with zero present benefit.
- **JavaScript, not TypeScript**: acknowledged debt, not a blocker at
  current team size. Migrate incrementally once there's a second engineer
  who needs the guardrails, not before.

## 2. Non-Functional Requirements

### 2.1 Reliability
- **Atomicity**: any operation touching money or inventory-like state
  (booking creation + coupon redemption, loyalty balance changes) must be a
  single Postgres transaction (RPC function), never multiple sequential
  application-level writes. Precedent: `create_booking_atomic`.
- **Idempotency**: anything that can be safely re-triggered by a retrying
  cron or a flaky network call must use claim-before-act (INSERT with a
  UNIQUE constraint, check for `23505` conflict = already done). Precedent:
  `booking_reminder_log`, loyalty review-bonus unique index.
  **Every future recurring job (cron or webhook-driven) must follow this
  pattern — do not add a new reminder/notification type without it.**
- **Retry**: outbound calls to third parties (Twilio, Anthropic, FCM) must
  use `services/retry.js`'s `withRetry()` — transient-only, exponential
  backoff, never retries permanent (4xx) failures.
- **Soft-delete safety**: `users`, `bookings`, `pets` use `deleted_at`.
  Reads must go through `services/db.js`'s `activeSelect()` helper or the
  `active_users`/`active_bookings`/`active_pets` Postgres views — never a
  raw `.select()` that can leak soft-deleted rows into reports/audits.

### 2.2 Security
- Secrets live in GCP Secret Manager, referenced via `--update-secrets` on
  the Cloud Run service — never plaintext in `cloudbuild.yaml`.
  **Known gap**: several vars (`HEALTH_SECRET`, `TWILIO_*`) are still plain
  env vars on the service, not yet migrated — see `IMPLEMENTATION_PLAN.md`.
- Rate limiting is Postgres-backed (`PgRateLimitStore`) so limits hold
  across all Cloud Run instances, not per-instance. **Every limiter needs
  its own store prefix** (`rl:otp`, `rl:booking`, `rl:concierge`, etc.) —
  a shared prefix was a real production bug (cross-limiter interference)
  fixed earlier.
- **Webhook-sourced requests must never be rate-limited by IP** — Twilio
  (and any future webhook source) originates from the provider's
  infrastructure, not the end user. Key by the actual user identifier from
  the payload (e.g., WhatsApp `From` number) instead.
- JWT in httpOnly cookies, 15-minute access token, refresh-token rotation.
  E2E test-account bypass is explicitly excluded for `role === 'admin'` —
  never weaken this exclusion.

### 2.3 Observability
Three SLOs today (booking success, dispatch accept, notification delivery),
a fourth just added (concierge reply outcome). Pattern for any new
user-facing critical path: emit a `metrics.record(logger, name, outcome,
labels)` call, no PII in labels, document it in `OBSERVABILITY.md`'s metric
catalogue table.

### 2.4 AI-specific requirements (new as of Tier 0 — apply to all future AI work)
- **No hardcoded facts that exist elsewhere in the codebase.** The
  concierge's system prompt computes prices from `pricingCatalog.js` at
  load time specifically because a hardcoded copy drifted into a real
  pricing-accuracy bug. Any future AI feature referencing product facts
  (policy, pricing, service list) must derive them from the same source of
  truth the rest of the app uses, not a second hardcoded copy.
- **Human-in-the-loop for anything money- or state-changing.** An LLM may
  inform, recommend, or draft — it must never independently execute a
  booking, cancellation, refund, or verification approval.
- **Eval before deploy.** Any prompt change needs to pass its eval script
  (pattern: `scripts/concierge-eval.js`) before shipping. Not part of CI
  (needs a real API key, costs money) — a deliberate manual gate.
- **Cost containment.** Any new LLM-backed endpoint needs its own
  rate limiter, keyed correctly for its trigger source (see §2.2).

## 3. Technical Requirements — Future Enhancements

### 3.1 Smart pro-matching (Tier 1)
- **Approach**: re-rank the *already-eligible* pool (same city/radius
  filter as today) by a weighted score — do not replace the fairness
  rotation (`last_assigned_at`) wholesale, blend it in as one factor so
  professionals aren't starved of bookings by a ranking model.
- **Inputs available today**: `professional_profiles.rating`,
  `total_reviews`, haversine distance (`address_lat/lng`), `sub_role`
  (service specialty match).
- **Inputs NOT yet available** (build if the model needs them):
  per-pro response-rate/response-time (derivable from
  `booking_assignments.offered_at`/`responded_at` — no new table needed,
  just an aggregation query or a materialized stat column).
- **V1 = rules-based scoring function**, not a trained model — there isn't
  enough booking volume yet to train anything meaningful. Upgrade to
  learned weights only once there's real data.
- **Measurement**: the existing `dispatch_offer` SLO (`success` vs
  `reject`) is the direct before/after signal — no new metric needed to
  prove impact.

### 3.2 Personalized recommendations (Tier 1)
- V0 already exists functionally ("Book Again" button).
- V1 needs a `recommendation_log`-style table (see `DATABASE_SCHEMA.md`
  §2.1) to track what was shown/clicked, both to power "similar pros" logic
  later and to eval the feature itself.
- Do not build a cross-customer collaborative-filtering model before there's
  enough booking density for it to outperform "recommend the pro they used
  last time + highest-rated alternative in radius."

### 3.3 Automated document pre-screening (Tier 2)
- Vision-model pass (Claude with image input, or a dedicated OCR/vision API)
  on `id_documents.doc_front/doc_back/doc_selfie` and `cert_photo_url` —
  checks legibility, expiry-date extraction, basic face-match confidence.
- **Must remain pre-screen only** — output is a confidence score/flag
  surfaced to the admin verification queue, never an auto-approve. The
  `professional_profiles.verification_status` transition to `'approved'`
  must stay a human action.
- Needs a new `document_review_results` table (see `DATABASE_SCHEMA.md`).
- **Trigger to build**: only once pro-application volume makes the 48-hour
  manual review a measured bottleneck — check `admin_logs` for verification
  action frequency before prioritizing this.

### 3.4 Insurance referral partnership (Tier 3)
- **Integration shape**: outbound referral link/embedded quote widget from
  an already-licensed insurtech partner (e.g., Riskcovry/Symbo-style API) —
  PETclub does not underwrite or hold an insurance license.
- Needs a `insurance_referrals` table to track referral events for
  commission reconciliation (see `DATABASE_SCHEMA.md`).
- Surfaces: pet profile page (once health records exist), post-vet-booking
  completion screen (highest-intent moment).
- **Compliance gate, not an engineering gate**: confirm with counsel whether
  the referral model requires PoSP/Corporate Agent registration in India
  before any UI ships — do not build the integration ahead of this answer.

### 3.5 Payments activation (Tier 3)
- No new engineering — `stripeService.js` and the Razorpay integration are
  built and tested (`/api/payments/*` routes exist, webhook handlers exist).
  This is gated on US entity registration, purely a business/legal
  dependency. When ready: flip the "payment collected at service" copy,
  confirm webhook secrets are in Secret Manager, run a live small-value
  transaction test in both currencies before announcing.

### 3.6 Cross-cutting technical debt (do alongside the above, not instead of)
- **Finish Secret Manager migration**: `HEALTH_SECRET`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` still plain env vars on the
  live Cloud Run service as of this writing. `TWILIO_WHATSAPP_FROM` isn't
  set at all — the AI concierge's inbound webhook wiring in Twilio's own
  console still needs verification/completion (see `IMPLEMENTATION_PLAN.md`).
- **Continue `server.js` decomposition** — extract the next-largest domain
  (bookings or admin) into a router-factory module, same pattern as
  `routes/geo.js`/`routes/services.js`.
- **Caching layer (Redis/Memorystore)**: not needed yet, but the trigger is
  concrete — once concurrent GPS-tracking sessions or booking-list reads
  show measurable Postgres load in Cloud Monitoring, add it then, not
  speculatively.
- **TypeScript migration**: sequence after the next engineering hire, not
  before — the ROI is in onboarding/velocity for a team, not solo output.

## 4. API Design Conventions

- REST under `/api/*`, resource-oriented (`/api/bookings/:id/status`, not
  RPC-style endpoint names) — keep new endpoints consistent with this.
- All mutating endpoints require `auth` middleware except OTP send/verify
  and the Twilio webhook (which has its own signature verification).
- Every list endpoint that touches `bookings`/`users`/`pets` must use the
  active-row-safe read pattern (§2.1).
- Financial response fields (`platform_fee`, `provider_earnings`,
  `gateway_fee`) are stripped from professional-facing responses via
  `stripFinancials()` — never expose platform economics to the supply side.

## 5. Infrastructure & Deployment

- CI/CD: `cloudbuild.yaml` → Cloud Run, triggered on push to `main`.
  `semantic-release` manages versioning/changelog.
- DB migrations: Supabase CLI, `supabase/migrations/` — **never hand-paste
  SQL into the Supabase dashboard again**; this was a real risk closed
  earlier (see `supabase/README.md` + `HISTORY.md` for the pre-CLI history).
- Cron: GitHub Actions (`.github/workflows/cron.yml`), hourly + daily +
  weekly jobs hitting `/api/cron/*` endpoints, each gated by
  `X-Cron-Secret`.
- Region: `us-west1` (Cloud Run), co-located with Supabase (AWS us-west-2)
  to minimize DB round-trip latency.
