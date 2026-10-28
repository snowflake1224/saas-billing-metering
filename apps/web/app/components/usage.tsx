"use client";

import { useMemo, useState } from "react";
import { Activity, Layers, Repeat, Send, Sparkles, Terminal } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiResult, QuotaMetric, QuotaStatus, UsageRow, compact, inspect, metricColor, metricLabel, number, relative, request, usePoll } from "../lib/api";
import { Badge, Card, JsonView, Option, Segmented, Select } from "./ui";

const tooltipStyle = { background: "#0d1424", border: "1px solid rgba(148,163,184,.2)", borderRadius: 12, fontSize: 12 };
type Range = "24h" | "72h" | "7d";
const ranges: Array<Option<Range>> = [{ value: "24h", label: "24h" }, { value: "72h", label: "72h" }, { value: "7d", label: "7d" }];

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

export function UsageSection({ quota, onSent, canSimulate }: { quota: QuotaStatus | null; onSent: () => void; canSimulate: boolean }) {
  const [range, setRange] = useState<Range>("24h");
  const metrics = useMemo(() => (quota?.metrics ?? []).map((item) => item.metric).filter((metric) => metric !== "seats"), [quota]);
  const timeline = usePoll(() => request<UsageRow[]>(`/analytics/usage?range=${range}&granularity=hour`), [range], 15000);
  const data = useMemo(() => pivot(timeline.data ?? [], metrics), [timeline.data, metrics]);

  return <>
    <div className="mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {quota ? quota.metrics.map((item) => <QuotaCard key={item.metric} item={item}/>)
        : [1, 2, 3, 4].map((key) => <div key={key} className="glass h-36 animate-pulse rounded-2xl"/>)}
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Card title="Hourly totals" icon={<Activity size={16} className="text-blue-300"/>} subtitle="Sum of stored usage events per hour"
        actions={<Segmented label="Time range" value={range} options={ranges} onChange={setRange}/>}>
        {data.length ? <div className="h-80" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 0, right: 8, top: 6 }}>
              <CartesianGrid stroke="#ffffff0a" vertical={false}/>
              <XAxis dataKey="bucket" tickFormatter={hourLabel} stroke="#475569" fontSize={11} minTickGap={40} tickLine={false}/>
              <YAxis stroke="#475569" fontSize={11} tickFormatter={(value) => compact(Number(value))} tickLine={false} axisLine={false}/>
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => new Date(String(value)).toLocaleString()} formatter={(value, name) => [number(Number(value)), metricLabel(String(name))]}/>
              {metrics.map((metric) => <Area key={metric} type="monotone" dataKey={metric} stroke={metricColor(metric)} fill={metricColor(metric)} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false}/>)}
            </AreaChart>
          </ResponsiveContainer>
        </div> : <div className="grid h-80 place-items-center text-sm text-slate-500">{timeline.data ? "No usage in this range yet." : "Loading usage…"}</div>}
        <p className="sr-only">The chart shows {data.length} hourly totals for {metrics.map(metricLabel).join(", ")}.</p>
      </Card>
      <Simulator onSent={() => { onSent(); void timeline.refresh(); }} disabled={!canSimulate} metrics={metrics}/>
    </div>
  </>;
}

function QuotaCard({ item }: { item: QuotaMetric }) {
  const tone = item.percent >= 90 ? "bg-red-400" : item.percent >= 80 ? "bg-amber-400" : "bg-blue-500";
  const Icon = item.metric === "ai_tokens" ? Sparkles : item.metric === "seats" ? Layers : Activity;
  return <article className="metric glass flex flex-col rounded-2xl p-5">
    <div className="mb-3 flex items-center gap-2 text-sm text-slate-400"><Icon size={16} style={{ color: metricColor(item.metric) }}/>{metricLabel(item.metric)}</div>
    <div className="text-2xl font-semibold tabular-nums">{number(item.used)} <span className="text-sm font-normal text-slate-500">/ {compact(item.limit)}</span></div>
    <div className="mt-3 h-1.5 rounded-full bg-white/6"><div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(1, item.percent)}%` }}/></div>
    <div className="mt-1 flex justify-between text-[11px] text-slate-500"><span>{item.percent}% used this month</span><span>{compact(item.remaining)} left</span></div>
  </article>;
}

type LogEntry = ApiResult<{ accepted?: boolean; duplicate?: boolean; eventId?: string; message?: string; warnings?: string[] }> & { key: string; metric: string; quantity: number };

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
  return <Card title="Send a usage event" icon={<Terminal size={16} className="text-blue-300"/>} subtitle="POST /usage/events. Replaying an idempotency key returns duplicate and leaves the total unchanged.">
    <div className="grid gap-3 sm:grid-cols-2">
      <div><div className="mb-1 text-xs text-slate-400">Metric</div><Select label="Simulator metric" value={metric} options={options} onChange={setMetric}/></div>
      <label className="block text-xs text-slate-400">Quantity <span className="tabular-nums text-slate-300">{number(quantity)}</span>
        <input aria-label="Quantity" type="range" min={1} max={500} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} className="mt-3 w-full"/>
      </label>
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs text-slate-400">Repeat <Segmented label="Burst size" value={burst} options={[{ value: "1", label: "×1" }, { value: "5", label: "×5" }, { value: "10", label: "×10" }]} onChange={setBurst}/></div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={reuse} onChange={(event) => setReuse(event.target.checked)} className="accent-violet-500"/>
        <Repeat size={13} className="text-violet-300"/>Reuse idempotency key
      </label>
    </div>
    <button disabled={pending || disabled} onClick={() => void send()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400 disabled:opacity-50">
      <Send size={16}/>{pending ? "Sending…" : Number(burst) > 1 ? `Send ${burst} usage events` : "Send usage event"}
    </button>
    {reuse && <p className="mt-2 text-[11px] text-violet-300/80">Replays <code className="code">{lastKey ? `${lastKey.slice(0, 18)}…` : "a new key"}</code>. Only the first send counts toward the total.</p>}
    {latest && <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={outcome(latest).tone}>{outcome(latest).label}</Badge>
        <span className="code text-slate-400">{latest.status} · {latest.ms} ms</span>
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
