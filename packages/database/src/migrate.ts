import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, "../migrations");
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
const baseline = await pool.query("SELECT to_regclass('public.users') AS users");
if (baseline.rows[0].users) {
  await pool.query("INSERT INTO schema_migrations(version) VALUES('001_init.sql') ON CONFLICT DO NOTHING");
}
for (const version of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
  const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
  if (applied.rowCount) continue;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(join(directory, version), "utf8"));
    await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    await client.query("COMMIT");
    console.log(`applied ${version}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
console.log("database migrations current");
await pool.end();
