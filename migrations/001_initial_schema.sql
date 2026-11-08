-- ============================================================================
-- GoGo Central Backend — PostgreSQL 16 Production & Local Schema Migration
-- File: migrations/001_initial_schema.sql
-- Covers all 10 core domain tables with strict FK constraints and indexes
-- ============================================================================

BEGIN;

-- 1. Users and Firebase UID Mapping
CREATE TABLE IF NOT EXISTS users (
  uid VARCHAR(128) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2. Registered GoGo Applications
CREATE TABLE IF NOT EXISTS registered_applications (
  app_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  domain VARCHAR(160) NOT NULL,
  category VARCHAR(24) NOT NULL CHECK (category IN ('portal', 'civic', 'news', 'game')),
  fcm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  web_push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  android_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 120 CHECK (rate_limit_per_min BETWEEN 10 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. User Application Access & Product-Specific Roles
CREATE TABLE IF NOT EXISTS user_app_roles (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id VARCHAR(64) NOT NULL REFERENCES registered_applications(app_id) ON DELETE CASCADE,
  app_role VARCHAR(24) NOT NULL DEFAULT 'member' CHECK (app_role IN ('member', 'moderator', 'admin')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_user_app_roles_user ON user_app_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_app_roles_app ON user_app_roles(app_id);

-- 4. Device and FCM Tokens
CREATE TABLE IF NOT EXISTS device_tokens (
  device_id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id VARCHAR(64) NOT NULL REFERENCES registered_applications(app_id) ON DELETE CASCADE,
  fcm_token VARCHAR(512) NOT NULL UNIQUE,
  platform VARCHAR(16) NOT NULL CHECK (platform IN ('web', 'android')),
  user_agent VARCHAR(256) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_app ON device_tokens(user_id, app_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_app_status ON device_tokens(app_id, status);

-- 5. Per-User & Per-Product Notification Preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  pref_id VARCHAR(196) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id VARCHAR(64) NOT NULL REFERENCES registered_applications(app_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  web_push BOOLEAN NOT NULL DEFAULT TRUE,
  android_push BOOLEAN NOT NULL DEFAULT TRUE,
  marketing_alerts BOOLEAN NOT NULL DEFAULT FALSE,
  transactional_alerts BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours_start CHAR(5) NOT NULL DEFAULT '22:00',
  quiet_hours_end CHAR(5) NOT NULL DEFAULT '07:00',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_prefs_app_enabled ON notification_preferences(app_id, enabled);

-- 6. Central FCM Notification Campaigns
CREATE TABLE IF NOT EXISTS notification_campaigns (
  notification_id VARCHAR(128) PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  app_id VARCHAR(64) NOT NULL,
  target_type VARCHAR(24) NOT NULL CHECK (target_type IN ('individual', 'group', 'product', 'ecosystem', 'broadcast', 'targeted', 'topic')),
  target_value VARCHAR(128) NOT NULL,
  platform VARCHAR(16) NOT NULL DEFAULT 'all' CHECK (platform IN ('all', 'web', 'android')),
  title VARCHAR(120) NOT NULL,
  body VARCHAR(500) NOT NULL,
  deep_link VARCHAR(256) NOT NULL,
  scheduled_for TIMESTAMPTZ NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'scheduled', 'processing', 'delivered', 'partial_failure', 'failed')),
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 10),
  author_id VARCHAR(128) NOT NULL REFERENCES users(uid),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_app_status ON notification_campaigns(app_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON notification_campaigns(created_at DESC);

-- 7. Notification Delivery Records (Per-Device Attempt Tracking)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id VARCHAR(128) PRIMARY KEY,
  notification_id VARCHAR(128) NOT NULL REFERENCES notification_campaigns(notification_id) ON DELETE CASCADE,
  device_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  platform VARCHAR(16) NOT NULL CHECK (platform IN ('web', 'android')),
  status VARCHAR(24) NOT NULL CHECK (status IN ('delivered', 'failed_transient', 'failed_expired_token', 'skipped_preference')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  fcm_message_id VARCHAR(128) NULL,
  error_code VARCHAR(64) NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON notification_deliveries(notification_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_user ON notification_deliveries(user_id);

-- 8. Admin Activity & Immutable Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id VARCHAR(128) PRIMARY KEY,
  actor_id VARCHAR(128) NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128) NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  details VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);

-- 9. Security Events (OWASP API Top 10 Telemetry)
CREATE TABLE IF NOT EXISTS security_events (
  event_id VARCHAR(128) PRIMARY KEY,
  event_type VARCHAR(48) NOT NULL CHECK (event_type IN ('UNVERIFIED_TOKEN_BLOCKED', 'RBAC_VIOLATION', 'RATE_LIMIT_EXCEEDED', 'IDEMPOTENCY_DUPLICATE_BLOCKED', 'INVALID_PAYLOAD_SANITIZED', 'CORS_ORIGIN_REJECTED', 'EXPIRED_FCM_TOKEN_PRUNED')),
  app_id VARCHAR(64) NOT NULL,
  actor_ip_hash VARCHAR(64) NOT NULL,
  endpoint VARCHAR(128) NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  mitigation_applied VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);

-- 10. System Configuration
CREATE TABLE IF NOT EXISTS system_configs (
  config_key VARCHAR(64) PRIMARY KEY,
  config_value VARCHAR(256) NOT NULL,
  description VARCHAR(256) NOT NULL,
  updated_by VARCHAR(128) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Canonical 5 GoGo Ecosystem Applications
INSERT INTO registered_applications (app_id, name, domain, category, fcm_enabled, web_push_enabled, android_enabled, rate_limit_per_min)
VALUES
  ('gogocompany-in', 'GoGo Company', 'https://gogocompany.in/', 'portal', TRUE, TRUE, TRUE, 180),
  ('sarkari-sarthi', 'Sarkari Sarthi', 'https://gogocompany.in/sarkari-sarthi/', 'civic', TRUE, TRUE, TRUE, 240),
  ('pika-news', 'Pika News', 'https://gogocompany.in/pikanews/', 'news', TRUE, TRUE, TRUE, 300),
  ('arrow-out', 'Arrow Out', 'https://gogocompany.in/arrowout/', 'game', TRUE, TRUE, TRUE, 150),
  ('crystal-quest', 'Crystal Quest', 'https://gogocompany.in/crystalquest/', 'game', TRUE, TRUE, TRUE, 150)
ON CONFLICT (app_id) DO NOTHING;

-- Seed Default System Configurations
INSERT INTO system_configs (config_key, config_value, description, updated_by)
VALUES
  ('fcm_max_retries', '3', 'Bounded exponential backoff retry attempts for transient FCM errors', 'system-bootstrap'),
  ('idempotency_ttl_hours', '72', 'Retention window for notification deduplication keys', 'system-bootstrap'),
  ('global_quiet_hours_enforced', 'true', 'Respect user local quiet hours for non-transactional broadcasts', 'system-bootstrap'),
  ('cloud_run_min_instances', '0', 'Scale-to-zero configuration for ₹0 idle Cloud Run compute cost', 'system-bootstrap')
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
