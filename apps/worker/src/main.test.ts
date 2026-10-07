import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@fb3/database";
import { aggregateUsage, publishOutbox, reconcileAndRepair, usageQueue } from "./main.js";

describe("usage pipeline integration", () => {
  afterAll(async () => { await usageQueue.close(); await pool.end(); });

  it("publishes outbox, deduplicates processing, aggregates and repairs drift", async () => {
    await pool.query("UPDATE outbox SET published_at=now() WHERE published_at IS NULL");
    const org = (await pool.query("INSERT INTO organizations(name,slug) VALUES('Pipeline Test',$1) RETURNING id", [`pipeline-${Date.now()}`])).rows[0].id;
    const event = {
      id: randomUUID(), organization_id: org, metric: "api_requests", quantity: 7, occurred_at: new Date().toISOString(),
    };
    await pool.query(`INSERT INTO usage_events(id,organization_id,idempotency_key,metric,quantity,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [event.id, org, `pipeline-${event.id}`, event.metric, event.quantity, event.occurred_at]);
    await pool.query("INSERT INTO outbox(organization_id,topic,payload) VALUES($1,'usage.recorded',$2)", [org, event]);
    expect(await publishOutbox()).toBeGreaterThanOrEqual(1);
    expect(await usageQueue.getJobCounts("waiting")).toHaveProperty("waiting");
    expect(await aggregateUsage(event)).toEqual({ aggregated: true });
    expect(await aggregateUsage(event)).toEqual({ duplicate: true });
    const aggregate = await pool.query("SELECT quantity::int FROM usage_aggregates WHERE organization_id=$1", [org]);
    expect(aggregate.rows[0].quantity).toBe(7);
    await pool.query("UPDATE usage_aggregates SET quantity=999 WHERE organization_id=$1", [org]);
    expect(await reconcileAndRepair()).toBeGreaterThanOrEqual(1);
    const repaired = await pool.query("SELECT quantity::int FROM usage_aggregates WHERE organization_id=$1", [org]);
    expect(repaired.rows[0].quantity).toBe(7);
  }, 30_000);
});
