# PETclub — Developer Workflow Guide

> Quick reference for day-to-day development, testing, and deployment.

---

## 1. Repositories

| Repo | Branch | URL |
|---|---|---|
| `petclub-backend` | `main` | `github.com/Kolanupaka92/petclub-backend` |
| `petclub-app` | `main` | `github.com/Kolanupaka92/petclub-app` |
| `petclub-website` | `master` | `github.com/Kolanupaka92/petclub-website` |

---

## 2. Local Development

### Start backend locally
```bash
cd petclub-backend
cp .env.example .env        # fill in all secrets
npm install
npm run dev                 # nodemon — hot reload on port 5000
```

### Start app locally
```bash
cd petclub-app
cp .env.example .env.local  # fill VITE_* vars
npm install
npm run dev                 # Vite — hot reload on http://localhost:5173
```

### Start website locally
```bash
cd petclub-website
npm install
npm run dev                 # Vite — http://localhost:5174
```

---

## 3. Making a Backend Change

```
1. Edit server.js (or related files)
2. Test locally:  curl http://localhost:5000/api/health
3. git add + git commit
4. git push origin main   ← Cloud Build auto-triggers from GitHub (us-south1)
```

### Backend Deploy — GitHub Auto-Trigger (primary)
```bash
cd petclub-backend
git add .
git commit -m "your message"
git push origin main
# Cloud Build trigger fires automatically → Docker build → Cloud Run deploy
# Monitor at: https://console.cloud.google.com/cloud-build/builds?project=project-c736b433-1b47-40c0-a2c
```

> **Build appears in us-south1 region** with source = Kolanupaka92/petclub-backend, ref = main.
> Auto-deploy takes ~2–3 minutes. No manual step needed after `git push`.

### Backend Deploy — Manual fallback (if trigger fails)
```bash
PROJECT="project-c736b433-1b47-40c0-a2c"
COMMIT_SHA=$(git rev-parse HEAD)

# 1. Get OAuth token (reads from gcloud credentials.db)
# 2. Create tarball:
tar -czf /tmp/src.tar.gz --exclude=./node_modules --exclude=./.git .
# 3. Upload to GCS:
#    gs://project-c736b433-1b47-40c0-a2c_cloudbuild/source/$COMMIT_SHA.tar.gz
# 4. POST https://cloudbuild.googleapis.com/v1/projects/$PROJECT/builds
#    with storageSource + steps from cloudbuild.yaml
```

---

## 4. Making a Frontend Change (App or Website)

```
1. Edit src/ files
2. npm run dev — verify locally
3. git add + git commit
4. git push origin main (or master for website)
5. Deploy to Vercel:
```

### Frontend Deploy Command
```bash
# From the repo root:
vercel --prod --yes
```

Vercel CLI version: **54.x** — auto-reads `.vercel/project.json` for project ID.

---

## 5. Testing Checklist (Before Every Deploy)

### Backend
```bash
# Health check
curl https://api.mypetclub.app/api/health

# Auth — no token
curl https://api.mypetclub.app/api/users/me

# Email OTP
curl -X POST https://api.mypetclub.app/api/auth/send-email-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com"}'

# Professionals (public)
curl "https://api.mypetclub.app/api/professionals"
```

### Frontend
- [ ] Login page loads (phone + email tabs visible)
- [ ] Trainer role shows 🐕‍🦺 (not 🎓)
- [ ] Service cards render without errors
- [ ] OTP input boxes auto-focus
- [ ] Role selection cards display correctly

---

## 6. Adding a New API Endpoint

1. Open `petclub-backend/server.js`
2. Add endpoint in the appropriate section:
   - Auth routes: after line ~300
   - User routes: after `/users/me`
   - Booking routes: after `/bookings`
3. Add to `petclub-app/src/api.js`:
   ```js
   newEndpoint: (param) => req('POST', '/new-endpoint', { param }, true),
   ```
4. Test locally, commit, push, deploy.

---

## 7. Adding a New Supabase Table

1. Open Supabase SQL Editor (petclub-43982)
2. Write migration:
   ```sql
   CREATE TABLE IF NOT EXISTS new_table (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );
   -- Add RLS if needed
   ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;
   ```
3. Run in Supabase SQL Editor
4. Add backend queries in `server.js`
5. **No ORM migrations needed** — Supabase handles schema directly.

---

## 8. Environment Variable Changes

### Backend (Cloud Run)
```bash
# Update a single env var:
gcloud run services update petclub-backend \
  --region us-central1 \
  --update-env-vars KEY=VALUE

# Update multiple:
gcloud run services update petclub-backend \
  --region us-central1 \
  --update-env-vars "KEY1=VAL1,KEY2=VAL2"
```

### Frontend (Vercel)
Update via Vercel Dashboard → Project Settings → Environment Variables.
Then redeploy: `vercel --prod --yes`

---

## 9. Monitoring & Logs

### Backend Logs (Cloud Run)
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=petclub-backend" \
  --limit=50 --format="table(timestamp,textPayload)"
```

### Or via GCP Console
Cloud Run → petclub-backend → Logs tab

### Supabase Logs
Supabase Dashboard → Database → Logs

---

## 10. Secrets Management

Firebase service account is stored in **Secret Manager**:
```
Secret name: firebase-service-account
Version: 2 (v1 had BOM — do not use)
Mounted as: FIREBASE_SERVICE_ACCOUNT_JSON env var
```

To rotate:
```bash
# Create new version
gcloud secrets versions add firebase-service-account \
  --data-file=/path/to/new-service-account.json

# Update Cloud Run to use latest
gcloud run services update petclub-backend \
  --region us-central1 \
  --update-secrets "FIREBASE_SERVICE_ACCOUNT_JSON=firebase-service-account:latest"
```

---

## 11. Common Issues & Fixes

| Issue | Cause | Fix |
|---|---|---|
| `553 relay error` SMTP | Sending FROM a group email | Use authenticated account as FROM |
| `JSON parse error` Firebase | BOM in service account JSON | Save as UTF-8 without BOM |
| Supabase `.catch()` error | PromiseLike, not full Promise | Wrap in `try/catch` |
| Cloud Build `invalid reference` | Empty `COMMIT_SHA` substitution | Pass `--substitutions=COMMIT_SHA=$(git rev-parse HEAD)` |
| OTP "not found" | User on wrong endpoint (old) | Use `/auth/send-email-otp` or Firebase |
| `auth/captcha-check-failed` | Stale reCAPTCHA verifier | Auto-retry clears and reinits verifier |

---

## 12. Production URLs Quick Reference

| Service | URL |
|---|---|
| App | https://app.mypetclub.app |
| Website | https://mypetclub.app |
| API | https://api.mypetclub.app/api |
| Health | https://api.mypetclub.app/api/health |
| Supabase | https://app.supabase.com (petclub-43982) |
| Cloud Run | https://console.cloud.google.com/run |
| Firebase | https://console.firebase.google.com/project/petclub-43982 |
| Vercel | https://vercel.com/kolanupaka92-s-projects |
