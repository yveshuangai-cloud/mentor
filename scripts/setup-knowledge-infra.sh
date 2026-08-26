#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${RUN_URL:?Set RUN_URL to the deployed mantou-backend URL}"

ACCOUNT="${GCP_ACCOUNT:-yveshuang.ai@gmail.com}"
REGION="${GCP_REGION:-asia-east1}"
BUCKET="${KNOWLEDGE_BUCKET:-mantou-knowledge-2026}"
RUNTIME_SA="mantou-runtime@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud storage buckets describe "gs://${BUCKET}" --project="$GCP_PROJECT_ID" --account="$ACCOUNT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="$GCP_PROJECT_ID" --account="$ACCOUNT" --location="$REGION" \
    --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${BUCKET}" \
  --project="$GCP_PROJECT_ID" --account="$ACCOUNT" --versioning

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project="$GCP_PROJECT_ID" --account="$ACCOUNT" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/storage.objectAdmin"

# Workload Identity signs short-lived V4 upload URLs without a downloadable key.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$GCP_PROJECT_ID" --account="$ACCOUNT" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/iam.serviceAccountTokenCreator"

cors_file="$(mktemp)"
trap 'rm -f "$cors_file"' EXIT
printf '[{"origin":["%s"],"method":["PUT","OPTIONS"],"responseHeader":["Content-Type","ETag"],"maxAgeSeconds":3600}]' "$RUN_URL" > "$cors_file"
gcloud storage buckets update "gs://${BUCKET}" \
  --project="$GCP_PROJECT_ID" --account="$ACCOUNT" --cors-file="$cors_file"

echo "Knowledge bucket ready: gs://${BUCKET}"
