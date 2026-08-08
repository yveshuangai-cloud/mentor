#!/usr/bin/env bash
# Deploy Mantou backend to Cloud Run with Cloud SQL and Secret Manager.
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_PROJECT_NUMBER:?Set GCP_PROJECT_NUMBER}"
: "${CLOUD_SQL_CONNECTION:?Set CLOUD_SQL_CONNECTION}"

PROJECT="$GCP_PROJECT_ID"
PROJECT_NUMBER="$GCP_PROJECT_NUMBER"
ACCOUNT="${GCP_ACCOUNT:-yveshuang.ai@gmail.com}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-mantou-backend}"
SQL_CONN="$CLOUD_SQL_CONNECTION"
INITIAL_URL="${PUBLIC_BASE_URL:-https://placeholder.invalid}"

cd "$(dirname "$0")"

gcloud run deploy "$SERVICE" \
  --account="$ACCOUNT" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --build-service-account="projects/${PROJECT}/serviceAccounts/mantou-build@${PROJECT}.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu=1 \
  --service-account="mantou-runtime@${PROJECT}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$SQL_CONN" \
  --set-env-vars="NODE_ENV=production,PUBLIC_BASE_URL=${INITIAL_URL},VOICE_BUCKET=mantou-voice-2026,LINEPAY_SANDBOX=true" \
  --set-secrets="DATABASE_URL=mantou-database-url:latest,LINE_CHANNEL_TOKEN=mantou-line-channel-token:latest,LINE_CHANNEL_SECRET=mantou-line-channel-secret:latest,SOUL_AUTHORIZED_LINE_USER_IDS=mantou-soul-authorized-line-users:latest,JWT_SECRET=mantou-jwt-secret:latest,ADMIN_TOKEN=mantou-admin-token:latest,CRON_SECRET=mantou-cron-secret:latest,ANTHROPIC_API_KEY=mantou-anthropic-api-key:latest,MINIMAX_API_KEY=mantou-minimax-api-key:latest,MINIMAX_VOICE_ID=mantou-minimax-voice-id:latest,GEMINI_API_KEY=mantou-gemini-api-key:latest"

RUN_URL="$(gcloud run services describe "$SERVICE" \
  --account="$ACCOUNT" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='value(status.url)')"

if [[ -z "${PUBLIC_BASE_URL:-}" ]]; then
  gcloud run services update "$SERVICE" \
    --account="$ACCOUNT" \
    --project="$PROJECT" \
    --region="$REGION" \
    --update-env-vars="PUBLIC_BASE_URL=${RUN_URL}" \
    --quiet
fi

echo "Cloud Run URL: ${RUN_URL}"
curl -fsS "${RUN_URL}/health"
echo
