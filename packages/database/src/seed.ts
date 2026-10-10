import argon2 from "argon2";
import { pool } from "./index.js";

const passwordHash = await argon2.hash("DemoPass123!");
const db = await pool.connect();
await db.query("BEGIN");
try {
  const user = await db.query(
    `INSERT INTO users(email,password_hash,name) VALUES('demo@fb3.local',$1,'Demo Owner')
     ON CONFLICT(email) DO UPDATE SET name=excluded.name RETURNING id`,
    [passwordHash],
  );
  const org = await db.query(
    `INSERT INTO organizations(name,slug) VALUES('Acme Analytics','acme')
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name RETURNING id`,
  );
  const orgId = org.rows[0].id;
  await db.query("SELECT set_config('app.organization_id',$1,true)", [orgId]);
  await db.query(
    `INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [orgId, user.rows[0].id],
  );
  await db.query(`INSERT INTO plan_versions(code,version,name,price_cents,entitlements) VALUES
    ('free',1,'Free',0,'{"api_requests":10000,"storage_gb":1,"seats":3,"ai_tokens":50000}'),
    ('pro',1,'Pro',4900,'{"api_requests":1000000,"storage_gb":100,"seats":25,"ai_tokens":5000000}'),
    ('enterprise',1,'Enterprise',null,'{"api_requests":100000000,"storage_gb":10000,"seats":1000,"ai_tokens":1000000000}')
    ON CONFLICT(code,version) DO NOTHING`);
  await db.query(`INSERT INTO subscriptions(organization_id,plan_version_id)
    SELECT $1,id FROM plan_versions WHERE code='pro' AND version=1 ON CONFLICT(organization_id) DO NOTHING`, [orgId]);

  const sampleUsers = await db.query(
    `INSERT INTO users(id,email,password_hash,name) VALUES
      ('10000000-0000-4000-8000-000000000001','maya@acme.demo',$1,'Maya Chen'),
      ('10000000-0000-4000-8000-000000000002','leo@acme.demo',$1,'Leo Martins'),
      ('10000000-0000-4000-8000-000000000003','priya@acme.demo',$1,'Priya Shah')
     ON CONFLICT(email) DO UPDATE SET name=excluded.name
     RETURNING id,email`,
    [passwordHash],
  );
  const sampleRoles: Record<string, string> = {
    "maya@acme.demo": "admin",
    "leo@acme.demo": "billing",
    "priya@acme.demo": "member",
  };
  for (const member of sampleUsers.rows) {
    await db.query(
      `INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role`,
      [orgId, member.id, sampleRoles[member.email]],
    );
  }

  await db.query(
    `INSERT INTO teams(id,organization_id,name) VALUES
      ('20000000-0000-4000-8000-000000000001',$1,'Platform'),
      ('20000000-0000-4000-8000-000000000002',$1,'AI Products')
     ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
    [orgId],
  );
  await db.query(
    `INSERT INTO team_members(organization_id,team_id,user_id)
     SELECT $1, team_id, user_id FROM (VALUES
       ('20000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000001'::uuid),
       ('20000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000003'::uuid),
       ('20000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000002'::uuid)
     ) AS memberships(team_id,user_id)
     ON CONFLICT DO NOTHING`,
    [orgId],
  );

  // Raw events (not hand-written aggregates) so the worker's hourly reconciler keeps the history intact.
  await db.query(
    `WITH hours AS (
       SELECT h, date_trunc('hour', now()) - make_interval(hours => h) AS bucket,
         0.5 + 0.5 * sin(2 * pi() * (extract(hour FROM date_trunc('hour', now()) - make_interval(hours => h)) - 9) / 24) AS wave
       FROM generate_series(0, 719) h
     ), samples AS (
       SELECT 'api_requests' AS metric, h, bucket, (350 + round(1250 * wave) + (h * 137) % 160)::bigint AS quantity,
         jsonb_build_object('endpoint', (ARRAY['/v1/query','/v1/ingest','/v1/export','/v1/search'])[1 + h % 4],
           'region', (ARRAY['us-east-1','eu-west-1','ap-south-1'])[1 + h % 3]) AS dimensions
       FROM hours
       UNION ALL
       SELECT 'ai_tokens', h, bucket, (2500 + round(8500 * wave) + (h * 3571) % 2400)::bigint,
         jsonb_build_object('model', (ARRAY['gpt-4o-mini','claude-haiku','llama-3-70b'])[1 + h % 3],
           'feature', (ARRAY['summaries','copilot','classification'])[1 + (h / 3) % 3])
       FROM hours
       UNION ALL
       SELECT 'storage_gb', h, bucket, 2, jsonb_build_object('bucket', 's3://acme-warehouse', 'tier', 'standard')
       FROM hours WHERE h % 24 = 5
     ), timed AS (
       SELECT *, least(now() - interval '1 minute', bucket + make_interval(mins => (h * 7) % 55)) AS occurred_at FROM samples
     )
     INSERT INTO usage_events(organization_id,idempotency_key,metric,quantity,occurred_at,created_at,dimensions)
     SELECT $1, 'seed-' || metric || '-' || to_char(bucket, 'YYYYMMDDHH24'), metric, quantity, occurred_at,
       occurred_at + make_interval(secs => ((h * 13) % 900) / 1000.0), dimensions || '{"source":"seed"}'
     FROM timed
     ON CONFLICT(organization_id,idempotency_key) DO NOTHING`,
    [orgId],
  );
  await db.query(
    `INSERT INTO outbox(organization_id,topic,payload,created_at,published_at)
     SELECT e.organization_id, 'usage.recorded', to_jsonb(e), e.created_at,
       e.created_at + make_interval(secs => (40 + abs(hashtext(e.id::text)) % 900) / 1000.0)
     FROM usage_events e
     WHERE e.organization_id=$1 AND e.idempotency_key LIKE 'seed-%'
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.payload->>'id' = e.id::text)`,
    [orgId],
  );
  await db.query(
    `INSERT INTO processed_events(consumer,event_id,processed_at)
     SELECT 'usage-aggregate', e.id, o.published_at + make_interval(secs => (15 + abs(hashtext(e.idempotency_key)) % 260) / 1000.0)
     FROM usage_events e JOIN outbox o ON o.payload->>'id' = e.id::text
     WHERE e.organization_id=$1 AND e.idempotency_key LIKE 'seed-%'
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  await db.query("DELETE FROM usage_aggregates WHERE organization_id=$1", [orgId]);
  await db.query(
    `INSERT INTO usage_aggregates(organization_id,metric,bucket_start,quantity)
     SELECT e.organization_id, e.metric, date_trunc('hour', e.occurred_at), sum(e.quantity)::bigint
     FROM usage_events e JOIN processed_events p ON p.consumer='usage-aggregate' AND p.event_id=e.id
     WHERE e.organization_id=$1 GROUP BY 1,2,3`,
    [orgId],
  );

  await db.query(
    `INSERT INTO entitlement_overrides(id,organization_id,key,value,reason,starts_at,ends_at,created_by)
     VALUES('30000000-0000-4000-8000-000000000001',$1,'ai_tokens',6500000,
       'Launch-week capacity approved for the demo workspace',now()-interval '2 days',now()+interval '12 days',$2)
     ON CONFLICT(id) DO UPDATE SET value=excluded.value,reason=excluded.reason,starts_at=excluded.starts_at,ends_at=excluded.ends_at`,
    [orgId, user.rows[0].id],
  );

  await db.query(
    `INSERT INTO invoices(id,organization_id,stripe_customer_id,status,currency,amount_due,amount_paid,hosted_invoice_url,period_start,period_end,stripe_event_created)
     VALUES
       ('in_demo_oct',$1,'cus_demo_acme','paid','usd',4900,4900,NULL,now()-interval '2 months',now()-interval '1 month',now()-interval '1 month'),
       ('in_demo_sep',$1,'cus_demo_acme','paid','usd',4900,4900,NULL,now()-interval '3 months',now()-interval '2 months',now()-interval '2 months')
     ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_paid=excluded.amount_paid`,
    [orgId],
  );

  await db.query(
    `INSERT INTO audit_log(organization_id,actor_id,action,target_type,target_id,metadata,created_at)
     SELECT $1,entry.actor_id::uuid,entry.action,entry.target_type,entry.target_id,entry.metadata,entry.created_at
     FROM (VALUES
       ($2::text,'plan.upgraded','plan','pro','{"from":"free","to":"pro"}'::jsonb,now()-interval '14 days'),
       ('10000000-0000-4000-8000-000000000001','team.created','team','20000000-0000-4000-8000-000000000001','{"name":"Platform"}'::jsonb,now()-interval '10 days'),
       ('10000000-0000-4000-8000-000000000001','team.created','team','20000000-0000-4000-8000-000000000002','{"name":"AI Products"}'::jsonb,now()-interval '9 days'),
       ($2::text,'member.invited','invitation','leo@acme.demo','{"role":"billing"}'::jsonb,now()-interval '8 days'),
       ('10000000-0000-4000-8000-000000000001','member.role_changed','membership','10000000-0000-4000-8000-000000000003','{"from":"billing","to":"member"}'::jsonb,now()-interval '5 days'),
       ($2::text,'override.created','entitlement_override','30000000-0000-4000-8000-000000000001','{"key":"ai_tokens","value":6500000}'::jsonb,now()-interval '2 days'),
       ('10000000-0000-4000-8000-000000000001','dlq.replayed','job','seed-job-1842','{"attempts":5}'::jsonb,now()-interval '20 hours')
     ) AS entry(actor_id,action,target_type,target_id,metadata,created_at)
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_log existing
       WHERE existing.organization_id=$1 AND existing.action=entry.action AND existing.target_id=entry.target_id
     )`,
    [orgId, user.rows[0].id],
  );
  await db.query("COMMIT");
  console.log("seeded demo@fb3.local / DemoPass123!");
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  db.release();
  await pool.end();
}
