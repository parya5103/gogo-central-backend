# GoGo Central Backend — Versioned REST API Documentation (`API.md`)

All endpoints are versioned under `/api/v1`. Protected routes require a valid Firebase ID token in the `Authorization` header:

```http
Authorization: Bearer <FIREBASE_ID_TOKEN>
Content-Type: application/json
X-GoGo-App-Id: sarkari-sarthi
```

---

## 1. System & Repository Audit Endpoints

### `GET /api/v1/health`
Public container & database health check used by Docker Compose and Cloud Run startup/liveness probes.

**Response `200 OK`**:
```json
{
  "status": "healthy",
  "service": "gogo-central-backend",
  "version": "1.0.0",
  "uptimeSeconds": 1482,
  "architecture": {
    "runtime": "Node.js + TypeScript Strict",
    "auth": "Firebase Admin SDK (verifyIdToken)",
    "messaging": "Firebase Cloud Messaging (FCM v1)",
    "database": "PostgreSQL 16 + Firestore Sync"
  },
  "securityRulesVerified": true
}
```

### `GET /api/v1/audit-report`
Returns the complete Phase 1 Repository Audit of `parya5103/gogo-central-backend` (legacy Cloudflare Workers/D1 findings, reusable components, security risks resolved, and Phase 1–9 status).

---

## 2. Authentication & Identity Endpoints

### `POST /api/v1/auth/verify`
Verifies a client Firebase ID token on the backend via `adminAuth.verifyIdToken()`, syncs the user's `uid` into the central database, and returns server-verified role permissions (`user` | `admin`).

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
Dispatches or schedules an FCM notification campaign with idempotency protection.

- `targetType`:
  - `"individual"` — Send to a single Firebase `uid` (`targetValue: "<uid>"`)
  - `"group"` — Send to a selected user segment (`targetValue: "exam-aspirants" | "vip-gamers" | "breaking-news"`)
  - `"product"` — Broadcast to all opted-in users of `appId` (`targetValue: "all"`)
  - `"ecosystem"` — Broadcast announcement across **all GoGo products** (`appId: "all-gogo"`, `targetValue: "all"`)

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

- `GET /api/v1/audit-logs` *(Admin Only)* — Lists immutable admin and user audit logs.
- `GET /api/v1/security-events` *(Admin Only)* — Lists OWASP API security events (blocked unverified tokens, rate-limit hits, invalid schemas, duplicate idempotency catches).
- `GET /api/v1/system-config` & `PUT /api/v1/system-config` *(Admin Only)* — Manages global FCM retry policies, quiet hours enforcement, and maintenance flags.
- `POST /api/v1/tests/run` *(Admin Only)* — Executes the 18-point automated backend, security, RBAC, idempotency, and Dirty Dozen verification suite.
