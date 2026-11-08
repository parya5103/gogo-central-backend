# GoGo Central Backend (`parya5103/gogo-central-backend`)

A secure, centralized, multi-product backend and Firebase Cloud Messaging (FCM) control plane serving the entire **GoGo Company** ecosystem at **₹0 local development cost**:

1. **GoGo Company** — `https://gogocompany.in/` (`gogocompany-in`)
2. **Sarkari Sarthi** — `https://gogocompany.in/sarkari-sarthi/` (`sarkari-sarthi`)
3. **Pika News** — `https://gogocompany.in/pikanews/` (`pika-news`)
4. **Arrow Out** — `https://gogocompany.in/arrowout/` (`arrow-out`)
5. **Crystal Quest** — `https://gogocompany.in/crystalquest/` (`crystal-quest`)
6. **Future GoGo Products** — Dynamically onboarded via `POST /api/v1/apps` without rebuilding the backend.

---

## 1. Quick Start — Desktop / Laptop (Docker Compose + PostgreSQL 18 at ₹0)

### Prerequisites
- Docker & Docker Compose v2+
- Node.js 24+ (LTS; the installed `@firebase/*` packages declare `engines >= 24.12.0`, so Node 24 avoids EBADENGINE install warnings without `--force` or `--legacy-peer-deps`)

### Commands
```bash
# 1. Copy environment template
cp .env.example .env

# 2. Start PostgreSQL 18 (postgres:18-alpine) + GoGo Central Backend
docker compose up --build

# 3. Verify health check & run the security regression suite
curl http://localhost:3000/api/v1/health
npm test
```

`npm test` runs 14 live HTTP regression tests (`REG-01`..`REG-14`) against an in-process app instance. It self-activates the `GOGO_ENABLE_SANDBOX_AUTH=true` test opt-in; the deployed server itself keeps sandbox headers disabled by default.

---

## 1a. Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | unset (= development) | `production` disables sandbox headers, the self-test endpoint, and the dev dashboard fallback. `docker-compose.yml` sets it to `production`. |
| `GOGO_ENABLE_SANDBOX_AUTH` | unset (= disabled) | Opt-in for `X-GoGo-Sandbox-Role: admin/user` header auth in non-production local/CI testing. Never enable in production or on any internet-reachable deployment. |
| `GOGO_IN_MEMORY_DEMO` | unset (= PostgreSQL runtime) | When `true`, runs the legacy in-memory engine with demo seeds instead of PostgreSQL. Demo/offline use only — never production. The PostgreSQL runtime is the default. |
| `FCM_DRY_RUN` | unset (= real sends) | When `true`, real-token FCM requests are validated by Firebase without delivering. Requires `GOOGLE_APPLICATION_CREDENTIALS` to point at a service-account key either way. |
| `CORS_ALLOWED_ORIGINS` | unset | Comma-separated extra origins merged into the GoGo-owned allowlist (`gogocompany.in` and subdomains). |
| `SQL_HOST`, `SQL_PORT`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`, `PG_PROVIDER` | see `.env.example` | PostgreSQL connection settings consumed by the runtime pool (`src/db/pool.ts`), the migration runner, and backup/restore scripts. If the database is unreachable at startup in PostgreSQL mode, the server exits with a sanitized error (never a silent in-memory fallback). |
| `PG_STATEMENT_TIMEOUT_MS`, `PG_QUERY_TIMEOUT_MS` | `15000` | Per-statement/query guard rails (milliseconds) against hostile or stalled queries. |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | Path to the Firebase service-account JSON used by `firebase-admin` for Auth verification and FCM. Without it, the server runs with demo `fcm_*` token simulation and Firebase token verification fails closed (401). |

---

## 1b. Persistence Status (v2.0.0)

The Express runtime is now PostgreSQL-backed by default: all users, apps, roles, device tokens, preferences, campaigns, delivery receipts, audit logs, security events, and system configs are served through the repository layer over a real `pg` pool. Migrations are tracked in `schema_migrations` and applied automatically at startup (`npm run db:migrate` does the same on demand). Idempotency is durable (database UNIQUE constraint), and scheduled campaign dispatch is a restart-safe worker loop. The in-memory engine remains only as an explicit demo mode (`GOGO_IN_MEMORY_DEMO=true`). Verification: the CI PostgreSQL 18 service runs the integration suite `npm run test:pg` (PGT-01..PGT-19) on every push/PR.

### Run the PostgreSQL integration tests locally

```bash
# Requires a disposable PostgreSQL 18 instance (docker compose up -d postgres)
export SQL_HOST=127.0.0.1 SQL_PORT=5432 SQL_DB_NAME=gogo_central \
       SQL_USER=gogo_app_user SQL_PASSWORD=local_dev_only_password_change_in_prod
npm run test:pg
```

Never point `SQL_*` (or the tests) at production: the tests write synthetic rows.

---

## 2. Complete Android / Termux Local Setup Guide (₹0 Cost)

### 2.1 Understanding Docker Limitations on Android / Termux
- **Why Standard Docker Fails on Unrooted Android**: Docker Engine (`dockerd`) and `docker compose` require Linux kernel namespaces (`USER_NS`, `PID_NS`, `NET_NS`), `cgroups v2`, and `overlayfs` mounts that are disabled in stock, unrooted Android OEM kernels. Attempting `docker run` or `docker compose up` directly in standard Termux will fail with `cgroups: cannot find cgroup mount destination` or permission errors.
- **Recommended Solution on Unrooted Android**: Run **native Termux `postgresql` + `nodejs-lts`** directly in user space! Both PostgreSQL and Node.js compile natively for `aarch64` (ARM64) in Termux and run at full native speed with **zero root access and ₹0 cost**.
- *(Optional QEMU Workaround)*: If you strictly need to test `Dockerfile` builds on an unrooted Android phone, you must boot an Alpine Linux x86_64/ARM64 virtual machine inside `qemu-system-aarch64` (`pkg install qemu-system-aarch64-headless`), which carries a ~4x CPU/RAM overhead. Therefore, native Termux PostgreSQL is strongly preferred for daily coding.

### 2.2 Step-by-Step Native Termux Setup (Unrooted Android)

```bash
# Step 1: Update Termux packages and install Node.js LTS, PostgreSQL, and Git
pkg update && pkg upgrade -y
pkg install -y nodejs-lts postgresql git bash

# Step 2: Initialize and start the local Termux PostgreSQL cluster
mkdir -p $PREFIX/var/lib/postgresql
initdb -D $PREFIX/var/lib/postgresql
pg_ctl -D $PREFIX/var/lib/postgresql -l $PREFIX/var/lib/postgresql/logfile start

# Step 3: Create the GoGo database user and database
createuser -s gogo_app_user || true
createdb -O gogo_app_user gogo_central || true

# Step 4: Clone repository and install dependencies
git clone https://github.com/parya5103/gogo-central-backend.git
cd gogo-central-backend
npm install

# Step 5: Apply the tracked migrations (001 + 002, safely repeatable, checksummed)
npm run db:migrate

# Step 6: Verify schema, run security + PostgreSQL integration tests, start the server
npm run db:verify
npm test
npm run test:pg
npm run dev
```
Open `http://127.0.0.1:3000` in your Android browser (Chrome / Brave / Firefox) to use the full Admin Control Plane locally!

---

## 3. Database Migration, Backup & Restore Commands

The repository provides both a cross-platform Node.js CLI (`scripts/db-manager.ts`) and a native `pg_dump`/`psql` shell script (`scripts/backup-restore.sh`):

```bash
# 1. Verify all 10 PostgreSQL tables, indexes, and foreign keys + active PG_PROVIDER
npm run db:verify

# 2. Apply all pending migrations (schema_migrations-tracked, checksummed, repeatable)
npm run db:migrate

# 3. Authoritative PostgreSQL backup (pg_dump custom format) & disposable-database restore
bash ./scripts/backup-restore.sh backup
bash ./scripts/backup-restore.sh restore ./backups/gogo_central_<TIMESTAMP>.sql.gz
# CI additionally proves the round trip: pg_dump -> pg_restore into a throwaway
# container -> row-count/index comparison (never against production).

# 4. Demo-mode SQL export (in-memory engine state ONLY — not a PostgreSQL backup)
npm run db:backup
npm run db:restore
```

---

## 4. Provider-Independent PostgreSQL Configuration (`src/db/postgres-config.ts`)

Switch PostgreSQL providers purely via environment variables without changing any backend code:

| Provider Mode (`PG_PROVIDER`) | Target Environment | Required Variables | Cost Tier |
| :--- | :--- | :--- | :--- |
| `PG_PROVIDER="local"` | Local Docker Compose (`postgres:18-alpine`) or Android Termux | `SQL_HOST=127.0.0.1`, `SQL_PORT=5432`, `SQL_DB_NAME=gogo_central`, `SQL_USER=gogo_app_user` | **₹0 / month** |
| `PG_PROVIDER="neon"` | Neon Serverless PostgreSQL (Cloud Free Tier) | `SQL_HOST=ep-*.neon.tech`, `SQL_DB_NAME=gogo_central`, `SQL_USER=...`, `SQL_PASSWORD=...` (TLS enabled automatically) | **₹0 / month** (within 0.5 GB & 100 CU-hrs/mo) |
| `PG_PROVIDER="cloudsql"` | Google Cloud SQL for PostgreSQL 18 | `SQL_HOST=/cloudsql/PROJECT:REGION:INSTANCE`, `SQL_DB_NAME=gogo_central`, `SQL_USER=...`, `SQL_PASSWORD=...` | Paid (`~₹1,204/mo`) unless Starter Tier eligible |

---

## 5. Readiness Matrix: Local vs. Cloud Hosting vs. Live Website Integration

| Capability | Works Locally Now (₹0) | Requires Cloud Hosting (Cloud Run + DB) | Required Before Connecting Live GoGo Websites |
| :--- | :--- | :--- | :--- |
| **10-Table PostgreSQL Schema & Migrations** | Yes (`docker-compose.yml` / Termux) | Cloud SQL or Neon Free Tier for 24/7 internet reachability | Apply `001_initial_schema.sql` to production DB |
| **Firebase ID Token Verification (`verifyIdToken`)** | Yes (`checkRevoked = true`) | Same Firebase project (`gen-lang-client-0566323659`) | Ensure all 5 websites use the shared Firebase project ID |
| **FCM Notification Engine & Idempotency** | Yes (Deduplication, retries, token lifecycle) | Public HTTPS URL for webhook/background workers | Add Web Push `firebase-messaging-sw.js` + VAPID key on each site |
| **Admin Dashboard & RBAC Security** | Yes (`http://localhost:3000`) | Cloud Run HTTPS URL (`--min-instances=0`) | Configure `CORS_ALLOWED_ORIGINS` for `https://gogocompany.in` |
| **Backup & Transactional Restore** | Yes (`npm run db:backup` exports all 10 tables; `db:restore` validates the dump and prints the `psql` restore command) | Automated daily cron or Cloud SQL backups | Verify initial backup before onboarding live traffic |
