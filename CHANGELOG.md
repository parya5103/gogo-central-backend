# GoGo Central Backend — Implementation Changelog (`CHANGELOG.md`)

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
