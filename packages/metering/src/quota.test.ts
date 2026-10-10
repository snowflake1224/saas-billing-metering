import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { QuotaService } from "./index.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379");
const quota = new QuotaService(redis);
describe("atomic quota reservations", () => {
  afterAll(() => redis.quit());
  it("never exceeds the limit under concurrency", async () => {
    const org = randomUUID();
    const results = await Promise.all(Array.from({ length: 100 }, () => quota.reserve(org, "api_requests", 1, 50)));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(Math.max(...results.map((r) => r.reserved))).toBe(50);
  });

  it("snapshots committed and reserved units", async () => {
    const org = randomUUID();
    await quota.reserve(org, "ai_tokens", 30, 100);
    await quota.reserve(org, "ai_tokens", 20, 100);
    await quota.commit(org, "ai_tokens", 30);
    expect(await quota.snapshot(org, "ai_tokens")).toMatchObject({ used: 30, reserved: 20 });
  });
});
