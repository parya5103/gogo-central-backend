# GoGo Central Backend - Agent Instructions

Operating rules for any AI coding agent in parya5103/gogo-central-backend.
This repository is a Node.js/Express/TypeScript FCM + auth control plane on PostgreSQL
(Neon in production, Render hosting). Previous AWS boilerplate in this file was removed by
the 2026-11-24 documentation-sync audit because no AWS resource is used anywhere in this stack.

## Read first
- KNOWLEDGE.md, ARCHITECTURE.md, SECURITY.md, API.md and the relevant docs/ before changing
  backend behavior. Inspect code before modifying it; reuse existing modules; smallest safe change.

## Architecture invariants
- All state lives in PostgreSQL behind the GoGoDataStore interface
  (src/db/pool.ts + src/repositories/*; PostgresDataStore default, fails closed when the
  database is unreachable). InMemoryDataStore only behind explicit test/demo flags.
- Never silently migrate providers, replace persistence, or change public API contracts.
- The legacy Cloudflare Workers/D1 reference is archived; do not delete or reuse it.
- Firestore stays strictly for existing client-side game saves/auth integration; the
  backend relational store must remain PostgreSQL.

## Auth and notification safeguards
- Every authenticated request requires a Firebase ID token verified via
  verifyIdToken(token, checkRevoked = true). Sandbox headers and diagnostic self-test
  endpoints stay disabled in production (fail closed).
- Keep idempotency (unique idempotency_key + payload hash, 409 on mismatch), the synchronous
  in-flight lock, FOR UPDATE SKIP LOCKED campaign claiming, bounded retries, quiet hours and
  the GoGo-domain-deep-link allowlist intact. These are the anti-duplicate-send guarantees.
- FCM_DRY_RUN default true; do not flip or remove dry-run accounting without explicit owner
  authorization.

## Testing requirements
- Every backend change adds/updates focused tests and keeps the CI suites green (unit REG-*,
  Postgres integration PGT-*, matrix MX-*, Docker Compose probe, pg_dump/restore, lockfile,
  typecheck, build). PGT-01/02/21 assert the known-migration count: adding migrations/00N
  requires bumping those assertions.
- Report skipped checks honestly. All repo tests are mocked or synthetic - never claim live
  push delivery without a real registered device and receipts.

## Secrets and cost
- Treat .env, service-account files, private keys, tokens and database URLs as sensitive;
  never commit them, never log them, never return them from API responses. Diagnostic
  endpoints must report credential STATE, never values.
- The budget mandate is Rs 0: do not provision cloud resources or change the deployment
  without explicit owner approval.

## Process
- Inspect first; feature branches + PRs; conventional commits; update docs when behavior
  changes; no force push; no history rewrite; no merging pull requests or deploying
  without explicit owner authorization.
