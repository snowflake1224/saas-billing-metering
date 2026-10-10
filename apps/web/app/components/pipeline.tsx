"use client";

import { ReactNode } from "react";
import { Archive, BarChart3, CheckCircle2, Database, Inbox, Repeat, ServerCog, ShieldCheck, Skull, Terminal, Timer, Workflow, Zap } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Health, Pipeline, compact, duration, number, relative } from "../lib/api";
import { Badge, Card, LivePulse, Stat } from "./ui";

const tooltipStyle = { background: "#0d1424", border: "1px solid rgba(148,163,184,.2)", borderRadius: 12, fontSize: 12 };

export function HealthStrip({ pipeline, health }: { pipeline: Pipeline | null; health: Health | null }) {
  const lagWarn = (pipeline?.outbox.oldestMs ?? 0) > 10000;
  const items: Array<{ label: string; value: ReactNode; ok: boolean | null }> = [
    { label: "Postgres", value: health ? (health.dependencies.postgres ? "healthy" : "down") : "…", ok: health ? health.dependencies.postgres : null },
    { label: "Redis", value: health ? (health.dependencies.redis ? "healthy" : "down") : "…", ok: health ? health.dependencies.redis : null },
    { label: "Queue depth", value: pipeline ? number(pipeline.queue.waiting + pipeline.queue.active + pipeline.queue.delayed) : "…", ok: pipeline ? pipeline.queue.available : null },
    { label: "Outbox lag", value: pipeline ? (pipeline.outbox.pending ? duration(pipeline.outbox.oldestMs) : "0 ms") : "…", ok: pipeline ? !lagWarn : null },
    { label: "p95 processing", value: pipeline ? duration(pipeline.processing.p95Ms) : "…", ok: pipeline ? (pipeline.processing.p95Ms ?? 0) < 5000 : null },
    { label: "Dead letters", value: pipeline ? number(pipeline.deadLetter.depth) : "…", ok: pipeline ? pipeline.deadLetter.depth === 0 : null },
  ];
  return <div className="glass mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl sm:grid-cols-3 xl:grid-cols-6" aria-label="System health">
    {items.map((item) => <div key={item.label} className="flex items-center gap-3 bg-[#0b111d]/60 px-4 py-3">
      <span className={`h-2 w-2 shrink-0 rounded-full ${item.ok == null ? "bg-slate-600" : item.ok ? "bg-emerald-400 shadow-[0_0_10px] shadow-emerald-400/60" : "bg-amber-400 shadow-[0_0_10px] shadow-amber-400/60"}`}/>
      <div className="min-w-0"><div className="text-[10px] uppercase tracking-wider text-slate-500">{item.label}</div><div className="truncate text-sm font-semibold tabular-nums">{item.value}</div></div>
    </div>)}
  </div>;
}

function Node({ icon, title, tech, active, children }: { icon: ReactNode; title: string; tech: string; active: boolean; children: ReactNode }) {
  return <div className={`glass relative min-w-0 rounded-xl p-4 transition ${active ? "border-cyan-400/40 shadow-[0_0_30px] shadow-cyan-500/10" : ""}`}>
    <div className="mb-3 flex items-center justify-between gap-2"><span className="text-cyan-300">{icon}</span><span className="code truncate text-[10px] text-slate-500">{tech}</span></div>
    <div className="text-sm font-semibold">{title}</div>
    <div className="mt-3 space-y-1.5 text-xs">{children}</div>
  </div>;
}

function Row({ label, value, tone = "text-slate-200" }: { label: string; value: ReactNode; tone?: string }) {
  return <div className="flex justify-between gap-2"><span className="text-slate-500">{label}</span><span className={`tabular-nums ${tone}`}>{value}</span></div>;
}

function Connector({ active }: { active: boolean }) {
  return <div className="hidden items-center xl:flex" aria-hidden="true"><div className={`h-0.5 w-full rounded-full bg-white/10 ${active ? "flow-line" : ""}`}/></div>;
}

export function PipelineSection({ pipeline, health }: { pipeline: Pipeline | null; health: Health | null }) {
  if (!pipeline) return <div className="glass h-96 animate-pulse rounded-2xl" aria-label="Loading pipeline"/>;
  const recent = pipeline.throughput.slice(-5).reduce((sum, row) => sum + row.events, 0);
  const lastHour = pipeline.throughput.reduce((sum, row) => sum + row.events, 0);
  const inFlight = pipeline.outbox.pending + pipeline.queue.waiting + pipeline.queue.active;
  const flowing = recent > 0 || inFlight > 0;
  const processedRatio = pipeline.processing.ingested24h ? Math.round((pipeline.processing.processed24h / pipeline.processing.ingested24h) * 1000) / 10 : 100;
  const data = pipeline.throughput.map((row) => ({ ...row, label: new Date(row.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  const percentiles = [
    { label: "p50", value: pipeline.processing.p50Ms },
    { label: "p95", value: pipeline.processing.p95Ms },
    { label: "p99", value: pipeline.processing.p99Ms },
  ];
  const maxPercentile = Math.max(1, ...percentiles.map((item) => item.value ?? 0));
  return <>
    <HealthStrip pipeline={pipeline} health={health}/>
    <Card title="Event flow" icon={<Workflow size={16} className="text-cyan-300"/>} subtitle={`Live counters for this tenant · refreshed ${relative(pipeline.generatedAt)}`}
      actions={<><LivePulse label={flowing ? "Events flowing" : "Idle"} stale={!flowing}/><Badge tone={inFlight ? "amber" : "green"}>{inFlight} in flight</Badge></>}>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-[1fr_1.5rem_1fr_1.5rem_1fr_1.5rem_1fr_1.5rem_1fr]">
        <Node icon={<Terminal size={18}/>} title="1. Ingest" tech="POST /usage/events" active={recent > 0}>
          <Row label="last 5 min" value={recent}/>
          <Row label="last 60 min" value={lastHour}/>
          <Row label="24h accepted" value={compact(pipeline.processing.ingested24h)}/>
        </Node>
        <Connector active={flowing}/>
        <Node icon={<ShieldCheck size={18}/>} title="2. Reserve" tech="Redis Lua EVAL" active={recent > 0}>
          <Row label="algorithm" value="reserve → commit"/>
          <Row label="on duplicate" value="release" tone="text-violet-300"/>
          <Row label="over limit" value="429 deny" tone="text-amber-300"/>
        </Node>
        <Connector active={flowing}/>
        <Node icon={<Inbox size={18}/>} title="3. Outbox" tech="postgres · outbox" active={pipeline.outbox.pending > 0}>
          <Row label="pending" value={pipeline.outbox.pending} tone={pipeline.outbox.pending ? "text-amber-300" : "text-emerald-300"}/>
          <Row label="oldest" value={pipeline.outbox.pending ? duration(pipeline.outbox.oldestMs) : "—"}/>
          <Row label="relayed 1h" value={pipeline.outbox.publishedLastHour}/>
        </Node>
        <Connector active={flowing}/>
        <Node icon={<Zap size={18}/>} title="4. Queue" tech={pipeline.queue.available ? "bullmq · usage" : "bullmq unavailable"} active={pipeline.queue.waiting + pipeline.queue.active > 0}>
          <Row label="waiting" value={pipeline.queue.waiting}/>
          <Row label="active" value={pipeline.queue.active}/>
          <Row label="delayed / failed" value={`${pipeline.queue.delayed} / ${pipeline.queue.failed}`} tone={pipeline.queue.failed ? "text-red-300" : "text-slate-200"}/>
        </Node>
        <Connector active={flowing}/>
        <Node icon={<BarChart3 size={18}/>} title="5. Aggregate" tech="worker → usage_aggregates" active={pipeline.processing.backlog > 0}>
          <Row label="processed 24h" value={`${processedRatio}%`} tone={processedRatio < 100 ? "text-amber-300" : "text-emerald-300"}/>
          <Row label="backlog" value={pipeline.processing.backlog}/>
          <Row label="hour buckets" value={compact(pipeline.aggregates.buckets)}/>
        </Node>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-400/10 bg-red-500/[.04] px-4 py-3 text-xs">
        <Skull size={15} className="text-red-300"/><b>Dead-letter queue</b>
        <span className="text-slate-400">Jobs that fail 5 attempts with exponential backoff move to <code className="code">usage-dlq</code> for inspection and replay.</span>
        <Badge tone={pipeline.deadLetter.depth ? "red" : "green"}>{pipeline.deadLetter.depth} jobs</Badge>
      </div>
    </Card>

    <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
      <Card title="Throughput" icon={<BarChart3 size={16} className="text-blue-300"/>} subtitle="Events per minute, last 60 minutes">
        <div className="h-60" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ left: -20, right: 4, top: 6 }}>
              <CartesianGrid stroke="#ffffff0a" vertical={false}/>
              <XAxis dataKey="label" stroke="#475569" fontSize={11} interval={9} tickLine={false}/>
              <YAxis stroke="#475569" fontSize={11} allowDecimals={false} tickLine={false} axisLine={false}/>
              <Tooltip cursor={{ fill: "rgba(255,255,255,.04)" }} contentStyle={tooltipStyle} formatter={(value) => [number(Number(value)), "Events"]}/>
              <Bar dataKey="events" fill="#3b82f6" radius={[3, 3, 0, 0]} isAnimationActive={false}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="End-to-end latency" icon={<Timer size={16} className="text-amber-300"/>} subtitle="usage_events.created_at → processed_events.processed_at, last 24h">
        <div className="space-y-4">{percentiles.map((item) => <div key={item.label}>
          <div className="mb-1 flex justify-between text-xs"><span className="code text-slate-400">{item.label}</span><b className="tabular-nums">{duration(item.value)}</b></div>
          <div className="h-2 rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-300 to-red-400" style={{ width: `${((item.value ?? 0) / maxPercentile) * 100}%` }}/></div>
        </div>)}</div>
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/6 pt-4">
          <Stat label="Ingested 24h" value={compact(pipeline.processing.ingested24h)}/>
          <Stat label="Processed 24h" value={compact(pipeline.processing.processed24h)}/>
        </div>
        {!pipeline.queue.available && <p className="mt-4 text-xs text-amber-300">BullMQ is unreachable, so queue counters are unavailable.</p>}
      </Card>
    </div>

    <Card className="mt-5" title="Delivery guarantees" icon={<CheckCircle2 size={16} className="text-emerald-300"/>} subtitle="What each stage protects against">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          [Repeat, "Idempotent ingest", "UNIQUE(organization_id, idempotency_key). Retries return duplicate and release their quota reservation."],
          [Database, "Transactional outbox", "Event row and outbox row commit atomically, so a crash can never lose or phantom-publish usage."],
          [ServerCog, "At-least-once + dedupe", "BullMQ redelivers on failure. processed_events makes aggregation effectively exactly-once."],
          [Archive, "Hourly reconciliation", "The worker rebuilds aggregates from immutable raw events and repairs any drift."],
        ].map(([Icon, title, copy]) => {
          const Glyph = Icon as typeof Repeat;
          return <div key={String(title)} className="rounded-xl border border-white/6 bg-white/[.02] p-4"><Glyph size={17} className="mb-2 text-emerald-300"/><b className="text-sm">{String(title)}</b><p className="m-0 mt-1 text-xs text-slate-400">{String(copy)}</p></div>;
        })}
      </div>
    </Card>
  </>;
}
