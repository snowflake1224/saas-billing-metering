import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { INestApplication } from "@nestjs/common";
import { BillingService, createApp } from "./main.js";
import { pool } from "@fb3/database";

let app: INestApplication;
let accessToken: string;
describe("API integration", () => {
  beforeAll(async () => { app = await createApp(); await app.init(); });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("reports dependency health", async () => {
    const response = await supertest(app.getHttpServer()).get("/health").expect(200);
    expect(response.body.dependencies).toEqual({ postgres: true, redis: true });
  });

  it("authenticates the seeded Argon user", async () => {
    const response = await supertest(app.getHttpServer()).post("/auth/login")
      .send({ email: "demo@fb3.local", password: "DemoPass123!" }).expect(201);
    expect(response.body.accessToken).toBeTypeOf("string");
    accessToken = response.body.accessToken;
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
  });

  it("returns structured validation errors", async () => {
    const response = await supertest(app.getHttpServer()).post("/auth/login")
      .send({ email: "not-an-email", password: "" }).expect(400);
    expect(response.body).toMatchObject({ statusCode: 400, message: "Invalid request" });
    expect(response.body.issues.length).toBeGreaterThan(0);
  });

  it("advertises and enforces protected public-demo capabilities", async () => {
    process.env.PUBLIC_DEMO = "true";
    try {
      const capabilities = await supertest(app.getHttpServer()).get("/capabilities")
        .set("authorization", `Bearer ${accessToken}`).expect(200);
      expect(capabilities.body).toMatchObject({
        protectedDemo: true,
        permissions: { simulateUsage: true, manageWorkspace: false, replayJobs: false },
      });
      const mutation = await supertest(app.getHttpServer()).post("/teams")
        .set("authorization", `Bearer ${accessToken}`).send({ name: "Should not exist" }).expect(403);
      expect(mutation.body.message).toContain("protected public demo");
    } finally {
      delete process.env.PUBLIC_DEMO;
    }
  });

  it("serves the populated dashboard through injected billing services", async () => {
    const response = await supertest(app.getHttpServer()).get("/dashboard")
      .set("authorization", `Bearer ${accessToken}`).expect(200);
    expect(response.body.plan).toMatchObject({ code: "pro", name: "Pro" });
    expect(response.body.usage).toEqual(expect.arrayContaining([expect.objectContaining({ metric: "api_requests" })]));
  });

  it("reserves quota and keeps duplicate ingestion idempotent", async () => {
    const event = { idempotencyKey: `api-test-${Date.now()}`, metric: "api_requests", quantity: 2, occurredAt: new Date().toISOString(), dimensions: { test: "true" } };
    const first = await supertest(app.getHttpServer()).post("/usage/events").set("authorization", `Bearer ${accessToken}`).send(event).expect(201);
    expect(first.body).toMatchObject({ accepted: true, warnings: [] });
    const duplicate = await supertest(app.getHttpServer()).post("/usage/events").set("authorization", `Bearer ${accessToken}`).send(event).expect(201);
    expect(duplicate.body).toMatchObject({ duplicate: true });
  });

  it("lists recent raw events and traces one through the pipeline", async () => {
    const key = `trace-test-${Date.now()}`;
    await supertest(app.getHttpServer()).post("/usage/events").set("authorization", `Bearer ${accessToken}`)
      .send({ idempotencyKey: key, metric: "ai_tokens", quantity: 5, occurredAt: new Date().toISOString(), dimensions: { source: "trace_test" } }).expect(201);
    const list = await supertest(app.getHttpServer()).get("/usage/events?source=trace_test&limit=5")
      .set("authorization", `Bearer ${accessToken}`).expect(200);
    const event = list.body.find((item: { idempotencyKey: string }) => item.idempotencyKey === key);
    expect(event).toMatchObject({ metric: "ai_tokens", quantity: 5, status: "pending", dimensions: { source: "trace_test" } });
    const trace = await supertest(app.getHttpServer()).get(`/usage/events/${event.id}/trace`)
      .set("authorization", `Bearer ${accessToken}`).expect(200);
    expect(trace.body.stages.map((stage: { stage: string }) => stage.stage)).toEqual(["accepted", "published", "processed", "aggregated"]);
    expect(trace.body.stages[0].offsetMs).toBe(0);
    await supertest(app.getHttpServer()).get("/usage/events/not-a-uuid/trace").set("authorization", `Bearer ${accessToken}`).expect(400);
  });

  it("reports pipeline, quota, ranged analytics, and runtime metrics", async () => {
    const auth = { authorization: `Bearer ${accessToken}` };
    const pipeline = await supertest(app.getHttpServer()).get("/ops/pipeline").set(auth).expect(200);
    expect(pipeline.body.throughput).toHaveLength(60);
    expect(pipeline.body.outbox).toEqual(expect.objectContaining({ pending: expect.any(Number), oldestMs: expect.any(Number) }));
    expect(pipeline.body.processing).toHaveProperty("p95Ms");

    const quotaStatus = await supertest(app.getHttpServer()).get("/quota/status").set(auth).expect(200);
    const requests = quotaStatus.body.metrics.find((item: { metric: string }) => item.metric === "api_requests");
    expect(requests).toEqual(expect.objectContaining({ limit: 1000000, used: expect.any(Number), burnPerHour: expect.any(Number) }));
    expect(requests.redis).toEqual(expect.objectContaining({ used: expect.any(Number), reserved: expect.any(Number) }));

    const ranged = await supertest(app.getHttpServer()).get("/analytics/usage?range=7d&granularity=day").set(auth).expect(200);
    expect(new Set(ranged.body.map((row: { bucket: string }) => row.bucket)).size).toBeLessThanOrEqual(8);
    await supertest(app.getHttpServer()).get("/analytics/usage?range=1y").set(auth).expect(400);

    const metrics = await supertest(app.getHttpServer()).get("/ops/metrics").set(auth).expect(200);
    expect(metrics.body.quotaDecisions.allow).toBeGreaterThan(0);
    expect(metrics.body.http.requests).toBeGreaterThan(0);
  });

  it("scopes raw events to the caller's tenant", async () => {
    const other = await pool.query(
      `INSERT INTO organizations(name,slug) VALUES('Isolation Probe','isolation-probe')
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name RETURNING id`,
    );
    const otherOrg = other.rows[0].id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [otherOrg]);
      await client.query(
        `INSERT INTO usage_events(organization_id,idempotency_key,metric,quantity,occurred_at,dimensions)
         VALUES($1,'isolation-probe-event','api_requests',1,now(),'{"source":"isolation_probe"}') ON CONFLICT DO NOTHING`,
        [otherOrg],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const list = await supertest(app.getHttpServer()).get("/usage/events?source=isolation_probe")
      .set("authorization", `Bearer ${accessToken}`).expect(200);
    expect(list.body).toEqual([]);
  });

  it("rejects unsigned Stripe events unless explicit demo mode was enabled at boot", async () => {
    await supertest(app.getHttpServer()).post("/stripe/webhook").set("content-type", "application/json")
      .send({ id: "evt_unsigned", created: 1, type: "invoice.paid", data: { object: {} } }).expect(503);
  });

  it("projects subscription lifecycle events without allowing stale rollback", async () => {
    const subscription = await pool.query("SELECT organization_id FROM subscriptions LIMIT 1");
    const orgId = subscription.rows[0].organization_id;
    await pool.query("UPDATE subscriptions SET stripe_customer_id='cus_fixture',stripe_event_created=NULL WHERE organization_id=$1", [orgId]);
    const projector = new BillingService();
    const fixture = (created: number, status: string) => ({
      id: `evt_${created}`, object: "event", api_version: "2025-04-30.basil", created, livemode: false,
      pending_webhooks: 1, request: null, type: "customer.subscription.updated",
      data: { object: { id: "sub_fixture", object: "subscription", customer: "cus_fixture", status, current_period_start: 100, current_period_end: 200, cancel_at_period_end: false, metadata: { organization_id: orgId } } },
    }) as any;
    await projector.projectStripeEvent(fixture(200, "active"));
    await projector.projectStripeEvent(fixture(100, "canceled"));
    const result = await pool.query("SELECT status FROM subscriptions WHERE organization_id=$1", [orgId]);
    expect(result.rows[0].status).toBe("active");
  });
});
