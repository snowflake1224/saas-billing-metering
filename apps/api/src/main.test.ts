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

  it("reserves quota and keeps duplicate ingestion idempotent", async () => {
    const event = { idempotencyKey: `api-test-${Date.now()}`, metric: "api_requests", quantity: 2, occurredAt: new Date().toISOString(), dimensions: { test: "true" } };
    const first = await supertest(app.getHttpServer()).post("/usage/events").set("authorization", `Bearer ${accessToken}`).send(event).expect(201);
    expect(first.body).toMatchObject({ accepted: true, warnings: [] });
    const duplicate = await supertest(app.getHttpServer()).post("/usage/events").set("authorization", `Bearer ${accessToken}`).send(event).expect(201);
    expect(duplicate.body).toMatchObject({ duplicate: true });
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
