"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, BarChart3, CreditCard, ListTree, LockKeyhole, LogOut, Menu, RefreshCw, X } from "lucide-react";
import { Capabilities, Dashboard, Health, Org, QuotaStatus, SESSION_EXPIRED_EVENT, SessionExpiredError, relative, request, usePoll } from "./lib/api";
import { LivePulse, Select } from "./components/ui";
import { UsageSection } from "./components/usage";
import { EventsSection } from "./components/events";
import { BillingSection } from "./components/billing";

const sections = ["Usage", "Events", "Billing"] as const;
type Section = typeof sections[number];
const navIcons = { Usage: BarChart3, Events: ListTree, Billing: CreditCard };
const descriptions: Record<Section, string> = {
  Usage: "This month's totals, hourly usage, and a way to send or replay an event.",
  Events: "Every stored usage event and the hourly bucket it landed in.",
  Billing: "Month-to-date totals from the hourly buckets against the plan.",
};

export default function DashboardApp() {
  const params = useSearchParams();
  const router = useRouter();
  const requestedSection = params.get("section");
  const initialSection = sections.find((item) => item.toLowerCase() === requestedSection?.toLowerCase()) ?? "Usage";
  const [token, setToken] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(initialSection);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard>({ usage: [] });
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const quota = usePoll(() => (token ? request<QuotaStatus>("/quota/status") : Promise.resolve(null)), [token, activeOrg, refreshKey], 10000);
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
        <nav className="space-y-0.5" aria-label="Workspace navigation">
          {sections.map((name) => {
            const Icon = navIcons[name];
            return <button key={name} onClick={() => navigate(name)} aria-current={section === name ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${section === name ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><Icon size={16}/>{name}</button>;
          })}
        </nav>
        <div className="mt-auto pt-6">
          <div className="mb-4 rounded-xl border border-white/8 bg-white/[.02] p-3 text-[11px]">
            <div className="mb-2 flex items-center justify-between"><span className="text-slate-500">System</span><LivePulse label={health.data ? (healthy ? "Operational" : "Degraded") : "Checking"} stale={!healthy}/></div>
            {[["API", Boolean(health.data)], ["Postgres", health.data?.dependencies.postgres], ["Redis", health.data?.dependencies.redis]].map(([name, ok]) => <div key={String(name)} className="flex items-center justify-between py-0.5">
              <span className="text-slate-400">{String(name)}</span><span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : ok === false ? "bg-red-400" : "bg-slate-600"}`}/>
            </div>)}
          </div>
          <button onClick={() => void logout()} className="flex items-center gap-3 px-3 text-sm text-slate-500 hover:text-white"><LogOut size={16}/> Sign out</button>
        </div>
      </aside>
      <section className="min-w-0 p-5 pt-20 lg:p-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-sm text-slate-500">{org?.name ?? "Workspace"} / {section}</div>
            <div className="mt-1 flex items-center gap-3"><h1 className="m-0 text-3xl font-semibold">{section}</h1>{loading && <span className="text-xs text-blue-300">Refreshing…</span>}</div>
            <p className="m-0 mt-1 text-sm text-slate-500">{descriptions[section]}</p>
          </div>
          <div className="flex items-center gap-3">
            <LivePulse label={quota.updatedAt ? `Live · ${relative(quota.updatedAt)}` : "Connecting"} stale={!quota.updatedAt}/>
            <button onClick={refreshAll} aria-label="Refresh data" className="rounded-xl border border-white/10 bg-[#0d1424] p-2 text-slate-400 hover:text-white"><RefreshCw size={15} className={loading ? "animate-spin" : ""}/></button>
          </div>
        </header>
        <div aria-live="polite">
          {error && <div className="mb-5 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200"><AlertTriangle size={16}/>{error}</div>}
        </div>
        {loading && !capabilities ? <DashboardSkeleton /> : capabilities && <div key={activeOrg}>
          {section === "Usage" && <UsageSection quota={quota.data} onSent={onSent} canSimulate={capabilities.permissions.simulateUsage}/>}
          {section === "Events" && <EventsSection metrics={metrics}/>}
          {section === "Billing" && <BillingSection dashboard={dashboard}/>}
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
          <div className="mb-6 text-xs font-semibold tracking-wider text-cyan-300">USAGE METERING</div>
          <h2 className="m-0 text-2xl font-semibold leading-snug">Send the same usage event twice. The total only counts it once.</h2>
        </div>
        <ul className="code m-0 list-none space-y-2 p-0 text-xs text-slate-300">
          {["POST /usage/events  → idempotency key", "store the event     → once per key", "hourly total        → sum of events", "dashboard           → shows the total"].map((line) => <li key={line} className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>{line}</li>)}
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
