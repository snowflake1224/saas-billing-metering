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
  await pool.query("COMMIT");
  console.log("seeded demo@fb3.local / DemoPass123!");
} catch (error) {
  await pool.query("ROLLBACK");
  throw error;
} finally {
  await pool.end();
}
