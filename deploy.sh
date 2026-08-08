#!/usr/bin/env bash
# mantou-platform 部署（Cloud Run + Cloud SQL）
# 單一真相源：線上設定一律改這裡再部署，不手動 gcloud update（手動改雲端同日改腳本天條）。
set -euo pipefail

: "${GCP_PROJECT_ID:?請設定饅頭專用 GCP_PROJECT_ID}"
: "${GCP_PROJECT_NUMBER:?請設定饅頭專用 GCP_PROJECT_NUMBER}"
: "${CLOUD_SQL_CONNECTION:?請設定饅頭專用 CLOUD_SQL_CONNECTION}"

PROJECT="$GCP_PROJECT_ID"
PROJECT_NUMBER="$GCP_PROJECT_NUMBER"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-mantou-backend}"
SQL_CONN="$CLOUD_SQL_CONNECTION"
RUN_URL="${PUBLIC_BASE_URL:-https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"

cd "$(dirname "$0")"

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu=1 \
  --add-cloudsql-instances="$SQL_CONN" \
  --set-env-vars="NODE_ENV=production,PUBLIC_BASE_URL=${RUN_URL},LLM_BASE_URL=https://bridge.soul-polaroid.work,LINEPAY_SANDBOX=true" \
  --set-secrets="DATABASE_URL=mantou-database-url:latest,LINE_CHANNEL_TOKEN=mantou-line-channel-token:latest,LINE_CHANNEL_SECRET=mantou-line-channel-secret:latest,BRIDGE_SECRET=mantou-bridge-secret:latest,JWT_SECRET=mantou-jwt-secret:latest,ADMIN_TOKEN=mantou-admin-token:latest,CRON_SECRET=mantou-cron-secret:latest,ANTHROPIC_API_KEY=mantou-anthropic-api-key:latest,MINIMAX_API_KEY=mantou-minimax-api-key:latest,MINIMAX_GROUP_ID=mantou-minimax-group-id:latest,MINIMAX_VOICE_ID=mantou-minimax-voice-id:latest,GEMINI_API_KEY=mantou-gemini-api-key:latest"

echo ""
echo "== 部署完成，鑑別信號驗證 =="
curl -sf "${RUN_URL}/health" && echo " ← health OK"
