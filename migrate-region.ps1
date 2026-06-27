# ══════════════════════════════════════════════════════════════════
#  PETclub — Migrate Cloud Run from us-central1 → us-west1
#
#  Why: Supabase project is in AWS us-west-2 (Oregon).
#       GCP us-west1 is also Oregon — same physical region,
#       eliminating cross-region DB latency on every call.
#
#  What this does:
#    1. Deploys a new Cloud Run service in us-west1 (same source)
#    2. Maps api.mypetclub.app domain to the new service
#    3. Removes the old us-central1 service
#
#  Run AFTER migrate-to-secret-manager.ps1
# ══════════════════════════════════════════════════════════════════

$PROJECT    = "petclub-438006"
$SERVICE    = "petclub-backend"
$OLD_REGION = "us-central1"
$NEW_REGION = "us-west1"
$SOURCE_DIR = "C:\Users\14697\petclub-backend"

Write-Host "`n==> Step 1: Deploy to $NEW_REGION..." -ForegroundColor Cyan

gcloud run deploy $SERVICE `
  --project=$PROJECT `
  --region=$NEW_REGION `
  --source=$SOURCE_DIR `
  --allow-unauthenticated `
  --min-instances=1 `
  --max-instances=10 `
  --memory=1Gi `
  --cpu=1 `
  --concurrency=80 `
  --timeout=3600 `
  --port=8080

Write-Host "`n==> Step 2: Map api.mypetclub.app → $NEW_REGION service..." -ForegroundColor Cyan

gcloud run domain-mappings create `
  --service=$SERVICE `
  --domain=api.mypetclub.app `
  --region=$NEW_REGION `
  --project=$PROJECT

Write-Host "`n==> Step 3: Delete old $OLD_REGION service..." -ForegroundColor Cyan
Write-Host "    (Only run this after verifying the new service is healthy!)" -ForegroundColor Yellow

$confirm = Read-Host "Type 'yes' to delete the old us-central1 service"
if ($confirm -eq "yes") {
  gcloud run services delete $SERVICE `
    --region=$OLD_REGION `
    --project=$PROJECT `
    --quiet
  Write-Host "`n✅ Migration complete — Cloud Run now runs in $NEW_REGION (Oregon, co-located with Supabase)." -ForegroundColor Green
} else {
  Write-Host "`nSkipped deletion. Old service still running in $OLD_REGION." -ForegroundColor Yellow
  Write-Host "Delete manually once you verify: gcloud run services delete $SERVICE --region=$OLD_REGION" -ForegroundColor Gray
}
