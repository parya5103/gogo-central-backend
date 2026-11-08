# GoGo Central Backend — Implementation Changelog (`CHANGELOG.md`)

## [2.0.0] — 2026-11-08 (PostgreSQL Runtime Integration & Production Hardening)

### Runtime Persistence (the headline change)
- **Real PostgreSQL data-access layer**: `src/db/pool.ts` (lazy `pg.Pool` singleton from `SQL_*` env: connection/query timeouts, graceful drain, `withTransaction()` with auto-rollback, `checkDatabaseHealth()`, sanitized `DatabaseUnavailableError` — never credentials), `src/db/migrate.ts` (`schema_migrations` tracking with sha256 checksums under `pg_advisory_lock`; safely repeatable), and nine repositories under `src/repositories/` (users, apps, devices, preferences, campaigns, deliveries, audit, security, config). All production API operations (users, apps, roles, device tokens, preferences, campaigns, delivery receipts, audit logs, security events, system configs) now read/write PostgreSQL; no production dependence on in-memory Maps.
- **Store architecture**: `GoGoDataStore` interface + `resolveDataStore()` — `PostgresDataStore` is the default; the legacy engine survives only behind explicit `InMemoryDataStore` (`GOGO_TEST_IMPORT`/`GOGO_IN_MEMORY_DEMO`). If PostgreSQL is unreachable at startup the service exits with a sanitized error instead of silently serving from memory.
- **Migration `002_postgres_runtime.sql`** (repeatable, non-destructive): `users.email_masked/email_verified/auth_provider/time_zone` (validated IANA), campaign `payload_hash`/`processing_locked_at`/`locked_by`/`next_retry_at` + worker indexes, delivery `skip_reason`/`retry_count`/`next_attempt_at` + extended status CHECK (`skipped_quiet_hours`, `failed_permanent`), delivery FKs (campaigns/devices/users/apps) with `UNIQUE (notification_id, device_id)` idempotent receipts, and the `rate_limit_buckets` table.

### Distributed Idempotency & Durable Worker
- **Database-backed idempotency**: atomic `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` reservation; concurrent duplicates can never create two campaigns (`PGT-09` proves exactly-one-winner across 6 racing inserts). Same key + different payload → `HTTP 409 IDEMPOTENCY_PAYLOAD_MISMATCH` (sha256 canonical payload hash). Durable across restarts and replicas; retention prunes only terminal campaigns.
- **Notification worker** (`src/server/notification-worker.ts`): `FOR UPDATE SKIP LOCKED` campaign claiming (disjoint across instances — `PGT-10`), 5-minute stale-claim reclamation for interrupted processing (`PGT-11`), bounded exponential backoff with jitter, transient-only retries with per-delivery `retry_count` and `failed_permanent` at the cap (`PGT-12`), expired-token pruning with security events, and honest `sent/failed/skipped` counts derived strictly from delivery receipts. Honest at-least-once processing (no exactly-once FCM claims).

### Preferences, Quiet Hours & Timezones
- Server-side preference enforcement before dispatch (enabled/per-platform/marketing/transactional gates) with `skipped_preference` receipts; marketing broadcasts additionally respect per-user quiet hours evaluated in the user's own validated IANA timezone (overnight windows and DST safe; users without a timezone are never assumed UTC). `PGT-13`/`PGT-14`/`PGT-15`.

### Hardening
- **Distributed rate limiting**: `PostgresRateLimitStore` shares express-rate-limit counters across instances via atomic UPSERT (`PGT-18`).
- **Health probes split**: `GET /api/v1/health/live` (process-only; survives brief DB outages) and `GET /api/v1/health/ready` (verifies real PostgreSQL connectivity, `503` when down); Docker/Docker-Compose healthchecks moved to readiness.
- **`db:migrate` now actually migrates** (runs `runMigrations()` against the configured database instead of only verifying the SQL file); `db:backup` output states clearly that the SQL export covers in-memory demo state only and PostgreSQL backups must use `pg_dump` (`scripts/backup-restore.sh`), and `POST /api/v1/db/backup` in PG mode returns `409 BACKUP_USES_PG_DUMP`.
- **CI**: added the PostgreSQL 18 service to all steps plus a real integration suite (`npm run test:pg`, tests `PGT-01`..`PGT-23` covering migrations (concurrent advisory-lock serialization, checksum tampering, atomic failure/retry), persistence, FK integrity, SQL-injection parameterization, idempotency races, worker concurrency, recovery, retry limits, quiet hours/timezones, provider mapping, mocked FCM multicast receipt handling, and the rate-limit store) and a **disposable-database backup/restore verification** (pg_dump custom format → pg_restore into a throwaway container → row-count and index comparison; never production data).
- `pg` added to dependencies; `@types/pg` to devDependencies; version bumped to 2.0.0.
- **Final review fixes (independent PR #2 audit)**:
  - `requireAuth` no longer hardcodes `google.com`: the synced user's provider now comes from the verified token's own `firebase.sign_in_provider` claim via `src/server/auth-provider.ts`. `google.com`, `password`, and `anonymous` (stored as `anonymous_guest`) are accepted; every other or missing provider claim is rejected with `HTTP 401 AUTH_PROVIDER_NOT_SUPPORTED` and a security event (`PGT-22`).
  - Migration runner atomicity: each migration's DDL and its `schema_migrations` record now commit in one transaction (the file's outer `BEGIN`/`COMMIT` is stripped at runtime). A crash can never leave a migration applied-but-unrecorded or half-applied; a failing migration rolls back completely (`PGT-01`/`PGT-20`/`PGT-21`).
  - `FCM_DRY_RUN=true` receipts now carry `dryrun:`-prefixed message IDs on both delivery and retry paths, so validation-only sends can never be mistaken for real delivered pushes.
  - Node.js 24 (LTS) adopted in CI and the Dockerfile, matching the installed `@firebase/*` packages' `engines >= 24.12.0` requirement — this removes the EBADENGINE install warnings without `--force` or `--legacy-peer-deps` (neither flag is used anywhere).
  - FCM per-token error classification now reads the canonical SDK error code (`error.code`) with a stringified fallback instead of relying on `String(error)` alone, so unregistered registration tokens are honestly classified `failed_expired_token` instead of being endlessly retried as transient (`SEC-28`; verified by the mocked-multicast test `PGT-23`).
  - Guarded Firebase test seam (`src/lib/firebase-admin.ts`): test runners (`GOGO_TEST_IMPORT=true` only) can inject deterministic `verifyIdToken`/`sendEachForMulticast` fakes, so provider mapping (`REG-15`..`REG-17`) and FCM multicast receipt handling (`PGT-23`) are genuinely executed in CI. The override setter throws in any non-test process, so production authentication and FCM delivery remain real and fail closed. Mocked tests are always labelled MOCKED and never reported as live Firebase verification.
  - Runtime verification in CI: a dedicated `docker-compose-runtime` job boots the full stack with `docker compose up --build` (PostgreSQL 18 + the app container), probes `/api/v1/health/live` and `/health/ready`, restarts PostgreSQL and proves the process stays live while readiness recovers, then verifies SIGTERM graceful shutdown (drain log line + exit code 0). All state is disposable (`docker compose down -v`); the job posts live stack diagnostics as a PR comment on failure.
  - Toolchain enforcement: CI prints and asserts `node --version`/`npm --version` and fails if the toolchain is below the `@firebase/*` engines requirement (>=24.12.0), both in the test job and inside the running container.
  - Reproducible installs: a dedicated `npm-lockfile` job generates `package-lock.json` with the same Node 24 toolchain, validates a clean `npm ci`, and commits the lockfile to the branch; the CI test job and the Dockerfile install with `npm ci` from that verified lockfile.
  - Docker Compose stack actually boots (HIGH availability defect caught by the new runtime job, the only check that really starts the stack): `postgres:18` images changed the canonical data layout to version-specific subdirectories, so the volume mount moved from `/var/lib/postgresql/data` to `/var/lib/postgresql`. With the old mount path, postgres 18 crash-looped on startup and the backend could never become ready. Local stacks created with pre-18 volumes should recreate the volume (`docker compose down -v`) or migrate with `pg_dump` first.
  - Repository hygiene (SEC-30): a regenerable demo SQL dump committed under `backups/` was removed (backups are never committed; they can contain real data and never belong in Git or the Docker build context), `backups/` and `*.dump` are now ignored in `.gitignore` and `.dockerignore`, and the stale `bun.lock` was removed so npm with the committed, CI-verified `package-lock.json` is the single supported package-manager path.
  - Compose hardening (SEC-29): the file is now explicitly documented as a local development/demo stack (not a production deployment configuration), and the PostgreSQL host port binds to `127.0.0.1` only (`127.0.0.1:5432:5432`), keeping the database reachable from the developer's own machine but no longer exposed on all host interfaces with a development password.
  - Deterministic outage verification: the compose runtime job no longer "restarts" PostgreSQL (which recovers too fast to observe) — it stops the container, asserts readiness actually returns `503` while liveness stays `200`, then after recovery executes a real application-level SQL query through the backend's own pool (`docker exec` + `SELECT` from `schema_migrations`) to prove post-recovery database operations, not just HTTP probes.
  - TypeScript strict mode enabled (SEC-17): a non-blocking CI `tsc --noEmit --strict` audit first measured the full error surface (zero errors across the codebase), then `"strict": true` was enabled in `tsconfig.json`. The main CI type-check step now enforces strict compilation on every push; the temporary informational audit step was removed once strict became the enforced default.
  - Testcontainers (node.testcontainers.org) was evaluated and intentionally not added: CI already runs the integration suite against a real managed PostgreSQL 18 service and boots the real compose stack in a dedicated job; unit tests stay Docker-free; a second container-based PostgreSQL test setup would add a dependency without solving an identified gap (rationale documented in README.md).
  - Availability defect found by the deterministic outage test (SEC-31): the health probes sat behind the PostgreSQL-backed rate limiter, so a database outage 500'd even the process-only /health/live probe (restart-storm risk on Kubernetes/Cloud Run). Probe routes (`/api/v1/health`, `/health/live`, `/health/ready`) are now exempt from the standard limiter — all other `/api/*` routes remain rate-limited — and each limiter owns its own `PostgresRateLimitStore` instance with a unique key prefix, which also eliminates the express-rate-limit `ERR_ERL_STORE_REUSE` warning that was printed at every container boot. Regression coverage: `REG-18` (probe burst returns 200s while a control burst on `/api/v1/overview` still triggers the 429 limiter).

### Disclosed Limitations (v2.0.0)
- Firebase live verification (real ID tokens, revoked-token flow against production Firebase) and live FCM delivery remain BLOCKED: CI runs without Firebase credentials; real-token sends fail honestly (`failed_transient`/transport error) rather than fabricating success. `FCM_DRY_RUN=true` default for local development.
- Docker runtime verification executes on every push (full compose stack boot, live/ready probes, PostgreSQL restart recovery, SIGTERM graceful shutdown with exit code 0); the only runtime aspects not exercised in CI are real Firebase/FCM calls (no credentials) and production traffic conditions.
- Cloud Run deployment is documented but intentionally not provisioned (₹0 mandate; no paid services enabled automatically).
- `bun.lock` was removed — a committed, CI-verified `package-lock.json` with `npm ci` is the single supported reproducible install path. `tsconfig.json` strict mode is now enabled and CI-enforced (SEC-17 fixed).
- `App.tsx` dashboard sandbox-header dev fallback retained (backend gate is the security boundary; unreachable by default).

---

## [1.3.0] — 2026-11-08 (Independent Master Audit: Security & Integrity Remediations)

### Security Fixes
- **[CRITICAL] Sandbox header auth disabled by default (`server.ts`)**: `X-GoGo-Sandbox-Role` now requires explicit `GOGO_ENABLE_SANDBOX_AUTH=true` even outside production; `docker-compose.yml` switched from `NODE_ENV=development` to `production` with `GOGO_ENABLE_SANDBOX_AUTH=false` (the previous default was a full auth bypass on any default deployment).
- **[CRITICAL] Honest FCM dispatch (`src/server/store.ts`)**: Removed unconditional `sendEachForMulticast(payload, true)` dry-run swallowing. Real tokens are now sent in 500-token chunks with `FCM_DRY_RUN` env control and per-token `BatchResponse` processing; demo `fcm_*` tokens are explicitly simulated; `sentCount`/`failedCount` derive strictly from delivery receipts.
- **[HIGH] CORS hardened (`server.ts`)**: Removed unowned `sarkarisaathi.com` from CORS and deepLink allowlists; `CORS_ALLOWED_ORIGINS` env is now actually merged into the allowlist.
- **[HIGH] Real client-IP hashing (`server.ts`, `src/server/store.ts`)**: `actorIpHash` is now a truncated SHA-256 of the extracted trusted client IP (previously a random fabricated value); audit logs capped at 5,000 and security events at 2,000 entries.

### Integrity Fixes
- **[HIGH] Removed fabricated metrics (`src/server/store.ts`)**: No more `registeredDevicesCount`-inflated `sentCount`, fake `fcmMessageIds`, hardcoded `failedCount=0`, or fabricated retry recovery. `retryFailedCampaign` now actually re-sends `failed_transient` receipts.
- **[HIGH] Preference & scheduler enforcement (`src/server/store.ts`)**: Server-side `marketingAlerts`/`transactionalAlerts`/per-platform preference gate with `skipped_preference` receipts; in-process scheduler (30s tick) dispatches `scheduledFor` campaigns (previously accepted but never sent).
- **[HIGH] Honest self-test suite (`src/server/store.ts`)**: Rewrote the 18 hardcoded `passed: true` claims as 13 genuinely executable tests (`TEST-01`..`TEST-13`).
- **[HIGH] Complete backups (`src/db/postgres-config.ts`, `scripts/db-manager.ts`)**: Transactional SQL backup now exports all 10 tables (previously missing `user_app_roles`, `notification_deliveries`, `audit_logs`, `security_events`); `db:restore` honestly reports `RESTORE_FILE_VALIDATED` and documents the `psql` command instead of implying execution.
- **[MEDIUM] Build & CI fixed (`Dockerfile`, `package.json`, `.github/workflows/ci.yml`)**: `npm ci` (impossible without `package-lock.json`) replaced with `npm install`; `tsx` moved to `dependencies` so the runtime `node --import tsx server.ts` command works after dev pruning; package name fixed to `gogo-central-backend`; CI PostgreSQL service upgraded 16 → 18; removed unused `@google/genai` and `motion` dependencies; misleading "TypeScript Strict Mode Verification" step renamed to "TypeScript Type-Check"; esbuild bumped `^0.25.0` → `^0.28.0` to resolve the `vite@8` peer-dependency ERESOLVE conflict that made `npm install` fail; CI now captures step logs and posts failures as PR comments for diagnostics. Full CI pipeline verified green on `fix/master-audit-fixes` (install, Firestore rules lint, `tsc --noEmit`, schema check, 14-test regression suite, vite build, docker build).
- **[MEDIUM] New admin endpoints (`server.ts`)**: `GET /api/v1/audit-logs`, `GET /api/v1/security-events`, `GET /api/v1/system-config` (documented in `API.md`, previously documented but non-existent).
- **[MEDIUM] Regression suite extended (`tests/security-audit.test.ts`)**: Added `REG-11`..`REG-14` (sandbox opt-in enforcement, admin RBAC on new endpoints, honest delivery counts).

### Disclosed Limitations (Documented, Not Fixed)
- Runtime persistence is in-memory only; PostgreSQL 18 schema/config/migrations are designed but not wired into the runtime (`ARCHITECTURE.md` §2a). Idempotency is per-process.
- `tsconfig.json` strict mode remains disabled (enabling requires a local compile loop); `bun.lock` is stale; quiet-hours preferences are stored but not enforced at dispatch; Firebase `GOOGLE_APPLICATION_CREDENTIALS` setup now documented in `README.md`.

---

## [1.2.0] — 2026-11-07 (Cloud SQL Developer Edition Eligibility & PostgreSQL 18 Verification)

### Database & Starter Tier Verification
- **Cloud SQL Developer Edition Eligibility Check**: Inspected `CLOUD_SQL_DEVELOPER_EDITION` eligibility for applet `5caa1dbb-212e-42a0-bc95-df3927ca2fa2`. The platform returned `reasonCode: "NO_VALID_PROJECT"` (`"No valid GCP project found with owner permissions and active billing"`).
- **Zero-Billing Protection**: Halted Cloud SQL provisioning per the user's strict no-billing / free-Starter-Tier-only mandate. Preserved the active ₹0 Firebase Firestore Enterprise database (`ai-studio-5caa1dbb-212e-42a0-bc95-df3927ca2fa2`) and local Docker Compose setup.
- **PostgreSQL 18 Alignment**: Updated `docker-compose.yml` to `postgres:18-alpine` to match Cloud SQL Developer Edition's PostgreSQL 18 runtime and verified all 10 tables, foreign keys, and indexes via `scripts/backup-restore.sh verify-schema`.
- **Full Regression Suite Verification**: Re-executed `npx eslint firestore.rules` and `npm test` (`10/10` HTTP security & regression checks passing).

---

## [1.1.0] — 2026-11-07 (Pre-Phase 9 Advanced Security & Reliability Audit)

### Security Remediations
- **[CRITICAL] Fixed Sandbox Auth Header Bypass (`server.ts`)**: Strictly blocked `X-GoGo-Sandbox-Role` when `NODE_ENV === 'production'`.
- **[HIGH] Fixed Rate Limiter Proxy Validation & Anti-Spoofing (`server.ts`)**: Replaced `validate: false` with `validate: { default: true }` and implemented `extractTrustedClientIp(req)` using `ipKeyGenerator`.
- **[HIGH] Enforced Firebase Token Revocation Check (`server.ts`)**: Upgraded `adminAuth.verifyIdToken(idToken, true)` (`checkRevoked = true`).
- **[HIGH] Protected Diagnostic Self-Test Endpoint (`server.ts`, `src/server/store.ts`)**: Disabled `POST /api/v1/tests/run` in production mode (`HTTP 403`) and isolated test execution.
- **[MEDIUM] Sanitized Public Health Endpoint (`server.ts`)**: Public `GET /api/v1/health` returns only `{ status: "ok", timestamp }`.
- **[MEDIUM] Added Synchronous Idempotency Mutex, Deep-Link Allowlist & Max Retry Cap (`src/server/store.ts`)**.
- **[MEDIUM/LOW] Added `.dockerignore`, Graceful Shutdown, Backup Script & Standalone CI Regression Suite**.

---

## [1.0.0] — 2026-11-07

### Phases 1–8 Initial Build
- Audited `parya5103/gogo-central-backend`, preserved legacy Cloudflare Workers/D1 implementation, and built the 10-table PostgreSQL schema, Zero-Trust Firestore rules, Express `/api/v1` backend, and React 19 Admin Control Plane.
