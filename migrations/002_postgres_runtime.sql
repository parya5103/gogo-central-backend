-- ============================================================================
-- GoGo Central Backend — Migration 002: PostgreSQL Runtime Integration
-- PostgreSQL 18
--
-- Runtime schema additions required by the real pg data-access layer:
--   1. users: Firebase auth profile columns + validated-at-runtime IANA timezone
--      (NULL = unknown; quiet-hours enforcement is skipped rather than
--       silently assuming UTC).
--   2. notification_campaigns: idempotency payload identity (sha256) + worker
--      lock/retry columns for multi-instance-safe processing.
--   3. notification_deliveries: referential integrity (device/user/app FKs),
--      idempotent receipt uniqueness, quiet-hours skip status, bounded retry
--      tracking.
--   4. rate_limit_buckets: distributed rate limiting shared across Cloud Run
--      instances.
--
-- Safety: every statement is repeatable (IF NOT EXISTS / DO-block guarded).
-- No data is deleted. If an existing database contains orphan delivery rows
-- that violate the new foreign keys, this migration fails loudly instead of
-- silently corrupting data.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. users: auth profile + timezone (quiet hours are computed in the user's
--    own IANA zone, validated at write time via Intl.supportedValuesOf).
-- ----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_masked VARCHAR(160) NOT NULL DEFAULT 'hidden@gogo.in';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32) NOT NULL DEFAULT 'google.com';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NULL;

-- ----------------------------------------------------------------------------
-- 2. notification_campaigns: durable idempotency payload hash + worker lock.
-- ----------------------------------------------------------------------------
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS processing_locked_at TIMESTAMPTZ NULL;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS locked_by VARCHAR(128) NULL;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_worker_queue
  ON notification_campaigns (status, scheduled_for)
  WHERE status IN ('queued', 'scheduled', 'processing');

CREATE INDEX IF NOT EXISTS idx_campaigns_next_retry
  ON notification_campaigns (next_retry_at)
  WHERE next_retry_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. notification_deliveries: honest receipt lifecycle.
--    - extended status enum (skipped_quiet_hours, failed_permanent)
--    - skip_reason kept as structured data (never logged as fake errors)
--    - FKs so receipts can never reference nonexistent devices/users/apps
--    - UNIQUE (notification_id, device_id) for idempotent delivery records
--    - bounded per-delivery retry tracking
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_status_check'
  ) THEN
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
      CHECK (status IN (''delivered'', ''failed_transient'', ''failed_expired_token'',
                        ''skipped_preference'', ''skipped_quiet_hours'', ''failed_permanent''))';
  ELSE
    EXECUTE 'ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check';
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
      CHECK (status IN (''delivered'', ''failed_transient'', ''failed_expired_token'',
                        ''skipped_preference'', ''skipped_quiet_hours'', ''failed_permanent''))';
  END IF;
END $$;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(64) NULL;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_delivery_device'
  ) THEN
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT fk_delivery_device
      FOREIGN KEY (device_id) REFERENCES device_tokens(device_id) ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_delivery_user'
  ) THEN
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT fk_delivery_user
      FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_delivery_app'
  ) THEN
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT fk_delivery_app
      FOREIGN KEY (app_id) REFERENCES registered_applications(app_id) ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_delivery_notification_device'
  ) THEN
    EXECUTE 'ALTER TABLE notification_deliveries ADD CONSTRAINT uq_delivery_notification_device
      UNIQUE (notification_id, device_id)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_deliveries_campaign
  ON notification_deliveries (notification_id);

CREATE INDEX IF NOT EXISTS idx_deliveries_user
  ON notification_deliveries (user_id);

-- ----------------------------------------------------------------------------
-- 4. rate_limit_buckets: shared, atomic, instance-independent rate limiting.
--    Rows are ephemeral bookkeeping (no PII). bucket_key is the already-hashed
--    client identity produced by ipKeyGenerator + route prefix.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON rate_limit_buckets (window_start);

COMMIT;
