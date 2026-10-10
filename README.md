# FB-3 — SaaS billing and metering

Portfolio-grade multi-tenant usage billing: Next.js dashboard, NestJS API, BullMQ worker, PostgreSQL RLS, Redis atomic quotas, and optional Stripe test-mode billing.

## Demo tour

Sign in with `demo@fb3.local` / `DemoPass123!`, then:

1. **Overview:** the system health strip (Postgres, Redis, queue depth, outbox lag, p95 processing, dead letters), quota cards with 24h sparklines, burn rate and exhaustion forecast, live ingestion throughput, and the tenant-isolation context.
2. **Usage:** a multi-metric timeline (24h/72h/7d/30d, absolute or normalized, CSV export), a month-to-date budget burn-down with limit and 80% soft-alert lines, a 7×24 hour-of-day heatmap, and top dimensions from raw events.
3. **Simulate usage:** send one event or a burst of ×5/×10, or reuse the idempotency key to watch the API return `duplicate` and release the reservation. Each call shows status, latency, `x-request-id` and the JSON response.
4. **Events:** browse immutable `usage_events` with stage chips (ingested → published → processed), then open a trace that shows millisecond offsets per stage and the hourly bucket the event landed in.
5. **Pipeline:** live counters for each stage (outbox pending and lag, BullMQ waiting/active/failed, worker backlog, DLQ), per-minute throughput and p50/p95/p99 end-to-end latency.
6. **API:** an authenticated playground for the real endpoints with copyable `curl`, request history, and runtime metrics parsed from the Prometheus registry.
7. **Members, Teams, Billing, Admin:** seat usage and RBAC, invoice line items, a what-if cost estimator across the plan catalog, override windows, expandable DLQ jobs, and a day-grouped audit timeline.

Read-only operations endpoints back these views. Each is tenant-scoped with an explicit `organization_id` filter in addition to RLS: `GET /ops/pipeline`, `GET /ops/metrics`, `GET /quota/status`, `GET /usage/events?limit=&metric=&source=`, `GET /usage/events/:id/trace` and `GET /analytics/usage?range=24h|72h|7d|30d&granularity=hour|day`.

Production demo deployments set `PUBLIC_DEMO=true`. The API—not only the UI—then blocks organization, member, invitation, team, plan, entitlement, and replay mutations. Usage simulation and demo checkout remain interactive, while shared records remain stable for the next visitor. Set `PUBLIC_DEMO=false` in a private environment to restore normal role-authorized management. Simulations are capped at 500 units per event and `PUBLIC_DEMO_DAILY_EVENTS` (default 500) events per day.

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

- `apps/web`: authenticated Tailwind/Recharts operations console (Overview, Usage, Events, Pipeline, API, Members, Teams, Billing, Admin). Shared UI lives in `app/components` and includes an accessible themed listbox, so no native dropdowns are used. The API client and visibility-aware polling live in `app/lib/api.ts`.
- `apps/api`: rotating sessions/logout, live-membership RBAC, organization and team management, invitations, usage/quota, plans/overrides/audit, DLQ operations, checkout/invoices, verified Stripe lifecycle projection, structured logs, Prometheus metrics, and PostgreSQL/Redis health.
- `apps/worker`: transactional-outbox publisher, BullMQ aggregate consumer, dedupe, retries, inspectable DLQ, replay, operational health/metrics, and automatic aggregate repair.
- `packages/database`: ordered `schema_migrations`, forced RLS transaction context, repeatable seed. The seed writes 30 days of raw events with outbox and processed rows and rebuilds aggregates from them, so the hourly reconciler keeps the history.
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
- **RLS debugging:** reproduce as the application role with `set_config` inside a transaction; never grant the runtime role `BYPASSRLS`. Superusers bypass RLS even when it is forced, so `DATABASE_URL` for the API and worker should use a `NOSUPERUSER NOBYPASSRLS` role like the `fb3_app` role in `rls.test.ts`, not the `fb3` bootstrap superuser.
- **Backup:** Cloud SQL PITR daily verification; quarterly restore drill. Redis is rebuildable from PostgreSQL aggregates and active reservations.

## Portfolio deployment (EC2 + Caddy)

`docker-compose.prod.yml` targets the shared `portfolio-demo-deployment` host: it joins the external `portfolio-edge` network, reads `.env.production`, and builds the web image with `NEXT_PUBLIC_API_URL=same-origin` and `API_INTERNAL_URL=http://api:4000`. In that mode the browser only calls `/api/*` on the web origin and Next rewrites it to the API container, so new API routes need no Caddyfile change. Rewrites are baked in at build time, so changing `API_INTERNAL_URL` requires a rebuild.

```bash
# on the EC2 host, after merging to main
cd /opt/portfolio/billing && git pull
cd /opt/portfolio/deploy && bash scripts/up.sh
```

The `migrate` service applies pending migrations and the repeatable seed before the API starts. Never commit `.env.production`.

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
