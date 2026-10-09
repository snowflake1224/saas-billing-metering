import argon2 from "argon2";
import { pool } from "./index.js";

const passwordHash = await argon2.hash("DemoPass123!");
await pool.query("BEGIN");
try {
  const user = await pool.query(
    `INSERT INTO users(email,password_hash,name) VALUES('demo@fb3.local',$1,'Demo Owner')
     ON CONFLICT(email) DO UPDATE SET name=excluded.name RETURNING id`,
    [passwordHash],
  );
  const org = await pool.query(
    `INSERT INTO organizations(name,slug) VALUES('Acme Analytics','acme')
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name RETURNING id`,
  );
  await pool.query(
    `INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [org.rows[0].id, user.rows[0].id],
  );
  await pool.query(`INSERT INTO plan_versions(code,version,name,price_cents,entitlements) VALUES
    ('free',1,'Free',0,'{"api_requests":10000,"storage_gb":1,"seats":3,"ai_tokens":50000}'),
    ('pro',1,'Pro',4900,'{"api_requests":1000000,"storage_gb":100,"seats":25,"ai_tokens":5000000}'),
    ('enterprise',1,'Enterprise',null,'{"api_requests":100000000,"storage_gb":10000,"seats":1000,"ai_tokens":1000000000}')
    ON CONFLICT(code,version) DO NOTHING`);
  await pool.query(`INSERT INTO subscriptions(organization_id,plan_version_id)
    SELECT $1,id FROM plan_versions WHERE code='pro' AND version=1 ON CONFLICT(organization_id) DO NOTHING`, [org.rows[0].id]);

  const sampleUsers = await pool.query(
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
    await pool.query(
      `INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role`,
      [org.rows[0].id, member.id, sampleRoles[member.email]],
    );
  }

  await pool.query(
    `INSERT INTO teams(id,organization_id,name) VALUES
      ('20000000-0000-4000-8000-000000000001',$1,'Platform'),
      ('20000000-0000-4000-8000-000000000002',$1,'AI Products')
     ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
    [org.rows[0].id],
  );
  await pool.query(
    `INSERT INTO team_members(organization_id,team_id,user_id)
     SELECT $1, team_id, user_id FROM (VALUES
       ('20000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000001'::uuid),
       ('20000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000003'::uuid),
       ('20000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000002'::uuid)
     ) AS memberships(team_id,user_id)
     ON CONFLICT DO NOTHING`,
    [org.rows[0].id],
  );

  await pool.query(
    `INSERT INTO usage_aggregates(organization_id,metric,bucket_start,quantity)
     SELECT $1, metric, date_trunc('hour', now()) - (hour_offset || ' hours')::interval,
       CASE metric
         WHEN 'api_requests' THEN 4000 + ((hour_offset * 791) % 8000)
         WHEN 'ai_tokens' THEN 15000 + ((hour_offset * 3571) % 50000)
         WHEN 'storage_gb' THEN 1
         ELSE 1
       END
     FROM generate_series(0,71) hour_offset
     CROSS JOIN (VALUES ('api_requests'),('ai_tokens'),('storage_gb')) metrics(metric)
     ON CONFLICT(organization_id,metric,bucket_start) DO UPDATE SET quantity=excluded.quantity`,
    [org.rows[0].id],
  );

  await pool.query(
    `INSERT INTO entitlement_overrides(id,organization_id,key,value,reason,starts_at,ends_at,created_by)
     VALUES('30000000-0000-4000-8000-000000000001',$1,'ai_tokens',6500000,
       'Launch-week capacity approved for the demo workspace',now()-interval '2 days',now()+interval '12 days',$2)
     ON CONFLICT(id) DO UPDATE SET value=excluded.value,reason=excluded.reason,ends_at=excluded.ends_at`,
    [org.rows[0].id, user.rows[0].id],
  );

  await pool.query(
    `INSERT INTO invoices(id,organization_id,stripe_customer_id,status,currency,amount_due,amount_paid,hosted_invoice_url,period_start,period_end,stripe_event_created)
     VALUES
       ('in_demo_oct',$1,'cus_demo_acme','paid','usd',4900,4900,NULL,now()-interval '2 months',now()-interval '1 month',now()-interval '1 month'),
       ('in_demo_sep',$1,'cus_demo_acme','paid','usd',4900,4900,NULL,now()-interval '3 months',now()-interval '2 months',now()-interval '2 months')
     ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_paid=excluded.amount_paid`,
    [org.rows[0].id],
  );

  await pool.query(
    `INSERT INTO audit_log(organization_id,actor_id,action,target_type,target_id,metadata,created_at)
     SELECT $1,$2,entry.action,entry.target_type,entry.target_id,entry.metadata,entry.created_at
     FROM (VALUES
       ('plan.upgraded','plan','pro','{"from":"free","to":"pro"}'::jsonb,now()-interval '14 days'),
       ('team.created','team','20000000-0000-4000-8000-000000000001','{"name":"Platform"}'::jsonb,now()-interval '10 days'),
       ('override.created','entitlement_override','30000000-0000-4000-8000-000000000001','{"key":"ai_tokens"}'::jsonb,now()-interval '2 days')
     ) AS entry(action,target_type,target_id,metadata,created_at)
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_log existing
       WHERE existing.organization_id=$1 AND existing.action=entry.action AND existing.target_id=entry.target_id
     )`,
    [org.rows[0].id, user.rows[0].id],
  );
  await pool.query("COMMIT");
  console.log("seeded demo@fb3.local / DemoPass123!");
} catch (error) {
  await pool.query("ROLLBACK");
  throw error;
} finally {
  await pool.end();
}
