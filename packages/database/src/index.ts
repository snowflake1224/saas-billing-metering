import pg from "pg";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://fb3:fb3@localhost:55432/fb3",
  max: 20,
});

export async function tenantTransaction<T>(
  organizationId: string,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [
      organizationId,
      userId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function healthcheck(): Promise<boolean> {
  return (await pool.query("SELECT 1 AS ok")).rows[0].ok === 1;
}
