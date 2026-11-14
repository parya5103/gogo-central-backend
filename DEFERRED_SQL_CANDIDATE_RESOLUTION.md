# Deferred: SQL-Side Notification Candidate Resolution

## Decision

Move notification candidate resolution (individual/group/targeted fan-out)
from the Node.js worker into a SQL query is DEFERRED. Not implemented.

## Rationale

- Current scale does not justify it: the ecosystem has 0 real registered
  devices today; candidate sets are tiny and the worker resolves them in
  memory in microseconds.
- The existing worker already uses atomic PG claims
  (FOR UPDATE SKIP LOCKED, claimDueCampaigns), so multi-instance safety
  does not depend on this change.
- Moving resolution into SQL adds a migration, a new query surface, and
  new failure modes (partial fan-out, pagination state) for zero
  measurable benefit at current scale.

## When to revisit

- When a single campaign routinely targets > ~10,000 devices, or
- when worker memory becomes the bottleneck (candidate lists no longer fit
  comfortably in one process), or
- when fan-out latency delays the HTTP 201 response contract.

## Implementation sketch (for whoever picks this up)

1. Add a parameterized, paginated query in devices.repository:
   SELECT device_id, fcm_token ... FROM devices JOIN preferences
   WHERE app_id = $1 AND status = active AND preference gates,
   ORDER BY device_id, LIMIT/OFFSET (or keyset pagination).
2. Worker loops pages until exhausted, inserting receipts per page.
3. Keep the existing atomic claim semantics; the campaign row remains the
   unit of idempotency.

Never interpolate user input into the query; keep it parameterized.

