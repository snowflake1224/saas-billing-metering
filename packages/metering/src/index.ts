import { Redis } from "ioredis";

const reserveLua = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
local requested = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + reserved + requested > limit then
  return {0, used, reserved, limit}
end
local next = redis.call('INCRBY', KEYS[2], requested)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return {1, used, next, limit}
`;

export class QuotaService {
  constructor(
    private readonly redis: Redis,
    private readonly failurePolicy: "open" | "closed" = "closed",
  ) {}

  async reserve(orgId: string, metric: string, quantity: number, limit: number, ttl = 300) {
    try {
      const period = new Date().toISOString().slice(0, 7);
      const prefix = `quota:${orgId}:${metric}:${period}`;
      const result = (await this.redis.eval(reserveLua, 2, `${prefix}:used`, `${prefix}:reserved`, quantity, limit, ttl)) as number[];
      return { allowed: result[0] === 1, used: result[1], reserved: result[2], limit, softAlert: (result[1] + result[2]) / limit >= 0.8 };
    } catch (error) {
      if (this.failurePolicy === "open") return { allowed: true, degraded: true, used: 0, reserved: 0, limit, softAlert: false };
      throw error;
    }
  }

  async commit(orgId: string, metric: string, quantity: number) {
    const period = new Date().toISOString().slice(0, 7);
    const prefix = `quota:${orgId}:${metric}:${period}`;
    await this.redis.multi().decrby(`${prefix}:reserved`, quantity).incrby(`${prefix}:used`, quantity).exec();
  }

  async release(orgId: string, metric: string, quantity: number) {
    const period = new Date().toISOString().slice(0, 7);
    const key = `quota:${orgId}:${metric}:${period}:reserved`;
    await this.redis.eval(
      "local n=tonumber(redis.call('GET',KEYS[1]) or '0'); return redis.call('SET',KEYS[1],math.max(0,n-tonumber(ARGV[1])))",
      1,
      key,
      quantity,
    );
  }
}

export interface AnalyticsAdapter {
  usage(orgId: string, from: Date, to: Date): Promise<Array<{ metric: string; quantity: number; bucket: Date }>>;
}

export class PostgresAnalyticsAdapter implements AnalyticsAdapter {
  constructor(private readonly query: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) {}

  async usage(orgId: string, from: Date, to: Date) {
    const result = await this.query(
      `SELECT metric,quantity::bigint,bucket_start AS bucket
       FROM usage_aggregates WHERE organization_id=$1 AND bucket_start >= $2 AND bucket_start < $3
       ORDER BY bucket_start,metric`,
      [orgId, from, to],
    );
    return result.rows.map((row) => ({
      metric: String(row.metric),
      quantity: Number(row.quantity),
      bucket: new Date(String(row.bucket)),
    }));
  }
}
