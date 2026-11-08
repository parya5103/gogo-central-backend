# GoGo Central Backend — System Architecture (`ARCHITECTURE.md`)

## 1. High-Level Topology

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           GoGo Client Properties                           │
│  [GoGo Company] [Sarkari Sarthi] [Pika News] [Arrow Out] [Crystal Quest]   │
│         (Web Push Service Worker + Future Android Kotlin FCM SDK)          │
└───────────────────┬────────────────────────────────────┬───────────────────┘
                    │ 1. Firebase ID Token (Bearer)      │ 2. Existing Auth &
                    ▼                                    ▼    Game Saves
┌───────────────────────────────────────┐    ┌───────────────────────────────┐
│     GoGo Central Backend (Node 22)    │    │   Firebase Auth & Firestore   │
│   Express + TypeScript + Zod          │◄──►│  (Preserved Existing Data +   │
│   Helmet + Rate Limiter + CORS Guard  │    │   Game Saves Untouched)       │
└─────────┬───────────────────┬─────────┘    └───────────────────────────────┘
          │                   │
          ▼                   ▼
┌───────────────────┐ ┌──────────────────────────────────────────────────────┐
│ PostgreSQL 18 DB  │ │         Firebase Cloud Messaging (FCM v1 API)        │
│ (Provider-Indep.) │ │  • Web Push VAPID Multicast                          │
│ • Local Docker 18 │ │  • Android Notification + Data Payloads              │
│ • Android Termux  │ │  • Durable PG Idempotency + Bounded Backoff Retry   │
│ • Cloud SQL / Neon│ └──────────────────────────────────────────────────────┘
└───────────────────┘
```

---

## 2. Authoritative 10-Table PostgreSQL 18 Schema (`migrations/001_initial_schema.sql`)

PostgreSQL is never replaced by Firestore. All 10 backend domain tables are defined in `migrations/001_initial_schema.sql` with foreign keys, composite indexes, and `CHECK` constraints:

### 2a. Runtime Persistence (Real PostgreSQL Runtime — v2.0.0)

Since v2.0.0 the runtime is PostgreSQL-backed by default. All production state (users, apps, roles, devices, preferences, campaigns, delivery receipts, audit logs, security events, system configs, rate-limit buckets) is served from PostgreSQL through a real `pg` data-access layer. The in-memory Maps engine survives only as an explicit, clearly-labelled demo/test adapter.

**Layer structure:**

- `src/db/pool.ts`: lazy singleton `pg.Pool` built from `SQL_*` env via `resolvePostgresConfig()`; statement/query timeouts, idle handling, graceful `closePool()`, `checkDatabaseHealth()`, parameterized `query()` helper, `withTransaction()` (auto-rollback), `DatabaseUnavailableError` sanitization (no credentials in errors/logs).
- `src/db/migrate.ts`: `runMigrations()` applies `migrations/*.sql` in order inside a `pg_advisory_lock`; every applied file is recorded in `schema_migrations` with a sha256 checksum. Re-runs are safe (skips applied files) and loud (checksum mismatch on an edited applied migration aborts startup).
- `src/repositories/*.repository.ts`: `users`, `apps`, `devices`, `preferences`, `campaigns`, `deliveries`, `audit`, `security`, `config`. All SQL is parameterized; no string interpolation of user input.
- `src/server/data-store.ts`: `GoGoDataStore` interface + `resolveDataStore()`:
  - `GOGO_TEST_IMPORT=true` or `GOGO_IN_MEMORY_DEMO=true` → `InMemoryDataStore` (wraps the legacy engine; test/demo only).
  - Otherwise → `PostgresDataStore`: runs migrations, starts the worker loop, and fails startup with a sanitized error if PostgreSQL is unreachable. **Production never silently falls back to memory.**
- `src/server/notification-worker.ts`: durable worker. Due campaigns are claimed with `FOR UPDATE SKIP LOCKED` (safe across replicas), stale `processing` claims are reclaimed after 5 minutes (crash recovery), transient delivery failures retry with bounded exponential backoff + jitter, permanent failures are terminal, and retention pruning only deletes terminal campaigns.
- `src/server/rate-limit-pg.ts`: `PostgresRateLimitStore` keeps express-rate-limit counters in the `rate_limit_buckets` table via a single atomic UPSERT per hit, so limits hold across Cloud Run replicas (the default MemoryStore is per-process and would multiply limits per instance).

**Idempotency is durable:** `notification_campaigns.idempotency_key` has a UNIQUE constraint; `insertCampaignIfAbsent` uses atomic `INSERT ... ON CONFLICT DO NOTHING`, so concurrent or replayed requests can never create a duplicate campaign (a stored sha256 payload hash makes key reuse with a different payload a `409 IDEMPOTENCY_PAYLOAD_MISMATCH`). This is honest at-least-once processing, not claimed exactly-once FCM delivery (external FCM cannot guarantee that).

**Quiet hours & timezones:** `users.time_zone` (validated IANA identifier) is set per user; quiet-hours evaluation runs in the user's own timezone with correct overnight-window and DST handling. Users without a timezone are never silently assumed to be in UTC (quiet hours are not enforced for them, documented).

The 10-table schema above is live and enforced; migration `002_postgres_runtime.sql` adds the runtime columns (`users.email_masked/email_verified/auth_provider/time_zone`, campaign `payload_hash`/worker-lock/`next_retry_at`, delivery `skip_reason`/`retry_count`/`next_attempt_at`, extended delivery status CHECK, `rate_limit_buckets`), plus delivery FKs with `UNIQUE (notification_id, device_id)` idempotent receipts.

1. **`users`**: `uid` (PK, Firebase Auth UID), `display_name`, `role` (`user` | `admin`), `is_active`, `created_at`, `updated_at`.
2. **`registered_applications`**: `app_id` (PK), `name`, `domain`, `category` (`portal` | `civic` | `news` | `game`), `fcm_enabled`, `web_push_enabled`, `android_enabled`, `rate_limit_per_min`.
3. **`user_app_roles`**: `id` (PK), `user_id` (FK -> `users.uid`), `app_id` (FK -> `registered_applications.app_id`), `app_role`, `last_seen_at`, `created_at`.
4. **`device_tokens`**: `device_id` (PK), `user_id` (FK), `app_id` (FK), `fcm_token` (UNIQUE), `platform` (`web` | `android`), `user_agent`, `status` (`active` | `revoked` | `expired`), `last_refreshed_at`, `created_at`, `updated_at`.
5. **`notification_preferences`**: `pref_id` (PK `{userId}_{appId}`), `user_id` (FK), `app_id` (FK), `enabled`, `web_push`, `android_push`, `marketing_alerts`, `transactional_alerts`, `quiet_hours_start`, `quiet_hours_end`.
6. **`notification_campaigns`**: `notification_id` (PK), `idempotency_key` (UNIQUE), `app_id`, `target_type`, `target_value`, `platform`, `title`, `body`, `deep_link`, `scheduled_for`, `status`, `sent_count`, `failed_count`, `retry_count`, `author_id` (FK), `created_at`, `updated_at`.
7. **`notification_deliveries`**: `delivery_id` (PK), `notification_id` (FK), `device_id`, `user_id`, `app_id`, `platform`, `status` (`delivered` | `failed_transient` | `failed_expired_token` | `skipped_preference`), `attempt_count`, `fcm_message_id`, `error_code`, `delivered_at`.
8. **`audit_logs`**: `log_id` (PK), `actor_id`, `app_id`, `action`, `resource_id`, `severity`, `details`, `created_at` (append-only, immutable).
9. **`security_events`**: `event_id` (PK), `event_type`, `app_id`, `actor_ip_hash`, `endpoint`, `severity`, `mitigation_applied`, `created_at`.
10. **`system_configs`**: `config_key` (PK), `config_value`, `description`, `updated_by`, `updated_at`.

---

## 3. Provider-Independent PostgreSQL Layer (`src/db/postgres-config.ts`)

`resolvePostgresConfig()` adapts connection pooling, TLS/SSL, and socket routing automatically based on `PG_PROVIDER`:

- **`local` (Default — ₹0)**: Connects to `127.0.0.1:5432` (`ssl: false`, `pool.max: 10`) for Docker Compose (`postgres:18-alpine`) or native Android Termux (`postgresql`).
- **`neon` (Serverless Free Tier — ₹0)**: Connects to `ep-*.neon.tech:5432` with `ssl: { rejectUnauthorized: true }` and `pool.max: 5` optimized for PgBouncer serverless connection pooling.
- **`cloudsql` (Google Cloud SQL for PostgreSQL 18)**: Connects via Cloud SQL Auth Proxy Unix domain socket (`/cloudsql/PROJECT:REGION:INSTANCE`) or Private IP (`pool.max: 10`, `connectionTimeoutMillis: 15000`).

---

## 4. Database Backup & Transactional Recovery Architecture

1. **Cross-Platform Node.js SQL Exporter (`npm run db:backup` & `POST /api/v1/db/backup`)**:
   - Generates `backups/gogo_central_latest.sql` wrapped in `BEGIN; ... COMMIT;` with idempotent `INSERT INTO ... ON CONFLICT DO UPDATE` statements across all 10 domain tables (including `user_app_roles`, `notification_deliveries`, `audit_logs`, and `security_events`).
   - `npm run db:restore` validates the exported SQL file structure (status `RESTORE_FILE_VALIDATED`) and prints the `psql --single-transaction` command to execute the restore; it does not itself execute SQL against a live database.
2. **Native PostgreSQL Shell Utility (`scripts/backup-restore.sh`)**:
   - `bash ./scripts/backup-restore.sh backup` creates a gzip-compressed `pg_dump` archive against a live PostgreSQL 18 instance.
   - `bash ./scripts/backup-restore.sh restore <file>` restores using `psql --single-transaction --set ON_ERROR_STOP=on`.
   - Both subcommands require a running PostgreSQL instance; the in-memory development store cannot be dumped by `pg_dump`.

---

## 5. Runtime Dispatch, Scheduler & Environment Variables

- FCM dispatch is receipt-honest: `sentCount`/`failedCount` derive strictly from per-device delivery receipts in PostgreSQL. Demo `fcm_*` tokens are simulated as delivered (marked with `simulated:` message IDs) so the stack runs without Firebase credentials; real tokens go through `adminMessaging.sendEachForMulticast` in 500-token chunks (`FCM_DRY_RUN` supported; missing credentials fail the real send honestly, never fabricating success).
- Immediate campaigns are processed inline (preserving the HTTP 201 + counts contract); the durable worker loop is the safety net for interrupted processing. Scheduled campaigns (`scheduledFor` in the future) are dispatched by the PostgreSQL-backed worker when due, so scheduling survives restarts and replicas.
- Health endpoints: `GET /api/v1/health/live` (process-only liveness; does not fail on a database outage), `GET /api/v1/health/ready` (readiness; returns 503 while PostgreSQL connectivity fails), and the original `GET /api/v1/health` for compatibility.
- `GOGO_ENABLE_SANDBOX_AUTH` (default unset): opt-in for `X-GoGo-Sandbox-Role` header auth in non-production environments. Always rejected in production mode.
- `GOGO_IN_MEMORY_DEMO=true`: explicit demo-mode escape hatch using the legacy in-memory engine (never for production).
- `FCM_DRY_RUN` (default unset): when `true`, real-token FCM requests are sent in FCM dry-run mode (validated, not delivered). Requires Firebase credentials either way.
- `CORS_ALLOWED_ORIGINS`: comma-separated extra origins merged into the hardcoded `gogocompany.in` allowlist. Unowned third-party domains are no longer allowed.
- `NODE_ENV=production`: disables sandbox headers, the `/api/v1/tests/run` self-test endpoint, and the App.tsx dev dashboard fallback expectations.
