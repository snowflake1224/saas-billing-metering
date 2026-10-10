"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CalendarClock, Download, Flame, Gauge, Grid3x3, Layers, Repeat, Send, Sparkles, Terminal, TrendingDown, TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiResult, Health, Pipeline, QuotaMetric, QuotaStatus, UsageEvent, UsageRow, compact, inspect, metricColor, metricLabel, number, relative, request, usePoll } from "../lib/api";
import { Badge, Card, JsonView, Option, Segmented, Select, Sparkline, Stat } from "./ui";
import { HealthStrip } from "./pipeline";

const tooltipStyle = { background: "#0d1424", border: "1px solid rgba(148,163,184,.2)", borderRadius: 12, fontSize: 12 };
type Range = "24h" | "72h" | "7d" | "30d";
const ranges: Array<Option<Range>> = [{ value: "24h", label: "24h" }, { value: "72h", label: "72h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }];

function pivot(rows: UsageRow[], metrics: string[]) {
  const buckets = new Map<string, Record<string, number | string>>();
  for (const row of rows) {
    if (!metrics.includes(row.metric)) continue;
    const key = new Date(row.bucket).toISOString();
    const entry = buckets.get(key) ?? { bucket: key };
    entry[row.metric] = Number(row.quantity);
    buckets.set(key, entry);
  }
  return [...buckets.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
    .map((entry) => Object.fromEntries([["bucket", entry.bucket], ...metrics.map((metric) => [metric, Number(entry[metric] ?? 0)])]) as Record<string, number | string>);
}

const hourLabel = (value: string) => new Date(value).toLocaleString([], { weekday: "short", hour: "2-digit" });
const dayLabel = (value: string) => new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });

export function OverviewSection({ quota, pipeline, health, onSent, canSimulate, orgName, orgId, role }: {
  quota: QuotaStatus | null; pipeline: Pipeline | null; health: Health | null; onSent: () => void; canSimulate: boolean; orgName: string; orgId?: string; role: string;
}) {
  const hourly = usePoll(() => request<UsageRow[]>("/analytics/usage?range=24h"), [], 30000);
  const series = (metric: string) => (hourly.data ?? []).filter((row) => row.metric === metric).map((row) => Number(row.quantity));
  return <>
    <HealthStrip pipeline={pipeline} health={health}/>
    <div className="mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {quota ? quota.metrics.map((item) => <QuotaCard key={item.metric} item={item} spark={series(item.metric)} softAlert={quota.softAlertPercent}/>)
        : [1, 2, 3, 4].map((key) => <div key={key} className="glass h-52 animate-pulse rounded-2xl"/>)}
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
      <ThroughputCard pipeline={pipeline}/>
      <Simulator onSent={onSent} disabled={!canSimulate} metrics={(quota?.metrics ?? []).map((item) => item.metric)}/>
    </div>
    <TenantCard orgName={orgName} orgId={orgId} role={role}/>
  </>;
}

function QuotaCard({ item, spark, softAlert }: { item: QuotaMetric; spark: number[]; softAlert: number }) {
  const tone = item.percent >= 90 ? "bg-red-400" : item.percent >= softAlert ? "bg-amber-400" : "bg-blue-500";
  const Icon = item.metric === "ai_tokens" ? Sparkles : item.metric === "seats" ? Layers : Activity;
  const change = item.changePercent;
  return <article className="metric glass flex flex-col rounded-2xl p-5">
    <div className="mb-3 flex items-center justify-between text-slate-400">
      <span className="flex items-center gap-2 text-sm"><Icon size={16} style={{ color: metricColor(item.metric) }}/>{metricLabel(item.metric)}</span>
      {change != null && <Badge tone={change >= 0 ? "amber" : "green"}>{change >= 0 ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}{Math.abs(change)}% 24h</Badge>}
    </div>
    <div className="text-2xl font-semibold tabular-nums">{compact(item.used)} <span className="text-sm font-normal text-slate-500">/ {compact(item.limit)}</span></div>
    <div className="relative mt-3 h-1.5 rounded-full bg-white/6">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(1, item.percent)}%` }}/>
      <div className="absolute -top-1 h-3.5 w-px bg-amber-300/60" style={{ left: `${softAlert}%` }} title={`${softAlert}% soft alert`}/>
    </div>
    <div className="mt-1 flex justify-between text-[11px] text-slate-500"><span>{item.percent}% used</span><span>{compact(item.remaining)} left</span></div>
    <Sparkline values={spark} color={metricColor(item.metric)} className="mt-3"/>
    <div className="mt-2 border-t border-white/6 pt-3 text-[11px] text-slate-400">
      {item.metric === "seats" ? <span>Seat-based · enforced on invite</span>
        : item.projectedExhaustionAt ? <span className="flex items-center gap-1 text-amber-300"><AlertTriangle size={12}/>Hits limit {new Date(item.projectedExhaustionAt).toLocaleDateString([], { month: "short", day: "numeric" })} at {compact(item.burnPerHour)}/h</span>
        : <span className="flex items-center gap-1"><Flame size={12} className="text-orange-300"/>{compact(item.burnPerHour)}/h · projected {Math.round((item.projectedPeriodTotal / item.limit) * 100)}% of limit</span>}
    </div>
  </article>;
}

function ThroughputCard({ pipeline }: { pipeline: Pipeline | null }) {
  const data = (pipeline?.throughput ?? []).map((row) => ({ ...row, label: new Date(row.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  const total = data.reduce((sum, row) => sum + row.events, 0);
  const lastFive = data.slice(-5).reduce((sum, row) => sum + row.events, 0);
  return <Card title="Ingestion throughput" icon={<Activity size={16} className="text-cyan-300"/>} subtitle="Events accepted per minute over the last hour, straight from usage_events"
    actions={<><Badge tone="cyan">{total} events / 60 min</Badge><Badge tone={lastFive ? "green" : "slate"}>{lastFive} in last 5 min</Badge></>}>
    <div className="h-56" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: -20, right: 4, top: 6 }}>
          <defs><linearGradient id="tp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={.5}/><stop offset="100%" stopColor="#22d3ee" stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke="#ffffff0a" vertical={false}/>
          <XAxis dataKey="label" stroke="#475569" fontSize={11} interval={9} tickLine={false}/>
          <YAxis stroke="#475569" fontSize={11} allowDecimals={false} tickLine={false} axisLine={false}/>
          <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [number(Number(value)), name === "events" ? "Events" : "Units"]}/>
          <Area type="stepAfter" dataKey="events" stroke="#22d3ee" fill="url(#tp)" strokeWidth={2} isAnimationActive={false}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <p className="sr-only">{total} usage events were ingested during the last hour.</p>
  </Card>;
}

function TenantCard({ orgName, orgId, role }: { orgName: string; orgId?: string; role: string }) {
  return <Card className="mt-5" title="Tenant isolation" icon={<Gauge size={16} className="text-emerald-300"/>} subtitle="Every read above ran inside a transaction scoped to this organization">
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Organization" value={orgName}/>
        <Stat label="Your role" value={<span className="capitalize">{role}</span>}/>
        <div className="col-span-2"><div className="text-[11px] uppercase tracking-wider text-slate-500">app.organization_id</div><code className="code mt-1 block truncate text-xs text-emerald-300">{orgId ?? "—"}</code></div>
        <p className="col-span-2 m-0 text-xs text-slate-400">Switch organizations in the sidebar: the JWT is reissued, and every query, quota key and aggregate shown here changes with it.</p>
      </div>
      <pre className="code m-0 overflow-auto rounded-xl border border-white/8 bg-black/40 p-4 text-[11px] leading-relaxed text-slate-300">{`BEGIN;
SELECT set_config('app.organization_id', '${orgId?.slice(0, 8) ?? "…"}…', true);
-- FORCE ROW LEVEL SECURITY on usage_events, usage_aggregates,
-- outbox, memberships, teams, invoices, audit_log, …
CREATE POLICY tenant_isolation ON usage_events
  USING (organization_id = current_setting('app.organization_id')::uuid);
COMMIT;`}</pre>
    </div>
  </Card>;
}

type Mode = "absolute" | "normalized";

export function UsageSection({ quota, onSent, canSimulate }: { quota: QuotaStatus | null; onSent: () => void; canSimulate: boolean }) {
  const [range, setRange] = useState<Range>("72h");
  const [mode, setMode] = useState<Mode>("absolute");
  const allMetrics = useMemo(() => (quota?.metrics ?? []).map((item) => item.metric).filter((metric) => metric !== "seats"), [quota]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [focus, setFocus] = useState("api_requests");
  const visible = allMetrics.filter((metric) => !hidden.includes(metric));
  const granularity = range === "30d" ? "day" : "hour";
  const timeline = usePoll(() => request<UsageRow[]>(`/analytics/usage?range=${range}&granularity=${granularity}`), [range], 15000);

  const data = useMemo(() => {
    const rows = pivot(timeline.data ?? [], visible);
    if (mode === "absolute") return rows;
    const peaks = Object.fromEntries(visible.map((metric) => [metric, Math.max(1, ...rows.map((row) => Number(row[metric])))]));
    return rows.map((row) => ({ ...row, ...Object.fromEntries(visible.map((metric) => [metric, Math.round((Number(row[metric]) / peaks[metric]) * 1000) / 10])) }));
  }, [timeline.data, visible, mode]);

  function exportCsv() {
    const header = ["bucket", ...visible].join(",");
    const lines = pivot(timeline.data ?? [], visible).map((row) => [row.bucket, ...visible.map((metric) => row[metric])].join(","));
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `usage-${range}-${granularity}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const focusOptions: Array<Option> = allMetrics.map((metric) => ({ value: metric, label: metricLabel(metric) }));
  return <>
    <Card title="Usage timeline" icon={<Activity size={16} className="text-blue-300"/>}
      subtitle={`${granularity === "day" ? "Daily" : "Hourly"} buckets from usage_aggregates · ${mode === "normalized" ? "each series scaled to its own peak" : "raw units"}`}
      actions={<>
        <Segmented label="Time range" value={range} options={ranges} onChange={setRange}/>
        <Segmented label="Scale" value={mode} options={[{ value: "absolute", label: "Absolute" }, { value: "normalized", label: "Normalized" }]} onChange={setMode}/>
        <button onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#0d1424] px-3 py-1.5 text-xs text-slate-300 hover:border-blue-400/40 hover:text-white"><Download size={13}/>CSV</button>
      </>}>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Visible metrics">
        {allMetrics.map((metric) => {
          const on = !hidden.includes(metric);
          return <button key={metric} aria-pressed={on} onClick={() => setHidden((list) => (on ? [...list, metric] : list.filter((item) => item !== metric)))}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${on ? "border-white/15 bg-white/5 text-white" : "border-white/5 text-slate-500 line-through"}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: metricColor(metric) }}/>{metricLabel(metric)}
          </button>;
        })}
      </div>
      {data.length ? <div className="h-80" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 6 }}>
            <defs>{visible.map((metric) => <linearGradient key={metric} id={`g-${metric}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={metricColor(metric)} stopOpacity={.35}/><stop offset="100%" stopColor={metricColor(metric)} stopOpacity={0}/></linearGradient>)}</defs>
            <CartesianGrid stroke="#ffffff0a" vertical={false}/>
            <XAxis dataKey="bucket" tickFormatter={granularity === "day" ? dayLabel : hourLabel} stroke="#475569" fontSize={11} minTickGap={40} tickLine={false}/>
            <YAxis stroke="#475569" fontSize={11} tickFormatter={(value) => (mode === "normalized" ? `${value}%` : compact(Number(value)))} tickLine={false} axisLine={false}/>
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => new Date(String(value)).toLocaleString()} formatter={(value, name) => [mode === "normalized" ? `${value}%` : number(Number(value)), metricLabel(String(name))]}/>
            {visible.map((metric) => <Area key={metric} type="monotone" dataKey={metric} stroke={metricColor(metric)} fill={`url(#g-${metric})`} strokeWidth={2} isAnimationActive={false}/>)}
          </AreaChart>
        </ResponsiveContainer>
      </div> : <div className="grid h-80 place-items-center text-sm text-slate-500">{timeline.data ? "No aggregated usage in this range yet." : "Loading usage…"}</div>}
      <p className="sr-only">The chart shows {data.length} {granularity} buckets for {visible.map(metricLabel).join(", ")}.</p>
    </Card>

    <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <BurnDown quota={quota} focus={focus} setFocus={setFocus} options={focusOptions}/>
      <DimensionBreakdown metric={focus}/>
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Heatmap metric={focus}/>
      <Simulator onSent={() => { onSent(); void timeline.refresh(); }} disabled={!canSimulate} metrics={allMetrics}/>
    </div>
  </>;
}

function BurnDown({ quota, focus, setFocus, options }: { quota: QuotaStatus | null; focus: string; setFocus: (metric: string) => void; options: Array<Option> }) {
  const daily = usePoll(() => request<UsageRow[]>("/analytics/usage?range=30d&granularity=day"), [], 30000);
  const item = quota?.metrics.find((metric) => metric.metric === focus);
  const data = useMemo(() => {
    if (!quota || !item) return [];
    const start = new Date(quota.period.start).getTime();
    const end = new Date(quota.period.end).getTime();
    const rows = (daily.data ?? []).filter((row) => row.metric === focus && new Date(row.bucket).getTime() >= start)
      .sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());
    let running = 0;
    const points: Array<{ day: string; actual?: number; projected?: number }> = rows.map((row) => {
      running += Number(row.quantity);
      return { day: new Date(row.bucket).toISOString(), actual: running };
    });
    if (points.length) points[points.length - 1].projected = running;
    const last = points.length ? new Date(points[points.length - 1].day).getTime() : start;
    for (let day = last + 86400000; day < end; day += 86400000) {
      running += item.burnPerHour * 24;
      points.push({ day: new Date(day).toISOString(), projected: Math.round(running) });
    }
    return points;
  }, [daily.data, quota, item, focus]);
  const projectedPercent = item ? Math.round((item.projectedPeriodTotal / item.limit) * 100) : 0;
  return <Card title="Budget burn-down" icon={<CalendarClock size={16} className="text-amber-300"/>}
    subtitle="Month-to-date cumulative usage, linear projection from the 24h burn rate, plan limit and 80% soft alert"
    actions={<Select label="Focus metric" value={focus} options={options} onChange={setFocus} size="sm" className="w-44"/>}>
    {item && <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Used" value={compact(item.used)} hint={`${item.percent}% of ${compact(item.limit)}`}/>
      <Stat label="Burn rate" value={`${compact(item.burnPerHour)}/h`} hint={`${compact(item.last24h)} in 24h`}/>
      <Stat label="Projected" value={`${projectedPercent}%`} tone={projectedPercent >= 100 ? "text-red-300" : projectedPercent >= 80 ? "text-amber-300" : "text-emerald-300"} hint={compact(item.projectedPeriodTotal)}/>
      <Stat label="Exhaustion" value={item.projectedExhaustionAt ? dayLabel(item.projectedExhaustionAt) : "Not this period"} tone={item.projectedExhaustionAt ? "text-red-300" : "text-white"} hint={item.redis ? `Redis: ${compact(item.redis.used)} committed · ${compact(item.redis.reserved)} reserved` : undefined}/>
    </div>}
    <div className="h-64" aria-hidden="true">
      {data.length && item ? <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ left: 0, right: 8, top: 10 }}>
          <CartesianGrid stroke="#ffffff0a" vertical={false}/>
          <XAxis dataKey="day" tickFormatter={dayLabel} stroke="#475569" fontSize={11} minTickGap={30} tickLine={false}/>
          <YAxis stroke="#475569" fontSize={11} tickFormatter={(value) => compact(Number(value))} domain={[0, (max: number) => Math.max(max, item.limit) * 1.08]} tickLine={false} axisLine={false}/>
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => dayLabel(String(value))} formatter={(value, name) => [number(Number(value)), name === "actual" ? "Actual" : "Projected"]}/>
          <ReferenceLine y={item.limit} stroke="#f87171" strokeDasharray="4 4" label={{ value: "limit", fill: "#f87171", fontSize: 11, position: "insideTopLeft" }}/>
          <ReferenceLine y={item.limit * 0.8} stroke="#fbbf24" strokeOpacity={.5} strokeDasharray="2 6" label={{ value: "80%", fill: "#fbbf24", fontSize: 11, position: "insideTopLeft" }}/>
          <Line type="monotone" dataKey="actual" stroke={metricColor(focus)} strokeWidth={2.5} dot={false} isAnimationActive={false}/>
          <Line type="monotone" dataKey="projected" stroke={metricColor(focus)} strokeWidth={2} strokeDasharray="6 5" dot={false} isAnimationActive={false}/>
        </ComposedChart>
      </ResponsiveContainer> : <div className="grid h-full place-items-center text-sm text-slate-500">No usage this period yet.</div>}
    </div>
  </Card>;
}

function Heatmap({ metric }: { metric: string }) {
  const week = usePoll(() => request<UsageRow[]>("/analytics/usage?range=7d&granularity=hour"), [], 60000);
  const { days, max } = useMemo(() => {
    const cells = new Map<string, number>();
    for (const row of week.data ?? []) {
      if (row.metric !== metric) continue;
      const date = new Date(row.bucket);
      cells.set(`${date.toDateString()}|${date.getHours()}`, Number(row.quantity));
    }
    const today = new Date();
    const list = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
      return { label: day.toLocaleDateString([], { weekday: "short" }), date: day.toLocaleDateString(), hours: Array.from({ length: 24 }, (_, hour) => cells.get(`${day.toDateString()}|${hour}`) ?? 0) };
    });
    return { days: list, max: Math.max(1, ...list.flatMap((day) => day.hours)) };
  }, [week.data, metric]);
  const color = metricColor(metric);
  return <Card title="Hour-of-day heatmap" icon={<Grid3x3 size={16} className="text-violet-300"/>} subtitle={`${metricLabel(metric)} per hour, last 7 days (local time)`}>
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="mb-1 grid grid-cols-[3rem_repeat(24,1fr)] gap-[3px] text-[10px] text-slate-600">
          <span/>{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="text-center">{hour % 3 === 0 ? hour : ""}</span>)}
        </div>
        {days.map((day) => <div key={day.date} className="mb-[3px] grid grid-cols-[3rem_repeat(24,1fr)] gap-[3px]">
          <span className="text-[11px] leading-5 text-slate-500">{day.label}</span>
          {day.hours.map((value, hour) => <span key={hour} title={`${day.date} ${String(hour).padStart(2, "0")}:00 · ${number(value)}`} className="h-5 rounded-[4px] border border-white/[.03]"
            style={{ background: value ? color : "rgba(255,255,255,.03)", opacity: value ? 0.15 + 0.85 * (value / max) : 1 }}/>)}
        </div>)}
        <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-slate-500">less{[0.15, 0.4, 0.65, 1].map((opacity) => <span key={opacity} className="h-3 w-3 rounded-[3px]" style={{ background: color, opacity }}/>)}more</div>
      </div>
    </div>
  </Card>;
}

function DimensionBreakdown({ metric }: { metric: string }) {
  const events = usePoll(() => request<UsageEvent[]>(`/usage/events?limit=200&metric=${metric}`), [metric], 30000);
  const { key, rows, total } = useMemo(() => {
    const list = events.data ?? [];
    const keys = new Map<string, number>();
    for (const event of list) for (const name of Object.keys(event.dimensions)) if (name !== "source") keys.set(name, (keys.get(name) ?? 0) + 1);
    const dimension = [...keys.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "source";
    const sums = new Map<string, number>();
    for (const event of list) {
      const value = String(event.dimensions[dimension] ?? "(none)");
      sums.set(value, (sums.get(value) ?? 0) + event.quantity);
    }
    const sum = [...sums.values()].reduce((a, b) => a + b, 0);
    return { key: dimension, rows: [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6), total: sum };
  }, [events.data]);
  return <Card title="Top dimensions" icon={<Layers size={16} className="text-cyan-300"/>} subtitle={<>Last {events.data?.length ?? 0} raw events grouped by <code className="code text-cyan-300">dimensions.{key}</code></>}>
    {rows.length ? <div className="space-y-3">{rows.map(([value, quantity]) => <div key={value}>
      <div className="mb-1 flex justify-between text-xs"><span className="code truncate text-slate-300">{value}</span><span className="tabular-nums text-slate-400">{compact(quantity)} · {Math.round((quantity / (total || 1)) * 100)}%</span></div>
      <div className="h-1.5 rounded-full bg-white/5"><div className="h-full rounded-full" style={{ width: `${(quantity / (rows[0][1] || 1)) * 100}%`, background: metricColor(metric) }}/></div>
    </div>)}</div> : <p className="text-sm text-slate-500">No raw events for this metric yet.</p>}
  </Card>;
}

type LogEntry = ApiResult<{ accepted?: boolean; duplicate?: boolean; eventId?: string; message?: string; quota?: { used: number; reserved: number; limit: number; softAlert: boolean }; warnings?: string[] }> & { key: string; metric: string; quantity: number };

function outcome(entry: LogEntry): { label: string; tone: "green" | "violet" | "amber" | "red" } {
  if (entry.ok && entry.body?.duplicate) return { label: "duplicate", tone: "violet" };
  if (entry.ok) return { label: "accepted", tone: "green" };
  if (entry.status === 429) return { label: "denied", tone: "amber" };
  return { label: `error ${entry.status}`, tone: "red" };
}

export function Simulator({ onSent, disabled, metrics }: { onSent: () => void; disabled: boolean; metrics: string[] }) {
  const options = metrics.filter((metric) => metric !== "seats").map((metric) => ({ value: metric, label: metricLabel(metric) }));
  const [metric, setMetric] = useState("api_requests");
  const [quantity, setQuantity] = useState(250);
  const [burst, setBurst] = useState<"1" | "5" | "10">("1");
  const [reuse, setReuse] = useState(false);
  const [lastKey, setLastKey] = useState("");
  const [pending, setPending] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const latest = log[0];

  async function send() {
    setPending(true);
    const sharedKey = reuse ? lastKey || `demo-${crypto.randomUUID()}` : "";
    const results: LogEntry[] = [];
    try {
      for (let index = 0; index < Number(burst); index++) {
        const key = sharedKey || `demo-${crypto.randomUUID()}`;
        const body = { idempotencyKey: key, metric, quantity, occurredAt: new Date().toISOString(), dimensions: { source: "portfolio_demo", client: "dashboard-simulator" } };
        const result = await inspect<LogEntry["body"]>("/usage/events", { method: "POST", body: JSON.stringify(body) });
        results.push({ ...result, key, metric, quantity });
        setLastKey(key);
      }
    } finally {
      setLog((current) => [...results.reverse(), ...current].slice(0, 10));
      setPending(false);
      onSent();
    }
  }

  const accepted = log.filter((entry) => outcome(entry).label === "accepted").length;
  const duplicates = log.filter((entry) => outcome(entry).label === "duplicate").length;
  return <Card title="Usage simulator" icon={<Terminal size={16} className="text-blue-300"/>} subtitle="Real POST /usage/events: Zod validation → Redis Lua reservation → Postgres event + outbox → BullMQ worker">
    <div className="grid gap-3 sm:grid-cols-2">
      <div><div className="mb-1 text-xs text-slate-400">Metric</div><Select label="Simulator metric" value={metric} options={options} onChange={setMetric}/></div>
      <label className="block text-xs text-slate-400">Quantity <span className="tabular-nums text-slate-300">{number(quantity)}</span>
        <input aria-label="Quantity" type="range" min={1} max={500} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} className="mt-3 w-full"/>
      </label>
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs text-slate-400">Burst <Segmented label="Burst size" value={burst} options={[{ value: "1", label: "×1" }, { value: "5", label: "×5" }, { value: "10", label: "×10" }]} onChange={setBurst}/></div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={reuse} onChange={(event) => setReuse(event.target.checked)} className="accent-violet-500"/>
        <Repeat size={13} className="text-violet-300"/>Reuse idempotency key
      </label>
    </div>
    <button disabled={pending || disabled} onClick={() => void send()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400 disabled:opacity-50">
      <Send size={16}/>{pending ? "Sending…" : Number(burst) > 1 ? `Send ${burst} usage events` : "Send usage event"}
    </button>
    {reuse && <p className="mt-2 text-[11px] text-violet-300/80">Replays <code className="code">{lastKey ? `${lastKey.slice(0, 18)}…` : "a new key"}</code>. The API answers duplicate and releases the reservation.</p>}
    {latest && <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={outcome(latest).tone}>{outcome(latest).label}</Badge>
        <span className="code text-slate-400">{latest.status} · {latest.ms} ms</span>
        {latest.requestId && <span className="code truncate text-slate-500" title="x-request-id">req {latest.requestId.slice(0, 8)}</span>}
        <span className="ml-auto text-slate-500">{accepted} accepted · {duplicates} duplicate</span>
      </div>
      <JsonView value={latest.body} className="max-h-48"/>
      <ol className="mt-3 space-y-1" aria-label="Recent simulator calls">
        {log.map((entry, index) => {
          const result = outcome(entry);
          return <li key={`${entry.at}-${index}`} className="code flex items-center gap-2 text-[11px] text-slate-400">
            <Badge tone={result.tone}>{result.label}</Badge>
            <span className="truncate">{entry.metric} +{entry.quantity}</span>
            <span className="ml-auto shrink-0 text-slate-600">{entry.key.slice(5, 13)} · {entry.ms} ms · {relative(entry.at)}</span>
          </li>;
        })}
      </ol>
    </div>}
  </Card>;
}
