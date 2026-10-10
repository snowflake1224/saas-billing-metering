"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Circle, Clock, ListTree, Loader2, Search } from "lucide-react";
import { EventTrace, UsageEvent, curl, duration, metricColor, metricLabel, number, relative, request, usePoll } from "../lib/api";
import { Badge, Card, CopyButton, Drawer, JsonView, LivePulse, Segmented, Select, Stat } from "./ui";

type Status = "all" | UsageEvent["status"];
const statusTone = { processed: "green", queued: "blue", pending: "amber" } as const;

function StageDots({ event }: { event: UsageEvent }) {
  const stages = [["ingested", true], ["published", Boolean(event.publishedAt)], ["processed", Boolean(event.processedAt)]] as const;
  return <span className="flex items-center gap-1" aria-label={`Stages: ${stages.filter(([, done]) => done).map(([name]) => name).join(", ")}`}>
    {stages.map(([name, done], index) => <span key={name} className="flex items-center gap-1">
      {index > 0 && <span className={`h-px w-3 ${done ? "bg-emerald-400/60" : "bg-white/10"}`}/>}
      <span title={name} className={`h-2 w-2 rounded-full ${done ? "bg-emerald-400" : "bg-white/15"}`}/>
    </span>)}
  </span>;
}

export function EventsSection({ metrics }: { metrics: string[] }) {
  const [metric, setMetric] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "100" });
  if (metric !== "all") params.set("metric", metric);
  if (source !== "all") params.set("source", source);
  const events = usePoll(() => request<UsageEvent[]>(`/usage/events?${params}`), [metric, source], 5000);

  const rows = useMemo(() => (events.data ?? []).filter((event) => (status === "all" || event.status === status)
    && (!query || event.idempotencyKey.includes(query) || event.id.includes(query) || JSON.stringify(event.dimensions).includes(query))), [events.data, status, query]);
  const latencies = rows.map((event) => event.latencyMs).filter((value): value is number => value != null).sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const processed = rows.filter((event) => event.status === "processed").length;

  return <>
    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card><Stat label="Events in view" value={number(rows.length)} hint={`of ${events.data?.length ?? 0} most recent`}/></Card>
      <Card><Stat label="Processed" value={rows.length ? `${Math.round((processed / rows.length) * 100)}%` : "—"} hint={`${processed} aggregated by the worker`} tone="text-emerald-300"/></Card>
      <Card><Stat label="Median latency" value={duration(median)} hint="ingest → aggregated"/></Card>
      <Card><Stat label="Units in view" value={number(rows.reduce((sum, event) => sum + event.quantity, 0))} hint="sum of quantity"/></Card>
    </div>
    <Card title="Event explorer" icon={<ListTree size={16} className="text-blue-300"/>} subtitle="Immutable usage_events joined with outbox and processed_events. Click a row to trace it."
      actions={<LivePulse label={events.updatedAt ? `Updated ${relative(events.updatedAt)}` : "Connecting"} stale={!events.updatedAt}/>}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select label="Filter metric" value={metric} onChange={setMetric} size="sm" className="w-40"
          options={[{ value: "all", label: "All metrics" }, ...metrics.map((item) => ({ value: item, label: metricLabel(item) }))]}/>
        <Select label="Filter source" value={source} onChange={setSource} size="sm" className="w-44"
          options={[{ value: "all", label: "All sources" }, { value: "portfolio_demo", label: "Simulator", hint: "portfolio_demo" }, { value: "seed", label: "Seed history", hint: "seed" }]}/>
        <Segmented label="Filter status" value={status} onChange={setStatus}
          options={[{ value: "all", label: "All" }, { value: "pending", label: "Pending" }, { value: "queued", label: "Queued" }, { value: "processed", label: "Processed" }]}/>
        <label className="relative ml-auto min-w-[12rem] flex-1 sm:flex-none">
          <span className="sr-only">Search events</span>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search key, id, dimension…" className="w-full rounded-xl border border-white/10 bg-[#0d1424] py-2 pl-9 pr-3 text-xs"/>
        </label>
      </div>
      <div className="max-h-[620px] overflow-auto rounded-xl border border-white/5">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[#0d1424] text-[10px] uppercase tracking-wider text-slate-500"><tr>
            <th className="py-2 pl-3 font-medium">Ingested</th><th className="font-medium">Metric</th><th className="text-right font-medium">Qty</th>
            <th className="pl-6 font-medium">Idempotency key</th><th className="font-medium">Stages</th><th className="font-medium">Status</th><th className="pr-3 text-right font-medium">Latency</th>
          </tr></thead>
          <tbody>
            {rows.map((event) => <tr key={event.id} onClick={() => setSelected(event.id)} onKeyDown={(key) => { if (key.key === "Enter") setSelected(event.id); }} tabIndex={0}
              className="cursor-pointer border-t border-white/5 hover:bg-white/[.03] focus-visible:bg-blue-500/10">
              <td className="py-2.5 pl-3 text-slate-400" title={new Date(event.ingestedAt).toLocaleString()}>{relative(event.ingestedAt)}</td>
              <td><span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: metricColor(event.metric) }}/>{metricLabel(event.metric)}</span></td>
              <td className="text-right tabular-nums">{number(event.quantity)}</td>
              <td className="code max-w-[14rem] truncate pl-6 text-slate-400">{event.idempotencyKey}</td>
              <td><StageDots event={event}/></td>
              <td><Badge tone={statusTone[event.status]}>{event.status}</Badge></td>
              <td className="code pr-3 text-right text-slate-400">{duration(event.latencyMs)}</td>
            </tr>)}
          </tbody>
        </table>
        {!rows.length && <p className="py-10 text-center text-sm text-slate-500">{events.data ? "No events match these filters." : "Loading events…"}</p>}
      </div>
    </Card>
    <TraceDrawer id={selected} onClose={() => setSelected(null)}/>
  </>;
}

function TraceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const trace = usePoll(() => (id ? request<EventTrace>(`/usage/events/${id}/trace`) : Promise.resolve(null)), [id], id ? 3000 : 0);
  const data = trace.data?.event.id === id ? trace.data : null;
  return <Drawer open={Boolean(id)} title="Event trace" onClose={onClose}>
    {!data ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={16} className="animate-spin"/>{trace.error || "Loading trace…"}</div> : <>
      <div className="mb-5 grid grid-cols-2 gap-4 rounded-xl border border-white/8 bg-white/[.02] p-4">
        <Stat label="Metric" value={metricLabel(data.event.metric)}/>
        <Stat label="Quantity" value={number(data.event.quantity)}/>
        <div className="col-span-2"><div className="text-[11px] uppercase tracking-wider text-slate-500">Event id</div><code className="code text-xs text-slate-300">{data.event.id}</code></div>
        <div className="col-span-2"><div className="text-[11px] uppercase tracking-wider text-slate-500">Idempotency key</div><code className="code break-all text-xs text-slate-300">{data.event.idempotencyKey}</code></div>
      </div>
      <h3 className="mb-3 text-sm">Pipeline timeline</h3>
      <ol className="relative mb-6 ml-2 border-l border-white/10">
        {data.stages.map((stage) => {
          const done = Boolean(stage.at);
          return <li key={stage.stage} className="mb-5 ml-5">
            <span className={`absolute -left-[9px] grid h-[18px] w-[18px] place-items-center rounded-full ${done ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5 text-slate-500"}`}>
              {done ? <CheckCircle2 size={14}/> : stage.stage === "processed" || stage.stage === "aggregated" ? <Clock size={12}/> : <Circle size={10}/>}
            </span>
            <div className="flex items-center justify-between gap-3"><b className="text-sm capitalize">{stage.stage}</b><span className="code text-xs text-slate-400">{stage.offsetMs != null ? `+${duration(stage.offsetMs)}` : "waiting"}</span></div>
            <div className="text-xs text-slate-500">{stage.label}</div>
            {stage.at && <div className="code mt-0.5 text-[11px] text-slate-600">{new Date(stage.at).toISOString()}</div>}
          </li>;
        })}
      </ol>
      {data.bucket && data.event.processedAt && <div className="mb-6 rounded-xl border border-blue-400/15 bg-blue-500/5 p-4 text-xs">
        Hour bucket <code className="code text-blue-300">{new Date(data.bucket.start).toISOString().slice(0, 13)}:00Z</code> now totals <b>{number(data.bucket.quantity)}</b> {metricLabel(data.event.metric).toLowerCase()}.
      </div>}
      {data.event.status !== "processed" && <p className="mb-6 rounded-xl border border-amber-400/15 bg-amber-500/5 p-3 text-xs text-amber-200">Not processed yet. The worker relays the outbox every second, and this panel refreshes every 3 seconds.</p>}
      <div className="mb-2 flex items-center justify-between"><h3 className="m-0 text-sm">Raw event</h3></div>
      <JsonView value={data.event} className="mb-5 max-h-72"/>
      <div className="mb-2 flex items-center justify-between"><h3 className="m-0 text-sm">Reproduce</h3><CopyButton text={curl("GET", `/usage/events/${data.event.id}/trace`)} label="Copy curl"/></div>
      <pre className="code overflow-auto rounded-xl border border-white/8 bg-black/40 p-3 text-[11px] text-slate-300">{curl("GET", `/usage/events/${data.event.id}/trace`)}</pre>
    </>}
  </Drawer>;
}
