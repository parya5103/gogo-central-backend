# GoGo Central Backend — Project Knowledge Base (`KNOWLEDGE.md`)

## 0. Master Audit State (2026-11-08, v2.0.0)

- **v1.3.0**: an independent master audit of all repository files produced findings SEC-09..SEC-18 (see `SECURITY.md` §1a) covering sandbox-auth defaults, FCM dry-run swallowing, fabricated metrics, CORS misconfig, backup gaps, and in-memory persistence. All security/integrity fixes shipped and CI-verified.
- **v2.0.0**: the PostgreSQL runtime milestone landed. The Express runtime now serves all state (users, apps, roles, devices, preferences, campaigns, delivery receipts, audit logs, security events, system configs) from PostgreSQL through `src/db/pool.ts` + `src/repositories/*` behind the `GoGoDataStore` interface (`PostgresDataStore` default; `InMemoryDataStore` only behind explicit `GOGO_TEST_IMPORT`/`GOGO_IN_MEMORY_DEMO`). Startup fails closed if the database is unreachable. Migration `002_postgres_runtime.sql` is applied by the checksummed `schema_migrations` runner.
- **Durable idempotency & worker**: unique `idempotency_key` with atomic INSERT..ON CONFLICT reservation and sha256 payload hash (`409 IDEMPOTENCY_PAYLOAD_MISMATCH` on key reuse with a different payload); `FOR UPDATE SKIP LOCKED` campaign claiming; 5-minute stale-claim recovery; bounded backoff retries; honest at-least-once processing (no exactly-once FCM claims). Quiet hours enforced per-user in validated IANA timezones (marketing campaigns only). Rate limits shared across instances via `rate_limit_buckets`.
- **Verification evidence**: CI on the feature branch runs the real integration suite `npm run test:pg` (PGT-01..PGT-19 against the PostgreSQL 18 service: migrations, persistence, FK integrity, idempotency races, worker SKIP LOCKED, recovery, retry caps, opt-out/quiet-hours/timezone, SQL-injection parameterization, rate-limit store) plus a disposable-database pg_dump/pg_restore round-trip with row-count comparison. Check the CI check runs on the PR for the authoritative status.
- **Still open (do not assume fixed)**: Firebase live token/revocation verification and live FCM delivery (no credentials in CI; real sends fail honestly), Docker runtime execution as a live service (image built in CI only), Cloud Run deployment (documented, not provisioned, ₹0 mandate), tsconfig strict enablement, `bun.lock` staleness, Firebase emulator rules tests, `App.tsx` sandbox-header dev fallback (backend gate is the boundary).

---

## 1. Repository Audit: `parya5103/gogo-central-backend`

### 1.1 Legacy Architecture Findings
- **Legacy Stack**: Cloudflare Workers + Cloudflare D1 (SQLite-at-edge) merged implementation.
- **Preservation Policy**: The legacy Cloudflare Workers/D1 implementation is **strictly preserved untouched** as an archived reference branch/layer. None of its worker bindings or D1 tables are silently reused or deleted.
- **Why We Built the New Architecture Separately**:
  1. **Unified Firebase UID Identity**: All GoGo products already rely on Firebase Authentication (Google Sign-In, Email/Password, Password Reset, and Guest/Anonymous Game Saves in Firestore). Native `firebase-admin` token verification (`verifyIdToken(token, true)`) and FCM SDK (`getMessaging()`) run cleanly in a standard Node.js 22 container on Cloud Run without V8 isolate crypto workarounds.
  2. **Provider-Independent PostgreSQL 18 Persistence**: PostgreSQL 18 (`migrations/001_initial_schema.sql`) is the authoritative relational backend schema, configured via `src/db/postgres-config.ts` to run seamlessly across Local Docker Compose (`postgres:18-alpine`), native Android/Termux PostgreSQL, Neon Serverless PostgreSQL (₹0 Free Tier), or Google Cloud SQL for PostgreSQL 18.
  3. **Zero Disruption to Live Properties**: Existing websites (`GoGo Company`, `Sarkari Sarthi`, `Pika News`, `Arrow Out`, `Crystal Quest`) continue using their existing Firebase Auth and Firestore game saves without any breaking changes.

---

## 2. GoGo Ecosystem Product Catalog

| Product Slug | Product Name | Primary Domain / Path | Category | Existing Auth / Data Footprint | Notification Use Cases |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gogocompany-in` | **GoGo Company** | `https://gogocompany.in/` | `portal` | Firebase Auth (SSO Hub) | Ecosystem announcements, security alerts, new product launches |
| `sarkari-sarthi` | **Sarkari Sarthi** | `https://gogocompany.in/sarkari-sarthi/` | `civic` | Firebase Auth + Firestore bookmarks | Exam deadlines, admit card releases, Sarkari job results, government scheme alerts |
| `pika-news` | **Pika News** | `https://gogocompany.in/pikanews/` | `news` | Firebase Auth + 30-min news aggregator | Breaking headlines across technology, business, sports, gaming, and entertainment |
| `arrow-out` | **Arrow Out** | `https://gogocompany.in/arrowout/` | `game` | Firebase Auth + Guest Mode + Firestore game saves | Daily puzzle challenges, leaderboard resets, tournament rewards |
| `crystal-quest` | **Crystal Quest** | `https://gogocompany.in/crystalquest/` | `game` | Firebase Auth + Guest Mode + Firestore game saves | Energy refill alerts, seasonal quests, cloud-save sync confirmations |

---

## 3. Core Architectural Decisions (ADRs)

### ADR-001: Common Identity via Firebase UID with Revocation Verification
- Every authenticated API request requires `Authorization: Bearer <Firebase_ID_Token>`.
- The backend verifies the token via `adminAuth.verifyIdToken(token, true)` (`checkRevoked = true`) and extracts `uid`, `email`, and `email_verified`.
- In production (`NODE_ENV=production`), sandbox testing headers (`X-GoGo-Sandbox-Role`) and diagnostic self-test endpoints (`POST /api/v1/tests/run`) are strictly disabled (`HTTP 401` / `HTTP 403`).

### ADR-002: Trusted Cloud Run Proxy & Anti-Spoofing Rate Limiting
- Cloud Run's Google Front End (GFE) appends the real client IP as the right-most hop in `X-Forwarded-For` and `Forwarded`.
- Express is configured with `app.set('trust proxy', 1)` so `req.ip` resolves strictly to the 1st reverse-proxy hop from the right, ignoring any fake left-most IPs prepended by an attacker.
- `express-rate-limit` uses a custom `extractTrustedClientIp(req)` key generator wrapped in `ipKeyGenerator()` with `validate: { default: true }` enabled.

### ADR-003: Synchronous In-Flight Idempotency Lock & Deep-Link Domain Allowlist
- Concurrent requests carrying the same `idempotencyKey` are serialized by a synchronous in-memory `inFlightIdempotencyKeys` mutex before any async `await` call, preventing race-condition duplicate FCM broadcasts.
- Every notification `deepLink` is validated against `isAllowedGoGoDeepLink()`, restricting click targets to `https://` URLs on registered GoGo domains.
- Retries (`POST /api/v1/notifications/:id/retry`) are capped by `fcm_max_retries` (default `3`).

### ADR-004: Provider-Independent PostgreSQL 18 & Zero-Cost Android/Termux Support
- **PostgreSQL Never Replaced by Firestore**: PostgreSQL (`migrations/001_initial_schema.sql`) remains the central backend relational schema for all 10 domain tables; Firestore is preserved strictly for existing client-side game saves and AI Studio auth integration.
- **Provider-Independent Adapter (`src/db/postgres-config.ts`)**: Supports `PG_PROVIDER=local` (Docker Compose `postgres:18-alpine` or native Termux `postgresql`), `PG_PROVIDER=neon` (Neon ₹0 Free Tier with TLS pooling), and `PG_PROVIDER=cloudsql` (Google Cloud SQL Unix socket or Private IP).
- **Android / Termux Workflow**: Because unrooted Android kernels lack `cgroups` and namespace mounts required by `dockerd`, developers on Android can run the entire stack natively in Termux (`pkg install nodejs-lts postgresql`) with `npm run db:verify`, `npm run db:backup`, `npm run db:restore`, and `npm run dev` at ₹0 cost.
