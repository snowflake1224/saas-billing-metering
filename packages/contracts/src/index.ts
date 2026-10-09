import { z } from "zod";
export { ZodError } from "zod";

export const metricSchema = z.enum(["api_requests", "storage_gb", "seats", "ai_tokens"]);
export type Metric = z.infer<typeof metricSchema>;
export const usageEventSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  metric: metricSchema,
  quantity: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  dimensions: z.record(z.string(), z.string()).default({}),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member", "billing"]),
});
export interface AuthClaims { sub: string; organizationId: string; role: string; type: "access" | "refresh"; jti: string }
export interface Entitlements { api_requests: number; storage_gb: number; seats: number; ai_tokens: number }
export interface UsageSummary { metric: Metric; used: number; limit: number; percent: number }
