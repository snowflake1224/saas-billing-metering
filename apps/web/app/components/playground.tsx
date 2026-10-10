"use client";

import { FormEvent, useMemo, useState } from "react";
import { Cpu, History, Play, Radio, Terminal } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiResult, OpsMetrics, bytes, curl, duration, inspect, number, request, usePoll } from "../lib/api";
import { Badge, Card, CopyButton, JsonView, Select, Stat } from "./ui";

type Endpoint = { value: string; method: "GET" | "POST"; path: string; label: string; hint: string; admin?: boolean; body?: () => string };
const endpoints: Endpoint[] = [
  { value: "health", method: "GET", path: "/health", label: "GET /health", hint: "Dependency checks, unauthenticated" },
  { value: "capabilities", method: "GET", path: "/capabilities", label: "GET /capabilities", hint: "Role and protected-demo permissions" },
  { value: "dashboard", method: "GET", path: "/dashboard", label: "GET /dashboard", hint: "Plan, entitlements, month-to-date usage" },
  { value: "quota", method: "GET", path: "/quota/status", label: "GET /quota/status", hint: "Limits, Redis reservations, burn rate, forecast" },
  { value: "pipeline", method: "GET", path: "/ops/pipeline", label: "GET /ops/pipeline", hint: "Outbox lag, BullMQ counts, latency percentiles" },
  { value: "metrics", method: "GET", path: "/ops/metrics", label: "GET /ops/metrics", hint: "Prometheus registry as JSON" },
  { value: "events", method: "GET", path: "/usage/events?limit=5", label: "GET /usage/events", hint: "Raw immutable events with stage timestamps" },
  { value: "analytics", method: "GET", path: "/analytics/usage?range=24h&granularity=hour", label: "GET /analytics/usage", hint: "Hourly or daily aggregates by range" },
  { value: "plans", method: "GET", path: "/plans", label: "GET /plans", hint: "Versioned plan catalog" },
  { value: "invoices", method: "GET", path: "/billing/invoices", label: "GET /billing/invoices", hint: "Stripe-projected invoices" },
  { value: "preview", method: "GET", path: "/billing/invoice-preview", label: "GET /billing/invoice-preview", hint: "Upcoming invoice" },
  { value: "members", method: "GET", path: "/members", label: "GET /members", hint: "Workspace memberships" },
  { value: "audit", method: "GET", path: "/admin/audit", label: "GET /admin/audit", hint: "Owner/admin only", admin: true },
  { value: "dlq", method: "GET", path: "/admin/dlq", label: "GET /admin/dlq", hint: "Owner/admin only", admin: true },
  {
    value: "ingest", method: "POST", path: "/usage/events", label: "POST /usage/events", hint: "Ingest one idempotent usage event",
    body: () => JSON.stringify({ idempotencyKey: `playground-${crypto.randomUUID()}`, metric: "api_requests", quantity: 25, occurredAt: new Date().toISOString(), dimensions: { source: "portfolio_demo", client: "api-playground" } }, null, 2),
  },
];

const statusTone = (status: number) => (status < 300 ? "green" : status < 500 ? "amber" : "red") as "green" | "amber" | "red";

export function PlaygroundSection({ isAdmin }: { isAdmin: boolean }) {
  const available = endpoints.filter((endpoint) => isAdmin || !endpoint.admin);
  const [choice, setChoice] = useState("quota");
  const endpoint = available.find((item) => item.value === choice) ?? available[0];
  const [path, setPath] = useState(endpoint.path);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [history, setHistory] = useState<ApiResult[]>([]);
  const [bodyError, setBodyError] = useState("");

  function pick(value: string) {
    const next = available.find((item) => item.value === value)!;
    setChoice(value);
    setPath(next.path);
    setBody(next.body?.() ?? "");
    setBodyError("");
  }

  async function run(event?: FormEvent) {
    event?.preventDefault();
    if (endpoint.method === "POST") {
      try { JSON.parse(body); } catch { setBodyError("Body must be valid JSON"); return; }
    }
    setBodyError("");
    setPending(true);
    try {
      const response = await inspect(path, endpoint.method === "POST" ? { method: "POST", body } : {});
      setResult(response);
      setHistory((list) => [response, ...list].slice(0, 8));
      if (endpoint.body) setBody(endpoint.body());
    } finally {
      setPending(false);
    }
  }

  const size = result ? new Blob([JSON.stringify(result.body)]).size : 0;
  return <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
    <div className="min-w-0 space-y-5">
      <Card title="API playground" icon={<Terminal size={16} className="text-blue-300"/>} subtitle="Authenticated requests with your session token. Every response carries an x-request-id that matches the API logs.">
        <form onSubmit={(event) => void run(event)} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[16rem_1fr_auto]">
            <Select label="Endpoint" value={endpoint.value} onChange={pick} options={available.map((item) => ({ value: item.value, label: item.label, hint: item.hint }))}/>
            <label className="relative">
              <span className="sr-only">Request path</span>
              <span className={`code absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-bold ${endpoint.method === "POST" ? "text-amber-300" : "text-emerald-300"}`}>{endpoint.method}</span>
              <input value={path} onChange={(event) => setPath(event.target.value)} className="code w-full rounded-xl border border-white/10 bg-[#0d1424] py-2.5 pl-14 pr-3 text-xs"/>
            </label>
            <button disabled={pending || !path.startsWith("/")} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-2.5 text-sm font-semibold hover:bg-blue-400 disabled:opacity-50"><Play size={14}/>{pending ? "Sending…" : "Send request"}</button>
          </div>
          {endpoint.method === "POST" && <label className="block text-xs text-slate-400">JSON body
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} spellCheck={false} className="code mt-1 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-slate-200"/>
            {bodyError && <span className="text-red-300">{bodyError}</span>}
          </label>}
        </form>
        {result ? <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={statusTone(result.status)}>{result.status}</Badge>
            <span className="code text-slate-400">{result.ms} ms</span>
            <span className="code text-slate-500">{bytes(size)}</span>
            {result.requestId && <span className="code truncate text-slate-500">x-request-id: {result.requestId}</span>}
          </div>
          <JsonView value={result.body} className="max-h-[420px]"/>
        </div> : <p className="mt-5 rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">Pick an endpoint and send a request to inspect the live response.</p>}
      </Card>
      <Card title="Reproduce with curl" icon={<Terminal size={16} className="text-slate-400"/>} actions={<CopyButton text={curl(endpoint.method, path, endpoint.method === "POST" ? JSON.stringify(JSON.parse(safeJson(body || "{}"))) : undefined)}/>}>
        <pre className="code m-0 overflow-auto rounded-xl border border-white/8 bg-black/40 p-4 text-[11px] leading-relaxed text-slate-300">{curl(endpoint.method, path, endpoint.method === "POST" ? JSON.stringify(JSON.parse(safeJson(body || "{}"))) : undefined)}</pre>
      </Card>
    </div>
    <div className="min-w-0 space-y-5">
      <RuntimeMetrics/>
      <Card title="Request history" icon={<History size={16} className="text-slate-400"/>}>
        {history.length ? <ol className="space-y-2">{history.map((item, index) => <li key={`${item.at}-${index}`}>
          <button onClick={() => setResult(item)} className="code flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-white/5">
            <Badge tone={statusTone(item.status)}>{item.status}</Badge><span className="text-slate-400">{item.method}</span><span className="truncate text-slate-300">{item.path}</span><span className="ml-auto shrink-0 text-slate-500">{item.ms} ms</span>
          </button>
        </li>)}</ol> : <p className="m-0 text-sm text-slate-500">No requests yet.</p>}
      </Card>
    </div>
  </div>;
}

function safeJson(text: string) {
  try { JSON.parse(text); return text; } catch { return "{}"; }
}

function RuntimeMetrics() {
  const metrics = usePoll(() => request<OpsMetrics>("/ops/metrics"), [], 5000);
  const data = metrics.data;
  const histogram = useMemo(() => {
    const buckets = data?.http.latencyBuckets ?? [];
    return buckets.filter((bucket) => bucket.le !== "+Inf").map((bucket, index) => ({
      le: `${Math.round(Number(bucket.le) * 1000)} ms`,
      count: Math.max(0, bucket.cumulative - (index ? buckets[index - 1].cumulative : 0)),
    }));
  }, [data]);
  if (!data) return <div className="glass h-96 animate-pulse rounded-2xl" aria-label="Loading runtime metrics"/>;
  const allow = data.quotaDecisions.allow ?? 0;
  const deny = data.quotaDecisions.deny ?? 0;
  const allowPercent = allow + deny ? (allow / (allow + deny)) * 100 : 100;
  return <Card title="Runtime metrics" icon={<Radio size={16} className="text-emerald-300"/>} subtitle="prom-client registry for this API instance (also scraped at /metrics)">
    <div className="grid grid-cols-2 gap-4">
      <Stat label="Uptime" value={duration(data.uptimeSeconds * 1000)}/>
      <Stat label="HTTP requests" value={number(data.http.requests)} hint={`avg ${data.http.averageMs} ms`}/>
      <Stat label="Resident memory" value={bytes(data.process.residentMemoryBytes)} hint={`heap ${bytes(data.process.heapUsedBytes)}`}/>
      <Stat label="Event-loop lag" value={duration(data.process.eventLoopLagSeconds * 1000)}/>
    </div>
    <div className="mt-5">
      <div className="mb-1 flex justify-between text-xs"><span className="text-slate-400">Quota decisions</span><span className="code text-slate-500">{allow} allow · {deny} deny</span></div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/5"><div className="bg-emerald-400" style={{ width: `${allowPercent}%` }}/><div className="bg-amber-400" style={{ width: `${100 - allowPercent}%` }}/></div>
    </div>
    <div className="mt-4 flex flex-wrap gap-2">
      {Object.entries(data.usageResults).map(([key, value]) => <Badge key={key} tone={key === "accepted" ? "green" : key === "duplicate" ? "violet" : "red"}>{key} {value}</Badge>)}
      {Object.entries(data.http.status).map(([key, value]) => <Badge key={key} tone={key === "2xx" ? "blue" : key === "3xx" ? "slate" : key === "4xx" ? "amber" : "red"}>{key} {value}</Badge>)}
    </div>
    <div className="mt-5"><div className="mb-2 flex items-center gap-2 text-xs text-slate-400"><Cpu size={13}/>HTTP latency histogram</div>
      <div className="h-40" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={histogram} margin={{ left: -24, right: 0, top: 4 }}>
            <CartesianGrid stroke="#ffffff0a" vertical={false}/>
            <XAxis dataKey="le" stroke="#475569" fontSize={9} tickLine={false} interval={0} angle={-30} textAnchor="end" height={36}/>
            <YAxis stroke="#475569" fontSize={10} allowDecimals={false} tickLine={false} axisLine={false}/>
            <Tooltip cursor={{ fill: "rgba(255,255,255,.04)" }} contentStyle={{ background: "#0d1424", border: "1px solid rgba(148,163,184,.2)", borderRadius: 12, fontSize: 12 }} formatter={(value) => [number(Number(value)), "Requests ≤ bucket"]}/>
            <Bar dataKey="count" fill="#34d399" radius={[3, 3, 0, 0]} isAnimationActive={false}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  </Card>;
}
