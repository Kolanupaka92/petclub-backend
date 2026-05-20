# PETclub — System Architecture

> Last updated: May 2026 · Stack version: v1.0

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENTS                                  │
│                                                                  │
│  mypetclub.app          app.mypetclub.app                        │
│  (Marketing Website)    (React PWA — customers + pros + admin)   │
│  Vercel · CDN           Vercel · CDN                             │
└────────────┬────────────────────┬───────────────────────────────┘
             │  HTTPS             │  HTTPS + JWT
             ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│             api.mypetclub.app  (Cloud Run · us-central1)         │
│                                                                  │
│  Node.js 20 · Express 4                                          │
│  ├── Auth: Firebase Phone Auth + Email OTP                       │
│  ├── Notifications: Zoho SMTP (email) + FCM push                │
│  ├── Payments: Razorpay (inactive until LLC)                     │
│  └── JWT (30d) — all protected routes                            │
└────────────┬────────────────────────────────────────────────────┘
             │
    ┌────────┴────────────────────────┐
    │                                 │
    ▼                                 ▼
┌──────────┐              ┌───────────────────────┐
│ Supabase │              │ Firebase (petclub-43982)│
│ Postgres │              │  ├── Phone Auth (OTP)  │
│  + Auth  │              │  └── FCM Messaging     │
└──────────┘              └───────────────────────┘
```

---

## 2. Infrastructure Components

### Frontend — Vercel

| Property | Value |
|---|---|
| **Marketing site** | `https://mypetclub.app` |
| **App (PWA)** | `https://app.mypetclub.app` |
| **Framework** | React 18 + Vite + Tailwind CSS |
| **Deploy trigger** | `vercel --prod` (manual) |
| **CDN** | Vercel Edge Network (global) |
| **Repos** | `petclub-website` (master), `petclub-app` (main) |

### Backend — Google Cloud Run

| Property | Value |
|---|---|
| **URL** | `https://api.mypetclub.app` |
| **Region** | `us-central1` |
| **Runtime** | Node.js 20 · Docker |
| **Container Registry** | Artifact Registry — `us-central1-docker.pkg.dev` |
| **Project ID** | `project-c736b433-1b47-40c0-a2c` |
| **Min instances** | 0 (scales to zero when idle) |
| **Max instances** | Auto |
| **Memory** | 512 MB |
| **Repo** | `petclub-backend` (main) |

### Database — Supabase

| Property | Value |
|---|---|
| **Type** | PostgreSQL (managed) |
| **Project** | `petclub-43982` |
| **Auth** | Supabase service key (backend only) |
| **Tables** | `users`, `professional_profiles`, `customer_profiles`, `pets`, `bookings`, `booking_assignments`, `otp_tokens`, `admin_logs`, `ratings` |

### Authentication — Firebase

| Property | Value |
|---|---|
| **Project** | `petclub-43982` |
| **Phone Auth** | Free tier — 10,000 SMS/month |
| **FCM Push** | Free tier — unlimited |
| **Admin SDK** | Mounted via Secret Manager (`FIREBASE_SERVICE_ACCOUNT_JSON`) |
| **Web SDK** | Loaded client-side via env vars (`VITE_FIREBASE_*`) |

### Email — Zoho SMTP

| Property | Value |
|---|---|
| **Server** | `smtppro.zoho.com:587` (STARTTLS) |
| **Sender** | `saikrishna.kolanupaka@mypetclub.app` |
| **From display** | `support@mypetclub.app` (group alias) |
| **Uses** | OTP emails, booking confirmations, admin notifications |

---

## 3. Data Flow — User Authentication

### Phone Login (Firebase)
```
Browser                    Backend                Firebase
  │                           │                      │
  ├── initPhoneAuth()         │                      │
  │   └── RecaptchaVerifier   │                      │
  │                           │                      │
  ├── sendPhoneOtp(+1xxx)     │                      │
  │   └─────────────────────────────────────────────►│
  │                           │                   SMS OTP
  │◄────────────────────────────────────────────── 6-digit
  │
  ├── verifyPhoneOtp(otp)
  │   └── Firebase confirm() ──────────────────────►│
  │       idToken ◄──────────────────────────────── │
  │
  ├── POST /auth/firebase-verify {idToken} ─────────►│
  │                           │  verifyIdToken()     │
  │                           │◄──── decoded phone ──│
  │                           │
  │                           ├── find/create user in Supabase
  │                           ├── issue JWT (30d)
  │◄───── {token, user} ──────│
```

### Email OTP Login
```
Browser                    Backend                  Zoho SMTP
  │                           │                         │
  ├── POST /auth/send-email-otp {email}                 │
  │                           ├── genOTP() + store DB   │
  │                           ├── sendEmail(email, otp) ►│
  │◄── {success}              │                         │
  │                                                     │
  ├── POST /auth/verify-email-otp {email, otp}
  │                           ├── verify DB record
  │                           ├── find/create user
  │                           ├── issue JWT (30d)
  │◄── {token, user} ─────────│
```

---

## 4. Data Flow — Booking

```
Customer App              Backend               Professional App
     │                       │                        │
     ├── POST /bookings ──────►                        │
     │                       ├── create booking        │
     │                       ├── findNextPro()         │
     │                       │   └── round-robin       │
     │                       ├── offerBookingToPro()   │
     │                       │   ├── email ──────────► │
     │                       │   └── FCM push ────────►│
     │                       │                         │
     │                       │      POST /bookings/:id/respond
     │                       │◄───────────────────────── {action}
     │                       ├── accept: update booking │
     │                       ├── email to customer      │
     │                       ├── FCM push to customer   │
     │◄── booking confirmed ──│                         │
```

---

## 5. Role System

```
                    ┌─────────────┐
                    │  pending_role│  ← new user before role selection
                    └──────┬──────┘
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
        customer      professional      admin
         (instant)    (pending review)  (manual DB set)
                           │
                  ┌────────┼────────┐
                  ▼        ▼        ▼
               Groomer  Trainer    Vet
              (subRole) (subRole) (subRole)
                           │
                    verification_status
                    pending → approved / rejected
```

---

## 6. Security

| Layer | Mechanism |
|---|---|
| **Auth** | JWT (HS256, 30d expiry) — `Authorization: Bearer <token>` |
| **API Rate Limiting** | express-rate-limit — 300 req/15 min general, 5/min OTP |
| **CORS** | Whitelist: `app.mypetclub.app`, `mypetclub.app`, `localhost:517x` |
| **Secrets** | Cloud Run env vars + Secret Manager (Firebase SA key) |
| **Suspended accounts** | `is_active = false` blocks JWT issuance |
| **Admin routes** | `adminOnly` middleware — role check on every request |

---

## 7. CI/CD Pipeline

```
Developer
  │
  ├── git push origin main  (petclub-app / petclub-website)
  │   └── Vercel auto-detects push → builds → deploys to CDN
  │
  └── git push origin main  (petclub-backend)
      └── MANUAL: gcloud builds submit (Cloud Build)
          OR: trigger via REST API with GCS source tarball
          Steps:
            1. Docker build → Artifact Registry
            2. Cloud Run deploy (new revision)
```

> **Note**: No GitHub → Cloud Build triggers exist. All backend deploys are manual.

---

## 8. Environment Variables

### Backend (Cloud Run)
| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase admin key (bypasses RLS) |
| `JWT_SECRET` | HS256 signing secret |
| `ZOHO_SMTP_USER` | `saikrishna.kolanupaka@mypetclub.app` |
| `ZOHO_SMTP_PASS` | Zoho app-specific password |
| `ZOHO_SMTP_FROM` | `saikrishna.kolanupaka@mypetclub.app` |
| `ADMIN_EMAIL` | Admin notification recipient |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK credentials (JSON) |
| `RAZORPAY_KEY_ID` | ⏳ Set after LLC registration |
| `RAZORPAY_KEY_SECRET` | ⏳ Set after LLC registration |

### Frontend App (Vercel — `VITE_*`)
| Variable | Purpose |
|---|---|
| `VITE_API_URL` | `https://api.mypetclub.app/api` |
| `VITE_FIREBASE_API_KEY` | Firebase web config |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | `petclub-43982` |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | FCM sender ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |
| `VITE_FIREBASE_VAPID_KEY` | FCM web push VAPID key |
| `VITE_MAPBOX_TOKEN` | Address autocomplete |
