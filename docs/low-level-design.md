# Low-Level Design & Data Model

## 1. Monorepo Modules

| Package / App | Role | Highlights |
| --- | --- | --- |
| `@fb3/contracts` | Shared Zod request schemas | `loginSchema`, `usageEventSchema` |
| `@fb3/database` | PostgreSQL pool, migrations (`001`–`003`), RLS helper | `tenantTransaction(orgId, actorId, fn)` sets transaction-local `app.organization_id` |
| `@fb3/metering` | Quota engine & usage query adapter | Redis Lua `QuotaService` (`reserve`, `commit`, `release`, `snapshot`), `PostgresAnalyticsAdapter` |
| `@fb3/api` (`apps/api`) | NestJS HTTP API (`:4000`) | Argon2 + HS256 JWT + refresh-token family revocation, Stripe webhooks, DLQ admin, `/metrics` |
| `@fb3/worker` (`apps/worker`) | BullMQ + Outbox Relay (`:4001`) | 1s outbox relay (`SKIP LOCKED`), worker concurrency 20, `reconcileAndRepair()` hourly job |
| `apps/web` | Next.js operator & simulator UI (`:3000`) | Idempotency replay simulator, stage latency trace waterfall, quota burn-rate & DLQ board |

---

## 2. Database Schema & Tenant Security (`packages/database/migrations/`)

1. **Strict Multi-Tenant RLS (`FORCE ROW LEVEL SECURITY`)**: Enabled across all **11** tenant-scoped tables (`memberships`, `teams`, `team_members`, `invitations`, `subscriptions`, `entitlement_overrides`, `usage_events`, `usage_aggregates`, `outbox`, `audit_log`, `invoices`). Queries executed without `SET LOCAL app.organization_id` match zero tenant rows.
2. **Append-Only Triggers**: `reject_mutation()` triggers block `UPDATE` and `DELETE` on `usage_events` and `audit_log`.
3. **Database Idempotency Constraints**:
   - `usage_events`: `UNIQUE (organization_id, idempotency_key)` + `CHECK (quantity > 0)`
   - `processed_events`: `PRIMARY KEY (consumer, event_id)`
   - `stripe_events`: `PRIMARY KEY (id)` + monotonic `stripe_event_created` guard (`WHERE stripe_event_created <= excluded.stripe_event_created`) preventing out-of-order webhook regression.

---

## 3. Quota State & End-to-End Trace Stages

- **Redis Key Layout (`QuotaService`)**:
  - `quota:<orgId>:<metric>:<YYYY-MM>:used`
  - `quota:<orgId>:<metric>:<YYYY-MM>:reserved` (`EXPIRE 300s` safety net)
- **Failure Policy (`QUOTA_FAILURE_POLICY`)**: Defaults to `"closed"` (throws on Redis error); `"open"` returns `{ allowed: true, degraded: true }` for availability over strict capping.
- **Per-Event Provenance (`GET /usage/events/:id/trace`)**: Joins `usage_events`, `outbox`, `processed_events`, and `usage_aggregates` to compute millisecond offsets for `accepted → published → processed → aggregated`.
