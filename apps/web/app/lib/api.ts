"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const configuredApi = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace("://localhost:", "://127.0.0.1:");
export const API = configuredApi === "same-origin" ? "/api" : configuredApi.replace(/\/$/, "");
export const SESSION_EXPIRED_EVENT = "fb3:session-expired";

export type Role = "owner" | "admin" | "billing" | "member";
export type Org = { id: string; name: string; slug?: string; role: Role };
export type Dashboard = {
  organizationId?: string;
  plan?: { code: string; name: string; version: number; status: string; price_cents?: number | null; entitlements: Record<string, number>; period_end?: string | null };
  usage: Array<{ metric: string; used: string }>;
};
export type Capabilities = {
  protectedDemo: boolean;
  role: Role;
  permissions: { simulateUsage: boolean; checkoutPreview: boolean; manageWorkspace: boolean; manageBilling: boolean; replayJobs: boolean };
};
export type Member = { id: string; name: string; email: string; role: Role };
export type Team = { id: string; name: string; member_count: number };
export type Invoice = { id: string; status: string; currency: string; amount_due: number; amount_paid?: number; hosted_invoice_url?: string | null; period_start?: string | null; period_end?: string | null; stripe_event_created: string };
export type UsageRow = { bucket: string; metric: string; quantity: number | string };
export type Override = { id: string; key: string; value: string; reason: string; starts_at?: string; ends_at: string };
export type Audit = { id: string; action: string; target_type: string; target_id?: string | null; actor_id?: string | null; metadata?: Record<string, unknown>; created_at: string };
export type Job = { id: string; failedReason?: string; attemptsMade: number; data?: { error?: string; failedAt?: string; original?: Record<string, unknown> } };
export type Plan = { code: string; name: string; price_cents: number | null; entitlements: Record<string, number> };
export type InvoicePreview = { mode: string; currency: string; amountDue: number; lines: Array<{ description?: string | null; amount: number }> };
export type Health = { status: string; dependencies: { postgres: boolean; redis: boolean }; time: string };
export type Pipeline = {
  generatedAt: string;
  outbox: { pending: number; oldestMs: number; publishedLastHour: number };
  queue: { waiting: number; active: number; completed: number; failed: number; delayed: number; available: boolean };
  deadLetter: { depth: number; available: boolean };
  processing: { ingested24h: number; processed24h: number; backlog: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
  aggregates: { buckets: number; latestBucket: string | null };
  throughput: Array<{ minute: string; events: number; units: number }>;
};
export type QuotaMetric = {
  metric: string; limit: number; used: number; remaining: number; percent: number; last24h: number; changePercent: number | null;
  burnPerHour: number; projectedPeriodTotal: number; projectedExhaustionAt: string | null; redis: { used: number; reserved: number } | null;
};
export type QuotaStatus = { period: { start: string; end: string }; softAlertPercent: number; metrics: QuotaMetric[] };
export type UsageEvent = {
  id: string; idempotencyKey: string; metric: string; quantity: number; occurredAt: string; ingestedAt: string;
  publishedAt: string | null; processedAt: string | null; status: "pending" | "queued" | "processed"; latencyMs: number | null; dimensions: Record<string, unknown>;
};
export type EventTrace = { event: UsageEvent; stages: Array<{ stage: string; label: string; at: string | null; offsetMs: number | null }>; bucket: { start: string; quantity: number } | null };
export type OpsMetrics = {
  uptimeSeconds: number;
  quotaDecisions: Record<string, number>;
  usageResults: Record<string, number>;
  webhooks: Record<string, number>;
  http: { requests: number; averageMs: number; status: Record<string, number>; latencyBuckets: Array<{ le: string; cumulative: number }> };
  process: { residentMemoryBytes: number; heapUsedBytes: number; eventLoopLagSeconds: number };
};
export type ApiResult<T = unknown> = { ok: boolean; status: number; ms: number; requestId: string | null; body: T; method: string; path: string; at: number };

export class SessionExpiredError extends Error {}

async function send(path: string, init: RequestInit, retry: boolean): Promise<Response> {
  const token = localStorage.getItem("fb3_access");
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (response.status === 401 && path !== "/auth/refresh" && path !== "/auth/login" && retry) {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) {
      localStorage.setItem("fb3_access", (await refreshed.json()).accessToken);
      return send(path, init, false);
    }
    localStorage.removeItem("fb3_access");
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new SessionExpiredError("Your session expired. Sign in again.");
  }
  return response;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init, true);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message : body.message?.message;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export async function inspect<T = unknown>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const started = performance.now();
  const response = await send(path, init, true);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON bodies are shown raw */ }
  return {
    ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), requestId: response.headers.get("x-request-id"),
    body: body as T, method: init.method ?? "GET", path, at: Date.now(),
  };
}

export function usePoll<T>(fetcher: () => Promise<T>, deps: unknown[], interval = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const latest = useRef(fetcher);
  latest.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      setData(await latest.current());
      setError("");
      setUpdatedAt(Date.now());
    } catch (reason) {
      if (!(reason instanceof SessionExpiredError)) setError(reason instanceof Error ? reason.message : "Request failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!interval) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, interval);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, interval, ...deps]);

  return { data, error, updatedAt, refresh };
}

export const metricLabels: Record<string, string> = { api_requests: "API requests", ai_tokens: "AI tokens", storage_gb: "Storage (GB)", seats: "Seats" };
export const metricColors: Record<string, string> = { api_requests: "#60a5fa", ai_tokens: "#a78bfa", storage_gb: "#22d3ee", seats: "#34d399" };
export const metricLabel = (metric: string) => metricLabels[metric] ?? metric.replaceAll("_", " ");
export const metricColor = (metric: string) => metricColors[metric] ?? "#94a3b8";

export const number = (value: number) => value.toLocaleString("en-US");
export function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value);
}
export const money = (cents: number, currency = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
export function duration(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${(ms / 3600000).toFixed(1)} h`;
}
export function bytes(value: number) {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
export function relative(value: string | number | Date | null | undefined) {
  if (!value) return "—";
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60000) return format.format(Math.round(diff / 1000), "second");
  if (abs < 3600000) return format.format(Math.round(diff / 60000), "minute");
  if (abs < 86400000) return format.format(Math.round(diff / 3600000), "hour");
  return format.format(Math.round(diff / 86400000), "day");
}
export function curl(method: string, path: string, body?: string) {
  const base = API.startsWith("/") ? `${window.location.origin}${API}` : API;
  const lines = [`curl -X ${method} '${base}${path}'`, `  -H 'authorization: Bearer $FB3_TOKEN'`];
  if (body) lines.push(`  -H 'content-type: application/json'`, `  -d '${body.replace(/'/g, "'\\''")}'`);
  return lines.join(" \\\n");
}
