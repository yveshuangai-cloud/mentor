#!/usr/bin/env bash
# Deploy the AI Personality (AIEQ) branch to an ISOLATED Cloud Run staging service.
#
# This never touches the production Mantou service, database or LIFF app:
# it refuses production names, has no default LIFF/LINE ids, and reads its own
# staging secrets. Follow docs/aieq/LINE-LIFF-STAGING-GUIDE.md for the LINE side.
#
# First deploy (LIFF app does not exist yet):
#   GCP_PROJECT_ID=... CLOUD_SQL_CONNECTION=... LINE_LOGIN_CHANNEL_ID=... ./deploy-aieq-staging.sh
# After creating the LIFF app with the printed URL as endpoint:
#   ... LIFF_ID=1234567890-abcdefgh ./deploy-aieq-staging.sh
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${CLOUD_SQL_CONNECTION:?Set CLOUD_SQL_CONNECTION (the STAGING Cloud SQL instance)}"
: "${LINE_LOGIN_CHANNEL_ID:?Set LINE_LOGIN_CHANNEL_ID (the staging LINE Login channel, same Provider as the test OA)}"

PROJECT="$GCP_PROJECT_ID"
ACCOUNT="${GCP_ACCOUNT:-yveshuang.ai@gmail.com}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-mentor-aieq-staging}"
LIFF_ID="${LIFF_ID:-not-configured}"

# Secret Manager names. Create these for staging; do not point them at production values.
SECRET_DATABASE_URL="${SECRET_DATABASE_URL:-aieq-staging-database-url}"
SECRET_LINE_CHANNEL_TOKEN="${SECRET_LINE_CHANNEL_TOKEN:-aieq-staging-line-channel-token}"
SECRET_LINE_CHANNEL_SECRET="${SECRET_LINE_CHANNEL_SECRET:-aieq-staging-line-channel-secret}"
SECRET_JWT="${SECRET_JWT:-aieq-staging-jwt-secret}"
SECRET_CRON="${SECRET_CRON:-aieq-staging-cron-secret}"

PRODUCTION_SERVICE="mantou-backend"
PRODUCTION_LIFF_ID="2010457475-hOQx38Bc"
PRODUCTION_LOGIN_CHANNEL_ID="2010457475"

fail() { echo "REFUSED: $1" >&2; exit 1; }
[[ "$SERVICE" != "$PRODUCTION_SERVICE" ]] || fail "CLOUD_RUN_SERVICE is the production service."
[[ "$LIFF_ID" != "$PRODUCTION_LIFF_ID" ]] || fail "LIFF_ID is the existing production LIFF app; create a dedicated AI Personality LIFF app."
# A new LIFF app may legitimately live under the existing Login channel (same Provider); that must be an explicit choice.
[[ "$LINE_LOGIN_CHANNEL_ID" != "$PRODUCTION_LOGIN_CHANNEL_ID" || "${ALLOW_SHARED_LOGIN_CHANNEL:-}" == "1" ]] \
  || fail "LINE_LOGIN_CHANNEL_ID is the production LINE Login channel. Set ALLOW_SHARED_LOGIN_CHANNEL=1 only if the staging LIFF app was deliberately created under it."
for secret in "$SECRET_DATABASE_URL" "$SECRET_LINE_CHANNEL_TOKEN" "$SECRET_LINE_CHANNEL_SECRET" "$SECRET_JWT" "$SECRET_CRON"; do
  [[ "$secret" != mantou-* ]] || fail "Secret '$secret' looks like a production Mantou secret."
done

cd "$(dirname "$0")"

# Deployment is blocked unless types, unit tests and the AIEQ integration flow all pass.
npm run typecheck -w packages/backend
DATABASE_URL="${DATABASE_URL:-postgresql://test:test@127.0.0.1:5432/test}" npm test -w packages/backend
npm run test:aieq:integration -w packages/backend

deploy() {
  gcloud run deploy "$SERVICE" \
    --account="$ACCOUNT" \
    --project="$PROJECT" \
    --region="$REGION" \
    --source=. \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=1 \
    --memory=512Mi \
    --cpu=1 \
    --add-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
    --set-env-vars="NODE_ENV=production,AIEQ_DEMO_MODE=false,PUBLIC_BASE_URL=$1,LINE_LOGIN_CHANNEL_ID=${LINE_LOGIN_CHANNEL_ID},LIFF_ID=${LIFF_ID}" \
    --set-secrets="DATABASE_URL=${SECRET_DATABASE_URL}:latest,LINE_CHANNEL_TOKEN=${SECRET_LINE_CHANNEL_TOKEN}:latest,LINE_CHANNEL_SECRET=${SECRET_LINE_CHANNEL_SECRET}:latest,JWT_SECRET=${SECRET_JWT}:latest,CRON_SECRET=${SECRET_CRON}:latest"
}

deploy "${PUBLIC_BASE_URL:-https://placeholder.invalid}"

RUN_URL="$(gcloud run services describe "$SERVICE" \
  --account="$ACCOUNT" --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)')"

if [[ -z "${PUBLIC_BASE_URL:-}" ]]; then
  gcloud run services update "$SERVICE" \
    --account="$ACCOUNT" --project="$PROJECT" --region="$REGION" \
    --update-env-vars="PUBLIC_BASE_URL=${RUN_URL}" --quiet
fi

echo
echo "Staging URL:        ${RUN_URL}"
echo "LIFF endpoint URL:  ${RUN_URL}/aieq"
echo "LINE webhook URL:   ${RUN_URL}/api/webhook/line"
echo
for path in /health /aieq /aieq-manifest.webmanifest /aieq-sw.js /api/aieq/config; do
  printf '%-32s ' "$path"
  curl -fsS -o /dev/null -w '%{http_code}\n' "${RUN_URL}${path}"
done
if [[ "$LIFF_ID" == "not-configured" ]]; then
  echo
  echo "Next: create the LIFF app (Size Full, scopes openid+profile, endpoint above), then re-run with LIFF_ID=<new id>."
fi
