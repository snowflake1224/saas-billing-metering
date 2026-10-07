"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, Building2, CreditCard, Gauge, Layers3, LogOut, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const configuredApi = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API = configuredApi === "same-origin" ? "" : configuredApi.replace(/\/$/, "");
type Section = "Overview" | "Usage" | "Members" | "Teams" | "Billing" | "Admin";
type Org = { id: string; name: string; role: string };
type Dashboard = { plan?: { name: string; version: number; status: string; entitlements: Record<string, number> }; usage: Array<{ metric: string; used: string }> };
const nav: Array<[Section, typeof Gauge]> = [["Overview", Gauge], ["Usage", BarChart3], ["Members", Users], ["Teams", Layers3], ["Billing", CreditCard], ["Admin", ShieldCheck]];

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("fb3_access");
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (response.status === 401 && path !== "/auth/refresh") {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) {
      localStorage.setItem("fb3_access", (await refreshed.json()).accessToken);
      return request<T>(path, init);
    }
  }
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `Request failed (${response.status})`);
  return response.json();
}

export default function DashboardPage() {
  const [token, setToken] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("Overview");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard>({ usage: [] });
  const [members, setMembers] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [chart, setChart] = useState<any[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [organizationData, dashboardData] = await Promise.all([request<Org[]>("/organizations"), request<Dashboard>("/dashboard")]);
      setOrgs(organizationData);
      setDashboard(dashboardData);
      setActiveOrg((value) => value || organizationData[0]?.id || "");
      const results = await Promise.all([
        request<any[]>("/members"), request<any[]>("/teams"), request<any[]>("/analytics/usage"),
        request<any[]>("/billing/invoices"), request<any[]>("/invitations").catch(() => []),
        request<any[]>("/admin/overrides").catch(() => []), request<any[]>("/admin/audit").catch(() => []),
      ]);
      setMembers(results[0]); setTeams(results[1]); setChart(results[2]); setInvoices(results[3]);
      setInvitations(results[4]); setOverrides(results[5]); setAudit(results[6]);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load workspace"); }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("fb3_access");
    setToken(stored);
    if (stored) void load();
  }, [load]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
      localStorage.setItem("fb3_access", result.accessToken);
      setToken(result.accessToken);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Login failed"); }
  }

  async function switchOrg(id: string) {
    const result = await request<{ accessToken: string }>(`/organizations/${id}/switch`, { method: "POST" });
    localStorage.setItem("fb3_access", result.accessToken);
    setToken(result.accessToken); setActiveOrg(id); await load();
  }

  async function logout() {
    await request("/auth/logout", { method: "POST" }).catch(() => undefined);
    localStorage.removeItem("fb3_access"); setToken(null);
  }

  async function submit(path: string, data: object, method = "POST") {
    try { await request(path, { method, body: JSON.stringify(data) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed"); }
  }

  if (!token) return <Login onSubmit={login} error={error} />;
  const entitlements = dashboard.plan?.entitlements ?? {};
  const metrics = Object.entries(entitlements).map(([metric, limit]) => {
    const used = Number(dashboard.usage.find((item) => item.metric === metric)?.used ?? 0);
    return { metric, used, limit, percent: limit ? Math.min(100, Math.round(used / limit * 100)) : 0 };
  });
  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[255px_1fr]">
      <aside className="border-r border-white/8 bg-[#090e18]/90 p-5">
        <div className="mb-9 flex items-center gap-3 px-2"><div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 font-black">F3</div><div><b>Fluxbill</b><div className="text-xs text-slate-500">Metering cloud</div></div></div>
        <label className="mb-7 block text-xs text-slate-500">ORGANIZATION<select value={activeOrg} onChange={(e) => void switchOrg(e.target.value)} className="glass mt-2 w-full rounded-xl px-3 py-3 text-sm"><option value="">Select workspace</option>{orgs.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.role}</option>)}</select></label>
        <nav className="space-y-1">{nav.map(([name, Icon]) => <button key={name} onClick={() => setSection(name)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${section === name ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><Icon size={17}/>{name}</button>)}</nav>
        <button onClick={() => void logout()} className="mt-10 flex items-center gap-3 px-3 text-sm text-slate-500 hover:text-white"><LogOut size={16}/> Sign out</button>
      </aside>
      <section className="overflow-hidden p-5 lg:p-9">
        <header className="mb-8"><div className="text-sm text-slate-500">Workspace / {section}</div><h1 className="mt-1 text-3xl font-semibold">{section}</h1>{error && <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}</header>
        {(section === "Overview" || section === "Usage") && <UsageSection metrics={metrics} chart={chart} detailed={section === "Usage"} />}
        {section === "Members" && <MembersSection members={members} invitations={invitations} submit={submit} />}
        {section === "Teams" && <TeamsSection teams={teams} members={members} submit={submit} />}
        {section === "Billing" && <BillingSection plan={dashboard.plan} invoices={invoices} submit={submit} />}
        {section === "Admin" && <AdminSection overrides={overrides} audit={audit} submit={submit} />}
      </section>
    </main>
  );
}

function Login({ onSubmit, error }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string }) {
  return <main className="grid min-h-screen place-items-center p-6"><form onSubmit={onSubmit} className="glass w-full max-w-md rounded-3xl p-8"><div className="mb-7 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-blue-500 font-black">F3</div><div><h1 className="m-0 text-xl font-semibold">Welcome to Fluxbill</h1><p className="m-0 text-sm text-slate-500">Sample workspace. The filled-in login is public demo data.</p></div></div>{error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}<input name="email" type="email" required defaultValue="demo@fb3.local" className="mb-3 w-full rounded-xl border border-white/10 bg-white/5 p-3" placeholder="Email"/><input name="password" type="password" required defaultValue="DemoPass123!" className="mb-5 w-full rounded-xl border border-white/10 bg-white/5 p-3" placeholder="Password"/><button className="w-full rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400">Sign in</button></form></main>;
}

function UsageSection({ metrics, chart, detailed }: { metrics: any[]; chart: any[]; detailed: boolean }) {
  const data = chart.map((row) => ({ bucket: new Date(row.bucket).toLocaleDateString(), quantity: Number(row.quantity), metric: row.metric }));
  return <><div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => <article key={metric.metric} className="metric glass rounded-2xl p-5"><div className="mb-4 flex justify-between text-slate-400">{metric.metric === "ai_tokens" ? <Sparkles/> : <Activity/>}<span>{metric.percent}%</span></div><div className="text-sm capitalize text-slate-400">{metric.metric.replaceAll("_", " ")}</div><div className="mt-1 text-2xl font-semibold">{metric.used.toLocaleString()} <span className="text-sm text-slate-600">/ {metric.limit.toLocaleString()}</span></div><div className="mt-4 h-1.5 rounded-full bg-white/6"><div className={metric.percent > 80 ? "h-full rounded bg-amber-400" : "h-full rounded bg-blue-500"} style={{ width: `${metric.percent}%` }}/></div></article>)}</div><article className="glass rounded-2xl p-6"><h2 className="mt-0">{detailed ? "Hourly usage by metric" : "Usage velocity"}</h2><div className="h-80"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data}><defs><linearGradient id="usage" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={.7}/><stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#ffffff0d"/><XAxis dataKey="bucket" stroke="#64748b"/><YAxis stroke="#64748b"/><Tooltip contentStyle={{ background: "#111827", border: "1px solid #334155" }}/><Area type="monotone" dataKey="quantity" stroke="#60a5fa" fill="url(#usage)"/></AreaChart></ResponsiveContainer></div></article></>;
}

function MembersSection({ members, invitations, submit }: { members: any[]; invitations: any[]; submit: Function }) {
  return <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]"><article className="glass rounded-2xl p-6"><h2 className="mt-0">Members</h2>{members.map((member) => <div key={member.id} className="flex items-center justify-between border-t border-white/6 py-4"><div><b>{member.name}</b><div className="text-sm text-slate-500">{member.email}</div></div><div className="flex gap-2"><select value={member.role} onChange={(e) => void submit(`/members/${member.id}`, { role: e.target.value }, "PATCH")} className="rounded-lg bg-white/5 p-2"><option>owner</option><option>admin</option><option>billing</option><option>member</option></select><button onClick={() => void submit(`/members/${member.id}`, {}, "DELETE")} className="text-sm text-red-300">Remove</button></div></div>)}</article><article className="glass rounded-2xl p-6"><h2 className="mt-0">Invite member</h2><form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void submit("/invitations", { email: f.get("email"), role: f.get("role") }); }}><input name="email" required type="email" placeholder="person@company.com" className="mb-3 w-full rounded-xl bg-white/5 p-3"/><select name="role" className="mb-3 w-full rounded-xl bg-white/5 p-3"><option>member</option><option>admin</option><option>billing</option></select><button className="w-full rounded-xl bg-blue-500 p-3">Send invitation</button></form><h3 className="mt-7 text-sm text-slate-400">Pending</h3>{invitations.filter((x) => !x.accepted_at && !x.revoked_at).map((invite) => <div key={invite.id} className="flex justify-between py-2 text-sm"><span>{invite.email}</span><button className="text-red-300" onClick={() => void submit(`/invitations/${invite.id}`, {}, "DELETE")}>Revoke</button></div>)}</article></div>;
}

function TeamsSection({ teams, members, submit }: { teams: any[]; members: any[]; submit: Function }) {
  return <><form className="glass mb-5 flex max-w-lg gap-3 rounded-2xl p-4" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void submit("/teams", { name: f.get("name") }); e.currentTarget.reset(); }}><input name="name" required placeholder="New team name" className="flex-1 rounded-xl bg-white/5 p-3"/><button className="rounded-xl bg-blue-500 px-5">Create</button></form><div className="grid gap-4 md:grid-cols-2">{teams.map((team) => <article key={team.id} className="glass rounded-2xl p-5"><div className="flex justify-between"><div><h2 className="m-0">{team.name}</h2><p className="text-sm text-slate-500">{team.member_count} members</p></div><button onClick={() => void submit(`/teams/${team.id}`, {}, "DELETE")} className="text-red-300">Delete</button></div><select onChange={(e) => e.target.value && void submit(`/teams/${team.id}/members/${e.target.value}`, {})} defaultValue="" className="mt-3 w-full rounded-xl bg-white/5 p-3"><option value="">Add a member…</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></article>)}</div></>;
}

function BillingSection({ plan, invoices }: { plan: any; invoices: any[]; submit: Function }) {
  async function checkout() {
    const result = await request<{ url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode: "pro", priceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID }) });
    window.location.assign(result.url);
  }
  return <div className="grid gap-5 xl:grid-cols-[1fr_1.5fr]"><article className="glass rounded-2xl p-6"><div className="text-xs text-blue-300">CURRENT PLAN</div><h2 className="text-3xl">{plan?.name ?? "Free"}</h2><p className="text-slate-400">Status: {plan?.status ?? "active"}</p><p className="text-sm text-slate-500">Sample workspace. Upgrade does not charge a card.</p><button onClick={() => void checkout()} className="mt-5 w-full rounded-xl bg-blue-500 p-3">Preview upgrade</button></article><article className="glass rounded-2xl p-6"><h2 className="mt-0">Invoices</h2>{invoices.length ? invoices.map((invoice) => <div key={invoice.id} className="flex justify-between border-t border-white/6 py-4"><span>{invoice.id}<small className="ml-2 text-slate-500">{invoice.status}</small></span><b>{new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency }).format(invoice.amount_due / 100)}</b></div>) : <p className="text-slate-500">No invoices yet.</p>}</article></div>;
}

function AdminSection({ overrides, audit, submit }: { overrides: any[]; audit: any[]; submit: Function }) {
  return <div className="grid gap-5 xl:grid-cols-2"><article className="glass rounded-2xl p-6"><h2 className="mt-0">Entitlement overrides</h2><form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void submit("/admin/overrides", { key: f.get("key"), value: Number(f.get("value")), reason: f.get("reason"), startsAt: new Date().toISOString(), endsAt: f.get("endsAt") }); }}><select name="key" className="rounded-xl bg-white/5 p-3"><option>api_requests</option><option>storage_gb</option><option>seats</option><option>ai_tokens</option></select><input name="value" type="number" min="1" required placeholder="New limit" className="rounded-xl bg-white/5 p-3"/><input name="reason" required placeholder="Business reason" className="rounded-xl bg-white/5 p-3"/><input name="endsAt" type="datetime-local" required className="rounded-xl bg-white/5 p-3"/><button className="rounded-xl bg-blue-500 p-3">Create override</button></form>{overrides.map((item) => <div key={item.id} className="flex justify-between border-t border-white/6 py-3 text-sm"><span>{item.key}: {item.value}</span><button onClick={() => void submit(`/admin/overrides/${item.id}`, {}, "DELETE")} className="text-red-300">Delete</button></div>)}</article><article className="glass max-h-[650px] overflow-auto rounded-2xl p-6"><h2 className="mt-0">Audit log</h2>{audit.map((item) => <div key={item.id} className="border-t border-white/6 py-3"><div className="text-sm">{item.action}</div><div className="text-xs text-slate-500">{item.target_type} · {new Date(item.created_at).toLocaleString()}</div></div>)}</article></div>;
}
