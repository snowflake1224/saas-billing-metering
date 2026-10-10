"use client";

import { useMemo, useState } from "react";
import { ChevronRight, CreditCard, Database, FileClock, KeyRound, Layers3, ServerCog, ShieldCheck, Skull, SlidersHorizontal, UserCog, Users } from "lucide-react";
import { Audit, Capabilities, Health, Job, Member, Override, Pipeline, Team, compact, metricLabel, relative } from "../lib/api";
import { Badge, Card, JsonView, Segmented, Select, Stat } from "./ui";

type Mutate = (path: string, data: object, method?: string, success?: string) => Promise<void>;

export function ReadOnlyNotice({ capabilities }: { capabilities: Capabilities }) {
  if (!capabilities.protectedDemo) return null;
  return <div className="mb-5 flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/8 p-4 text-sm text-cyan-100"><KeyRound className="mt-0.5 shrink-0" size={17}/><div><b>Protected demo data</b><div className="text-cyan-200/70">Management controls are intentionally read-only so every visitor gets a reliable workspace. The API enforces this too, so the 403 is real.</div></div></div>;
}

const roleOptions = (["owner", "admin", "billing", "member"] as const).map((role) => ({ value: role, label: role[0].toUpperCase() + role.slice(1) }));
const roleTone = { owner: "violet", admin: "blue", billing: "amber", member: "slate" } as const;

export function MembersSection({ members, capabilities, mutate, seatLimit }: { members: Member[]; capabilities: Capabilities; mutate: Mutate; seatLimit: number }) {
  const counts = members.reduce<Record<string, number>>((totals, member) => ({ ...totals, [member.role]: (totals[member.role] ?? 0) + 1 }), {});
  const percent = seatLimit ? Math.min(100, (members.length / seatLimit) * 100) : 0;
  return <>
    <ReadOnlyNotice capabilities={capabilities}/>
    <div className="mb-5 grid gap-4 md:grid-cols-3">
      <Card><Stat label="Seats used" value={`${members.length} / ${seatLimit || "—"}`} hint="enforced when invitations are accepted"/><div className="mt-3 h-1.5 rounded-full bg-white/5"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${percent}%` }}/></div></Card>
      <Card><div className="text-[11px] uppercase tracking-wider text-slate-500">Role mix</div><div className="mt-3 flex flex-wrap gap-2">{roleOptions.map((role) => <Badge key={role.value} tone={roleTone[role.value]}>{role.label} {counts[role.value] ?? 0}</Badge>)}</div></Card>
      <Card><div className="text-[11px] uppercase tracking-wider text-slate-500">RBAC</div><p className="m-0 mt-2 text-xs text-slate-400">The role is re-read from <code className="code">memberships</code> on every request, so a revoked member loses access before their 15-minute JWT expires.</p></Card>
    </div>
    <Card title="Workspace members" icon={<Users size={16} className="text-blue-300"/>} subtitle={`${members.length} of ${seatLimit || "—"} seats used`}>
      {members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/6 py-3.5">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-blue-500/40 to-cyan-400/30 text-xs font-bold">{member.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
          <div><b className="text-sm">{member.name}</b><div className="text-xs text-slate-500">{member.email}</div></div>
        </div>
        {capabilities.permissions.manageWorkspace ? <div className="flex items-center gap-3">
          <Select label={`Role for ${member.name}`} value={member.role} options={roleOptions} size="sm" className="w-32" onChange={(role) => void mutate(`/members/${member.id}`, { role }, "PATCH", `${member.name}'s role updated`)}/>
          <button onClick={() => window.confirm(`Remove ${member.name}?`) && void mutate(`/members/${member.id}`, {}, "DELETE", `${member.name} removed`)} className="text-xs text-red-300 hover:text-red-200">Remove {member.name}</button>
        </div> : <Badge tone={roleTone[member.role]}>{member.role}</Badge>}
      </div>)}
    </Card>
  </>;
}

export function TeamsSection({ teams, capabilities, mutate }: { teams: Team[]; capabilities: Capabilities; mutate: Mutate }) {
  const largest = Math.max(1, ...teams.map((team) => team.member_count));
  return <>
    <ReadOnlyNotice capabilities={capabilities}/>
    {capabilities.permissions.manageWorkspace && <form className="glass mb-5 flex max-w-lg gap-3 rounded-2xl p-4" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate("/teams", { name: form.get("name") }, "POST", "Team created"); event.currentTarget.reset(); }}>
      <label className="sr-only" htmlFor="team-name">New team name</label><input id="team-name" name="name" required placeholder="New team name" className="flex-1 rounded-xl border border-white/10 bg-[#0d1424] p-3 text-sm"/><button className="rounded-xl bg-blue-500 px-5 text-sm font-semibold">Create team</button>
    </form>}
    <div className="grid gap-4 md:grid-cols-2">{teams.map((team) => <article key={team.id} className="glass rounded-2xl p-5">
      <div className="flex justify-between"><div><h2 className="m-0 text-base">{team.name}</h2><p className="m-0 mt-1 text-xs text-slate-500">{team.member_count} members · unique name per tenant</p></div><Layers3 className="text-cyan-300" size={20}/></div>
      <div className="mt-5 h-1.5 rounded-full bg-white/5"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${(team.member_count / largest) * 100}%` }}/></div>
      <code className="code mt-3 block truncate text-[10px] text-slate-600">{team.id}</code>
    </article>)}</div>
  </>;
}

const actionIcon = (action: string) => {
  if (action.startsWith("plan")) return CreditCard;
  if (action.startsWith("team")) return Layers3;
  if (action.startsWith("member") || action.startsWith("invitation")) return UserCog;
  if (action.startsWith("override")) return SlidersHorizontal;
  if (action.startsWith("dlq")) return Skull;
  return FileClock;
};
type AuditWindow = "24h" | "7d" | "30d" | "all";
const windows: Record<AuditWindow, number> = { "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000, all: Infinity };

export function AdminSection({ overrides, audit, jobs, capabilities, mutate, health, pipeline, members }: {
  overrides: Override[]; audit: Audit[]; jobs: Job[]; capabilities: Capabilities; mutate: Mutate; health: Health | null; pipeline: Pipeline | null; members: Member[];
}) {
  const [span, setSpan] = useState<AuditWindow>("30d");
  const [open, setOpen] = useState<string | null>(null);
  const names = useMemo(() => Object.fromEntries(members.map((member) => [member.id, member.name])), [members]);
  const grouped = useMemo(() => {
    const cutoff = Date.now() - windows[span];
    const groups = new Map<string, Audit[]>();
    for (const item of audit.filter((entry) => new Date(entry.created_at).getTime() >= cutoff)) {
      const day = new Date(item.created_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      groups.set(day, [...(groups.get(day) ?? []), item]);
    }
    return [...groups.entries()];
  }, [audit, span]);
  const healthy = health?.status === "ok";

  return <>
    <ReadOnlyNotice capabilities={capabilities}/>
    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatusCard icon={ServerCog} label="API dependencies" value={health ? (healthy ? "Operational" : "Degraded") : "Checking…"} tone={health ? (healthy ? "text-emerald-300" : "text-amber-300") : "text-slate-400"}
        hint={health ? `Postgres ${health.dependencies.postgres ? "up" : "down"} · Redis ${health.dependencies.redis ? "up" : "down"}` : undefined}/>
      <StatusCard icon={Database} label="Failed jobs (DLQ)" value={String(jobs.length)} tone={jobs.length ? "text-red-300" : "text-emerald-300"} hint={pipeline ? `${pipeline.queue.failed} failed attempts in BullMQ` : undefined}/>
      <StatusCard icon={SlidersHorizontal} label="Active overrides" value={String(overrides.length)} tone="text-blue-300" hint="time-boxed entitlement changes"/>
      <StatusCard icon={ShieldCheck} label="Audit events" value={String(audit.length)} tone="text-violet-300" hint="append-only, enforced by trigger"/>
    </div>
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-5">
        <Card title="Entitlement overrides" icon={<SlidersHorizontal size={16} className="text-blue-300"/>} subtitle="Merged over plan entitlements while now() is inside the window">
          {overrides.length ? overrides.map((item) => {
            const start = new Date(item.starts_at ?? Date.now()).getTime();
            const end = new Date(item.ends_at).getTime();
            const progress = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start || 1)) * 100));
            return <div key={item.id} className="border-t border-white/6 py-4 first:border-t-0 first:pt-0">
              <div className="flex justify-between gap-3"><b className="text-sm">{metricLabel(item.key)}</b><span className="tabular-nums">{compact(Number(item.value))}</span></div>
              <div className="mt-1 text-xs text-slate-500">{item.reason}</div>
              <div className="mt-3 h-1 rounded-full bg-white/5"><div className="h-full rounded-full bg-blue-400" style={{ width: `${progress}%` }}/></div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>started {relative(start)}</span><span>expires {relative(end)}</span></div>
            </div>;
          }) : <p className="m-0 text-sm text-slate-500">No active overrides.</p>}
        </Card>
        <Card title="Dead-letter queue" icon={<Skull size={16} className="text-red-300"/>} subtitle="usage-dlq · jobs that exhausted 5 attempts">
          {jobs.length ? jobs.map((job) => <div key={job.id} className="border-t border-white/6 py-3 text-sm first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between gap-3">
              <button onClick={() => setOpen(open === job.id ? null : job.id)} aria-expanded={open === job.id} className="flex items-center gap-2 text-left"><ChevronRight size={14} className={`transition ${open === job.id ? "rotate-90" : ""}`}/>Job <code className="code">{job.id}</code></button>
              <span className="flex items-center gap-3"><Badge tone="red">{job.attemptsMade} attempts</Badge>{capabilities.permissions.replayJobs && <button onClick={() => void mutate(`/admin/dlq/${job.id}/replay`, {}, "POST", "Job replayed")} className="text-xs text-blue-300">Replay</button>}</span>
            </div>
            <div className="mt-1 text-xs text-red-300">{job.data?.error ?? job.failedReason ?? "Awaiting inspection"}</div>
            {open === job.id && <JsonView value={job.data ?? job} className="mt-3 max-h-60"/>}
          </div>) : <p className="m-0 flex items-center gap-2 text-sm text-emerald-300"><ShieldCheck size={16}/>Queue is clear</p>}
        </Card>
      </div>
      <Card title="Audit log" icon={<FileClock size={16} className="text-violet-300"/>} subtitle="Immutable audit_log rows for this tenant" className="max-h-[760px] overflow-auto"
        actions={<Segmented label="Audit window" value={span} onChange={setSpan} options={[{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "all", label: "All" }]}/>}>
        {grouped.length ? grouped.map(([day, items]) => <section key={day} className="mb-4">
          <div className="sticky top-0 mb-2 bg-[#0f1726]/95 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{day}</div>
          <ol className="relative ml-2 border-l border-white/10">
            {items.map((item) => {
              const Icon = actionIcon(item.action);
              return <li key={item.id} className="mb-3 ml-5">
                <span className="absolute -left-[11px] grid h-[22px] w-[22px] place-items-center rounded-full border border-white/10 bg-[#0d1424] text-violet-300"><Icon size={11}/></span>
                <div className="flex flex-wrap items-center justify-between gap-2"><code className="code text-xs text-slate-200">{item.action}</code><span className="text-[11px] text-slate-500">{new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                <div className="text-[11px] text-slate-500">{(item.actor_id && names[item.actor_id]) || "System"} · {item.target_type}{item.target_id ? ` ${item.target_id.slice(0, 18)}` : ""}</div>
                {item.metadata && Object.keys(item.metadata).length > 0 && <code className="code mt-1 block truncate text-[10px] text-slate-600">{JSON.stringify(item.metadata)}</code>}
              </li>;
            })}
          </ol>
        </section>) : <p className="m-0 text-sm text-slate-500">No audit events in this window.</p>}
      </Card>
    </div>
  </>;
}

function StatusCard({ icon: Icon, label, value, tone, hint }: { icon: typeof ServerCog; label: string; value: string; tone: string; hint?: string }) {
  return <article className="glass rounded-2xl p-5"><Icon className={`mb-3 ${tone}`} size={20}/><div className="text-xs text-slate-500">{label}</div><b className={`text-xl ${tone}`}>{value}</b>{hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}</article>;
}
