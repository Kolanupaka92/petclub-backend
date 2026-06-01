# ══════════════════════════════════════════════════════════════════
#  PETclub — Migrate sensitive env vars → Google Secret Manager
#  Run once from PowerShell after setting the VALUES below.
#
#  What this does:
#    1. Creates a Secret Manager secret for each sensitive var
#    2. Stores the current value as the first version
#    3. Updates Cloud Run to reference the secret (not plain env var)
#    4. Removes the plain-text env var from Cloud Run
#
#  After running:
#    - Secrets are versioned and auditable in GCP Console
#    - Cloud Run mounts them at runtime — same as before for the app
#    - Rotating a secret = add new version in Secret Manager, redeploy
#
#  FIREBASE_SERVICE_ACCOUNT_JSON is already in Secret Manager — skipped.
# ══════════════════════════════════════════════════════════════════

$PROJECT   = "petclub-438006"   # your GCP project ID
$REGION    = "us-west1"         # updated region (was us-central1)
$SERVICE   = "petclub-backend"

# ── Fill in current values before running ────────────────────────
$SECRETS = @{
  "JWT_SECRET"           = "PASTE_CURRENT_JWT_SECRET_HERE"
  "SUPABASE_SERVICE_KEY" = "PASTE_CURRENT_SUPABASE_SERVICE_KEY_HERE"
  "SUPABASE_DB_PASSWORD" = "PASTE_SUPABASE_DB_PASSWORD_HERE"
  "RESEND_API_KEY"       = "PASTE_CURRENT_RESEND_API_KEY_HERE"
  "TWILIO_AUTH_TOKEN"    = "PASTE_CURRENT_TWILIO_AUTH_TOKEN_HERE"
  "ADMIN_SECRET"         = "PASTE_CURRENT_ADMIN_SECRET_HERE"
  "HEALTH_SECRET"        = "PASTE_CURRENT_HEALTH_SECRET_HERE"
  "SENTRY_DSN"           = "PASTE_SENTRY_DSN_HERE_OR_LEAVE_BLANK"
}

Write-Host "`n==> Creating secrets in Secret Manager..." -ForegroundColor Cyan

foreach ($name in $SECRETS.Keys) {
  $value = $SECRETS[$name]
  if ($value -like "PASTE_*" -or $value -eq "") {
    Write-Host "  SKIPPED $name (no value set)" -ForegroundColor Yellow
    continue
  }

  # Create secret (ignore error if already exists)
  gcloud secrets create $name `
    --project=$PROJECT `
    --replication-policy="automatic" 2>$null

  # Add the value as a new version
  $value | gcloud secrets versions add $name `
    --project=$PROJECT `
    --data-file=- 2>&1

  Write-Host "  OK $name" -ForegroundColor Green
}

Write-Host "`n==> Updating Cloud Run to reference secrets..." -ForegroundColor Cyan

# Build --update-secrets flags for all created secrets
$secretFlags = @()
foreach ($name in $SECRETS.Keys) {
  $value = $SECRETS[$name]
  if ($value -like "PASTE_*" -or $value -eq "") { continue }
  $secretFlags += "${name}=${name}:latest"
}

# Build --remove-env-vars flags to drop plain-text versions
$removeFlags = ($SECRETS.Keys | Where-Object {
  $SECRETS[$_] -notlike "PASTE_*" -and $SECRETS[$_] -ne ""
}) -join ","

if ($secretFlags.Count -gt 0) {
  $secretArg  = $secretFlags -join ","
  gcloud run services update $SERVICE `
    --project=$PROJECT `
    --region=$REGION `
    --update-secrets=$secretArg `
    --remove-env-vars=$removeFlags

  Write-Host "`n✅ Done — Cloud Run now reads secrets from Secret Manager." -ForegroundColor Green
  Write-Host "   View secrets: https://console.cloud.google.com/security/secret-manager?project=$PROJECT" -ForegroundColor Cyan
} else {
  Write-Host "`nNo secrets were created — fill in the values above and re-run." -ForegroundColor Yellow
}

# ── How to rotate a secret later ─────────────────────────────────
Write-Host @"

HOW TO ROTATE A SECRET LATER:
  echo "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-
  gcloud run services update petclub-backend --region=$REGION --update-secrets=SECRET_NAME=SECRET_NAME:latest

"@ -ForegroundColor Gray
