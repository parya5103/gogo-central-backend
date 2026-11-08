# GoGo Central Backend — Security Policy & Audit Report (`SECURITY.md`)

## 1. Independent Security Audit & Remediation Report (Pre-Phase 9)

| Finding ID | Severity | Vulnerability Identified | Resolution & Regression Test | Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **CRITICAL** | `X-GoGo-Sandbox-Role` preview header was not blocked when `NODE_ENV=production`, risking authentication bypass in production. | Restricted `X-GoGo-Sandbox-Role` strictly to non-production environments; production mode returns `HTTP 401 AUTH_SANDBOX_DISABLED_IN_PROD` and logs a `CRITICAL` security event. Verified by `REG-01`. | **FIXED** |
| **SEC-02** | **HIGH** | `validate: false` in `express-rate-limit` suppressed proxy validation checks instead of properly handling `Forwarded` and `X-Forwarded-For` headers. | Implemented `extractTrustedClientIp(req)` using `app.set('trust proxy', 1)` + right-most RFC 7239 `Forwarded` fallback + `ipKeyGenerator()`, and re-enabled `validate: { default: true }`. Verified by `REG-02`. | **FIXED** |
| **SEC-03** | **HIGH** | `adminAuth.verifyIdToken(idToken)` did not pass `checkRevoked = true`, allowing revoked Firebase sessions to remain valid until JWT expiry. | Enabled `adminAuth.verifyIdToken(idToken, true)` and added explicit `auth/id-token-revoked` handling (`HTTP 401`). Verified by `REG-04`. | **FIXED** |
| **SEC-04** | **HIGH** | `POST /api/v1/tests/run` diagnostic endpoint was reachable in production mode and ran against the primary store. | Disabled `POST /api/v1/tests/run` in production (`HTTP 403 TEST_ENDPOINT_DISABLED_IN_PRODUCTION`) and isolated all test runs into an ephemeral `GoGoCentralBackendEngine` instance. Verified by `REG-03`. | **FIXED** |
| **SEC-05** | **MEDIUM** | Public `GET /api/v1/health` disclosed `firebaseProjectId`, internal version strings, and database row counts to unauthenticated callers. | Reduced public `GET /api/v1/health` to `{ status: "ok", timestamp }` and moved detailed diagnostics to admin-protected `GET /api/v1/health/detailed`. Verified by `REG-07`. | **FIXED** |
| **SEC-06** | **MEDIUM** | Notification `deepLink` accepted arbitrary external URLs (phishing risk), concurrent duplicate requests lacked a synchronous pre-await mutex, and retries were unbounded. | Added `isAllowedGoGoDeepLink()` HTTPS GoGo domain allowlist, `inFlightIdempotencyKeys` synchronous mutex, and `fcm_max_retries` (3x) enforcement. Verified by `REG-08` & `REG-09`. | **FIXED** |
| **SEC-07** | **MEDIUM** | Missing `.dockerignore` risked copying `.env` and `.git` into Docker build context; missing `SIGTERM` graceful shutdown and PostgreSQL backup verification script. | Added `.dockerignore`, `SIGTERM`/`SIGINT` connection draining in `server.ts`, and `scripts/backup-restore.sh`. Verified by `REG-10`. | **FIXED** |
| **SEC-08** | **LOW** | GitHub Actions CI did not execute a standalone HTTP security regression test runner. | Added `tests/security-audit.test.ts` (`npm test`) and wired it as a blocking step in `.github/workflows/ci.yml`. | **FIXED** |

---

## 2. Defense-in-Depth Architecture

### 2.1 Identity & Authentication
- **Firebase ID Token + Revocation Verification**: Every protected backend route requires `Authorization: Bearer <Firebase_ID_Token>` verified via `adminAuth.verifyIdToken(token, true)`.
- **Zero Impact on Existing Flows**: Existing Google Sign-In, Email/Password login, password reset, guest mode, and Firestore game saves on `Arrow Out` and `Crystal Quest` remain untouched.

### 2.2 Role-Based Access Control (RBAC) & Data Isolation
- **`user` Role**: Can register/revoke only their own FCM device tokens (`userId === req.user.uid`) and read/update only their own per-app notification preferences (`prefId === ${uid}_${appId}`).
- **`admin` Role**: Verified server-side via `/admins/{uid}` and verified root admin email (`aaryapratik@gmail.com`). Required for broadcasting notifications, modifying app-level rate limits, reading documentation blueprints, and inspecting security audit logs.

### 2.3 Network, Rate Limiting & Input Hardening
- **Anti-Spoofing Rate Limiters**:
  - `standardApiLimiter`: 180 req/min/IP keyed by `extractTrustedClientIp(req)`.
  - `sensitiveMutationLimiter`: 30 req/min/IP on `/api/v1/auth/verify`, `/api/v1/notifications/send`, `/api/v1/apps`, `/api/v1/devices`, and `/api/v1/preferences`.
- **Strict Zod Schemas (`.strict()`)**: Rejects shadow/unknown fields (`unrecognized_keys`) and strips `<script>`, `javascript:`, and inline `on*=` event handlers.
