"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle, BarChart3, CheckCircle2, Code2, CreditCard, Gauge, Layers3, ListTree, LockKeyhole, LogOut, Menu, RefreshCw,
  ShieldCheck, Users, Workflow, X,
} from "lucide-react";
import {
  Audit, Capabilities, Dashboard, Health, Invoice, InvoicePreview, Job, Member, Org, Override, Pipeline, Plan, QuotaStatus, SESSION_EXPIRED_EVENT,
  SessionExpiredError, Team, relative, request, usePoll,
} from "./lib/api";
import { LivePulse, Select } from "./components/ui";
import { OverviewSection, UsageSection } from "./components/usage";
import { EventsSection } from "./components/events";
import { PipelineSection } from "./components/pipeline";
import { PlaygroundSection } from "./components/playground";
import { BillingSection } from "./components/billing";
import { AdminSection, MembersSection, TeamsSection } from "./components/admin";

const sections = ["Overview", "Usage", "Events", "Pipeline", "API", "Members", "Teams", "Billing", "Admin"] as const;
type Section = typeof sections[number];
const navGroups: Array<{ label: string; items: Section[] }> = [
  { label: "Observe", items: ["Overview", "Usage", "Events", "Pipeline", "API"] },
  { label: "Workspace", items: ["Members", "Teams", "Billing"] },
  { label: "Operate", items: ["Admin"] },
];
const navIcons = { Overview: Gauge, Usage: BarChart3, Events: ListTree, Pipeline: Workflow, API: Code2, Members: Users, Teams: Layers3, Billing: CreditCard, Admin: ShieldCheck };
const descriptions: Record<Section, string> = {
  Overview: "Quota posture, live ingestion and system health for this tenant.",
  Usage: "Time-series analytics, budget forecasting and a live event simulator.",
  Events: "Every raw usage event and where it is in the pipeline.",
  Pipeline: "Ingest → reserve → outbox → queue → aggregate, with live counters.",
  API: "Call the real API, inspect responses and copy reproducible curl commands.",
  Members: "Seat usage and role-based access control.",
  Teams: "Tenant-scoped teams and membership.",
  Billing: "Plan, invoices and a what-if cost model across the catalog.",
  Admin: "Overrides, dead letters and the immutable audit trail.",
};

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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const quota = usePoll(() => (token ? request<QuotaStatus>("/quota/status") : Promise.resolve(null)), [token, activeOrg, refreshKey], 10000);
  const pipeline = usePoll(() => (token ? request<Pipeline>("/ops/pipeline") : Promise.resolve(null)), [token, activeOrg, refreshKey], 5000);
  const health = usePoll(() => (token ? request<Health>("/health") : Promise.resolve(null)), [token], 15000);

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
      setActiveOrg(dashboardData.organizationId ?? organizationData[0]?.id ?? "");
      const isAdmin = ["owner", "admin"].includes(capabilityData.role);
      const results = await Promise.all([
        request<Member[]>("/members"),
        request<Team[]>("/teams"),
        request<Invoice[]>("/billing/invoices"),
        request<Plan[]>("/plans"),
        request<InvoicePreview>("/billing/invoice-preview").catch(() => null),
        isAdmin ? request<Override[]>("/admin/overrides") : Promise.resolve([]),
        isAdmin ? request<Audit[]>("/admin/audit") : Promise.resolve([]),
        isAdmin ? request<Job[]>("/admin/dlq").catch(() => []) : Promise.resolve([]),
      ]);
      setMembers(results[0]); setTeams(results[1]); setInvoices(results[2]); setPlans(results[3]);
      setPreview(results[4]); setOverrides(results[5]); setAudit(results[6]); setJobs(results[7]);
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

  useEffect(() => {
    const expired = () => signOutLocally("Your session expired. Sign in again.");
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, [signOutLocally]);

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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to switch organization");
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
      setRefreshKey((key) => key + 1);
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

  function refreshAll() {
    void load(true);
    setRefreshKey((key) => key + 1);
  }

  if (!token) return <Login onSubmit={login} error={error} pending={action === "login"} />;

  const isAdmin = ["owner", "admin"].includes(capabilities?.role ?? "member");
  const activeSection: Section = section === "Admin" && capabilities && !isAdmin ? "Overview" : section;
  const org = orgs.find((item) => item.id === activeOrg);
  const metrics = Object.keys(dashboard.plan?.entitlements ?? {});
  const healthy = health.data?.status === "ok";
  const onSent = () => setRefreshKey((key) => key + 1);

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <button className="fixed right-4 top-4 z-40 rounded-xl border border-white/10 bg-slate-900 p-2 lg:hidden" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? "Close navigation" : "Open navigation"}>
        {menuOpen ? <X /> : <Menu />}
      </button>
      <aside className={`${menuOpen ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 z-30 flex w-[260px] flex-col overflow-y-auto border-r border-white/8 bg-[#090e18]/98 p-5 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0`}>
        <div className="mb-6 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 font-black">F3</div>
          <div><b>Fluxbill</b><div className="text-xs text-slate-500">Usage operations cloud</div></div>
        </div>
        {capabilities?.protectedDemo && <div className="mb-5 rounded-xl border border-cyan-400/20 bg-cyan-400/8 p-3 text-xs text-cyan-100"><LockKeyhole className="mb-2" size={16}/><b>Protected public demo</b><div className="mt-1 text-cyan-200/70">Explore live data and simulate usage. Shared records are read-only.</div></div>}
        <div className="mb-6">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Organization</div>
          <Select label="Organization" value={activeOrg} disabled={action === "switch-org"} onChange={(id) => void switchOrg(id)}
            options={orgs.map((item) => ({ value: item.id, label: `${item.name} · ${item.role}`, hint: item.slug }))} placeholder="Select workspace"/>
        </div>
        <nav className="space-y-5" aria-label="Workspace navigation">
          {navGroups.map((group) => {
            const items = group.items.filter((item) => item !== "Admin" || isAdmin);
            if (!items.length) return null;
            return <div key={group.label}>
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">{group.label}</div>
              <div className="space-y-0.5">{items.map((name) => {
                const Icon = navIcons[name];
                return <button key={name} onClick={() => navigate(name)} aria-current={activeSection === name ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${activeSection === name ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><Icon size={16}/>{name}</button>;
              })}</div>
            </div>;
          })}
        </nav>
        <div className="mt-auto pt-6">
          <div className="mb-4 rounded-xl border border-white/8 bg-white/[.02] p-3 text-[11px]">
            <div className="mb-2 flex items-center justify-between"><span className="text-slate-500">System</span><LivePulse label={health.data ? (healthy ? "Operational" : "Degraded") : "Checking"} stale={!healthy}/></div>
            {[["API", Boolean(health.data)], ["Postgres", health.data?.dependencies.postgres], ["Redis", health.data?.dependencies.redis], ["BullMQ", pipeline.data?.queue.available]].map(([name, ok]) => <div key={String(name)} className="flex items-center justify-between py-0.5">
              <span className="text-slate-400">{String(name)}</span><span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : ok === false ? "bg-red-400" : "bg-slate-600"}`}/>
            </div>)}
          </div>
          <button onClick={() => void logout()} className="flex items-center gap-3 px-3 text-sm text-slate-500 hover:text-white"><LogOut size={16}/> Sign out</button>
        </div>
      </aside>
      <section className="min-w-0 p-5 pt-20 lg:p-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-sm text-slate-500">{org?.name ?? "Workspace"} / {activeSection}</div>
            <div className="mt-1 flex items-center gap-3"><h1 className="m-0 text-3xl font-semibold">{activeSection}</h1>{loading && <span className="text-xs text-blue-300">Refreshing…</span>}</div>
            <p className="m-0 mt-1 text-sm text-slate-500">{descriptions[activeSection]}</p>
          </div>
          <div className="flex items-center gap-3">
            <LivePulse label={pipeline.updatedAt ? `Live · ${relative(pipeline.updatedAt)}` : "Connecting"} stale={!pipeline.updatedAt}/>
            <button onClick={refreshAll} aria-label="Refresh data" className="rounded-xl border border-white/10 bg-[#0d1424] p-2 text-slate-400 hover:text-white"><RefreshCw size={15} className={loading ? "animate-spin" : ""}/></button>
          </div>
        </header>
        <div aria-live="polite">
          {error && <div className="mb-5 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200"><AlertTriangle size={16}/>{error}</div>}
          {notice && <div className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"><CheckCircle2 size={16}/>{notice}</div>}
        </div>
        {loading && !capabilities ? <DashboardSkeleton /> : capabilities && <div key={activeOrg}>
          {activeSection === "Overview" && <OverviewSection quota={quota.data} pipeline={pipeline.data} health={health.data} onSent={onSent} canSimulate={capabilities.permissions.simulateUsage} orgName={org?.name ?? "—"} orgId={activeOrg} role={capabilities.role}/>}
          {activeSection === "Usage" && <UsageSection quota={quota.data} onSent={onSent} canSimulate={capabilities.permissions.simulateUsage}/>}
          {activeSection === "Events" && <EventsSection metrics={metrics}/>}
          {activeSection === "Pipeline" && <PipelineSection pipeline={pipeline.data} health={health.data}/>}
          {activeSection === "API" && <PlaygroundSection isAdmin={isAdmin}/>}
          {activeSection === "Members" && <MembersSection members={members} capabilities={capabilities} mutate={mutate} seatLimit={Number(dashboard.plan?.entitlements.seats ?? 0)}/>}
          {activeSection === "Teams" && <TeamsSection teams={teams} capabilities={capabilities} mutate={mutate}/>}
          {activeSection === "Billing" && <BillingSection plan={dashboard.plan} plans={plans} invoices={invoices} preview={preview} capabilities={capabilities} quota={quota.data}/>}
          {activeSection === "Admin" && <AdminSection overrides={overrides} audit={audit} jobs={jobs} capabilities={capabilities} mutate={mutate} health={health.data} pipeline={pipeline.data} members={members}/>}
        </div>}
      </section>
    </main>
  );
}

function Login({ onSubmit, error, pending }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string; pending: boolean }) {
  return <main className="grid min-h-screen place-items-center p-6">
    <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between bg-gradient-to-br from-blue-600/25 via-[#0b1222] to-cyan-500/10 p-8 lg:flex">
        <div>
          <div className="mb-6 text-xs font-semibold tracking-wider text-cyan-300">USAGE-BASED BILLING INFRASTRUCTURE</div>
          <h2 className="m-0 text-2xl font-semibold leading-snug">Meter, enforce and bill every API call. Then watch it move through the pipeline.</h2>
        </div>
        <ul className="code m-0 list-none space-y-2 p-0 text-xs text-slate-300">
          {["POST /usage/events  → zod + idempotency", "redis EVAL reserve  → atomic quota", "postgres outbox     → no lost events", "bullmq worker       → dedupe + aggregate", "row-level security  → tenant isolation"].map((line) => <li key={line} className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>{line}</li>)}
        </ul>
      </section>
      <form onSubmit={onSubmit} className="glass p-8">
        <div className="mb-7 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-blue-500 font-black">F3</div><div><h1 className="m-0 text-xl font-semibold">Welcome to Fluxbill</h1><p className="m-0 text-sm text-slate-500">Explore a protected, live metering workspace.</p></div></div>
        {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        <label className="mb-3 block text-sm text-slate-300">Email<input name="email" type="email" required defaultValue="demo@fb3.local" className="mt-1 w-full rounded-xl border border-white/10 bg-[#0d1424] p-3" autoComplete="username"/></label>
        <label className="mb-5 block text-sm text-slate-300">Password<input name="password" type="password" required defaultValue="DemoPass123!" className="mt-1 w-full rounded-xl border border-white/10 bg-[#0d1424] p-3" autoComplete="current-password"/></label>
        <button disabled={pending} className="w-full rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400 disabled:opacity-60">{pending ? "Signing in…" : "Enter demo workspace"}</button>
        <p className="mt-4 text-center text-xs text-slate-500">Public credentials access sample data only. Destructive actions are disabled.</p>
      </form>
    </div>
  </main>;
}

function DashboardSkeleton() {
  return <div aria-label="Loading workspace" className="grid animate-pulse gap-4 md:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="glass h-36 rounded-2xl"/>)}</div>;
}
