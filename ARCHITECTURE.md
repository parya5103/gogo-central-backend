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
│ • Android Termux  │ │  • Synchronous Idempotency Mutex + 3x Backoff Retry  │
│ • Cloud SQL / Neon│ └──────────────────────────────────────────────────────┘
└───────────────────┘
```

---

## 2. Authoritative 10-Table PostgreSQL 18 Schema (`migrations/001_initial_schema.sql`)

PostgreSQL is never replaced by Firestore. All 10 backend domain tables are defined in `migrations/001_initial_schema.sql` with foreign keys, composite indexes, and `CHECK` constraints:

### 2a. Current Persistence Reality (Honest Status)

The runtime today stores all state in in-memory Maps inside `src/server/store.ts` (users, devices, preferences, campaigns, delivery receipts, audit logs, security events, system configs). No PostgreSQL client is imported anywhere in the runtime; `PG_*` connection variables are consumed only by `src/db/postgres-config.ts` configuration resolution and the migration/backup scripts. Consequences:

- All state is lost on process/container restart.
- Idempotency protection is in-memory per-process; a restart clears idempotency keys, and two app replicas would not share the mutex.
- Audit logs and security events are capped in memory (5,000 audit logs / 2,000 security events, oldest dropped) to prevent unbounded growth.
- The PostgreSQL 18 schema below is fully designed and migration-ready (see section 4), but wiring it into the Express runtime requires adding a `pg` dependency and repository layer. This is the single largest remaining engineering task and is intentionally not half-implemented: cross-process idempotency (`notification_campaigns.idempotency_key UNIQUE`), durable receipts, and restart-safe state all depend on it.

The schema as designed:

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

- FCM dispatch is receipt-honest: `sentCount`/`failedCount` derive strictly from per-device delivery receipts. Demo `fcm_*` tokens are simulated as delivered (marked with `simulated:` message IDs) so the stack runs without Firebase credentials; real tokens go through `adminMessaging.sendEachForMulticast` in 500-token chunks.
- Scheduled campaigns (`scheduledFor` in the future) are dispatched by an in-process scheduler (`startScheduler`, 30s tick, singleton auto-start). On restart, still-pending scheduled campaigns are re-scanned from memory; once PostgreSQL wiring lands, scheduling must move to a durable queue.
- `GOGO_ENABLE_SANDBOX_AUTH` (default unset): opt-in for `X-GoGo-Sandbox-Role` header auth in non-production environments. Always rejected in production mode.
- `FCM_DRY_RUN` (default unset): when `true`, real-token FCM requests are sent in FCM dry-run mode (validated, not delivered). Requires Firebase credentials either way.
- `CORS_ALLOWED_ORIGINS`: comma-separated extra origins merged into the hardcoded `gogocompany.in` allowlist. Unowned third-party domains are no longer allowed.
- `NODE_ENV=production`: disables sandbox headers, the `/api/v1/tests/run` self-test endpoint, and the App.tsx dev dashboard fallback expectations.
