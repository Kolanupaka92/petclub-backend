# PETclub — Billing & Subscription Estimation

> Current subscriptions as of May 2026 · All amounts in USD/month unless noted.

---

## 1. Summary

| Service | Plan | Monthly Cost | Notes |
|---|---|---|---|
| **Vercel** | Hobby (Free) | $0 | 2 projects |
| **Supabase** | Free | $0 | 500 MB DB, 2 GB bandwidth |
| **Google Cloud Run** | Pay-as-you-go | ~$0–$5 | Scales to zero |
| **Google Artifact Registry** | Pay-as-you-go | ~$0.10 | Docker images |
| **Google Cloud Build** | Free tier | $0 | 120 build-minutes/day free |
| **Google Cloud Storage** | Pay-as-you-go | ~$0.02 | Build source tarballs |
| **Firebase** | Spark (Free) | $0 | Phone Auth + FCM |
| **Zoho Mail** | Zoho Workplace | ~$1/user | 1 user = ~$1/mo |
| **Namecheap DNS** | Basic | ~$0.50 | Domain renewal amortized |
| **Razorpay** | Inactive | $0 | Pending LLC registration |
| **TOTAL** | | **~$2–$7/mo** | Lean startup cost |

---

## 2. Detailed Breakdown

### Vercel — $0/month
- **Plan**: Hobby (Free)
- **Projects**: `petclub-app` + `petclub-website`
- **Includes**: 100 GB bandwidth, custom domains, SSL, instant rollbacks
- **Limits**: 100 deployments/day, no commercial SLA
- **Upgrade trigger**: >100 GB/month traffic OR need team collaboration
- **Next tier**: Pro — $20/user/month

### Supabase — $0/month
- **Plan**: Free tier
- **Includes**: 500 MB database, 1 GB file storage, 2 GB bandwidth, 50K MAU auth
- **Current usage**: <10 MB DB (users, pets, bookings), 0 active users
- **Upgrade trigger**: >500 MB DB OR >50K monthly active users
- **Next tier**: Pro — $25/month (8 GB DB, 250 GB bandwidth, daily backups)

### Google Cloud Run — ~$0–$5/month
- **Plan**: Pay-as-you-go (no minimum)
- **Pricing**:
  - CPU: $0.00002400/vCPU-second (allocated only during requests)
  - Memory: $0.00000250/GiB-second
  - Requests: $0.40/million (first 2M free)
- **Free tier**: 180,000 vCPU-seconds + 360,000 GiB-seconds + 2M requests/month
- **Estimated cost at 0 users**: $0 (scales to zero between requests)
- **Estimated cost at 1,000 users/day**: ~$1–$2/month
- **Estimated cost at 10,000 users/day**: ~$3–$8/month
- **Upgrade trigger**: None needed — auto-scales

### Google Artifact Registry — ~$0.10/month
- **Usage**: Docker images for petclub-backend
- **Pricing**: $0.10/GB/month
- **Current storage**: ~1–2 image layers ≈ ~1 GB = ~$0.10/month
- **Cleanup tip**: Delete old image tags to keep storage minimal

### Google Cloud Build — $0/month
- **Free tier**: 120 build-minutes/day
- **Current usage**: Manual builds only — ~1–3 builds/week, ~3 min each
- **Monthly estimate**: 12 builds × 3 min = 36 minutes (well within free tier)
- **Upgrade trigger**: >120 build-minutes/day (very unlikely for solo dev)

### Firebase — $0/month
- **Plan**: Spark (Free), upgraded to **Blaze** (pay-as-you-go, $0 base)
- **Phone Auth free tier**: 10,000 SMS verifications/month
  - At $0.01/SMS beyond free tier — enough for ~1,000 users/month at ~10 logins each
- **FCM Push**: Completely free, unlimited messages
- **Upgrade trigger**: >10,000 SMS/month (i.e., >10K active users logging in monthly)
- **Cost at 10K SMS**: $0 (exactly at limit)
- **Cost at 20K SMS**: ~$100/month (SMS are expensive — watch this!)

### Zoho Mail — ~$1/month
- **Plan**: Zoho Workplace Starter (or Mail Lite)
- **Seats**: 1 (saikrishna.kolanupaka@mypetclub.app)
- **SMTP access**: Included
- **Group aliases**: support@mypetclub.app (free group)
- **Estimated**: $1/month per user
- **Upgrade trigger**: Adding more team members

### Domain (Namecheap) — ~$0.50/month
- **Domain**: `mypetclub.app`
- **Registrar**: Namecheap
- **Annual cost**: ~$5–$10/year = ~$0.50–$0.83/month
- **DNS**: Namecheap Basic DNS (free)
- **SSL**: Managed by Vercel and Google (free)

### Razorpay — $0/month (currently inactive)
- **Status**: Not active — awaiting LLC registration
- **When active**:
  - Setup fee: $0
  - Transaction fee: 2% per transaction (India standard)
  - Settlement: T+2 days
- **Monthly estimate at ₹1L GMV**: ~₹2,000 fees (~$24)
- **Activate by**: Setting `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` in Cloud Run

---

## 3. Scaling Cost Projections

| Monthly Active Users | Backend (Cloud Run) | Firebase SMS | Supabase | Total/month |
|---|---|---|---|---|
| 0–100 | $0 | $0 | $0 | **$2** (fixed) |
| 500 | ~$1 | $0 | $0 | **~$3** |
| 2,000 | ~$3 | $0 | $0 | **~$5** |
| 5,000 | ~$6 | $0 | $0 → $25 | **~$33** |
| 10,000 | ~$12 | $0 | $25 | **~$39** |
| 25,000 | ~$30 | ~$150 | $25 | **~$207** |
| 50,000 | ~$60 | ~$400 | $25 | **~$487** |

> Firebase SMS cost becomes significant at scale. Consider switching to OTP-less auth (magic links) or app-based TOTP for power users above 25K MAU.

---

## 4. Cost Optimization Tips

1. **Cloud Run min instances = 0** ✅ Already set — no idle cost
2. **Delete old Docker images** — run monthly cleanup in Artifact Registry
3. **Supabase row limits** — archive old `otp_tokens` rows regularly (add cron cleanup)
4. **Firebase SMS** — encourage email OTP for returning users (zero SMS cost)
5. **Vercel bandwidth** — images served from Unsplash CDN (not your bandwidth)
6. **Future**: When >5K users, consider Cloudflare Workers for edge API caching

---

## 5. When to Upgrade Each Service

| Service | Upgrade When | New Cost |
|---|---|---|
| Vercel Hobby → Pro | Team of 2+ OR >100 GB/month | $20/user/month |
| Supabase Free → Pro | >500 MB DB OR >50K MAU | $25/month |
| Firebase Spark → Blaze | Already on Blaze (pay-as-you-go, no base fee) | $0 base |
| Zoho Mail | Adding support staff | $1/user/month |
| Razorpay | LLC registered + payment feature launch | 2% per transaction |

---

## 6. Annual Budget (Current)

| Item | Annual |
|---|---|
| Domain renewal | ~$10 |
| Zoho Mail | ~$12 |
| GCP (Cloud Run + AR + GCS) | ~$15 |
| Everything else | $0 |
| **Total** | **~$37/year** |

> Running a production-grade, multi-region pet care platform for under **$40/year** at zero users is exceptional. The main cost drivers at scale will be Firebase SMS and Supabase DB storage.
