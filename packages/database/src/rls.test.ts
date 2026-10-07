import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { pool } from "./index.js";

const { Pool } = pg;
const appUrl = new URL(process.env.DATABASE_URL ?? "postgresql://fb3:fb3@localhost:55432/fb3");
appUrl.username = "fb3_app";
appUrl.password = "fb3_app_test";
const appPool = new Pool({ connectionString: appUrl.toString() });
let orgA: string;
let orgB: string;

describe("tenant RLS", () => {
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN CREATE ROLE fb3_app LOGIN PASSWORD 'fb3_app_test' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN ALTER ROLE fb3_app WITH PASSWORD 'fb3_app_test' NOSUPERUSER NOBYPASSRLS; END $$`);
    await pool.query("GRANT USAGE ON SCHEMA public TO fb3_app");
    await pool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fb3_app");
    const orgs = await pool.query("INSERT INTO organizations(name,slug) VALUES('RLS A',$1),('RLS B',$2) RETURNING id", [`rls-a-${Date.now()}`, `rls-b-${Date.now()}`]);
    [orgA, orgB] = orgs.rows.map((row) => row.id);
    await pool.query(`INSERT INTO usage_events(organization_id,idempotency_key,metric,quantity,occurred_at)
      VALUES($1,'rls-a-event','api_requests',1,now()),($2,'rls-b-event','api_requests',1,now())`, [orgA, orgB]);
  });
  afterAll(async () => {
    await appPool.end();
    await pool.end();
  });

  it("returns only the selected organization", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [orgA]);
      const visible = await client.query("SELECT organization_id,idempotency_key FROM usage_events");
      expect(visible.rows).toEqual([{ organization_id: orgA, idempotency_key: "rls-a-event" }]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("rejects cross-tenant inserts", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [orgA]);
      await expect(client.query(`INSERT INTO usage_events(organization_id,idempotency_key,metric,quantity,occurred_at)
        VALUES($1,'cross-tenant','api_requests',1,now())`, [orgB])).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("keeps usage events immutable", async () => {
    await expect(pool.query("DELETE FROM usage_events WHERE organization_id=$1", [orgA])).rejects.toThrow(/immutable/);
  });
});
