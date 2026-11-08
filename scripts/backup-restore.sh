#!/usr/bin/env bash
# ==============================================================================
# GoGo Central Backend — PostgreSQL 18 Backup & Recovery Verification Script
# Usage:
#   ./scripts/backup-restore.sh backup
#   ./scripts/backup-restore.sh restore <backup_file.sql.gz>
#   ./scripts/backup-restore.sh verify-schema
# ==============================================================================
set -euo pipefail

ACTION="${1:-verify-schema}"
PG_HOST="${SQL_HOST:-localhost}"
PG_DB="${SQL_DB_NAME:-gogo_central}"
PG_USER="${SQL_USER:-gogo_app_user}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

case "$ACTION" in
  backup)
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    OUT_FILE="${BACKUP_DIR}/gogo_central_${TIMESTAMP}.sql.gz"
    echo "[INFO] Starting transactional pg_dump for ${PG_DB} on ${PG_HOST}..."
    PGPASSWORD="${SQL_PASSWORD:-}" pg_dump \
      --host="$PG_HOST" \
      --username="$PG_USER" \
      --dbname="$PG_DB" \
      --no-owner \
      --no-privileges \
      --clean \
      --if-exists | gzip -9 > "$OUT_FILE"
    echo "[OK] Backup written to ${OUT_FILE} ($(wc -c < "$OUT_FILE") bytes)"
    ;;

  restore)
    ARCHIVE_FILE="${2:-}"
    if [[ -z "$ARCHIVE_FILE" || ! -f "$ARCHIVE_FILE" ]]; then
      echo "[ERROR] Must specify an existing .sql.gz backup file to restore." >&2
      exit 1
    fi
    echo "[INFO] Restoring ${ARCHIVE_FILE} into ${PG_DB} in a single transaction..."
    gunzip -c "$ARCHIVE_FILE" | PGPASSWORD="${SQL_PASSWORD:-}" psql \
      --host="$PG_HOST" \
      --username="$PG_USER" \
      --dbname="$PG_DB" \
      --single-transaction \
      --set ON_ERROR_STOP=on
    echo "[OK] Restore completed successfully."
    ;;

  verify-schema)
    echo "[INFO] Verifying migrations/001_initial_schema.sql completeness..."
    REQUIRED_TABLES=(
      "users"
      "registered_applications"
      "user_app_roles"
      "device_tokens"
      "notification_preferences"
      "notification_campaigns"
      "notification_deliveries"
      "audit_logs"
      "security_events"
      "system_configs"
    )
    for tbl in "${REQUIRED_TABLES[@]}"; do
      if ! grep -q "CREATE TABLE IF NOT EXISTS ${tbl}" ./migrations/001_initial_schema.sql; then
        echo "[FAIL] Missing table definition: ${tbl}" >&2
        exit 1
      fi
    done
    echo "[OK] All 10 PostgreSQL tables verified in migrations/001_initial_schema.sql."
    ;;

  *)
    echo "Usage: $0 {backup|restore <file>|verify-schema}" >&2
    exit 1
    ;;
esac
