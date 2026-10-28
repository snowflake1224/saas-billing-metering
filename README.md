# FB-3: usage metering

Posting the same usage event twice does not change the total.

Each event carries an idempotency key. The API stores at most one event per key per organization, and a retry with the same key gets back `duplicate` instead of a second row. The total is a sum of stored events, rolled into an hourly number the dashboard shows.

## Failure made safe

A client that times out and retries must not double-count. That is the whole point of the key: the first `POST /usage/events` stores the event, every later post with the same key is answered `duplicate` and adds nothing. The dashboard's simulator lets you see this directly. Tick "Reuse idempotency key", send ×5, and you get 1 accepted and 4 duplicates while the total moves once.

## Run it

```bash
cp .env.example .env
docker compose up -d postgres redis
corepack pnpm install
pnpm build
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Open http://localhost:3000.

**Demo login:** `demo@fb3.local` / `DemoPass123!`

To run the whole stack in containers instead: `docker network create portfolio-edge` (once), then `docker compose up --build`.

## One tradeoff

The hourly total is derived from stored events instead of being the source of truth. A background worker keeps the hourly table up to date, so the dashboard reads a small table, not every event. The cost is that the two could drift. Because events are never edited, you can recompute any hour with one SQL sum over `usage_events` and compare it with the stored row. See [docs/architecture.md](docs/architecture.md).

## Metrics

The API's `/metrics` endpoint exposes Prometheus counters. `fb3_usage_events_total{result="accepted"}` counts ingested events, `fb3_usage_events_total{result="duplicate"}` counts duplicates, and `fb3_outbox_unpublished` gives the queue depth (stored events not yet picked up by the worker). `docker compose --profile metrics up` adds Prometheus (:9090) and one local Grafana board (:3001) with those three panels.

## Tenancy

Queries filter by `organization_id`. Row-level security in Postgres enforces the same rule in the database.

## Billing

An invoice can be built from the hourly totals; Stripe would charge that amount. The Billing page shows this month's totals against the plan.

## What I would add in a real account

There is no Terraform here. The demo runs this Compose file on a single shared host. In a real account I would add one VM, a managed Postgres, a managed Redis, and secrets in an env file on that VM, all described in code.

## Checks

```bash
pnpm typecheck
pnpm test        # needs postgres + redis from docker compose
```
