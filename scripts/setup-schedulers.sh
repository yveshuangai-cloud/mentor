#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${RUN_URL:?Set RUN_URL}"
: "${CRON_SECRET:?Set CRON_SECRET without printing it}"

ACCOUNT="${GCP_ACCOUNT:-yveshuang.ai@gmail.com}"
REGION="${GCP_REGION:-asia-east1}"

upsert_job() {
  local name="$1" schedule="$2" path="$3" deadline="$4"
  local verb="create"
  if gcloud scheduler jobs describe "$name" --location="$REGION" --project="$GCP_PROJECT_ID" --account="$ACCOUNT" >/dev/null 2>&1; then
    verb="update"
  fi
  gcloud scheduler jobs "$verb" http "$name" \
    --location="$REGION" \
    --project="$GCP_PROJECT_ID" \
    --account="$ACCOUNT" \
    --schedule="$schedule" \
    --time-zone="Asia/Taipei" \
    --uri="${RUN_URL}${path}" \
    --http-method=POST \
    --headers="X-Cron-Secret=${CRON_SECRET}" \
    --attempt-deadline="$deadline" \
    --max-retry-attempts=3 \
    --quiet
}

upsert_job mantou-nightly-memory "10 3 * * *" /api/cron/nightly-memory 1800s
upsert_job mantou-fire-promises "* * * * *" /api/cron/fire-promises 60s
upsert_job mantou-proactive-care "*/15 * * * *" /api/cron/proactive-care 120s
upsert_job mantou-expire-sweep "5 * * * *" /api/cron/expire-sweep 120s

echo "Mantou schedulers are configured in ${REGION}."
