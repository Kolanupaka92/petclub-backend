# PETclub — Implementation Plan

**Status:** as of 2026-07-27, post YC application submission.
**Companion docs:** `PRD.md`, `TRD.md`, `APP_FLOW.md`, `DATABASE_SCHEMA.md`.

Sequencing principle carried through this whole plan: **liquidity and real
bookings outrank every item below.** Nothing here should consume more than
a few days at a time without checking back against actual usage — a
pre-traction marketplace's highest-leverage work is almost never more
engineering.

---

## Phase 0 — AI Concierge Activation — ✅ DONE (2026-07-27)

| Item | Status |
|---|---|
| Rate limiter (`rl:concierge`, keyed by WhatsApp number) | ✅ Shipped |
| Pricing computed from `pricingCatalog.js`, not hardcoded | ✅ Shipped (fixed a real pricing bug in the process) |
| Cancellation/reschedule policy text corrected | ✅ Shipped |
| `concierge_reply` SLO metric | ✅ Shipped |
| Eval harness (`scripts/concierge-eval.js`) | ✅ Shipped |
| `ANTHROPIC_API_KEY` in Secret Manager, wired to Cloud Run | ✅ Done |
| **Twilio-side webhook wiring** | ⚠️ **BLOCKED — see below** |

### Immediate follow-up (before Phase 0 is truly complete)
Testing revealed the WhatsApp number displayed everywhere in-product
(`+1 609 721 5754`) does not match `TWILIO_PHONE_NUMBER` on the live
service (`+1 855 696 5767`), and `TWILIO_WHATSAPP_FROM` is unset. No
inbound webhook traffic has been observed at all. **Action needed:**
1. Check Twilio Console → Messaging → Senders → WhatsApp senders — confirm
   which number is actually WhatsApp-enabled and what its inbound webhook
   URL is set to (must be `https://api.mypetclub.app/api/whatsapp/inbound`).
2. Set `TWILIO_WHATSAPP_FROM` to match once identified.
3. Re-test end to end.

### Security follow-up (unrelated to the above, surfaced during this work)
`TWILIO_AUTH_TOKEN` was accidentally exposed in a debugging session — **rotate it** in Twilio Console → Account → API keys & tokens, then update wherever it's configured on Cloud Run.

## Phase 1 — Smart Matching & Recommendations (next engineering priority)

**Trigger to start:** not gated on volume — this improves quality on day
one, unlike Tier 2/3 which need real usage to justify.

| Task | Effort | Notes |
|---|---|---|
| Add `response_rate_30d`/`avg_response_seconds_30d` to `professional_profiles` (or compute on-demand first) | 0.5–1 day | Start on-demand; only materialize if query cost becomes measurable |
| Rules-based ranking function layered on existing round-robin | 2–3 days | Blend distance + rating + response-rate + specialty match; must not starve low-rotation pros — fairness stays a factor, not replaced |
| Wire into `findNextPro()` dispatch path | 1 day | Behavior-preserving extraction into `routes/` while touching this code, per the ongoing decomposition pattern |
| Measure against existing `dispatch_offer` SLO | — | No new metric needed — before/after on the existing one is the proof |
| `recommendation_log` table (§2.1 of `DATABASE_SCHEMA.md`) | 0.5 day | Only if/when recommendations become a distinct trackable surface beyond dispatch ranking |

**Total: ~1 week of engineering.** Do this incrementally, tests green at
every step (same discipline as the reliability work already shipped this
session).

## Phase 2 — Automated Document Pre-Screening

**Trigger to start:** do NOT build ahead of need. Check
`admin_logs` for verification-action frequency and time-to-approve first —
only prioritize this once the 48-hour manual review is a *measured*
bottleneck (real applications queuing), not a hypothetical one.

| Task | Effort | Notes |
|---|---|---|
| `document_review_results` table | 0.5 day | See `DATABASE_SCHEMA.md` §2.2 |
| Vision-model integration (Claude image input or dedicated OCR API) | 3–4 days | Pre-screen only — confidence score + flags surfaced to admin queue |
| Admin UI surface for flagged documents | 1–2 days | Existing admin dashboard, new panel |
| **Explicit non-goal**: auto-approve | — | `verification_status → 'approved'` transition stays a human action, permanently |

**Total: ~1 week, once triggered.**

## Phase 3 — Insurance Referral Partnership

**Trigger to start:** compliance answer first, engineering second.

| Task | Effort | Notes |
|---|---|---|
| **Compliance consult**: does a pure referral link require PoSP/Corporate Agent registration in India? | N/A — legal, not engineering | Do not build UI ahead of this answer |
| Select partner (Riskcovry/Symbo-style embeddable quote flow) | research | Evaluate 2-3, prioritize ones with a simple referral-commission API |
| `insurance_referrals` table | 0.5 day | See `DATABASE_SCHEMA.md` §2.3 |
| Surface: pet profile card (once health records exist) | 1 day | |
| Surface: post-vet-booking-completion nudge | 1 day | Highest-intent moment |
| Commission reconciliation (manual at first, automate once volume justifies) | — | Don't build a full webhook reconciliation pipeline before there's a single real referral to reconcile |

**Total: ~1 week of engineering, gated on an unknown-length compliance step.**

## Phase 4 — Payments Activation

**Trigger to start:** US entity (LLC) registration complete.

| Task | Effort | Notes |
|---|---|---|
| Confirm Stripe/Razorpay webhook secrets in Secret Manager | 0.5 day | Not `cloudbuild.yaml` plaintext |
| Flip "payment collected at service" copy across app/website/deck | 0.5 day | Multiple surfaces already audited this session — re-check each |
| Live small-value transaction test, both currencies | 0.5 day | Before any public announcement |
| Update pitch deck business-model slide status line | 0.25 day | Already flagged there as "ready to switch on" |

**Total: ~2 days, purely execution once the legal gate clears.**

## Cross-Cutting Technical Debt (interleave with the above, don't block on it)

| Item | Priority | Trigger |
|---|---|---|
| Finish Secret Manager migration (`HEALTH_SECRET`, `TWILIO_*`) | Medium | Do alongside the Phase 0 Twilio fix — you'll already be in that config |
| Continue `server.js` decomposition (bookings or admin domain next) | Low-Medium | Opportunistic — do it when touching that code for a feature, not as a standalone sprint |
| Redis/Memorystore caching layer | Low | Concrete trigger: Cloud Monitoring shows measurable Postgres load from concurrent tracking/booking reads — not before |
| TypeScript migration | Low | Sequence after the next engineering hire |
| Normalize `booking_messages.booking_id` to `uuid` + real FK | Low | Opportunistic, low risk, do in a quiet week |

## What Explicitly Does NOT Get a Phase

Per `PRD.md` §4 non-goals — revisit only if a specific, real business reason
emerges, not proactively:
- Dynamic/surge pricing
- Autonomous AI booking (concierge stays inform-only, permanently)
- Predictive health-risk modeling (no data to support it yet)
- B2B/enterprise features (SSO, multi-tenancy)
- Native mobile investment beyond the existing `petclub-mobile` repo, until
  PWA usage data suggests it's the actual bottleneck to growth

## Sequencing Summary

```
NOW        Phase 0 follow-up: fix Twilio wiring, rotate exposed token  (days)
NEXT       Phase 1: Smart matching & recommendations                  (~1 week)
GATED      Phase 4: Payments activation                                (~2 days, waits on LLC)
GATED      Phase 2: Doc pre-screening                                  (~1 week, waits on volume)
GATED      Phase 3: Insurance referral                                 (~1 week, waits on compliance answer)
ONGOING    Tech debt, interleaved opportunistically, never blocking    (—)
```

The two "GATED" phases with external dependencies (LLC, compliance
consult) should be **kicked off in parallel now** even though the
engineering waits — the legal/business clock is the actual critical path
for both, not the code.
