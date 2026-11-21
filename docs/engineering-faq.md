# Engineering FAQ

This guide prepares engineering walkthroughs on the idempotent SaaS billing and usage metering architecture, concurrency guarantees, and production trade-offs.

---

## 1. 60-Second Elevator Pitch

> We built a multi-tenant SaaS metering and subscription platform (`apps/api`, `apps/worker`, `apps/web`, `@fb3/metering`, `@fb3/database`). Every metered usage event goes through a two-phase atomic Redis Lua quota check, writes an immutable usage row and a transactional outbox event inside a PostgreSQL `FORCE ROW LEVEL SECURITY` transaction using `ON CONFLICT(organization_id, idempotency_key) DO NOTHING`, publishes via a `FOR UPDATE SKIP LOCKED` BullMQ relay, folds idempotently into hourly materialized buckets, and runs an hourly drift reconciler directly over the raw event ledger.

---

## 2. Core Technical Interview Q&A

### Q1: Why use two-phase Redis quota (`reserve` → `commit` / `release`) instead of just `INCRBY`?
- If two requests arrive concurrently when quota is nearly full, a simple read-then-write race lets both pass (`used + qty <= limit`).
- `reserveLua` checks `used + reserved + requested <= limit` and increments `:reserved` with a TTL in one atomic Lua execution.
- If PostgreSQL returns `duplicate` (idempotency conflict) or rolls back, the API calls `release()` so duplicates never hold permanent quota; only freshly inserted rows call `commit()` (`reserved -= qty; used += qty`).

### Q2: How do you guarantee a stored event is never lost between Postgres and BullMQ?
- **Transactional Outbox Pattern**: The `usage_events` row and the `outbox` row (`topic = 'usage.recorded'`) share the same SQL commit inside `tenantTransaction`.
- The worker's outbox publisher runs `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100` so concurrent relay workers never contend on the same rows, enqueues the job onto BullMQ with deterministic `jobId = outbox.id`, and marks `published_at = now()`.

### Q3: Why store raw `usage_events` separately from `usage_aggregates` AND run an hourly reconciler?
- Reading raw events on every dashboard load doesn't scale; reading pre-aggregated hourly buckets (`usage_aggregates`) keeps dashboard & burn-rate queries instant.
- Because `usage_events` is protected by an append-only `reject_mutation()` trigger, `reconcileAndRepair()` can deterministically re-derive any hour via `SUM(quantity)` and overwrite drift or delete orphaned buckets safely.

### Q4: How do you protect Stripe subscription state against delayed/out-of-order webhooks?
- Each `stripe_events.id` is deduplicated first via `INSERT ... ON CONFLICT DO NOTHING`.
- Even across distinct event IDs, Stripe does not guarantee strict chronological delivery. Updates on `subscriptions` and `invoices` check `stripe_event_created <= excluded.stripe_event_created` so a delayed older webhook can never overwrite newer subscription state.

### Q5: How is multi-tenant isolation enforced beyond application `WHERE` clauses?
- Every request calls `tenantTransaction(orgId, actorId, fn)`, which executes `SET LOCAL app.organization_id = $1` inside an explicit transaction.
- All 11 tenant tables enforce `ALTER TABLE ... FORCE ROW LEVEL SECURITY` with policies checking `organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`, so even an application SQL omission fails closed inside PostgreSQL.
- Auth also enforces **refresh-token family rotation**: reusing a revoked/stale refresh token revokes the entire `family_id` chain immediately.

### Q6: What would need hardening for multi-region cloud production?
- Provision managed HA PostgreSQL + Redis via Terraform (not yet checked into this local Compose stack), partition `usage_events` monthly by `occurred_at`, move outbox relay to Debezium/CDC at very high ingest throughput, and enable mTLS / secret rotation on JWT signing keys.
