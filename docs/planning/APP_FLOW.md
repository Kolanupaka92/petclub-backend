# PETclub — App Flow

**Status:** Reflects the codebase as of 2026-07-27. Companion to `PRD.md`
and `TRD.md`.

---

## 1. Actors

| Actor | Surface | Auth |
|---|---|---|
| **Customer** | `app.mypetclub.app` (React PWA) | Phone/email OTP → JWT (httpOnly cookie) |
| **Professional** | Same PWA, role-gated views | Same, `role = 'professional'` |
| **Admin** | Same PWA, admin views | Same, `role = 'admin'` (E2E test-OTP bypass explicitly excluded) |
| **System / Cron** | GitHub Actions → `/api/cron/*` | `X-Cron-Secret` header |
| **Twilio** | `/api/whatsapp/inbound` webhook | Twilio request-signature verification |

## 2. Customer Flow — Signup to Completed Booking

```
Landing page (mypetclub.app or in-app)
   │
   ▼
Choose Sign In / role (customer)
   │
   ▼
Enter phone or email → OTP sent (Firebase for India phone, Twilio SMS/email
   fallback for US or on Firebase failure) → verify OTP → JWT issued
   │
   ▼
New user? → Profile setup (name, address via AddressPicker autocomplete,
   optional first pet) │ Existing user → straight to dashboard
   │
   ▼
Dashboard: "Book a Service" (Grooming / Vet / Training / Walking / Boarding)
   │
   ▼
Booking form (3 steps: Service+Package → Details → Confirm)
   1. Pick package/size (pricing from GET /api/services/catalog,
      region-aware INR/USD)
   2. Pet, date/time, verified address (must select from autocomplete —
      free text is rejected), special notes
   3. Cancellation/reschedule policy shown, terms checkbox required
   │
   ▼
POST /api/bookings
   → create_booking_atomic RPC (booking insert + coupon redemption,
     single transaction)
   → auto-dispatch: findNextPro() — city/radius filter, haversine sort,
     fair round-robin by last_assigned_at
   → offer sent to nearest eligible pro (push + email), 5-min response
     window
   │
   ▼
Customer sees "Pro Notified" (assignment_status = 'offered')
   │
   ├── Pro accepts within 5 min → assignment_status = 'confirmed' →
   │     customer notified (push + email) → booking becomes "upcoming"
   │
   └── Pro rejects / times out → auto-reassign to next eligible pro
         (same offer flow) → if none available → 'no_pros_available',
         admin alerted via Sentry
   │
   ▼
Reminders fire automatically at 24h / 5h / 2h / 1h before scheduled_at
   (push + email, claim-based idempotent — see booking_reminder_log)
   │
   ▼
Day of service:
   Pro marks "On My Way" → live GPS tracking begins (SSE,
   GET /api/bookings/:id/track) → customer sees pro's live position,
   ETA, distance
   │
   ▼
Pro marks service complete (with optional service notes)
   │
   ▼
Customer: loyalty credits auto-awarded, "Rate this session" prompt
   → POST /api/bookings/:id/rate → feeds professional_profiles.rating
   │
   ▼
Pet's service-specific record updated (grooming_records / vet_records /
   training_records) — persists on the pet's profile regardless of which
   pro performed the service
```

### 2.1 Cancellation / reschedule branch
```
Customer taps "Cancel Booking" → GET /api/bookings/:id/cancel-preview
   (live fee/refund calc via calcCancellation()) shown before confirming
   │
   ├── ≥ 1 hour before appointment → full refund, no fee
   └── < 1 hour before / no-show → flat fee (₹300 / $5, capped at total),
         remainder refunded

Customer taps "Reschedule" (hidden client-side, rejected server-side, once
   < 2 hours before the appointment) → new date/time → pro notified
```

## 3. Professional Flow — Application to Payout

```
Landing page → "Join as Pro" → choose sub_role (Groomer/Trainer/Vet/
   Walker/Boarding)
   │
   ▼
OTP verify (same as customer) → profile setup (service area, experience,
   bio, pricing tier hints) → ID + certification upload
   (id_documents: doc_front/back/selfie, cert_type/cert_photo_url)
   │
   ▼
verification_status = 'pending' → admin manually reviews within 48h
   (target) → 'approved' or 'rejected'
   │
   ▼
Approved pro: toggle "Online" (is_available = true) to start receiving
   offers
   │
   ▼
Incoming request queue (GET /api/bookings/incoming) — polled, shows offers
   within the 5-min response window
   │
   ├── Accept → POST /api/bookings/:id/respond {action:'accept'} →
   │     booking confirmed, customer notified, appears in pro's Bookings
   │
   └── Reject → next eligible pro in rotation is offered automatically
   │
   ▼
Day of service: "On My Way" → location posted every ~3s while active
   (POST /api/bookings/:id/location) → "Mark Complete" (+ service notes)
   │
   ▼
Earnings dashboard (GET /api/professionals/earnings) — 70/30 (Groomer) or
   45/55 (other services) split, platform fee and gateway fee never shown
   to the pro (stripFinancials())
   │
   ▼
Weekly payout request (POST /api/professionals/payout) → admin marks paid
   (POST /api/admin/payouts/:profId/mark-paid)
```

### 3.1 No-show branch
```
Pro marks customer no-show at location → same calcCancellation() logic,
   byNoShow=true → fee always applies regardless of timing → customer
   charged, pro's time protected
```

## 4. Admin Flow

```
Admin dashboard (role='admin')
   │
   ├── Pending Verifications → review ID/cert docs → approve/reject pro
   ├── Users → search, edit, suspend, set role, view activity
   ├── Revenue Report → platform take by service type, by period
   ├── Loyalty → award/adjust credits, review anomaly-flagged accounts
   │     (>600 pts/24h auto-flagged)
   ├── Payouts → mark professional payout requests as paid
   ├── DB Audit / Cleanup → soft-delete-safe integrity checks
   └── Refund status management → PUT /api/admin/bookings/:id/refund-status
```

## 5. System / Automated Flows

```
Hourly cron → POST /api/cron/booking-reminders
   → 4 checkpoints (24h/5h/2h/1h before scheduled_at), ±35min match window
   → claim-before-send per (booking, checkpoint, recipient, channel) →
     push + email to customer (whichever channels on file), email to pro

Daily cron → POST /api/cron/care-reminders
   → vet_records.next_due within [now+6d, now+7d] → owner emailed

Daily cron → POST /api/cron/coupon-expiry
   → loyalty_coupons expiring soon → owner notified

Daily cron → POST /api/cron/refresh-leaderboard
   → loyalty leaderboard materialization

Weekly cron → POST /api/cron/payout-summary → admin email digest

Booking-timeout cron → auto-expire unanswered 5-min offer windows,
   trigger reassignment

Auto-delete / hard-purge crons → soft-deleted record lifecycle management
```

## 6. WhatsApp AI Concierge Flow (Tier 0 — shipped)

```
Customer messages the WhatsApp number
   │
   ▼
Twilio POSTs to /api/whatsapp/inbound (signature-verified)
   │
   ▼
rl:concierge rate limit check (20 msgs/hour, keyed by sender's WhatsApp
   number — NOT by IP, since all Twilio traffic shares Twilio's IPs)
   │
   ├── Over limit → TwiML reply: "sent quite a few messages, try again
   │     shortly" (still valid TwiML, not a bare error)
   │
   └── Under limit → concierge.reply(text, {from})
         │
         ├── ANTHROPIC_API_KEY unset → static fallback menu
         │
         └── Configured → Claude call (withRetry, transient-only) →
               system prompt with LIVE prices (computed from
               pricingCatalog.js, never hardcoded) → reply, or fallback
               menu on any error/refusal
   │
   ▼
outcome recorded: concierge_reply.{success|fallback|disabled} metric
   │
   ▼
TwiML response sent back to Twilio → delivered to customer

Guardrail: concierge may inform + link to the app; it must never claim to
   have completed/confirmed/modified a booking itself.
```

## 7. Future Flow Additions (see `IMPLEMENTATION_PLAN.md` for sequencing)

### 7.1 Smart matching (Tier 1)
```
Booking created → eligible pro pool (same filter as today) → NEW: score
   each eligible pro (distance + rating + response-rate + specialty match)
   → offer to highest-scored pro first, same fairness-aware fallback
   sequence on reject/timeout
```

### 7.2 Insurance referral (Tier 3)
```
Pet profile has ≥1 health record OR a vet booking just completed →
   "Protect [pet name]" card shown → tap → outbound to licensed partner's
   quote flow → referral event logged (insurance_referrals table) for
   commission reconciliation
```
