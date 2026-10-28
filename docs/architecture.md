# Architecture

```text
client -> POST /usage/events (idempotency key) -> store event -> worker -> hourly total -> dashboard
```

1. **Ingest.** `POST /usage/events` takes a metric, a quantity, a timestamp, and an `idempotencyKey`.
2. **Idempotency key.** `usage_events` has a unique constraint on `(organization_id, idempotency_key)`. The insert uses `ON CONFLICT DO NOTHING`. If no row comes back, the API answers `duplicate` and nothing else happens.
3. **Store the event.** A new event and an outbox row are written in the same transaction, so a stored event is never lost on the way to the worker.
4. **Hourly total.** The worker reads the outbox and adds the event's quantity to `usage_aggregates` for `date_trunc('hour', occurred_at)`. It records each event ID it has processed, so a redelivered job does not add twice.
5. **Dashboard.** The web app reads the hourly rows and sums them for the month.

Before inserting, the API reserves the quantity against the plan limit in Redis, so two concurrent requests cannot both squeeze past the limit. After the insert it commits the reservation for a new event and releases it for a duplicate or an error.

Queries filter by `organization_id`. Row-level security in Postgres enforces the same rule in the database.

## Checking an hour

Events are never edited, so any hourly total can be recomputed from them:

```sql
SELECT metric, sum(quantity) AS from_events
FROM usage_events
WHERE organization_id = :org
  AND occurred_at >= '2026-10-28 14:00+00' AND occurred_at < '2026-10-28 15:00+00'
GROUP BY metric;

SELECT metric, quantity AS stored
FROM usage_aggregates
WHERE organization_id = :org AND bucket_start = '2026-10-28 14:00+00';
```

The two results should match.
