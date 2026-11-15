# GoGo Central Backend — Versioned REST API Documentation (`API.md`)

All endpoints are versioned under `/api/v1`. Protected routes require a valid Firebase ID token in the `Authorization` header:

```http
Authorization: Bearer <FIREBASE_ID_TOKEN>
Content-Type: application/json
X-GoGo-App-Id: sarkari-sarthi
```

Local testing alternative: `X-GoGo-Sandbox-Role: admin | user` headers are rejected everywhere by default and always rejected in production mode. They only work when `NODE_ENV !== "production"` and `GOGO_ENABLE_SANDBOX_AUTH=true` is explicitly set for local/CI testing.

---

## 1. System & Repository Audit Endpoints

### `GET /api/v1/health`
Public liveness probe used by legacy integrations. Intentionally minimal: no version, uptime, infrastructure, or project identifiers are exposed publicly.

**Response `200 OK`**:
```json
{
  "status": "ok",
  "timestamp": "2026-11-08T12:00:00.000Z"
}
```

### `GET /api/v1/health/live`
Process-only liveness probe (Cloud Run / Docker). Returns `200` as long as the Node process is serving HTTP. It deliberately does NOT fail when PostgreSQL is temporarily unavailable, so a brief database outage does not kill healthy instances.

### `GET /api/v1/health/ready`
Readiness probe. Verifies actual PostgreSQL connectivity through the runtime pool (not a stub). Returns `503 Service Unavailable` with `{ "status": "unavailable" }` while the database is unreachable, and `200 OK` with `{ "status": "ready", "database": "connected" }` otherwise. Use this for container health checks and Cloud Run readiness.

### `GET /api/v1/health/detailed` *(Admin Only)*
Protected diagnostics endpoint exposing uptime, Firebase project ID, store metrics, and the active `persistenceMode` (`"postgres"` in production; `"in-memory"` only in explicit demo/test mode).

### `GET /api/v1/overview`
Protected overview of registered apps, users, devices, and campaigns. Requires Firebase auth (or the sandbox header when `GOGO_ENABLE_SANDBOX_AUTH=true` in non-production environments).

---

## 2. Authentication & Identity Endpoints

### `POST /api/v1/auth/verify`
Verifies a client Firebase ID token on the backend via `adminAuth.verifyIdToken()`, syncs the user's `uid` into the central database, and returns server-verified role permissions (`user` | `admin`).

The synced user's `authProvider` is read from the verified token's own `firebase.sign_in_provider` claim (`google.com` | `password` | `anonymous`, stored as `anonymous_guest`) — never hardcoded and never client-supplied.

**Responses**:
- `200 OK` — token verified; server-side role returned.
- `401 Unauthorized` — invalid/expired token (`AUTH_INVALID_ID_TOKEN`), revoked session (`AUTH_TOKEN_REVOKED`), missing/malformed Bearer header (`AUTH_MISSING_TOKEN` / `AUTH_MALFORMED_TOKEN`), or a token minted by an unsupported sign-in provider such as phone, custom, or SAML (`AUTH_PROVIDER_NOT_SUPPORTED`).

```bash
curl -X POST http://localhost:3000/api/v1/auth/verify \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"appId": "gogocompany-in"}'
```

---

## 3. Registered GoGo Applications (`gogo_apps`)

### `GET /api/v1/apps`
Lists all registered GoGo ecosystem applications (`gogocompany-in`, `sarkari-sarthi`, `pika-news`, `arrow-out`, `crystal-quest`, plus any dynamically added products).

### `POST /api/v1/apps` *(Admin Only)*
Dynamically registers a new GoGo product without rebuilding or redeploying the backend.

```json
{
  "appId": "gogo-cricket",
  "name": "GoGo Cricket Live",
  "domain": "https://gogocompany.in/cricket/",
  "category": "news",
  "fcmEnabled": true,
  "webPushEnabled": true,
  "androidEnabled": true,
  "rateLimitPerMin": 180
}
```

### `PATCH /api/v1/apps/:appId` *(Admin Only)*
Updates product notification switches (`fcmEnabled`, `webPushEnabled`, `androidEnabled`) or rate limits (`rateLimitPerMin`) and records an immutable audit log.

---

## 4. Device & FCM Token Lifecycle (`device_tokens`)

### `GET /api/v1/devices`
Returns registered FCM tokens. Regular users receive only their own tokens (`userId === req.user.uid`); admins can filter by `appId`, `platform`, or `status`.

### `POST /api/v1/devices/register`
Registers or refreshes a Web Push or Android FCM token for the authenticated user and target GoGo product.

```json
{
  "appId": "sarkari-sarthi",
  "fcmToken": "fcm_web_vapid_token_98a7bc65d4e3f2a1b0c9d8e7f6a5b4c3",
  "platform": "web",
  "userAgent": "Mozilla/5.0 (Linux; Android 14) Chrome/131.0"
}
```

### `DELETE /api/v1/devices/:deviceId`
Revokes or removes an FCM device token. Enforces ownership (`device.userId === req.user.uid`) or `admin` role.

---

## 5. Per-User, Per-App Notification Preferences (`notification_preferences`)

### `GET /api/v1/preferences`
Returns the authenticated user's notification preferences across all GoGo products.

### `PUT /api/v1/preferences/:appId`
Updates the authenticated user's notification preferences for a specific GoGo product without affecting other GoGo products.

```json
{
  "enabled": true,
  "webPush": true,
  "androidPush": true,
  "marketingAlerts": false,
  "transactionalAlerts": true,
  "quietHoursStart": "22:00",
  "quietHoursEnd": "07:00"
}
```

---

## 6. Central FCM Notification Dispatch (`notification_campaigns` & `notification_deliveries`)

### `POST /api/v1/notifications/send` *(Admin Only)*
Dispatches or schedules an FCM notification campaign with durable, database-backed idempotency protection (unique `idempotency_key` constraint; safe across restarts and multiple instances).

- `targetType`:
  - `"individual"` — Send to a single Firebase `uid` (`targetValue: "<uid>"`)
  - `"group"` — Send to a selected user segment (`targetValue: "exam-aspirants" | "vip-gamers" | "breaking-news"`)
  - `"product"` — Broadcast to all opted-in users of `appId` (`targetValue: "all"`)
  - `"ecosystem"` — Broadcast announcement across **all GoGo products** (`appId: "all-gogo"`, `targetValue: "all"`)
  - `"topic"` — **Not an accepted value.** Requests fail schema validation with `400 Invalid notification campaign payload` (Zod issue on `targetType`). Topic delivery is not implemented (no topic subscriptions exist); it is never silently converted into a broadcast. Defense-in-depth: the delivery worker also fails closed with `TOPIC_TARGETING_NOT_IMPLEMENTED` if a topic campaign ever reaches it.

- **`200 OK` with `duplicatePrevented: true`** — the idempotency key was seen before with the same payload; the original campaign is returned and nothing is re-sent.
- **`409 Conflict` (`IDEMPOTENCY_PAYLOAD_MISMATCH`)** — the idempotency key was reused with a different payload; nothing is dispatched.
- Immediate campaigns are processed inline and return `201 Created` with honest counts; future-dated `scheduledFor` campaigns return `201 Created` with `status: "scheduled"` and are dispatched by the durable PostgreSQL worker when due (survives restarts and replicas).

```json
{
  "idempotencyKey": "idem_sarkari_upsc_2026_11_07_01",
  "appId": "sarkari-sarthi",
  "targetType": "product",
  "targetValue": "all",
  "platform": "all",
  "title": "UPSC Civil Services Admit Card Released",
  "body": "Download your verified hall ticket and exam center details on Sarkari Sarthi.",
  "deepLink": "https://gogocompany.in/sarkari-sarthi/admit-cards",
  "scheduledFor": null
}
```

### `POST /api/v1/notifications/:notificationId/retry` *(Admin Only)*
Safely retries temporary delivery failures using bounded exponential backoff while skipping permanently expired tokens.

---

## 7. Security Events, Audit Logs & Automated Self-Test Suite

- `GET /api/v1/audit-logs` *(Admin Only)* — Lists immutable admin and user audit logs. Supports `?limit=<1..200>` (default 50, newest first). Returns `{ auditLogs, count, total }`.
- `GET /api/v1/security-events` *(Admin Only)* — Lists OWASP API security events (blocked unverified tokens, rate-limit hits, invalid schemas, duplicate idempotency catches). Supports `?limit=<1..200>`. Returns `{ securityEvents, count, total }`.
- `GET /api/v1/system-config` *(Admin Only)* — Lists global FCM retry policies, quiet hours enforcement, and maintenance flags. Returns `{ systemConfigs, count }`.
- `PUT /api/v1/system-config/:configKey` *(Admin Only)* — Updates a single config entry by key. Body: `{ "configValue": "<1..256 chars>" }`. Returns `404` if the key does not exist.
- `POST /api/v1/tests/run` *(Admin Only, disabled in production mode)* — In in-memory demo mode, executes the 13-test automated backend, security, RBAC, idempotency, scheduler, backup, and Dirty Dozen verification suite. In the PostgreSQL runtime it honestly returns `status: "SKIPPED"` and points at the dedicated integration suite (`npm run test:pg`) instead of reporting in-memory results as if they described the runtime.

Note on delivery metrics: `sentCount` counts only confirmed deliveries, `failedCount` counts transient/expired-token/permanent failures, and devices skipped by user notification preferences or quiet hours are recorded as `skipped_preference` / `skipped_quiet_hours` receipts and counted in neither. Counts are derived strictly from per-device delivery receipts in PostgreSQL; there is no inflation by `registeredDevicesCount`. Delivery receipt statuses: `delivered`, `failed_transient`, `failed_expired_token`, `failed_permanent`, `skipped_preference`, `skipped_quiet_hours`. When `FCM_DRY_RUN=true`, FCM validates requests without delivering and the resulting receipts carry `dryrun:`-prefixed message IDs (never real delivery confirmations); delivery is at-least-once by design (see `SECURITY.md`).

---

## Addendum — v2.1.0 (Ecosystem Notification Readiness)

### GET /api/v1/overview
New top-level field `fcmDryRun: boolean` — `true` when the server runs with `FCM_DRY_RUN=true` (receipts carry `dryrun:`-prefixed message IDs and nothing is really delivered). The admin panel renders the delivery-mode badge from this flag.

### POST /api/v1/devices/register — register-or-refresh semantics
`fcm_token` is globally unique. Re-registering the same token (web token refresh after a service-worker update, re-opt-in, or a returning device) now refreshes the existing row: `user_id`, `platform` and `user_agent` are updated, `status` returns to `active`, `last_refreshed_at` is bumped, and the original `device_id` is preserved (stable audit identity). It never creates a second row, so the same physical device cannot be targeted twice in one campaign. Previously this failed with HTTP 500 (unique-constraint violation).

### Notification matrix coverage
`tests/notification-matrix.test.ts` (MX-01..MX-12) covers: per-product registration for all five products, duplicate-token refresh, the Firebase auth failure contract, admin-only broadcast protection, user opt-out enforcement, platform preference gates, invalid-token cleanup, ecosystem (`appId: "all-gogo"`, `targetType: "ecosystem"`) target selection, and retry/idempotency behavior. FCM multicast responses are MOCKED via the `GOGO_TEST_IMPORT`-guarded seam; live delivery verification is a manual post-deployment step (`docs/DEPLOYMENT.md`).


## OpenAPI Description

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 document. Request-body
schemas are generated from the live Zod validators via `z.toJSONSchema` at
request time, so the document cannot drift from actual validation.
Staleness is guarded by REG-21 in `tests/security-audit.test.ts`.
