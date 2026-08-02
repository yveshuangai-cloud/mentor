#!/usr/bin/env bash
# manman-platform 測試環境部署（Cloud Run + Cloud SQL）
# 單一真相源：線上設定一律改這裡再部署，不手動 gcloud update（手動改雲端同日改腳本天條）。
set -euo pipefail

PROJECT=manman-2026
REGION=asia-east1
SERVICE=manman-backend
PROJECT_NUMBER=533860518045
SQL_CONN="${PROJECT}:${REGION}:manman-pg"
RUN_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

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
  --set-env-vars="NODE_ENV=production,PORT=3000,PUBLIC_BASE_URL=${RUN_URL},LLM_BASE_URL=https://bridge.soul-polaroid.work,LINEPAY_SANDBOX=true" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,LINE_CHANNEL_TOKEN=LINE_CHANNEL_TOKEN:latest,LINE_CHANNEL_SECRET=LINE_CHANNEL_SECRET:latest,BRIDGE_SECRET=BRIDGE_SECRET:latest,JWT_SECRET=JWT_SECRET:latest,ADMIN_TOKEN=ADMIN_TOKEN:latest,CRON_SECRET=CRON_SECRET:latest"

echo ""
echo "== 部署完成，鑑別信號驗證 =="
curl -sf "${RUN_URL}/health" && echo " ← health OK"
