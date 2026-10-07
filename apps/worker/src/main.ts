import { createServer } from "node:http";
import { Queue, Worker, type Job } from "bullmq";
import pino from "pino";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { pool } from "@fb3/database";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
export const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
};
export const usageQueue = new Queue("usage", { connection });
export const dlq = new Queue("usage-dlq", { connection });
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const processed = new Counter({ name: "fb3_worker_events_total", help: "Worker event results", labelNames: ["result"], registers: [registry] });
const repaired = new Counter({ name: "fb3_worker_reconciled_buckets_total", help: "Repaired aggregate buckets", registers: [registry] });
const outboxLag = new Gauge({ name: "fb3_worker_outbox_oldest_seconds", help: "Age of oldest unpublished outbox event", registers: [registry] });
const dlqDepth = new Gauge({ name: "fb3_worker_dlq_depth", help: "DLQ jobs", registers: [registry] });

export type UsagePayload = { id: string; organization_id: string; metric: string; quantity: number; occurred_at: string };

export async function aggregateUsage(event: UsagePayload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dedupe = await client.query(
      "INSERT INTO processed_events(consumer,event_id) VALUES('usage-aggregate',$1) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.id],
    );
    if (!dedupe.rows[0]) { await client.query("COMMIT"); processed.inc({ result: "duplicate" }); return { duplicate: true }; }
    await client.query(
      `INSERT INTO usage_aggregates(organization_id,metric,bucket_start,quantity)
       VALUES($1,$2,date_trunc('hour',$3::timestamptz),$4)
       ON CONFLICT(organization_id,metric,bucket_start) DO UPDATE SET quantity=usage_aggregates.quantity+excluded.quantity`,
      [event.organization_id, event.metric, event.occurred_at, event.quantity],
    );
    await client.query("COMMIT");
    processed.inc({ result: "aggregated" });
    return { aggregated: true };
  } catch (error) {
    await client.query("ROLLBACK");
    processed.inc({ result: "error" });
    throw error;
  } finally {
    client.release();
  }
}

export async function publishOutbox() {
  const client = await pool.connect();
  let published = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED");
    for (const event of rows) {
      await usageQueue.add(event.topic, event.payload, { jobId: event.id, attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000 });
      await client.query("UPDATE outbox SET published_at=now() WHERE id=$1", [event.id]);
      published++;
    }
    await client.query("COMMIT");
    const lag = await pool.query("SELECT coalesce(extract(epoch FROM now()-min(created_at)),0)::float lag FROM outbox WHERE published_at IS NULL");
    outboxLag.set(lag.rows[0].lag);
    return published;
  } catch (error) {
    await client.query("ROLLBACK");
    log.error({ err: error }, "outbox publish failed");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileAndRepair() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      WITH expected AS (
        SELECT organization_id,metric,date_trunc('hour',occurred_at) bucket_start,sum(quantity)::bigint quantity
        FROM usage_events GROUP BY organization_id,metric,date_trunc('hour',occurred_at)
      ), repaired AS (
        INSERT INTO usage_aggregates(organization_id,metric,bucket_start,quantity)
        SELECT organization_id,metric,bucket_start,quantity FROM expected
        ON CONFLICT(organization_id,metric,bucket_start) DO UPDATE SET quantity=excluded.quantity
        WHERE usage_aggregates.quantity <> excluded.quantity
        RETURNING 1
      )
      SELECT count(*)::int repaired FROM repaired`);
    const removed = await client.query(`
      DELETE FROM usage_aggregates a WHERE NOT EXISTS (
        SELECT 1 FROM usage_events e WHERE e.organization_id=a.organization_id AND e.metric=a.metric
          AND date_trunc('hour',e.occurred_at)=a.bucket_start
      ) RETURNING 1`);
    await client.query("COMMIT");
    const count = result.rows[0].repaired + (removed.rowCount ?? 0);
    if (count) {
      repaired.inc(count);
      log.warn({ repaired: result.rows[0].repaired, removed: removed.rowCount }, "usage drift repaired");
    }
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function moveToDlq(job: Job, error: Error) {
  const dlqJob = await dlq.add("failed", {
    originalJobId: job.id,
    original: job.data,
    error: error.message,
    failedAt: new Date().toISOString(),
  });
  dlqDepth.set(await dlq.getWaitingCount() + await dlq.getFailedCount());
  return dlqJob.id;
}

export function startWorker() {
  const worker = new Worker("usage", (job) => aggregateUsage(job.data as UsagePayload), { connection, concurrency: 20 });
  worker.on("failed", async (job, error) => {
    log.error({ jobId: job?.id, error }, "usage job failed");
    if (job && job.attemptsMade >= 5) await moveToDlq(job, error);
  });
  const publisher = setInterval(() => void publishOutbox().catch(() => undefined), 1000);
  const reconciler = setInterval(() => void reconcileAndRepair().catch((error) => log.error({ error }, "reconciliation failed")), 60 * 60 * 1000);
  publisher.unref();
  reconciler.unref();
  void publishOutbox();
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    if (req.url === "/health") {
      const database = await pool.query("SELECT 1").then(() => true).catch(() => false);
      const redis = await usageQueue.getJobCounts().then(() => true).catch(() => false);
      res.writeHead(database && redis ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: database && redis ? "ok" : "degraded", dependencies: { database, redis } }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(Number(process.env.WORKER_HEALTH_PORT ?? 4001));
  log.info({ healthPort: Number(process.env.WORKER_HEALTH_PORT ?? 4001) }, "worker started");
  return { worker, server };
}

if (process.env.NODE_ENV !== "test") startWorker();
