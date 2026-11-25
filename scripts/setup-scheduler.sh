#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  Cloud Scheduler jobs for PETclub (idempotent: safe to re-run).
#
#    scripts/setup-scheduler.sh            create or update everything
#    scripts/setup-scheduler.sh check      fail if a job is missing, paused,
#                                          failing or overdue
#    Run one by hand:  gcloud scheduler jobs run petclub-<job> --location us-west1
#
#  Each call carries a Google-signed token for petclub-scheduler@, which has no
#  roles on the project. The API accepts only that identity (services/cronAuth.js).
#  Cost: $0.10 per job per month beyond the 3 free per billing account.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
PROJECT="${PROJECT:-project-c736b433-1b47-40c0-a2c}"
LOCATION="${LOCATION:-us-west1}"
API="${API:-https://api.mypetclub.app}"
SA="petclub-scheduler@${PROJECT}.iam.gserviceaccount.com"

# job | schedule (UTC) | retries | longest acceptable gap in minutes
# Jobs that email without a sent-log get 0 retries, so a retry can't double-send.
JOBS='booking-timeout|*/5 * * * *|2|20
booking-reminders|0 * * * *|2|130
refresh-leaderboard|0 2 * * *|2|1560
coupon-expiry|30 2 * * *|0|1560
care-reminders|0 3 * * *|0|1560
auto-delete|0 4 * * *|2|1560
hard-purge|15 4 * * *|2|1560
stale-bookings|0 5 * * *|0|1560
payout-summary|0 6 * * 6|0|10200'

g() { gcloud --project "$PROJECT" --quiet "$@" </dev/null; }

check() {
  g scheduler jobs list --location "$LOCATION" --format=json > "${TMPDIR:-/tmp}/petclub-jobs.json"
  JOBS="$JOBS" python3 - "${TMPDIR:-/tmp}/petclub-jobs.json" <<'PY'
import json, os, sys
from datetime import datetime, timezone
jobs = {j['name'].rsplit('/', 1)[1]: j for j in json.load(open(sys.argv[1]))}
now, bad = datetime.now(timezone.utc), 0
def age(t): return (now - datetime.fromisoformat(t.split('.')[0].rstrip('Z') + '+00:00')).total_seconds() / 60
for line in os.environ['JOBS'].splitlines():
    name, _, _, gap = line.split('|'); j = jobs.get('petclub-' + name); p = None
    if not j: p = 'missing'
    elif j.get('state') != 'ENABLED': p = 'state ' + j.get('state', '?')
    elif not j.get('lastAttemptTime'):
        if age(j['userUpdateTime']) > int(gap): p = 'has never run'
    elif j.get('status', {}).get('code'): p = f"last run failed (code {j['status']['code']})"
    elif age(j['lastAttemptTime']) > int(gap): p = f"last ran {age(j['lastAttemptTime']):.0f} min ago"
    print(('FAIL ' if p else 'ok   ') + name + (': ' + p if p else '')); bad += bool(p)
sys.exit(1 if bad else 0)
PY
}

setup() {
  g services enable cloudscheduler.googleapis.com
  g iam service-accounts describe "$SA" >/dev/null 2>&1 ||
    g iam service-accounts create petclub-scheduler --display-name "PETclub Cloud Scheduler (identity only, no roles)"
  while IFS='|' read -r name schedule retries _; do
    verb=create
    g scheduler jobs describe "petclub-$name" --location "$LOCATION" >/dev/null 2>&1 && verb=update
    g scheduler jobs "$verb" http "petclub-$name" --location "$LOCATION" \
      --schedule "$schedule" --time-zone Etc/UTC \
      --uri "$API/api/cron/$name" --http-method POST \
      --oidc-service-account-email "$SA" --oidc-token-audience "$API" \
      --attempt-deadline 300s --max-retry-attempts "$retries" --min-backoff 30s --max-backoff 120s >/dev/null
    echo "$verb petclub-$name  ($schedule UTC)"
  done <<< "$JOBS"
}

case "${1:-setup}" in setup) setup ;; check) check ;; *) echo "usage: $0 [setup|check]" >&2; exit 2 ;; esac
