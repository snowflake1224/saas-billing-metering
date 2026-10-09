"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, CreditCard, Database,
  ExternalLink, Gauge, Layers3, LockKeyhole, LogOut, Menu, ServerCog,
  ShieldCheck, Sparkles, Terminal, Users, Workflow, X,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const configuredApi = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace("://localhost:", "://127.0.0.1:");
const API = configuredApi === "same-origin" ? "" : configuredApi.replace(/\/$/, "");
const sections = ["Overview", "Usage", "Members", "Teams", "Billing", "Admin"] as const;
type Section = typeof sections[number];
type Org = { id: string; name: string; role: Role };
type Role = "owner" | "admin" | "billing" | "member";
type Dashboard = {
  plan?: { code: string; name: string; version: number; status: string; entitlements: Record<string, number> };
  usage: Array<{ metric: string; used: string }>;
};
type Capabilities = {
  protectedDemo: boolean;
  role: Role;
  permissions: { simulateUsage: boolean; checkoutPreview: boolean; manageWorkspace: boolean; manageBilling: boolean; replayJobs: boolean };
};
type Member = { id: string; name: string; email: string; role: Role };
type Team = { id: string; name: string; member_count: number };
type Invoice = { id: string; status: string; currency: string; amount_due: number; hosted_invoice_url?: string | null; stripe_event_created: string };
type UsageRow = { bucket: string; metric: string; quantity: string };
type Override = { id: string; key: string; value: string; reason: string; ends_at: string };
type Audit = { id: string; action: string; target_type: string; created_at: string };
type Job = { id: string; failedReason?: string; attemptsMade: number };
type Plan = { code: string; name: string; price_cents: number | null; entitlements: Record<string, number> };
type InvoicePreview = { mode: string; currency: string; amountDue: number; lines: Array<{ description?: string; amount: number }> };

const navIcons = { Overview: Gauge, Usage: BarChart3, Members: Users, Teams: Layers3, Billing: CreditCard, Admin: ShieldCheck };

class SessionExpiredError extends Error {}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = localStorage.getItem("fb3_access");
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (response.status === 401 && path !== "/auth/refresh" && retry) {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) {
      localStorage.setItem("fb3_access", (await refreshed.json()).accessToken);
      return request<T>(path, init, false);
    }
    localStorage.removeItem("fb3_access");
    throw new SessionExpiredError("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export default function DashboardApp() {
  const params = useSearchParams();
  const router = useRouter();
  const requestedSection = params.get("section");
  const initialSection = sections.find((item) => item.toLowerCase() === requestedSection?.toLowerCase()) ?? "Overview";
  const [token, setToken] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(initialSection);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard>({ usage: [] });
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [chart, setChart] = useState<UsageRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);

  const signOutLocally = useCallback((message = "") => {
    localStorage.removeItem("fb3_access");
    setToken(null);
    setError(message);
    setCapabilities(null);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [organizationData, dashboardData, capabilityData] = await Promise.all([
        request<Org[]>("/organizations"),
        request<Dashboard>("/dashboard"),
        request<Capabilities>("/capabilities"),
      ]);
      setOrgs(organizationData);
      setDashboard(dashboardData);
      setCapabilities(capabilityData);
      setActiveOrg((value) => value || organizationData[0]?.id || "");
      const isAdmin = ["owner", "admin"].includes(capabilityData.role);
      const results = await Promise.all([
        request<Member[]>("/members"),
        request<Team[]>("/teams"),
        request<UsageRow[]>("/analytics/usage"),
        request<Invoice[]>("/billing/invoices"),
        request<Plan[]>("/plans"),
        request<InvoicePreview>("/billing/invoice-preview").catch(() => null),
        isAdmin ? request<Override[]>("/admin/overrides") : Promise.resolve([]),
        isAdmin ? request<Audit[]>("/admin/audit") : Promise.resolve([]),
        isAdmin ? request<Job[]>("/admin/dlq").catch(() => []) : Promise.resolve([]),
      ]);
      setMembers(results[0]); setTeams(results[1]); setChart(results[2]); setInvoices(results[3]);
      setPlans(results[4]); setPreview(results[5]); setOverrides(results[6]); setAudit(results[7]); setJobs(results[8]);
      setError("");
    } catch (reason) {
      if (reason instanceof SessionExpiredError) signOutLocally(reason.message);
      else setError(reason instanceof Error ? reason.message : "Unable to load workspace");
    } finally {
      setLoading(false);
    }
  }, [signOutLocally]);

  useEffect(() => {
    const stored = localStorage.getItem("fb3_access");
    setToken(stored);
    if (stored) void load();
  }, [load]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAction("login");
    const form = new FormData(event.currentTarget);
    try {
      const result = await request<{ accessToken: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      localStorage.setItem("fb3_access", result.accessToken);
      setToken(result.accessToken);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Login failed");
    } finally {
      setAction("");
    }
  }

  async function switchOrg(id: string) {
    setAction("switch-org");
    try {
      const result = await request<{ accessToken: string }>(`/organizations/${id}/switch`, { method: "POST" });
      localStorage.setItem("fb3_access", result.accessToken);
      setToken(result.accessToken);
      setActiveOrg(id);
      await load();
    } finally {
      setAction("");
    }
  }

  async function logout() {
    await request("/auth/logout", { method: "POST" }).catch(() => undefined);
    signOutLocally();
  }

  async function mutate(path: string, data: object, method = "POST", success = "Saved") {
    setAction(path); setError(""); setNotice("");
    try {
      await request(path, { method, body: JSON.stringify(data) });
      setNotice(success);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action failed");
    } finally {
      setAction("");
    }
  }

  function navigate(next: Section) {
    setSection(next);
    setMenuOpen(false);
    router.replace(`/?section=${next.toLowerCase()}`, { scroll: false });
  }

  if (!token) return <Login onSubmit={login} error={error} pending={action === "login"} />;

  const allowedSections = sections.filter((item) => item !== "Admin" || ["owner", "admin"].includes(capabilities?.role ?? "member"));
  const entitlements = dashboard.plan?.entitlements ?? {};
  const metrics = Object.entries(entitlements).map(([metric, limit]) => {
    const used = Number(dashboard.usage.find((item) => item.metric === metric)?.used ?? 0);
    return { metric, used, limit, percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0 };
  });

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[270px_1fr]">
      <button className="fixed right-4 top-4 z-40 rounded-xl border border-white/10 bg-slate-900 p-2 lg:hidden" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? "Close navigation" : "Open navigation"}>
        {menuOpen ? <X /> : <Menu />}
      </button>
      <aside className={`${menuOpen ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 z-30 w-[270px] border-r border-white/8 bg-[#090e18]/98 p-5 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0`}>
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 font-black">F3</div>
          <div><b>Fluxbill</b><div className="text-xs text-slate-500">Usage operations cloud</div></div>
        </div>
        {capabilities?.protectedDemo && <div className="mb-5 rounded-xl border border-cyan-400/20 bg-cyan-400/8 p-3 text-xs text-cyan-100"><LockKeyhole className="mb-2" size={16}/><b>Protected public demo</b><div className="mt-1 text-cyan-200/70">Explore live data and simulate usage. Shared records are read-only.</div></div>}
        <label className="mb-7 block text-xs text-slate-500">ORGANIZATION
          <select aria-label="Organization" value={activeOrg} disabled={action === "switch-org"} onChange={(event) => void switchOrg(event.target.value)} className="glass mt-2 w-full rounded-xl px-3 py-3 text-sm text-white">
            <option value="">Select workspace</option>{orgs.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.role}</option>)}
          </select>
        </label>
        <nav className="space-y-1" aria-label="Workspace navigation">
          {allowedSections.map((name) => {
            const Icon = navIcons[name];
            return <button key={name} onClick={() => navigate(name)} aria-current={section === name ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${section === name ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><Icon size={17}/>{name}</button>;
          })}
        </nav>
        <button onClick={() => void logout()} className="mt-10 flex items-center gap-3 px-3 text-sm text-slate-500 hover:text-white"><LogOut size={16}/> Sign out</button>
      </aside>
      <section className="min-w-0 overflow-hidden p-5 pt-20 lg:p-9">
        <header className="mb-8">
          <div className="text-sm text-slate-500">Acme Analytics / {section}</div>
          <div className="mt-1 flex items-center gap-3"><h1 className="m-0 text-3xl font-semibold">{section}</h1>{loading && <span className="text-xs text-blue-300">Refreshing…</span>}</div>
          <div aria-live="polite">
            {error && <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200"><AlertTriangle size={16}/>{error}</div>}
            {notice && <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"><CheckCircle2 size={16}/>{notice}</div>}
          </div>
        </header>
        {loading && !capabilities ? <DashboardSkeleton /> : <>
          {(section === "Overview" || section === "Usage") && <UsageSection metrics={metrics} chart={chart} detailed={section === "Usage"} pending={action === "/usage/events"} onSimulate={(metric, quantity) => mutate("/usage/events", { idempotencyKey: `demo-${crypto.randomUUID()}`, metric, quantity, occurredAt: new Date().toISOString(), dimensions: { source: "portfolio_demo" } }, "POST", "Usage event accepted. The worker will aggregate it shortly.")}/>}
          {section === "Members" && <MembersSection members={members} capabilities={capabilities!} mutate={mutate}/>}
          {section === "Teams" && <TeamsSection teams={teams} capabilities={capabilities!} mutate={mutate}/>}
          {section === "Billing" && <BillingSection plan={dashboard.plan} plans={plans} invoices={invoices} preview={preview} capabilities={capabilities!}/>}
          {section === "Admin" && <AdminSection overrides={overrides} audit={audit} jobs={jobs} capabilities={capabilities!} mutate={mutate}/>}
        </>}
      </section>
    </main>
  );
}

function Login({ onSubmit, error, pending }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string; pending: boolean }) {
  return <main className="grid min-h-screen place-items-center p-6">
    <form onSubmit={onSubmit} className="glass w-full max-w-md rounded-3xl p-8">
      <div className="mb-7 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-blue-500 font-black">F3</div><div><h1 className="m-0 text-xl font-semibold">Welcome to Fluxbill</h1><p className="m-0 text-sm text-slate-500">Explore a protected, live metering workspace.</p></div></div>
      {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      <label className="mb-3 block text-sm text-slate-300">Email<input name="email" type="email" required defaultValue="demo@fb3.local" className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 p-3" autoComplete="username"/></label>
      <label className="mb-5 block text-sm text-slate-300">Password<input name="password" type="password" required defaultValue="DemoPass123!" className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 p-3" autoComplete="current-password"/></label>
      <button disabled={pending} className="w-full rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400 disabled:opacity-60">{pending ? "Signing in…" : "Enter demo workspace"}</button>
      <p className="mt-4 text-center text-xs text-slate-500">Public credentials access sample data only. Destructive actions are disabled.</p>
    </form>
  </main>;
}

function DashboardSkeleton() {
  return <div aria-label="Loading workspace" className="grid animate-pulse gap-4 md:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="glass h-36 rounded-2xl"/>)}</div>;
}

function UsageSection({ metrics, chart, detailed, pending, onSimulate }: { metrics: Array<{ metric: string; used: number; limit: number; percent: number }>; chart: UsageRow[]; detailed: boolean; pending: boolean; onSimulate: (metric: string, quantity: number) => void }) {
  const [metric, setMetric] = useState("api_requests");
  const [quantity, setQuantity] = useState(250);
  const chartMetric = detailed ? metric : "api_requests";
  const data = chart.filter((row) => row.metric === chartMetric).map((row) => ({ bucket: new Date(row.bucket).toLocaleString([], { weekday: "short", hour: "2-digit" }), quantity: Number(row.quantity) }));
  const total = metrics.reduce((sum, item) => sum + item.used, 0);
  return <>
    <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics.map((item) => <article key={item.metric} className="metric glass rounded-2xl p-5"><div className="mb-4 flex justify-between text-slate-400">{item.metric === "ai_tokens" ? <Sparkles/> : <Activity/>}<span>{item.percent}%</span></div><div className="text-sm capitalize text-slate-400">{item.metric.replaceAll("_", " ")}</div><div className="mt-1 text-2xl font-semibold">{item.used.toLocaleString()} <span className="text-sm text-slate-600">/ {item.limit.toLocaleString()}</span></div><div className="mt-4 h-1.5 rounded-full bg-white/6"><div className={item.percent > 80 ? "h-full rounded bg-amber-400" : "h-full rounded bg-blue-500"} style={{ width: `${item.percent}%` }}/></div></article>)}</div>
    <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
      <article className="glass rounded-2xl p-6"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="m-0">{detailed ? "Hourly usage by metric" : "API request velocity"}</h2><p className="mt-1 text-sm text-slate-500">{total.toLocaleString()} metered units represented this month</p></div>{detailed && <select aria-label="Chart metric" value={metric} onChange={(event) => setMetric(event.target.value)} className="rounded-xl bg-white/5 p-2">{metrics.map((item) => <option key={item.metric}>{item.metric}</option>)}</select>}</div>
        {data.length ? <><div className="h-72" aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data}><defs><linearGradient id="usage" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={.7}/><stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#ffffff0d"/><XAxis dataKey="bucket" stroke="#64748b"/><YAxis stroke="#64748b"/><Tooltip contentStyle={{ background: "#111827", border: "1px solid #334155" }}/><Area type="monotone" dataKey="quantity" stroke="#60a5fa" fill="url(#usage)"/></AreaChart></ResponsiveContainer></div><p className="sr-only">The chart contains {data.length} hourly {chartMetric.replaceAll("_", " ")} usage points.</p></> : <div className="grid h-72 place-items-center text-slate-500">No aggregated usage yet. Send an event to start the pipeline.</div>}
      </article>
      <article className="glass rounded-2xl p-6"><div className="flex items-center gap-2 text-blue-300"><Terminal size={18}/><span className="text-xs font-semibold tracking-wider">LIVE PIPELINE</span></div><h2>Simulate usage</h2><p className="text-sm text-slate-400">Send a real idempotent event through quota reservation, PostgreSQL outbox, BullMQ, and aggregation.</p>
        <label className="mt-5 block text-sm text-slate-400">Metric<select value={metric} onChange={(event) => setMetric(event.target.value)} className="mt-1 w-full rounded-xl bg-white/5 p-3 text-white">{metrics.filter((item) => item.metric !== "seats").map((item) => <option key={item.metric}>{item.metric}</option>)}</select></label>
        <label className="mt-3 block text-sm text-slate-400">Quantity<input value={quantity} min={1} max={500} onChange={(event) => setQuantity(Number(event.target.value))} type="number" className="mt-1 w-full rounded-xl bg-white/5 p-3 text-white"/></label>
        <button disabled={pending} onClick={() => onSimulate(metric, quantity)} className="mt-4 w-full rounded-xl bg-blue-500 p-3 font-semibold disabled:opacity-50">{pending ? "Sending event…" : "Send usage event"}</button>
      </article>
    </div>
    <Pipeline/>
  </>;
}

function Pipeline() {
  const steps = [[Terminal, "Ingest", "Validated + idempotent"], [ShieldCheck, "Reserve", "Atomic Redis quota"], [Database, "Persist", "Event + outbox"], [Workflow, "Process", "BullMQ worker"], [BarChart3, "Aggregate", "Hourly analytics"]] as const;
  return <section className="mt-5"><h2 className="text-lg">How this data moves</h2><div className="grid gap-3 md:grid-cols-5">{steps.map(([Icon, title, copy], index) => <div key={title} className="glass relative rounded-xl p-4"><Icon className="mb-3 text-cyan-300" size={20}/><b className="text-sm">{index + 1}. {title}</b><div className="mt-1 text-xs text-slate-500">{copy}</div></div>)}</div></section>;
}

function ReadOnlyNotice() {
  return <div className="mb-5 flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/8 p-4 text-sm text-cyan-100"><LockKeyhole className="mt-0.5 shrink-0" size={17}/><div><b>Protected demo data</b><div className="text-cyan-200/70">Management controls are intentionally read-only so every visitor gets a reliable workspace.</div></div></div>;
}

function MembersSection({ members, capabilities, mutate }: { members: Member[]; capabilities: Capabilities; mutate: (path: string, data: object, method?: string, success?: string) => Promise<void> }) {
  return <><ReadOnlyNotice/><article className="glass rounded-2xl p-6"><div className="mb-4 flex items-center justify-between"><div><h2 className="m-0">Workspace members</h2><p className="mt-1 text-sm text-slate-500">{members.length} of 25 seats used</p></div><Users className="text-blue-300"/></div>{members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/6 py-4"><div><b>{member.name}</b><div className="text-sm text-slate-500">{member.email}</div></div>{capabilities.permissions.manageWorkspace ? <div className="flex gap-2"><select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => void mutate(`/members/${member.id}`, { role: event.target.value }, "PATCH", `${member.name}'s role updated`)} className="rounded-lg bg-white/5 p-2"><option>owner</option><option>admin</option><option>billing</option><option>member</option></select><button onClick={() => window.confirm(`Remove ${member.name}?`) && void mutate(`/members/${member.id}`, {}, "DELETE", `${member.name} removed`)} className="text-sm text-red-300">Remove {member.name}</button></div> : <span className="rounded-full bg-white/5 px-3 py-1 text-xs capitalize text-slate-300">{member.role}</span>}</div>)}</article></>;
}

function TeamsSection({ teams, capabilities, mutate }: { teams: Team[]; capabilities: Capabilities; mutate: (path: string, data: object, method?: string, success?: string) => Promise<void> }) {
  return <><ReadOnlyNotice/>{capabilities.permissions.manageWorkspace && <form className="glass mb-5 flex max-w-lg gap-3 rounded-2xl p-4" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate("/teams", { name: form.get("name") }, "POST", "Team created"); event.currentTarget.reset(); }}><label className="sr-only" htmlFor="team-name">New team name</label><input id="team-name" name="name" required placeholder="New team name" className="flex-1 rounded-xl bg-white/5 p-3"/><button className="rounded-xl bg-blue-500 px-5">Create team</button></form>}<div className="grid gap-4 md:grid-cols-2">{teams.map((team) => <article key={team.id} className="glass rounded-2xl p-5"><div className="flex justify-between"><div><h2 className="m-0">{team.name}</h2><p className="text-sm text-slate-500">{team.member_count} members · Active</p></div><Layers3 className="text-cyan-300"/></div><div className="mt-5 h-1.5 rounded-full bg-white/5"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${Math.min(100, team.member_count * 28)}%` }}/></div></article>)}</div></>;
}

function BillingSection({ plan, plans, invoices, preview, capabilities }: { plan: Dashboard["plan"]; plans: Plan[]; invoices: Invoice[]; preview: InvoicePreview | null; capabilities: Capabilities }) {
  async function checkout() {
    const result = await request<{ url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode: "pro", priceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID }) });
    window.location.assign(result.url);
  }
  const money = (amount: number, currency = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
  return <><div className="grid gap-5 xl:grid-cols-[1fr_1.5fr]"><article className="glass rounded-2xl p-6"><div className="text-xs text-blue-300">CURRENT PLAN</div><h2 className="text-3xl">{plan?.name ?? "Free"}</h2><p className="text-slate-400">Status: {plan?.status ?? "active"}</p>{preview && <div className="mt-4 rounded-xl bg-white/4 p-4"><div className="text-xs text-slate-500">NEXT INVOICE PREVIEW</div><div className="mt-1 text-xl font-semibold">{money(preview.amountDue, preview.currency)}</div><div className="text-xs text-slate-500">{preview.mode === "demo" ? "Safe sample — no card is charged" : "Stripe preview"}</div></div>}<button disabled={!capabilities.permissions.checkoutPreview} onClick={() => void checkout()} className="mt-5 w-full rounded-xl bg-blue-500 p-3 disabled:opacity-40">Preview upgrade flow</button></article>
    <article className="glass rounded-2xl p-6"><h2 className="mt-0">Invoices</h2>{invoices.length ? invoices.map((invoice) => <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/6 py-4"><span><b>{invoice.id}</b><small className="ml-2 rounded-full bg-emerald-400/10 px-2 py-1 text-emerald-300">{invoice.status}</small><div className="mt-1 text-xs text-slate-500">{new Date(invoice.stripe_event_created).toLocaleDateString()}</div></span><span className="flex items-center gap-3"><b>{money(invoice.amount_due, invoice.currency)}</b>{invoice.hosted_invoice_url && <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer" aria-label={`Open invoice ${invoice.id}`} className="text-blue-300"><ExternalLink size={16}/></a>}</span></div>) : <p className="text-slate-500">No invoices yet.</p>}</article></div>
    <section className="mt-5"><h2 className="text-lg">Plan catalog</h2><div className="grid gap-4 md:grid-cols-3">{plans.map((item) => <article key={item.code} className={`glass rounded-2xl p-5 ${item.code === plan?.code ? "border-blue-400/50" : ""}`}><div className="flex justify-between"><h3 className="m-0">{item.name}</h3>{item.code === plan?.code && <span className="text-xs text-blue-300">ACTIVE</span>}</div><div className="mt-3 text-2xl font-semibold">{item.price_cents == null ? "Custom" : item.price_cents === 0 ? "Free" : `${money(item.price_cents)}/mo`}</div><div className="mt-4 space-y-2 text-xs text-slate-400">{Object.entries(item.entitlements).slice(0, 3).map(([key, value]) => <div key={key} className="flex justify-between"><span>{key.replaceAll("_", " ")}</span><b>{value.toLocaleString()}</b></div>)}</div></article>)}</div></section></>;
}

function AdminSection({ overrides, audit, jobs, capabilities, mutate }: { overrides: Override[]; audit: Audit[]; jobs: Job[]; capabilities: Capabilities; mutate: (path: string, data: object, method?: string, success?: string) => Promise<void> }) {
  return <><ReadOnlyNotice/><div className="mb-5 grid gap-4 md:grid-cols-3"><StatusCard icon={ServerCog} label="API + worker" value="Operational"/><StatusCard icon={Database} label="Failed jobs" value={String(jobs.length)}/><StatusCard icon={ShieldCheck} label="Audit events" value={String(audit.length)}/></div><div className="grid gap-5 xl:grid-cols-2"><article className="glass rounded-2xl p-6"><h2 className="mt-0">Entitlement overrides</h2>{overrides.length ? overrides.map((item) => <div key={item.id} className="border-t border-white/6 py-4"><div className="flex justify-between"><b>{item.key.replaceAll("_", " ")}</b><span>{Number(item.value).toLocaleString()}</span></div><div className="mt-1 text-xs text-slate-500">{item.reason} · expires {new Date(item.ends_at).toLocaleDateString()}</div></div>) : <p className="text-slate-500">No active overrides.</p>}<h2 className="mt-7">Dead-letter queue</h2>{jobs.length ? jobs.map((job) => <div key={job.id} className="border-t border-white/6 py-3 text-sm"><div className="flex justify-between"><span>Job {job.id}</span>{capabilities.permissions.replayJobs && <button onClick={() => void mutate(`/admin/dlq/${job.id}/replay`, {}, "POST", "Job replayed")} className="text-blue-300">Replay</button>}</div><div className="text-xs text-red-300">{job.failedReason ?? "Awaiting inspection"}</div></div>) : <p className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 size={16}/>Queue is clear</p>}</article><article className="glass max-h-[650px] overflow-auto rounded-2xl p-6"><h2 className="mt-0">Audit log</h2>{audit.map((item) => <div key={item.id} className="border-t border-white/6 py-3"><div className="text-sm">{item.action.replaceAll(".", " ")}</div><div className="text-xs text-slate-500">{item.target_type} · {new Date(item.created_at).toLocaleString()}</div></div>)}</article></div></>;
}

function StatusCard({ icon: Icon, label, value }: { icon: typeof ServerCog; label: string; value: string }) {
  return <article className="glass rounded-2xl p-5"><Icon className="mb-4 text-emerald-300"/><div className="text-sm text-slate-500">{label}</div><b className="text-xl">{value}</b></article>;
}
