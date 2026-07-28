# PETclub — Database Schema

**Status:** Pulled directly from the live Supabase project
(`zjrgbsrsthtmxkislgcm`) on 2026-07-27 — this is the real schema, not a
design doc. 26 tables, RLS enabled on all (backend uses `service_role`,
which bypasses RLS by design — RLS is defense-in-depth, see
`supabase/migrations/`).

**Migration workflow**: Supabase CLI, files in `supabase/migrations/`.
Never hand-paste SQL into the dashboard — see `supabase/README.md`.

---

## 1. Current Schema, by Domain

### 1.1 Identity & Access

**`users`** — every person on the platform (customer, professional, admin).
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| phone | text NOT NULL | primary login identity |
| name, email | text | |
| role | text, default `'customer'` | `customer` \| `professional` \| `admin` \| `pending_role` |
| is_active | boolean, default true | suspension flag |
| fcm_token | text | push notification target |
| loyalty_points | integer, default 0 | denormalized balance (source of truth is `loyalty_transactions`) |
| referral_code, referred_by_code | text | |
| partner_source, commission_paid | text, boolean | referral-partner attribution |
| deleted_at | timestamptz | soft delete |

**`customer_profiles`** (1:1 `users`) — address, KYC fields
(`id_doc_type/number/photo_url` — legacy; ID verification for customers has
since been simplified, see `PRD.md` honesty-pass notes), lat/lng/postal for
geocoded address.

**`professional_profiles`** (1:1 `users`) — the supply side.
Key columns: `sub_role` (Groomer/Trainer/Vet/Walker/Boarding),
`verification_status` (default `'pending'`), `is_available` (online/offline
toggle), `rating`/`total_reviews`, `last_assigned_at` (drives fair
round-robin dispatch), `address_lat/lng` (drives haversine matching),
`price_basic/full/custom` (legacy pricing hints — actual pricing is
`pricingCatalog.js`, platform-owned).

**`id_documents`** (N:1 `professional_profiles` via `prof_id`) — ID + cert
upload: `id_type/id_num/doc_front/doc_back/doc_selfie/cert_type/cert_photo_url`.

**`refresh_tokens`** (N:1 `users`) — rotation family tracking:
`token_hash`, `family` (uuid — a family is revoked together on reuse
detection), `expires_at`, `revoked_at`.

**`otp_tokens`** — phone/email OTP verification, standalone (keyed by
`phone`, which doubles as email for email-OTP flow), hashed `otp`,
`expires_at`, `verified`.

### 1.2 Pets & Records

**`pets`** (N:1 `users` via `owner_id`) — the portable pet profile:
`name, species, breed, age, dob, weight, gender, color, chip, health_notes,
photo_url`. `deleted_at` for soft delete.

**`grooming_records`**, **`training_records`**, **`vet_records`**,
**`food_orders`** — all N:1 `pets`, one table per service type, each
capturing service-specific history (`vet_records` additionally has
`vtype`/`next_due` — powers the care-reminders cron).

### 1.3 Bookings & Dispatch

**`bookings`** — the core transactional table (50 columns; grew
organically, candidate for the next `server.js`-style decomposition pass
if it keeps growing). Key groups:
- **Parties/service**: `customer_id`→users, `professional_id`→professional_profiles,
  `pet_id`→pets, `service_type`, `service_name`, `pet_size`.
- **Scheduling**: `scheduled_at`, `city`, `address`, `address_lat/lng`.
- **State machine**: `status` (default `'upcoming'`), `assignment_status`
  (default `'searching'` → `offered` → `confirmed` / `no_pros_available`),
  `response_deadline`.
- **Live tracking**: `pro_lat/lng`, `pro_location_updated_at`.
- **Money**: `amount`, `total_amount`, `platform_fee`, `provider_earnings`,
  `gateway_fee`, `petclub_offer_amount`, `currency` (default `'INR'`),
  `payment_status`, `payout_status`/`payout_reference`,
  `razorpay_order_id/payment_id`.
- **Cancellation/reschedule**: `cancelled_by`, `cancelled_at`,
  `cancellation_fee`, `cancellation_reason`, `refund_amount`,
  `refund_status` (default `'not_applicable'`), `rescheduled_from`.
- **Loyalty/coupon**: `is_loyalty_redemption`, `coupon_code_used`.
- **Legal**: `terms_version`, `terms_accepted_at`.
- **Ops**: `service_notes`, `ten_min_notified`, `deleted_at`.

**`booking_assignments`** (N:1 `bookings`, N:1 `professional_profiles`) —
the dispatch offer log: `status` (default `'offered'`), `offered_at`,
`responded_at`, `response_deadline`. One row per pro an offer was extended
to — this is what makes round-robin fairness and reassignment auditable.

**`booking_messages`** — in-booking chat between customer and pro.
Note: `booking_id` is `text`, not `uuid` FK (schema inconsistency —
worth normalizing to `uuid` + real FK in a future migration).
`sender_id`, `sender_role`, `sender_name`, `content`, `read_at`.

**`booking_reminder_log`** (N:1 `bookings`) — idempotency ledger for the
reminder cron. `checkpoint` (`24h`/`5h`/`2h`/`1h`), `recipient`
(`customer`/`professional`), `channel` (`email`/`push`), unique on
`(booking_id, checkpoint, recipient, channel)` — the claim-before-send
pattern referenced throughout `TRD.md`.

**`reviews`** — `reviewer_id`, `reviewee_id`, `booking_id` (all →
`users`/`bookings`), `rating`, `comment`.

### 1.4 Payments & Revenue

**`payment_logs`** — gateway transaction audit trail: `booking_id`,
`user_id`, `razorpay_order_id/payment_id`, `amount`, `currency`, `status`.

**`payout_details`** (N:1 `professional_profiles`) — payout method:
`payout_type`, `upi_id` (India), `account_name/num/ifsc` (bank).

### 1.5 Loyalty ("PETclub Credits")

**`loyalty_transactions`** — append-only ledger, the actual source of
truth for a user's balance (`users.loyalty_points` is denormalized from
this). `points` (signed int), `type`, `description`, `booking_id`,
`coupon_code`.

**`loyalty_coupons`** — redeemed-credit coupons: `code` (unique),
`user_id`, `service_name` (default `'Basic Bath'`), `discount_pct`
(default 100), `is_used`, `used_booking_id`, `expires_at` (default
`now() + 6 months`).

### 1.6 Subscriptions (built, low usage today)

**`subscription_plans`** — `service_type`, `interval`, `price_inr/usd`,
`discount_pct`, `perks` (jsonb).
**`subscriptions`** (N:1 `users`, N:1 `subscription_plans`) — `status`,
`started_at`, `current_period_end` (default `+1 month`), `provider`/
`provider_sub_id` (gateway subscription reference).

### 1.7 Admin & Ops

**`admin_logs`** — audit trail of every admin action: `admin_id`→users,
`action`, `target_id`, `target_type`, `notes`. 82 rows already — actively
used.

**`notifications`** — in-app notification inbox (separate from
push/email delivery): `user_id`, `title`, `body`, `data` (jsonb),
`read_at`.

**`rate_limits`** — backing store for `PgRateLimitStore`: `key` (includes
the store prefix, e.g. `rl:concierge:<phone>`), `count`, `reset_at`.

**`website_leads`** — marketing-site contact-form submissions, not tied to
a `users` row (pre-signup lead capture).

## 2. Proposed Schema Additions — Future Enhancements

These do not exist yet. Written in the project's actual migration
convention (see `supabase/migrations/20260726000001_booking_reminder_log.sql`
for the template this follows) — copy this shape when actually building
each one, don't hand-paste into the dashboard.

### 2.1 Smart matching / recommendations (Tier 1)

```sql
-- Tracks what was recommended/offered to whom, for both matching-quality
-- eval and future "similar pros" collaborative signal. Not required for
-- the v1 rules-based scoring function (that reads existing columns), but
-- needed the moment recommendations become a distinct, trackable feature.
CREATE TABLE IF NOT EXISTS public.recommendation_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES public.professional_profiles(id) ON DELETE CASCADE,
  context         text NOT NULL, -- 'book_again' | 'similar_pros' | 'ranked_dispatch'
  score           numeric,        -- the ranking score at time of recommendation, if applicable
  shown_at        timestamptz NOT NULL DEFAULT now(),
  clicked_at      timestamptz,
  resulted_booking_id uuid REFERENCES public.bookings(id)
);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_user ON public.recommendation_log(user_id);
```

Optionally, a lightweight materialized stat instead of computing pro
response-rate live on every dispatch:
```sql
-- Refreshed periodically (cron) or computed on-demand — start on-demand,
-- only materialize if it becomes a measured query-time cost.
ALTER TABLE public.professional_profiles
  ADD COLUMN IF NOT EXISTS response_rate_30d numeric,
  ADD COLUMN IF NOT EXISTS avg_response_seconds_30d integer;
```

### 2.2 Automated document pre-screening (Tier 2)

```sql
-- Vision-model pre-screen results for pro verification documents.
-- Human review of professional_profiles.verification_status remains the
-- only path to 'approved' — this table informs, never decides.
CREATE TABLE IF NOT EXISTS public.document_review_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prof_id         uuid NOT NULL REFERENCES public.professional_profiles(id) ON DELETE CASCADE,
  document_field  text NOT NULL, -- 'doc_front' | 'doc_back' | 'doc_selfie' | 'cert_photo_url'
  legible         boolean,
  expiry_detected date,
  confidence      numeric,        -- 0-1, model's own confidence
  flags           jsonb DEFAULT '[]'::jsonb, -- e.g. ["expired", "mismatch", "low_quality"]
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  model_version   text
);
CREATE INDEX IF NOT EXISTS idx_document_review_prof ON public.document_review_results(prof_id);
```

### 2.3 Insurance referral partnership (Tier 3)

```sql
-- Referral events to the insurance partner, for commission reconciliation.
-- PETclub does not underwrite — this table tracks outbound referrals only.
CREATE TABLE IF NOT EXISTS public.insurance_referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  pet_id          uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  partner         text NOT NULL,           -- e.g. 'riskcovry', 'symbo'
  referral_ref    text,                    -- partner's own tracking id, once known
  surfaced_context text NOT NULL,          -- 'pet_profile' | 'post_vet_booking'
  clicked_at      timestamptz NOT NULL DEFAULT now(),
  policy_purchased boolean DEFAULT false,  -- updated via partner webhook/reconciliation, once integrated
  commission_amount numeric,
  commission_status text DEFAULT 'pending' -- 'pending' | 'confirmed' | 'paid'
);
CREATE INDEX IF NOT EXISTS idx_insurance_referrals_user ON public.insurance_referrals(user_id);
```

### 2.4 Notes on existing schema debt (fix opportunistically, not urgently)

- `booking_messages.booking_id` is `text`, should be `uuid` with a real FK
  to `bookings.id` — currently relies on application-level correctness.
- `customer_profiles` carries legacy `id_doc_type/number/photo_url` columns
  from a KYC flow that was simplified — candidate for removal once
  confirmed unused (check `grep -rn "id_doc_type\|id_doc_number" petclub-backend petclub-app` before dropping).
- No `deleted_at` on `professional_profiles`, `bookings.professional_id`
  target, or several other tables that arguably want soft-delete parity
  with `users`/`bookings`/`pets` — audit before assuming safe to hard-delete
  anywhere.
