# Cloudflare Workers + Neon Migration Plan

Status: architecture and deployment plan only; **not a deployable Worker implementation**.

## Decision

Keep Neon PostgreSQL as the authoritative database and evaluate Cloudflare Workers as the API runtime. Do not replace the current production-capable Node.js/Express runtime until the Worker implementation passes the parity and security gates below.

The existing backend already has a provider-independent PostgreSQL layer and Neon connection configuration. Its current production runtime is nevertheless Node.js/Express, uses `pg.Pool`, Firebase Admin SDK, and a long-running PostgreSQL notification worker. Those are not a drop-in Cloudflare Workers deployment.

## Why a direct deploy is unsafe

The current `server.ts` starts an Express HTTP server and Vite middleware. The database layer uses the Node `pg` TCP pool. Authentication calls Firebase Admin `verifyIdToken(token, true)`, which also checks token revocation. Notification delivery uses Firebase Admin Messaging. The durable notification worker is a long-running polling loop.

A Worker has a request/event lifecycle rather than a permanently running Node process. A naive compatibility flag or a Wrangler config would not make these components compatible. In particular:

- Do not replace revoked-token checks with signature-only JWT verification without an explicit security design and tests.
- Do not claim FCM delivery succeeds unless the FCM HTTP v1 response is verified and each device receipt is persisted.
- Do not run a permanent polling loop inside a Worker request. Use Cloudflare Cron Triggers or Queues with bounded work and durable PostgreSQL claims.
- Do not use Node `pg` TCP connections from a Worker. Use the supported Neon serverless HTTP/WebSocket driver and test its runtime compatibility.
- Do not move Firebase service-account JSON, Neon credentials, signing keys, or API secrets into source files or GitHub commits.

## Target topology

```text
GoGo web clients
  | Firebase ID token (Bearer)
  v
Cloudflare Worker API (new adapter; versioned /api/v1 routes)
  |-- Firebase token verification (signature, issuer, audience, expiry,
  |   plus a separately verified revocation strategy)
  |-- authorization / validation / rate limiting / CORS
  |-- Neon serverless driver over HTTPS
  v
Neon PostgreSQL (existing authoritative schema + migrations)

Cloudflare Cron Trigger / Queue
  | bounded worker invocation; claim due campaigns with SKIP LOCKED
  v
Neon PostgreSQL -> Firebase FCM HTTP v1 -> durable per-device receipts
```

The current Node/Express service remains available as the rollback path during rollout. Both runtimes must use the same Neon database schema and migration history; only one runtime should own campaign scheduling at a time.

## Phased implementation

### Phase 0 — Baseline and parity inventory

- Read `KNOWLEDGE.md`, `ARCHITECTURE.md`, `SECURITY.md`, `API.md`, all route handlers, repositories, migrations, and tests.
- Export an exact route/method/auth/role/validation/response matrix from `server.ts`.
- Record current CI results and keep the existing PostgreSQL integration suite as the behavior oracle.
- Confirm Neon project/branch/database ownership and take a verified backup before any live migration.

### Phase 1 — Worker foundation (no production traffic)

- Add a separate `cloudflare-worker/` package using a Workers-native router (for example Hono) and Wrangler configuration.
- Pin compatible dependency versions; enable only the required Workers compatibility flags.
- Add a Worker entrypoint with liveness/readiness endpoints and strict environment bindings.
- Use the Neon serverless driver in its documented Workers-compatible mode. Keep SQL parameterized and preserve transaction boundaries.
- Add local Worker tests and CI type-check/build tests. Do not point it at production Neon during initial tests.

### Phase 2 — Identity and security parity

- Implement Firebase ID-token verification using a maintained JOSE implementation and Google's published signing keys. Validate algorithm, key id, signature, issuer, audience, subject, expiry, and issued-at.
- Design and implement revocation enforcement equivalent to the current `verifyIdToken(token, true)` behavior. If equivalent revocation checks cannot be safely implemented, keep protected routes on the Node runtime; never silently weaken auth.
- Preserve server-side admin role resolution; never trust client role headers or claims that are not issued by the trusted server.
- Port exact CORS allowlists, trusted client-IP handling, rate limits, request-size limits, security headers, Zod schemas, and deep-link allowlists.
- Add negative tests for expired, malformed, wrong-project, revoked, and unsupported-provider tokens; spoofed admin headers; CORS abuse; SQL injection; and oversized payloads.

### Phase 3 — API and persistence parity

- Port each route from the route inventory, retaining its exact request/response contract.
- Reuse the current PostgreSQL schema and migrations; do not create a parallel database or silently reset Neon.
- Port repositories to the Neon serverless driver with parameterized SQL and explicit transaction tests.
- Preserve idempotency keys, payload hashes, `FOR UPDATE SKIP LOCKED` campaign claims, bounded retry/backoff, quiet hours, opt-outs, and immutable audit records.
- Keep existing Firebase Auth and Firestore game-save integrations unchanged.

### Phase 4 — Notification worker

- Replace the permanent Node polling loop with a bounded Cron Trigger or Queue consumer.
- Use database claims and short transactions; never hold a DB transaction open while calling FCM.
- Send through FCM HTTP v1 using short-lived OAuth access tokens generated from a secret-bound service account. Never commit service-account JSON.
- Persist each device result and classify permanent/transient errors. Expired tokens must be revoked. Retry only transient failures with bounded backoff.
- Ensure only one scheduler is active during cutover. Add a dry-run mode and a single-device staging test before any broadcast.

### Phase 5 — Staging, cutover, and rollback

- Deploy a staging Worker using separate Neon branch/database and non-production Firebase credentials.
- Run schema, unit, route-contract, security, integration, concurrency, and notification dry-run suites.
- Compare responses against the Node runtime for every route.
- Test Worker CPU/time limits, Neon connection behavior, Cron/Queue retry semantics, and Cloudflare plan quotas.
- Route one test account/device to staging. Do not send ecosystem-wide notifications during validation.
- Cut over only after all gates pass and the user explicitly approves the production change.
- Keep the Node runtime and its database access ready for rollback. Avoid concurrent campaign schedulers.

## Required GitHub CI gates

- Worker type-check and production build.
- Unit tests for auth, authorization, CORS, validation, rate limiting, deep links, and error sanitization.
- Neon-compatible integration tests against a disposable database branch.
- Route contract parity tests against the existing Node API.
- Campaign idempotency and concurrent-claim tests.
- FCM mocked tests clearly labelled as mocked; no CI claim of live FCM delivery.
- Dependency and secret scanning; fail if credentials or private keys are committed.

## Required runtime configuration (secrets are set outside Git)

Non-secret bindings:
- `FIREBASE_PROJECT_ID`
- `CORS_ALLOWED_ORIGINS`
- `FCM_DRY_RUN` (true by default in staging)

Secret bindings (configure with Wrangler secrets or the Cloudflare dashboard; never commit):
- Neon connection string or the minimum required Neon connection credentials
- Firebase service-account material required for FCM OAuth signing, if using service-account authentication
- Any additional signing/verification secret required by the selected revocation strategy

Do not put actual values in `.dev.vars`, tracked files, Actions logs, PR comments, or chat. Use local untracked files only for development.

## Free-tier and operational caveats

Cloudflare Workers and Neon have free plans with changing quotas and limits. This plan does not promise unlimited execution, always-on background processing, or zero cost. Confirm current account eligibility, request/CPU limits, Cron/Queue availability, Neon compute/storage limits, and data-transfer limits in the provider dashboards before deployment. Configure usage alerts and avoid enabling paid features without explicit approval.

## Acceptance checklist

- [ ] Complete route parity inventory committed.
- [ ] Worker runtime build and tests pass in CI.
- [ ] Firebase token revocation behavior is equivalent or protected routes remain on Node.
- [ ] Neon integration tests pass against a disposable database.
- [ ] Existing PostgreSQL migrations and data remain intact.
- [ ] Notification worker has bounded execution and single-scheduler ownership.
- [ ] FCM receipts, retry limits, preferences, quiet hours, and idempotency match current behavior.
- [ ] Staging smoke test passes, including a single test device.
- [ ] Rollback procedure is tested.
- [ ] User explicitly approves production cutover.

## Current state

This document records the safe migration path. It does not add a Worker entrypoint, deploy a Cloudflare resource, create a Neon project, change production DNS, or migrate live traffic. Those actions require implementation, provider-side authentication, and a successful staging verification first.
