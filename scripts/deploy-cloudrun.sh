#!/usr/bin/env bash
# GoGo Central Backend — Cloud Run deploy helper (DOCUMENTED, NOT auto-executed).
#
# Fill every variable in the CONFIG block, then run manually:
#   bash scripts/deploy-cloudrun.sh
#
# This script NEVER runs from CI. It creates/updates only the resources named
# below and assumes the two Secret Manager secrets already exist
# (see docs/DEPLOYMENT.md §3).

set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIG — fill these in before running
# ---------------------------------------------------------------------------
PROJECT_ID="<YOUR_GCP_PROJECT_ID>"        # e.g. gen-lang-client-0566323659
REGION="asia-south1"                      # pick the cheapest region you like
SERVICE_NAME="gogo-central-backend"
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/gogo-central/backend:latest"
SQL_SECRET="gogo-sql-password"            # Secret Manager: Neon SQL password
FIREBASE_SECRET="firebase-service-account" # Secret Manager: service-account JSON
SQL_HOST="<NEON_HOST>"                     # e.g. ep-cool-name-123456.aws.neon.tech
SQL_PORT="5432"
SQL_DB_NAME="<NEON_DATABASE>"              # e.g. neondb
SQL_USER="<NEON_USER>"
FCM_DRY_RUN="true"                        # start with dry-run; flip to "false" after verification
# ---------------------------------------------------------------------------

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (${REGION})"
echo "    Project: ${PROJECT_ID}"
echo "    FCM_DRY_RUN=${FCM_DRY_RUN} (true = simulated receipts only, never real delivery)"

# 1. Build and push the container image from the repository Dockerfile.
gcloud builds submit --tag "${IMAGE_NAME}" .

# 2. Deploy with min-instances 0 (scales to zero; free tier friendly).
#    - SQL_PASSWORD comes from Secret Manager (never plaintext here).
#    - The Firebase service-account JSON is volume-mounted at
#      /secrets/firebase-sa and GOOGLE_APPLICATION_CREDENTIALS points at it.
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production,PORT=3000,FCM_DRY_RUN=${FCM_DRY_RUN}" \
  --set-env-vars "SQL_HOST=${SQL_HOST},SQL_PORT=${SQL_PORT},SQL_DB_NAME=${SQL_DB_NAME},SQL_USER=${SQL_USER}" \
  --set-secrets "SQL_PASSWORD=${SQL_SECRET}:latest" \
  --set-secrets "/secrets/firebase-sa=${FIREBASE_SECRET}:latest" \
  --set-env-vars "GOOGLE_APPLICATION_CREDENTIALS=/secrets/firebase-sa/firebase-service-account.json"

# 3. Post-deploy health verification (fail loudly on a broken deploy).
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format 'value(status.url)')
echo "==> Probing ${SERVICE_URL}"

for path in "api/v1/health/live" "api/v1/health/ready"; do
  echo "    GET /${path}"
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${SERVICE_URL}/${path}")
  if [ "${STATUS}" != "200" ]; then
    echo "FAIL: /${path} returned ${STATUS}."
    echo "Rollback: gcloud run services update-traffic ${SERVICE_NAME} --to-revisions PREVIOUS_REVISION=100 --region ${REGION}"
    exit 1
  fi
done

echo "==> Deployed and healthy: ${SERVICE_URL}"
echo "    Remember: FCM_DRY_RUN=${FCM_DRY_RUN}. Flip to false only after verifying the full chain."
echo "    Migrations are applied automatically at startup (pg_advisory_lock serialized)."
