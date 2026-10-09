# FB-3 — SaaS billing and metering

Portfolio-grade multi-tenant usage billing: Next.js dashboard, NestJS API, BullMQ worker, PostgreSQL RLS, Redis atomic quotas, and optional Stripe test-mode billing.

## Demo tour

Sign in with `demo@fb3.local` / `DemoPass123!`, then:

1. **Overview:** inspect realistic monthly entitlements and the live API-request chart.
2. **Simulate usage:** send an idempotent event through Redis quota reservation, the PostgreSQL outbox, BullMQ, and hourly aggregation.
3. **Members and Teams:** inspect role-based collaboration and seat allocation.
4. **Billing:** compare versioned plans, preview an invoice, and follow the safe checkout result flow.
5. **Admin:** inspect active overrides, audit evidence, operational status, and DLQ health.

Production demo deployments set `PUBLIC_DEMO=true`. The API—not only the UI—then blocks organization, member, invitation, team, plan, entitlement, and replay mutations. Usage simulation and demo checkout remain interactive, while shared records remain stable for the next visitor. Set `PUBLIC_DEMO=false` in a private environment to restore normal role-authorized management.

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis
corepack pnpm install
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000. Seed login: `demo@fb3.local` / `DemoPass123!`. The UI authenticates against the API, rotates the HttpOnly refresh session, loads live usage through the PostgreSQL analytics adapter, and exposes working organization, member, invitation, team, billing, and admin workflows. Stripe keys are optional only when `LOCAL_DEMO_MODE=true`; production and normal non-demo environments reject unsigned webhooks and unavailable checkout.

## Architecture

- `apps/web`: authenticated Tailwind/Recharts dashboard with distinct Usage, Members, Teams, Billing, and Admin screens plus checkout result handling.
- `apps/api`: rotating sessions/logout, live-membership RBAC, organization and team management, invitations, usage/quota, plans/overrides/audit, DLQ operations, checkout/invoices, verified Stripe lifecycle projection, structured logs, Prometheus metrics, and PostgreSQL/Redis health.
- `apps/worker`: transactional-outbox publisher, BullMQ aggregate consumer, dedupe, retries, inspectable DLQ, replay, operational health/metrics, and automatic aggregate repair.
- `packages/database`: ordered `schema_migrations`, forced RLS transaction context, repeatable seed.
- `packages/metering`: Redis Lua hard reservation/commit/release and PostgreSQL `AnalyticsAdapter`.
- `packages/contracts`: shared Zod API contracts.
- `infra/terraform`: Cloud Run API/worker, HA Cloud SQL/Redis and Secret Manager. Deploy the web workspace to Vercel.

Usage ingestion atomically reserves quota before inserting the immutable event and outbox row. It commits the Redis reservation only after PostgreSQL commits, releases on duplicate/failure, returns 80% soft-limit warnings, and applies the configured open/closed dependency-failure policy. The publisher locks unpublished rows, queues them with the outbox ID, then marks them published. The consumer records `(consumer,event_id)` before updating hourly aggregates.

```text
Dashboard -> NestJS ingest -> Redis quota -> PostgreSQL event + outbox
                                              |
                                              v
                                    BullMQ worker -> hourly aggregate -> dashboard
```

The PostgreSQL analytics implementation queries `usage_aggregates` behind `AnalyticsAdapter`; BigQuery or ClickHouse can implement that interface without changing product APIs.

## Security and threat model

- Tenant tables carry `organization_id`, have forced RLS, and are only accessed after transaction-local tenant context is set.
- Argon2id passwords, 15-minute access JWTs and hashed, rotating 30-day refresh tokens. Refresh reuse revokes the whole token family.
- RBAC roles are owner/admin/member/billing and every protected request rechecks current membership; privileged mutations write the immutable audit log. Overrides are time-bounded.
- Webhooks use the exact raw request body and Stripe signature; unsigned payloads are accepted only in explicit non-production demo mode. Persisted event IDs deduplicate retries and projector timestamps prevent stale subscription/invoice state rollback.
- Immutable triggers protect usage and audit evidence. Idempotency keys are tenant-scoped.
- Redis quota checks are one Lua operation. `closed` is the safe default outage policy; `open` is available for non-critical workloads and emits degraded status to callers.
- Primary threats: cross-tenant IDOR (RLS + membership-scoped token), replay (idempotency/dedupe), refresh theft (hashed rotation/reuse detection), webhook forgery (raw-body HMAC), quota races (Lua), and privileged abuse (bounded overrides + immutable audit).
- Production requirements: HTTPS, managed key rotation, private SQL/Redis networking, CSP/CSRF controls, WAF/rate limits, alerting, PITR drills, and restricted service accounts.

## Operations runbook

- **Health:** `GET /health`; scrape `GET /metrics`. Alert on API 5xx, outbox oldest-unpublished age, DLQ depth, reconciliation mismatches, Redis latency, and SQL saturation.
- **Public demo:** keep `PUBLIC_DEMO=true`, `LOCAL_DEMO_MODE=false`, and strong JWT secrets. The repeatable seed refreshes the portfolio workspace without duplicating sample records.
- **Replay:** owners/admins inspect `GET /admin/dlq` and replay a repaired job with `POST /admin/dlq/:id/replay`; the API removes it from DLQ only after enqueue succeeds.
- **Reconcile:** the worker recomputes expected hourly buckets from immutable events, upserts mismatches, removes orphan buckets, and reports repair counts at `/metrics`.
- **Stripe incident:** retain the raw event in `stripe_events`; correct configuration, clear its error, and replay with Stripe CLI. Never synthesize event signatures.
- **Quota outage:** choose `QUOTA_FAILURE_POLICY=closed` for paid/expensive operations. If temporarily changed to `open`, cap upstream rate and reconcile accepted usage before restoring.
- **RLS debugging:** reproduce as the application role with `set_config` inside a transaction; never grant the runtime role `BYPASSRLS`.
- **Backup:** Cloud SQL PITR daily verification; quarterly restore drill. Redis is rebuildable from PostgreSQL aggregates and active reservations.

## Verification

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
docker compose up -d postgres redis
pnpm db:migrate && pnpm db:seed
pnpm db:migrate
pnpm test
pnpm --filter @fb3/web exec playwright install chromium
pnpm --filter @fb3/web test:e2e
docker compose config
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
```

Stripe end-to-end requires test-mode `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`. Checkout places the organization ID in the session and subscription metadata. Use `stripe listen --forward-to localhost:4000/stripe/webhook`; Test Clocks are compatible because projectors order state by Stripe event creation time.
