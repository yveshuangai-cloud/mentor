#!/usr/bin/env bash
# Deploy the isolated Mantou real-time voice service after LINE LIFF is created.
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${CLOUD_SQL_CONNECTION:?Set CLOUD_SQL_CONNECTION}"
: "${LINE_LOGIN_CHANNEL_ID:?Set LINE_LOGIN_CHANNEL_ID}"
: "${LIFF_ID:?Set LIFF_ID}"

PROJECT="$GCP_PROJECT_ID"
ACCOUNT="${GCP_ACCOUNT:-yveshuang.ai@gmail.com}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${CLOUD_RUN_VOICE_SERVICE:-mantou-voice}"
IMAGE="${VOICE_IMAGE:-asia-east1-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/mantou-voice:latest}"

cd "$(dirname "$0")"

npm run typecheck -w packages/backend
npm test -w packages/backend
npm run build -w packages/voice-call/frontend

gcloud builds submit . \
  --account="$ACCOUNT" \
  --project="$PROJECT" \
  --region="$REGION" \
  --config=cloudbuild.voice.yaml \
  --substitutions="_IMAGE=${IMAGE}" \
  --service-account="projects/${PROJECT}/serviceAccounts/mantou-build@${PROJECT}.iam.gserviceaccount.com"

gcloud run deploy "$SERVICE" \
  --account="$ACCOUNT" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --allow-unauthenticated \
  --session-affinity \
  --timeout=3600 \
  --min-instances=0 \
  --max-instances=2 \
  --memory=1Gi \
  --cpu=1 \
  --service-account="mantou-runtime@${PROJECT}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
  --set-env-vars="NODE_ENV=production,LINE_LOGIN_CHANNEL_ID=${LINE_LOGIN_CHANNEL_ID},LIFF_ID=${LIFF_ID},TURN_SHADOW_ENABLED=true" \
  --set-secrets="DATABASE_URL=mantou-database-url:latest,JWT_SECRET=mantou-jwt-secret:latest,ANTHROPIC_API_KEY=mantou-anthropic-api-key:latest,MINIMAX_API_KEY=mantou-minimax-api-key:latest,MINIMAX_VOICE_ID=mantou-minimax-voice-id:latest,DEEPGRAM_API_KEY=mantou-deepgram-api-key:latest"

RUN_URL="$(gcloud run services describe "$SERVICE" \
  --account="$ACCOUNT" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='value(status.url)')"

echo "Mantou voice URL: ${RUN_URL}"
curl -fsS "${RUN_URL}/health"
echo
