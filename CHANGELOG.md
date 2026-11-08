# GoGo Central Backend — Implementation Changelog (`CHANGELOG.md`)

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
