import "reflect-metadata";
import {
  ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, Headers, HttpException, Inject, Injectable, Module, Param, Patch, Post, Query, Req, Res,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import Stripe from "stripe";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import pino from "pino";
import pinoHttp from "pino-http";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { pool, healthcheck, tenantTransaction } from "@fb3/database";
import { loginSchema, usageEventSchema, ZodError } from "@fb3/contracts";
import { PostgresAnalyticsAdapter, QuotaService } from "@fb3/metering";

const production = process.env.NODE_ENV === "production";
const demoMode = process.env.LOCAL_DEMO_MODE === "true" && !production;
const isPublicDemo = () => process.env.PUBLIC_DEMO === "true";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const accessSecret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET ?? "local-access-secret-change-me-32chars");
const refreshSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET ?? "local-refresh-secret-change-me-32chars");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379", { lazyConnect: true, maxRetriesPerRequest: 2 });
const quota = new QuotaService(redis, process.env.QUOTA_FAILURE_POLICY === "open" ? "open" : "closed");
const analytics = new PostgresAnalyticsAdapter((sql, values) => pool.query(sql, values));
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
const queueConnection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), username: redisUrl.username || undefined, password: redisUrl.password || undefined };
const usageQueue = new Queue("usage", { connection: queueConnection });
const dlq = new Queue("usage-dlq", { connection: queueConnection });
const log = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] });

const registry = new Registry();
collectDefaultMetrics({ register: registry });
const usageCounter = new Counter({ name: "fb3_usage_events_total", help: "Accepted usage events", labelNames: ["metric", "result"], registers: [registry] });
const webhookCounter = new Counter({ name: "fb3_stripe_webhooks_total", help: "Stripe webhook outcomes", labelNames: ["type", "result"], registers: [registry] });
const quotaCounter = new Counter({ name: "fb3_quota_decisions_total", help: "Quota decisions", labelNames: ["metric", "decision"], registers: [registry] });
const requestLatency = new Histogram({ name: "fb3_http_duration_seconds", help: "HTTP request latency", labelNames: ["method", "status"], registers: [registry] });
const outboxGauge = new Gauge({ name: "fb3_outbox_unpublished", help: "Unpublished outbox events", registers: [registry] });

type Role = "owner" | "admin" | "billing" | "member";
type AuthContext = { sub: string; organizationId: string; role: Role; email: string };
type AuthedRequest = Request & { auth?: AuthContext };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: production, path: "/", maxAge: 30 * 86400000 };

const analyticsRanges: Record<string, number> = { "24h": 24, "72h": 72, "7d": 168, "30d": 720 };
const eventSelect = `SELECT e.id,e.idempotency_key,e.metric,e.quantity::bigint AS quantity,e.occurred_at,e.created_at,e.dimensions,
  o.published_at,p.processed_at
  FROM usage_events e
  LEFT JOIN outbox o ON o.topic='usage.recorded' AND o.payload->>'id'=e.id::text
  LEFT JOIN processed_events p ON p.consumer='usage-aggregate' AND p.event_id=e.id`;

function serializeEvent(row: Record<string, any>) {
  const iso = (value: unknown) => (value ? (value instanceof Date ? value : new Date(String(value))).toISOString() : null);
  const processedAt = iso(row.processed_at);
  const publishedAt = iso(row.published_at);
  const ingestedAt = iso(row.created_at)!;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    metric: String(row.metric),
    quantity: Number(row.quantity),
    occurredAt: iso(row.occurred_at)!,
    ingestedAt,
    publishedAt,
    processedAt,
    status: processedAt ? "processed" : publishedAt ? "queued" : "pending",
    latencyMs: processedAt ? new Date(processedAt).getTime() - new Date(ingestedAt).getTime() : null,
    dimensions: row.dimensions ?? {},
  };
}

function requireWritableWorkspace() {
  if (isPublicDemo()) throw new HttpException("This action is disabled in the protected public demo", 403);
}

@Catch(ZodError)
class ZodExceptionFilter implements ExceptionFilter {
  catch(error: ZodError, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().status(400).json({
      statusCode: 400,
      message: "Invalid request",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
}

async function authorize(req: AuthedRequest, allowed?: Role[]): Promise<AuthContext> {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) throw new HttpException("missing bearer token", 401);
  try {
    const { payload } = await jwtVerify(token, accessSecret);
    if (payload.type !== "access" || !payload.sub || !payload.organizationId) throw new Error("invalid claims");
    const membership = await pool.query(
      "SELECT m.role,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2",
      [payload.organizationId, payload.sub],
    );
    if (!membership.rows[0]) throw new HttpException("membership revoked", 403);
    const context = { sub: payload.sub, organizationId: String(payload.organizationId), role: membership.rows[0].role as Role, email: membership.rows[0].email };
    if (allowed && !allowed.includes(context.role)) throw new HttpException("insufficient role", 403);
    return context;
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new HttpException("invalid access token", 401);
  }
}

async function issueTokens(userId: string, organizationId: string, role: string, familyId: string = randomUUID()) {
  const access = await new SignJWT({ organizationId, role, type: "access" }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setJti(randomUUID()).setExpirationTime("15m").sign(accessSecret);
  const id = randomUUID();
  const refresh = await new SignJWT({ organizationId, role, type: "refresh", familyId }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setJti(id).setExpirationTime("30d").sign(refreshSecret);
  await pool.query("INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')", [id, userId, familyId, hash(refresh)]);
  return { access, refresh };
}

async function audit(orgId: string, actorId: string, action: string, targetType: string, targetId?: string, metadata: object = {}) {
  await tenantTransaction(orgId, actorId, (db) =>
    db.query("INSERT INTO audit_log(organization_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)", [orgId, actorId, action, targetType, targetId, metadata]),
  );
}

@Injectable()
export class BillingService {
  async entitlements(orgId: string) {
    const { rows } = await pool.query(
      `SELECT pv.code,pv.name,pv.version,pv.price_cents,pv.entitlements ||
       COALESCE(jsonb_object_agg(e.key,e.value) FILTER (WHERE e.id IS NOT NULL),'{}') AS entitlements,
       s.status,s.period_start,s.period_end,s.cancel_at_period_end
       FROM subscriptions s JOIN plan_versions pv ON pv.id=s.plan_version_id
       LEFT JOIN entitlement_overrides e ON e.organization_id=s.organization_id AND now() BETWEEN e.starts_at AND e.ends_at
       WHERE s.organization_id=$1 GROUP BY pv.code,pv.name,pv.version,pv.price_cents,pv.entitlements,s.status,s.period_start,s.period_end,s.cancel_at_period_end`,
      [orgId],
    );
    return rows[0];
  }

  async projectStripeEvent(event: Stripe.Event) {
    const object = event.data.object as Stripe.Event.Data.Object & Record<string, any>;
    const created = new Date(event.created * 1000);
    if (event.type === "checkout.session.completed") {
      const orgId = object.client_reference_id ?? object.metadata?.organization_id;
      if (!orgId) throw new Error("checkout session missing organization linkage");
      await pool.query(
        `UPDATE subscriptions SET stripe_customer_id=$2,stripe_subscription_id=COALESCE($3,stripe_subscription_id),
         stripe_event_created=$4 WHERE organization_id=$1 AND (stripe_event_created IS NULL OR stripe_event_created <= $4)`,
        [orgId, String(object.customer), object.subscription ? String(object.subscription) : null, created],
      );
      return;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const customerId = String(object.customer);
      const orgId = object.metadata?.organization_id ?? (await pool.query("SELECT organization_id FROM subscriptions WHERE stripe_customer_id=$1", [customerId])).rows[0]?.organization_id;
      if (!orgId) throw new Error(`no organization linked to Stripe customer ${customerId}`);
      const planCode = object.metadata?.plan_code;
      const plan = planCode ? (await pool.query("SELECT id FROM plan_versions WHERE code=$1 AND active_until IS NULL ORDER BY version DESC LIMIT 1", [planCode])).rows[0] : null;
      await pool.query(
        `UPDATE subscriptions SET stripe_customer_id=$2,stripe_subscription_id=$3,status=$4,
         period_start=to_timestamp($5),period_end=to_timestamp($6),cancel_at_period_end=$7,
         plan_version_id=COALESCE($8,plan_version_id),stripe_event_created=$9
         WHERE organization_id=$1 AND (stripe_event_created IS NULL OR stripe_event_created <= $9)`,
        [orgId, customerId, object.id, object.status, object.current_period_start, object.current_period_end, Boolean(object.cancel_at_period_end), plan?.id, created],
      );
      return;
    }
    if (event.type.startsWith("invoice.")) {
      const customerId = String(object.customer);
      const linked = await pool.query("SELECT organization_id FROM subscriptions WHERE stripe_customer_id=$1", [customerId]);
      if (!linked.rows[0]) throw new Error(`no organization linked to invoice customer ${customerId}`);
      await pool.query(
        `INSERT INTO invoices(id,organization_id,stripe_customer_id,status,currency,amount_due,amount_paid,hosted_invoice_url,period_start,period_end,stripe_event_created)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),to_timestamp($10),$11)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_due=excluded.amount_due,amount_paid=excluded.amount_paid,
         hosted_invoice_url=excluded.hosted_invoice_url,period_start=excluded.period_start,period_end=excluded.period_end,
         stripe_event_created=excluded.stripe_event_created
         WHERE invoices.stripe_event_created <= excluded.stripe_event_created`,
        [object.id, linked.rows[0].organization_id, customerId, object.status ?? "unknown", object.currency, object.amount_due ?? 0, object.amount_paid ?? 0, object.hosted_invoice_url, object.period_start, object.period_end, created],
      );
    }
  }
}

@Controller()
export class AppController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get("health")
  async health() {
    const [postgres, redisStatus] = await Promise.all([
      healthcheck().catch(() => false),
      redis.ping().then(() => true).catch(() => false),
    ]);
    await pool.query("SELECT count(*)::int count FROM outbox WHERE published_at IS NULL").then((r) => outboxGauge.set(r.rows[0].count)).catch(() => undefined);
    return { status: postgres && redisStatus ? "ok" : "degraded", dependencies: { postgres, redis: redisStatus }, service: "api", time: new Date().toISOString() };
  }

  @Get("metrics")
  async metrics(@Res() res: Response) { res.type(registry.contentType).send(await registry.metrics()); }

  @Get("capabilities")
  async capabilities(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    const protectedDemo = isPublicDemo();
    return {
      protectedDemo,
      role: c.role,
      permissions: {
        simulateUsage: true,
        checkoutPreview: ["owner", "billing"].includes(c.role),
        manageWorkspace: !protectedDemo && ["owner", "admin"].includes(c.role),
        manageBilling: !protectedDemo && ["owner", "billing"].includes(c.role),
        replayJobs: !protectedDemo && ["owner", "admin"].includes(c.role),
      },
    };
  }

  @Post("auth/login")
  async login(@Body() input: unknown, @Res({ passthrough: true }) res: Response) {
    const body = loginSchema.parse(input);
    const { rows } = await pool.query(
      `SELECT u.id,u.password_hash,m.organization_id,m.role FROM users u JOIN memberships m ON m.user_id=u.id
       WHERE lower(u.email)=lower($1) ORDER BY m.role='owner' DESC LIMIT 1`, [body.email],
    );
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, body.password))) throw new HttpException("invalid credentials", 401);
    const tokens = await issueTokens(rows[0].id, rows[0].organization_id, rows[0].role);
    res.cookie("refresh_token", tokens.refresh, cookieOptions);
    return { accessToken: tokens.access, organizationId: rows[0].organization_id };
  }

  @Post("auth/refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.refresh_token;
    if (!token) throw new HttpException("missing refresh token", 401);
    const { payload } = await jwtVerify(token, refreshSecret);
    const old = await pool.query("SELECT * FROM refresh_tokens WHERE id=$1", [payload.jti]);
    if (!old.rows[0] || old.rows[0].revoked_at || old.rows[0].expires_at < new Date() || old.rows[0].token_hash !== hash(token)) {
      if (payload.familyId) await pool.query("UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL", [payload.familyId]);
      res.clearCookie("refresh_token", { ...cookieOptions, maxAge: undefined });
      throw new HttpException("refresh token reuse detected", 401);
    }
    const membership = await pool.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2", [payload.organizationId, payload.sub]);
    if (!membership.rows[0]) throw new HttpException("membership revoked", 403);
    const next = await issueTokens(payload.sub!, String(payload.organizationId), membership.rows[0].role, String(payload.familyId));
    await pool.query("UPDATE refresh_tokens SET revoked_at=now(),replaced_by=$2 WHERE id=$1", [payload.jti, (await jwtVerify(next.refresh, refreshSecret)).payload.jti]);
    res.cookie("refresh_token", next.refresh, cookieOptions);
    return { accessToken: next.access };
  }

  @Post("auth/logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.refresh_token;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, refreshSecret);
        await pool.query("UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL", [payload.familyId]);
      } catch { /* an invalid cookie is still cleared */ }
    }
    res.clearCookie("refresh_token", { ...cookieOptions, maxAge: undefined });
    return { loggedOut: true };
  }

  @Get("organizations")
  async organizations(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    return (await pool.query("SELECT o.id,o.name,o.slug,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.name", [c.sub])).rows;
  }

  @Post("organizations")
  async createOrganization(@Req() req: AuthedRequest, @Body() body: { name: string; slug: string }) {
    const c = await authorize(req);
    requireWritableWorkspace();
    if (!body.name?.trim() || !/^[a-z0-9-]{3,50}$/.test(body.slug)) throw new HttpException("invalid organization", 400);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = await client.query("INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING *", [body.name.trim(), body.slug]);
      await client.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
      await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [org.rows[0].id, c.sub]);
      await client.query(`INSERT INTO subscriptions(organization_id,plan_version_id) SELECT $1,id FROM plan_versions WHERE code='free' AND active_until IS NULL ORDER BY version DESC LIMIT 1`, [org.rows[0].id]);
      await client.query("COMMIT");
      await audit(org.rows[0].id, c.sub, "organization.created", "organization", org.rows[0].id);
      return org.rows[0];
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  @Post("organizations/:id/switch")
  async switchOrganization(@Req() req: AuthedRequest, @Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    const c = await authorize(req);
    const membership = await pool.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2", [id, c.sub]);
    if (!membership.rows[0]) throw new HttpException("not a member", 403);
    const tokens = await issueTokens(c.sub, id, membership.rows[0].role);
    res.cookie("refresh_token", tokens.refresh, cookieOptions);
    return { accessToken: tokens.access, organizationId: id };
  }

  @Get("dashboard")
  async dashboard(@Req() req: AuthedRequest) {
    try {
      const c = await authorize(req);
      const plan = await this.billing.entitlements(c.organizationId);
      const usage = await tenantTransaction(c.organizationId, c.sub, async (db) =>
        (await db.query("SELECT metric,sum(quantity)::bigint AS used FROM usage_aggregates WHERE organization_id=$1 AND bucket_start>=date_trunc('month',now()) GROUP BY metric", [c.organizationId])).rows,
      );
      return { plan, usage, organizationId: c.organizationId };
    } catch (error) {
      log.error({ err: error }, "dashboard query failed");
      throw error;
    }
  }

  @Get("analytics/usage")
  async usageAnalytics(@Req() req: AuthedRequest, @Query("range") range?: string, @Query("granularity") granularity?: string) {
    const c = await authorize(req);
    if (!range) return analytics.usage(c.organizationId, new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date());
    const hours = analyticsRanges[range];
    if (!hours) throw new HttpException(`range must be one of ${Object.keys(analyticsRanges).join(", ")}`, 400);
    const unit = granularity === "day" ? "day" : "hour";
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query(
      `SELECT metric,date_trunc($1,bucket_start) AS bucket,sum(quantity)::bigint AS quantity FROM usage_aggregates
       WHERE organization_id=$3 AND bucket_start >= date_trunc('hour',now()) - make_interval(hours => $2) GROUP BY 1,2 ORDER BY 2,1`,
      [unit, hours - 1, c.organizationId],
    )).rows.map((row) => ({ metric: row.metric, bucket: row.bucket, quantity: Number(row.quantity) })));
  }

  @Get("ops/pipeline")
  async pipeline(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    const [tenant, queue, deadLetters] = await Promise.all([
      tenantTransaction(c.organizationId, c.sub, async (db) => {
        const outbox = await db.query(
          `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
             coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE published_at IS NULL))*1000,0)::float AS oldest_ms,
             count(*) FILTER (WHERE published_at > now()-interval '1 hour')::int AS published_1h
           FROM outbox WHERE organization_id=$1`,
          [c.organizationId],
        );
        const throughput = await db.query(
          `SELECT date_trunc('minute',created_at) AS minute,count(*)::int AS events,sum(quantity)::bigint AS units
           FROM usage_events WHERE organization_id=$1 AND created_at > now()-interval '60 minutes' GROUP BY 1 ORDER BY 1`,
          [c.organizationId],
        );
        const processing = await db.query(
          `SELECT count(*)::int AS ingested,count(p.event_id)::int AS processed,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.processed_at-e.created_at)*1000) AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM p.processed_at-e.created_at)*1000) AS p95_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM p.processed_at-e.created_at)*1000) AS p99_ms
           FROM usage_events e LEFT JOIN processed_events p ON p.consumer='usage-aggregate' AND p.event_id=e.id
           WHERE e.organization_id=$1 AND e.created_at > now()-interval '24 hours'`,
          [c.organizationId],
        );
        const buckets = await db.query("SELECT count(*)::int AS buckets,max(bucket_start) AS latest FROM usage_aggregates WHERE organization_id=$1", [c.organizationId]);
        return { outbox: outbox.rows[0], throughput: throughput.rows, processing: processing.rows[0], aggregates: buckets.rows[0] };
      }),
      usageQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed").catch(() => null),
      dlq.getJobCounts("waiting", "failed").catch(() => null),
    ]);
    const now = Date.now();
    const perMinute = new Map(tenant.throughput.map((row) => [new Date(row.minute).getTime(), row]));
    const start = Math.floor(now / 60000) * 60000 - 59 * 60000;
    const throughput = Array.from({ length: 60 }, (_, index) => {
      const minute = start + index * 60000;
      const row = perMinute.get(minute);
      return { minute: new Date(minute).toISOString(), events: row?.events ?? 0, units: Number(row?.units ?? 0) };
    });
    const round = (value: unknown) => (value == null ? null : Math.round(Number(value)));
    return {
      generatedAt: new Date(now).toISOString(),
      outbox: { pending: tenant.outbox.pending, oldestMs: Math.round(tenant.outbox.oldest_ms), publishedLastHour: tenant.outbox.published_1h },
      queue: queue ? { ...queue, available: true } : { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, available: false },
      deadLetter: deadLetters ? { depth: (deadLetters.waiting ?? 0) + (deadLetters.failed ?? 0), available: true } : { depth: 0, available: false },
      processing: {
        ingested24h: tenant.processing.ingested,
        processed24h: tenant.processing.processed,
        backlog: tenant.processing.ingested - tenant.processing.processed,
        p50Ms: round(tenant.processing.p50_ms),
        p95Ms: round(tenant.processing.p95_ms),
        p99Ms: round(tenant.processing.p99_ms),
      },
      aggregates: { buckets: tenant.aggregates.buckets, latestBucket: tenant.aggregates.latest },
      throughput,
    };
  }

  @Get("usage/events")
  async usageEvents(@Req() req: AuthedRequest, @Query("limit") limit?: string, @Query("metric") metric?: string, @Query("source") source?: string) {
    const c = await authorize(req);
    const size = Math.min(200, Math.max(1, Number(limit) || 50));
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query(
      `${eventSelect} WHERE e.organization_id=$4 AND ($1::text IS NULL OR e.metric=$1) AND ($2::text IS NULL OR e.dimensions->>'source'=$2)
       ORDER BY e.created_at DESC LIMIT $3`,
      [metric || null, source || null, size, c.organizationId],
    )).rows.map(serializeEvent));
  }

  @Get("usage/events/:id/trace")
  async usageEventTrace(@Req() req: AuthedRequest, @Param("id") id: string) {
    const c = await authorize(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpException("invalid event id", 400);
    return tenantTransaction(c.organizationId, c.sub, async (db) => {
      const found = await db.query(`${eventSelect} WHERE e.id=$1 AND e.organization_id=$2`, [id, c.organizationId]);
      if (!found.rows[0]) throw new HttpException("event not found", 404);
      const event = serializeEvent(found.rows[0]);
      const bucket = await db.query(
        "SELECT bucket_start,quantity::bigint AS quantity FROM usage_aggregates WHERE organization_id=$3 AND metric=$1 AND bucket_start=date_trunc('hour',$2::timestamptz)",
        [event.metric, event.occurredAt, c.organizationId],
      );
      const at = (value: string | null) => (value ? new Date(value).getTime() : null);
      const ingested = at(event.ingestedAt)!;
      const stages = [
        { stage: "accepted", label: "Validated, quota reserved, row + outbox committed", at: event.ingestedAt, offsetMs: 0 },
        { stage: "published", label: "Outbox relay enqueued BullMQ job", at: event.publishedAt, offsetMs: event.publishedAt ? at(event.publishedAt)! - ingested : null },
        { stage: "processed", label: "Worker deduplicated via processed_events", at: event.processedAt, offsetMs: event.processedAt ? at(event.processedAt)! - ingested : null },
        { stage: "aggregated", label: "Folded into hourly usage_aggregates bucket", at: event.processedAt && bucket.rows[0] ? event.processedAt : null, offsetMs: event.processedAt && bucket.rows[0] ? at(event.processedAt)! - ingested : null },
      ];
      return {
        event,
        stages,
        bucket: bucket.rows[0] ? { start: bucket.rows[0].bucket_start, quantity: Number(bucket.rows[0].quantity) } : null,
      };
    });
  }

  @Get("quota/status")
  async quotaStatus(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    const plan = await this.billing.entitlements(c.organizationId);
    const entitlements: Record<string, number> = plan?.entitlements ?? {};
    const { rows, seats } = await tenantTransaction(c.organizationId, c.sub, async (db) => ({
      rows: (await db.query(
        `SELECT metric,
           coalesce(sum(quantity) FILTER (WHERE bucket_start >= date_trunc('month',now())),0)::bigint AS month_to_date,
           coalesce(sum(quantity) FILTER (WHERE bucket_start >= now()-interval '24 hours'),0)::bigint AS last_24h,
           coalesce(sum(quantity) FILTER (WHERE bucket_start >= now()-interval '48 hours' AND bucket_start < now()-interval '24 hours'),0)::bigint AS previous_24h
         FROM usage_aggregates WHERE organization_id=$1 AND bucket_start >= least(date_trunc('month',now()),now()-interval '48 hours') GROUP BY metric`,
        [c.organizationId],
      )).rows,
      seats: Number((await db.query("SELECT count(*)::int AS count FROM memberships WHERE organization_id=$1", [c.organizationId])).rows[0].count),
    }));
    const now = new Date();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const hoursLeft = (periodEnd.getTime() - now.getTime()) / 3600000;
    const metrics = await Promise.all(Object.entries(entitlements).map(async ([metric, rawLimit]) => {
      const limit = Number(rawLimit);
      const row = rows.find((item) => item.metric === metric);
      const used = metric === "seats" ? seats : Number(row?.month_to_date ?? 0);
      const last24h = Number(row?.last_24h ?? 0);
      const previous24h = Number(row?.previous_24h ?? 0);
      const burnPerHour = metric === "seats" ? 0 : last24h / 24;
      const remaining = Math.max(0, limit - used);
      const hoursToLimit = burnPerHour > 0 ? remaining / burnPerHour : null;
      const redisState = await quota.snapshot(c.organizationId, metric).catch(() => null);
      return {
        metric,
        limit,
        used,
        remaining,
        percent: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0,
        last24h,
        changePercent: previous24h ? Math.round(((last24h - previous24h) / previous24h) * 1000) / 10 : null,
        burnPerHour: Math.round(burnPerHour),
        projectedPeriodTotal: Math.round(used + burnPerHour * hoursLeft),
        projectedExhaustionAt: hoursToLimit != null && hoursToLimit < hoursLeft ? new Date(now.getTime() + hoursToLimit * 3600000).toISOString() : null,
        redis: redisState ? { used: redisState.used, reserved: redisState.reserved } : null,
      };
    }));
    return { period: { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), end: periodEnd.toISOString() }, softAlertPercent: 80, metrics };
  }

  @Get("ops/metrics")
  async opsMetrics(@Req() req: AuthedRequest) {
    await authorize(req);
    const metrics = await registry.getMetricsAsJSON();
    const find = (name: string) => metrics.find((metric) => metric.name === name)?.values ?? [];
    const sumBy = (name: string, label: string) => find(name).reduce<Record<string, number>>((totals, item) => {
      const key = String(item.labels[label] ?? "unknown");
      totals[key] = (totals[key] ?? 0) + Number(item.value);
      return totals;
    }, {});
    const histogram = find("fb3_http_duration_seconds") as Array<{ labels: Record<string, string | number>; value: number; metricName?: string }>;
    const buckets = new Map<string, number>();
    for (const item of histogram.filter((entry) => entry.metricName === "fb3_http_duration_seconds_bucket")) {
      const le = String(item.labels.le);
      buckets.set(le, (buckets.get(le) ?? 0) + Number(item.value));
    }
    const count = histogram.filter((entry) => entry.metricName === "fb3_http_duration_seconds_count").reduce((total, entry) => total + Number(entry.value), 0);
    const sum = histogram.filter((entry) => entry.metricName === "fb3_http_duration_seconds_sum").reduce((total, entry) => total + Number(entry.value), 0);
    const status = histogram.filter((entry) => entry.metricName === "fb3_http_duration_seconds_count").reduce<Record<string, number>>((totals, entry) => {
      const key = `${String(entry.labels.status).charAt(0)}xx`;
      totals[key] = (totals[key] ?? 0) + Number(entry.value);
      return totals;
    }, {});
    const gauge = (name: string) => Number(find(name)[0]?.value ?? 0);
    return {
      uptimeSeconds: Math.round(process.uptime()),
      quotaDecisions: sumBy("fb3_quota_decisions_total", "decision"),
      usageResults: sumBy("fb3_usage_events_total", "result"),
      webhooks: sumBy("fb3_stripe_webhooks_total", "result"),
      http: {
        requests: count,
        averageMs: count ? Math.round((sum / count) * 10000) / 10 : 0,
        status,
        latencyBuckets: [...buckets.entries()].map(([le, cumulative]) => ({ le, cumulative })),
      },
      process: {
        residentMemoryBytes: gauge("process_resident_memory_bytes"),
        heapUsedBytes: gauge("nodejs_heap_size_used_bytes"),
        eventLoopLagSeconds: gauge("nodejs_eventloop_lag_seconds"),
      },
    };
  }

  @Post("usage/events")
  async ingest(@Req() req: AuthedRequest, @Body() input: unknown) {
    const c = await authorize(req);
    const event = usageEventSchema.parse(input);
    if (isPublicDemo()) {
      if (event.metric === "seats" || event.quantity > 500) throw new HttpException("Demo simulations are limited to 500 non-seat units", 400);
      const demoRateKey = `public-demo-events:${new Date().toISOString().slice(0, 10)}`;
      const demoEvents = await redis.incr(demoRateKey);
      if (demoEvents === 1) await redis.expire(demoRateKey, 86400);
      if (demoEvents > Number(process.env.PUBLIC_DEMO_DAILY_EVENTS ?? 500)) throw new HttpException("The public demo simulation limit has been reached for today", 429);
    }
    const plan = await this.billing.entitlements(c.organizationId);
    const limit = Number(plan?.entitlements?.[event.metric] ?? 0);
    if (!limit) throw new HttpException(`metric ${event.metric} is not entitled`, 403);
    const reservation = await quota.reserve(c.organizationId, event.metric, event.quantity, limit);
    quotaCounter.inc({ metric: event.metric, decision: reservation.allowed ? "allow" : "deny" });
    if (!reservation.allowed) throw new HttpException({ message: "quota exceeded", quota: reservation }, 429);
    try {
      const result = await tenantTransaction(c.organizationId, c.sub, async (db) => {
        const inserted = await db.query(
          `INSERT INTO usage_events(organization_id,idempotency_key,metric,quantity,occurred_at,dimensions)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,idempotency_key) DO NOTHING RETURNING *`,
          [c.organizationId, event.idempotencyKey, event.metric, event.quantity, event.occurredAt, event.dimensions],
        );
        if (!inserted.rows[0]) return { duplicate: true };
        await db.query("INSERT INTO outbox(organization_id,topic,payload) VALUES($1,'usage.recorded',$2)", [c.organizationId, inserted.rows[0]]);
        return { accepted: true, eventId: inserted.rows[0].id };
      });
      if ("duplicate" in result) await quota.release(c.organizationId, event.metric, event.quantity);
      else await quota.commit(c.organizationId, event.metric, event.quantity);
      usageCounter.inc({ metric: event.metric, result: "duplicate" in result ? "duplicate" : "accepted" });
      return { ...result, quota: reservation, warnings: reservation.softAlert ? [`${event.metric} usage is above 80%`] : [] };
    } catch (error) {
      await quota.release(c.organizationId, event.metric, event.quantity).catch((releaseError) => log.error({ releaseError }, "quota rollback failed"));
      usageCounter.inc({ metric: event.metric, result: "error" });
      throw error;
    }
  }

  @Get("members")
  async members(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    return tenantTransaction(c.organizationId, c.sub, async (db) =>
      (await db.query("SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.name", [c.organizationId])).rows,
    );
  }

  @Patch("members/:userId")
  async updateMember(@Req() req: AuthedRequest, @Param("userId") userId: string, @Body() body: { role: Role }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    if (!["owner", "admin", "billing", "member"].includes(body.role)) throw new HttpException("invalid role", 400);
    if (body.role === "owner" && c.role !== "owner") throw new HttpException("only owners can grant owner", 403);
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("UPDATE memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2 RETURNING *", [c.organizationId, userId, body.role]));
    await audit(c.organizationId, c.sub, "member.role_changed", "user", userId, { role: body.role });
    return { updated: true };
  }

  @Delete("members/:userId")
  async removeMember(@Req() req: AuthedRequest, @Param("userId") userId: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    const member = await pool.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2", [c.organizationId, userId]);
    if (member.rows[0]?.role === "owner") {
      const owners = await pool.query("SELECT count(*)::int count FROM memberships WHERE organization_id=$1 AND role='owner'", [c.organizationId]);
      if (owners.rows[0].count <= 1) throw new HttpException("cannot remove the last owner", 409);
      if (c.role !== "owner") throw new HttpException("only owners can remove owners", 403);
    }
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2", [c.organizationId, userId]));
    await audit(c.organizationId, c.sub, "member.removed", "user", userId);
    return { removed: true };
  }

  @Get("invitations")
  async invitations(@Req() req: AuthedRequest) {
    const c = await authorize(req, ["owner", "admin"]);
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query("SELECT id,email,role,expires_at,accepted_at,revoked_at FROM invitations WHERE organization_id=$1 ORDER BY expires_at DESC", [c.organizationId])).rows);
  }

  @Post("invitations")
  async invite(@Req() req: AuthedRequest, @Body() body: { email: string; role: Role }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    if (!body.email?.includes("@") || !["admin", "billing", "member"].includes(body.role)) throw new HttpException("invalid invitation", 400);
    const plan = await this.billing.entitlements(c.organizationId);
    const seats = Number(plan?.entitlements?.seats ?? 0);
    const occupied = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM memberships WHERE organization_id=$1) +
        (SELECT count(*)::int FROM invitations WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()) AS count`,
      [c.organizationId],
    );
    if (seats > 0 && occupied.rows[0].count >= seats) throw new HttpException("seat entitlement exceeded", 409);
    const token = randomBytes(32).toString("base64url");
    const invitation = await tenantTransaction(c.organizationId, c.sub, async (db) =>
      (await db.query("INSERT INTO invitations(organization_id,email,role,token_hash,expires_at) VALUES($1,lower($2),$3,$4,now()+interval '7 days') RETURNING id,email,role,expires_at", [c.organizationId, body.email, body.role, hash(token)])).rows[0],
    );
    await audit(c.organizationId, c.sub, "invitation.created", "invitation", invitation.id, { email: invitation.email, role: body.role });
    return { ...invitation, token: demoMode ? token : undefined, acceptUrl: demoMode ? `${webOrigin}?invite=${token}` : undefined };
  }

  @Post("invitations/accept")
  async acceptInvitation(@Req() req: AuthedRequest, @Body() body: { token: string }) {
    const c = await authorize(req);
    requireWritableWorkspace();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query("SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE", [hash(body.token)]);
      if (!invitation.rows[0] || invitation.rows[0].email.toLowerCase() !== c.email.toLowerCase()) throw new HttpException("invalid invitation", 400);
      await client.query("SELECT set_config('app.organization_id',$1,true)", [invitation.rows[0].organization_id]);
      await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [invitation.rows[0].organization_id, c.sub, invitation.rows[0].role]);
      await client.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [invitation.rows[0].id]);
      await client.query("COMMIT");
      await audit(invitation.rows[0].organization_id, c.sub, "invitation.accepted", "invitation", invitation.rows[0].id);
      return { accepted: true, organizationId: invitation.rows[0].organization_id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  @Delete("invitations/:id")
  async revokeInvitation(@Req() req: AuthedRequest, @Param("id") id: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("UPDATE invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL", [id]));
    await audit(c.organizationId, c.sub, "invitation.revoked", "invitation", id);
    return { revoked: true };
  }

  @Get("teams")
  async teams(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query(`SELECT t.id,t.name,count(tm.user_id)::int member_count FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id WHERE t.organization_id=$1 GROUP BY t.id ORDER BY t.name`, [c.organizationId])).rows);
  }

  @Post("teams")
  async createTeam(@Req() req: AuthedRequest, @Body() body: { name: string }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    const team = await tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query("INSERT INTO teams(organization_id,name) VALUES($1,$2) RETURNING *", [c.organizationId, body.name.trim()])).rows[0]);
    await audit(c.organizationId, c.sub, "team.created", "team", team.id);
    return team;
  }

  @Patch("teams/:id")
  async updateTeam(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { name: string }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("UPDATE teams SET name=$2 WHERE id=$1", [id, body.name.trim()]));
    await audit(c.organizationId, c.sub, "team.updated", "team", id);
    return { updated: true };
  }

  @Delete("teams/:id")
  async deleteTeam(@Req() req: AuthedRequest, @Param("id") id: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("DELETE FROM teams WHERE id=$1", [id]));
    await audit(c.organizationId, c.sub, "team.deleted", "team", id);
    return { deleted: true };
  }

  @Post("teams/:id/members/:userId")
  async addTeamMember(@Req() req: AuthedRequest, @Param("id") id: string, @Param("userId") userId: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query(`INSERT INTO team_members(organization_id,team_id,user_id)
      SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$3) ON CONFLICT DO NOTHING`, [c.organizationId, id, userId]));
    await audit(c.organizationId, c.sub, "team.member_added", "team", id, { userId });
    return { added: true };
  }

  @Delete("teams/:id/members/:userId")
  async removeTeamMember(@Req() req: AuthedRequest, @Param("id") id: string, @Param("userId") userId: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [id, userId]));
    await audit(c.organizationId, c.sub, "team.member_removed", "team", id, { userId });
    return { removed: true };
  }

  @Get("plans")
  async plans(@Req() req: AuthedRequest) {
    await authorize(req);
    return (await pool.query("SELECT id,code,version,name,price_cents,entitlements FROM plan_versions WHERE active_until IS NULL ORDER BY price_cents NULLS LAST")).rows;
  }

  @Post("plans/:code/select")
  async selectPlan(@Req() req: AuthedRequest, @Param("code") code: string) {
    const c = await authorize(req, ["owner", "billing"]);
    requireWritableWorkspace();
    const updated = await tenantTransaction(c.organizationId, c.sub, (db) => db.query(`UPDATE subscriptions SET plan_version_id=(
      SELECT id FROM plan_versions WHERE code=$2 AND active_until IS NULL ORDER BY version DESC LIMIT 1)
      WHERE organization_id=$1 RETURNING *`, [c.organizationId, code]));
    if (!updated.rowCount) throw new HttpException("plan not found", 404);
    await audit(c.organizationId, c.sub, "plan.selected", "plan", code);
    return { updated: true };
  }

  @Get("admin/overrides")
  async overrides(@Req() req: AuthedRequest) {
    const c = await authorize(req, ["owner", "admin"]);
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query("SELECT * FROM entitlement_overrides WHERE organization_id=$1 ORDER BY ends_at DESC", [c.organizationId])).rows);
  }

  @Post("admin/overrides")
  async createOverride(@Req() req: AuthedRequest, @Body() body: { key: string; value: number; reason: string; startsAt: string; endsAt: string }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    if (new Date(body.endsAt) <= new Date(body.startsAt) || !body.reason?.trim()) throw new HttpException("invalid override window", 400);
    const result = await tenantTransaction(c.organizationId, c.sub, (db) => db.query(
      "INSERT INTO entitlement_overrides(organization_id,key,value,reason,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [c.organizationId, body.key, body.value, body.reason, body.startsAt, body.endsAt, c.sub],
    ));
    await audit(c.organizationId, c.sub, "override.created", "entitlement_override", result.rows[0].id, body);
    return result.rows[0];
  }

  @Patch("admin/overrides/:id")
  async updateOverride(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { value: number; reason: string; endsAt: string }) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("UPDATE entitlement_overrides SET value=$2,reason=$3,ends_at=$4 WHERE id=$1", [id, body.value, body.reason, body.endsAt]));
    await audit(c.organizationId, c.sub, "override.updated", "entitlement_override", id, body);
    return { updated: true };
  }

  @Delete("admin/overrides/:id")
  async deleteOverride(@Req() req: AuthedRequest, @Param("id") id: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    await tenantTransaction(c.organizationId, c.sub, (db) => db.query("DELETE FROM entitlement_overrides WHERE id=$1", [id]));
    await audit(c.organizationId, c.sub, "override.deleted", "entitlement_override", id);
    return { deleted: true };
  }

  @Get("admin/audit")
  async auditLog(@Req() req: AuthedRequest) {
    const c = await authorize(req, ["owner", "admin"]);
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query("SELECT * FROM audit_log WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200", [c.organizationId])).rows);
  }

  @Get("admin/dlq")
  async inspectDlq(@Req() req: AuthedRequest) {
    await authorize(req, ["owner", "admin"]);
    const jobs = await dlq.getJobs(["waiting", "failed"], 0, 99);
    return Promise.all(jobs.map(async (job) => ({ id: job.id, data: job.data, failedReason: job.failedReason, attemptsMade: job.attemptsMade })));
  }

  @Post("admin/dlq/:id/replay")
  async replayDlq(@Req() req: AuthedRequest, @Param("id") id: string) {
    const c = await authorize(req, ["owner", "admin"]);
    requireWritableWorkspace();
    const job = await dlq.getJob(id);
    if (!job) throw new HttpException("DLQ job not found", 404);
    await usageQueue.add("usage.recorded", job.data.original, { attempts: 5, backoff: { type: "exponential", delay: 1000 } });
    await job.remove();
    await audit(c.organizationId, c.sub, "dlq.replayed", "job", id);
    return { replayed: true };
  }

  @Get("billing/invoices")
  async invoices(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    return tenantTransaction(c.organizationId, c.sub, async (db) => (await db.query("SELECT * FROM invoices WHERE organization_id=$1 ORDER BY stripe_event_created DESC", [c.organizationId])).rows);
  }

  @Get("billing/invoice-preview")
  async invoicePreview(@Req() req: AuthedRequest) {
    const c = await authorize(req);
    const subscription = await pool.query("SELECT stripe_customer_id FROM subscriptions WHERE organization_id=$1", [c.organizationId]);
    if (!stripe || !subscription.rows[0]?.stripe_customer_id) {
      if (!demoMode && !isPublicDemo()) throw new HttpException("Stripe is not configured", 503);
      return { mode: "demo", currency: "usd", amountDue: 4900, lines: [{ description: "Pro plan (sample)", amount: 4900 }] };
    }
    const invoice = await stripe.invoices.createPreview({ customer: subscription.rows[0].stripe_customer_id });
    return { mode: "stripe", currency: invoice.currency, amountDue: invoice.amount_due, lines: invoice.lines.data };
  }

  @Post("billing/checkout")
  async checkout(@Req() req: AuthedRequest, @Body() body: { priceId?: string; planCode?: string }) {
    const c = await authorize(req, ["owner", "billing"]);
    if (!stripe || !body.priceId) {
      if (!demoMode && !isPublicDemo()) throw new HttpException("Stripe checkout is not configured", 503);
      return { mode: "demo", url: `${webOrigin}/billing/result?checkout=demo-success` };
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: body.priceId, quantity: 1 }],
      success_url: `${webOrigin}/billing/result?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${webOrigin}/billing/result?checkout=cancel`,
      client_reference_id: c.organizationId,
      metadata: { organization_id: c.organizationId, plan_code: body.planCode ?? "pro" },
      subscription_data: { metadata: { organization_id: c.organizationId, plan_code: body.planCode ?? "pro" } },
    });
    return { mode: "stripe", url: session.url };
  }

  @Post("stripe/webhook")
  async webhook(@Req() req: Request, @Headers("stripe-signature") signature?: string) {
    let event: Stripe.Event;
    if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
      if (!signature) throw new HttpException("missing Stripe signature", 400);
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      if (!demoMode) throw new HttpException("unsigned webhooks are disabled", 503);
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
    }
    const inserted = await pool.query(
      "INSERT INTO stripe_events(id,event_created,event_type,payload) VALUES($1,to_timestamp($2),$3,$4) ON CONFLICT DO NOTHING RETURNING id",
      [event.id, event.created, event.type, event],
    );
    if (!inserted.rows[0]) { webhookCounter.inc({ type: event.type, result: "duplicate" }); return { received: true, duplicate: true }; }
    try {
      await this.billing.projectStripeEvent(event);
      await pool.query("UPDATE stripe_events SET processed_at=now(),error=NULL WHERE id=$1", [event.id]);
      webhookCounter.inc({ type: event.type, result: "processed" });
      return { received: true };
    } catch (error) {
      await pool.query("UPDATE stripe_events SET error=$2 WHERE id=$1", [event.id, error instanceof Error ? error.message : String(error)]);
      webhookCounter.inc({ type: event.type, result: "error" });
      throw new HttpException("webhook projection failed", 500);
    }
  }
}

@Module({ controllers: [AppController], providers: [BillingService] })
export class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  app.use("/stripe/webhook", express.raw({ type: "application/json" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.useGlobalFilters(new ZodExceptionFilter());
  app.use(pinoHttp({
    logger: log,
    genReqId: (req, res) => {
      const requestId = String(req.headers["x-request-id"] ?? randomUUID());
      res.setHeader("x-request-id", requestId);
      return requestId;
    },
    customProps: (req) => ({ requestId: req.id }),
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
  }));
  app.use((req: Request, res: Response, next: () => void) => {
    const end = requestLatency.startTimer();
    res.on("finish", () => end({ method: req.method, status: String(res.statusCode) }));
    next();
  });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      const allowed = !origin || origin === webOrigin || (!production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
      callback(null, allowed);
    },
    credentials: true,
    exposedHeaders: ["x-request-id"],
  });
  return app;
}

async function bootstrap() {
  if (production && !isPublicDemo() && (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET)) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required in production");
  }
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
  log.info({ port: Number(process.env.PORT ?? 4000) }, "api started");
}

if (process.env.NODE_ENV !== "test") void bootstrap();
