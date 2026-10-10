"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, CreditCard, ExternalLink, Receipt, Trophy } from "lucide-react";
import { Capabilities, Dashboard, Invoice, InvoicePreview, Plan, QuotaStatus, compact, metricLabel, money, number, request } from "../lib/api";
import { Badge, Card, Stat } from "./ui";

const overageRates: Record<string, { per: number; cents: number; unit: string }> = {
  api_requests: { per: 10000, cents: 50, unit: "10k requests" },
  ai_tokens: { per: 1000000, cents: 200, unit: "1M tokens" },
  storage_gb: { per: 1, cents: 10, unit: "GB" },
  seats: { per: 1, cents: 800, unit: "seat" },
};
const sliderMax: Record<string, number> = { api_requests: 5000000, ai_tokens: 20000000, storage_gb: 500, seats: 60 };

function estimate(plan: Plan, usage: Record<string, number>) {
  if (plan.price_cents == null) return { total: null, overage: 0, lines: [] as Array<{ metric: string; units: number; cents: number }> };
  const lines = Object.entries(usage).map(([metric, units]) => {
    const included = Number(plan.entitlements[metric] ?? 0);
    const extra = Math.max(0, units - included);
    const rate = overageRates[metric];
    return { metric, units: extra, cents: rate ? Math.ceil(extra / rate.per) * rate.cents : 0 };
  }).filter((line) => line.units > 0);
  const overage = lines.reduce((sum, line) => sum + line.cents, 0);
  return { total: plan.price_cents + overage, overage, lines };
}

export function BillingSection({ plan, plans, invoices, preview, capabilities, quota }: { plan: Dashboard["plan"]; plans: Plan[]; invoices: Invoice[]; preview: InvoicePreview | null; capabilities: Capabilities; quota: QuotaStatus | null }) {
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [checkoutError, setCheckoutError] = useState("");
  useEffect(() => {
    if (!quota || Object.keys(usage).length) return;
    setUsage(Object.fromEntries(quota.metrics.map((item) => [item.metric, item.metric === "seats" ? item.used : item.projectedPeriodTotal])));
  }, [quota, usage]);

  async function checkout() {
    try {
      const result = await request<{ url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode: "pro", priceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID }) });
      window.location.assign(result.url);
    } catch (reason) {
      setCheckoutError(reason instanceof Error ? reason.message : "Checkout failed");
    }
  }

  const estimates = useMemo(() => plans.map((item) => ({ plan: item, ...estimate(item, usage) })), [plans, usage]);
  const cheapest = estimates.filter((item) => item.total != null).sort((a, b) => a.total! - b.total!)[0]?.plan.code;
  const paid = invoices.filter((invoice) => invoice.status === "paid").reduce((sum, invoice) => sum + Number(invoice.amount_paid ?? invoice.amount_due), 0);

  return <>
    <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
      <Card title="Current plan" icon={<CreditCard size={16} className="text-blue-300"/>} subtitle={plan ? `${plan.code} · version ${plan.version}` : undefined}>
        <div className="flex items-end justify-between gap-4">
          <div><div className="text-3xl font-semibold">{plan?.name ?? "Free"}</div><div className="mt-1 text-sm text-slate-400">Status <Badge tone={plan?.status === "active" ? "green" : "amber"}>{plan?.status ?? "active"}</Badge></div></div>
          <Stat label="Lifetime paid" value={money(paid)} hint={`${invoices.length} invoices`}/>
        </div>
        {preview && <div className="mt-5 rounded-xl border border-white/8 bg-white/[.03] p-4">
          <div className="flex items-center justify-between"><div className="text-[11px] uppercase tracking-wider text-slate-500">Next invoice preview</div><Badge tone={preview.mode === "demo" ? "cyan" : "blue"}>{preview.mode === "demo" ? "sample" : "stripe"}</Badge></div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{money(preview.amountDue, preview.currency)}</div>
          <table className="mt-3 w-full text-xs"><tbody>
            {preview.lines.map((line, index) => <tr key={index} className="border-t border-white/5"><td className="py-2 text-slate-400">{line.description ?? "Line item"}</td><td className="text-right tabular-nums">{money(line.amount, preview.currency)}</td></tr>)}
            <tr className="border-t border-white/10 font-semibold"><td className="py-2">Total due</td><td className="text-right tabular-nums">{money(preview.amountDue, preview.currency)}</td></tr>
          </tbody></table>
          {preview.mode === "demo" && <p className="m-0 mt-2 text-[11px] text-slate-500">Safe sample. No card is charged.</p>}
        </div>}
        <button disabled={!capabilities.permissions.checkoutPreview} onClick={() => void checkout()} className="mt-5 w-full rounded-xl bg-blue-500 p-3 font-semibold hover:bg-blue-400 disabled:opacity-40">Preview upgrade flow</button>
        {!capabilities.permissions.checkoutPreview && <p className="m-0 mt-2 text-center text-[11px] text-slate-500">Checkout needs the owner or billing role.</p>}
        {checkoutError && <p className="m-0 mt-2 text-xs text-red-300">{checkoutError}</p>}
      </Card>

      <Card title="Invoices" icon={<Receipt size={16} className="text-emerald-300"/>} subtitle="Projected from Stripe webhooks with stale-event protection">
        {invoices.length ? <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="py-2 font-medium">Invoice</th><th className="font-medium">Period</th><th className="font-medium">Status</th><th className="text-right font-medium">Amount</th><th/></tr></thead>
          <tbody>{invoices.map((invoice) => <tr key={invoice.id} className="border-t border-white/5">
            <td className="code py-3">{invoice.id}</td>
            <td className="text-slate-400">{invoice.period_start ? `${new Date(invoice.period_start).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(invoice.period_end ?? invoice.stripe_event_created).toLocaleDateString([], { month: "short", day: "numeric" })}` : new Date(invoice.stripe_event_created).toLocaleDateString()}</td>
            <td><Badge tone={invoice.status === "paid" ? "green" : "amber"}>{invoice.status}</Badge></td>
            <td className="text-right font-semibold tabular-nums">{money(Number(invoice.amount_due), invoice.currency)}</td>
            <td className="pl-3 text-right">{invoice.hosted_invoice_url && <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer" aria-label={`Open invoice ${invoice.id}`} className="text-blue-300"><ExternalLink size={14}/></a>}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm text-slate-500">No invoices yet.</p>}
      </Card>
    </div>

    <Card className="mt-5" title="What-if cost estimator" icon={<Calculator size={16} className="text-amber-300"/>}
      subtitle="Starts from this period's projected usage. Drag to model growth; overage uses illustrative per-unit rates.">
      <div className="grid gap-6 xl:grid-cols-[1fr_1.5fr]">
        <div className="space-y-5">
          {Object.keys(overageRates).map((metric) => {
            const value = usage[metric] ?? 0;
            return <label key={metric} className="block text-xs">
              <div className="mb-1 flex justify-between"><span className="text-slate-300">{metricLabel(metric)}</span><span className="tabular-nums text-white">{number(value)}</span></div>
              <input type="range" min={0} max={sliderMax[metric]} step={Math.max(1, Math.round(sliderMax[metric] / 500))} value={Math.min(value, sliderMax[metric])}
                onChange={(event) => setUsage((current) => ({ ...current, [metric]: Number(event.target.value) }))} className="w-full" aria-label={`${metricLabel(metric)} per month`}/>
              <div className="text-[10px] text-slate-500">Overage {money(overageRates[metric].cents)} per {overageRates[metric].unit}</div>
            </label>;
          })}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {estimates.map((item) => {
            const best = item.plan.code === cheapest;
            const current = item.plan.code === plan?.code;
            return <article key={item.plan.code} className={`relative rounded-2xl border p-4 ${best ? "border-emerald-400/50 bg-emerald-500/[.06]" : current ? "border-blue-400/40 bg-blue-500/[.04]" : "border-white/8 bg-white/[.02]"}`}>
              <div className="flex items-center justify-between gap-2"><h3 className="m-0 text-sm">{item.plan.name}</h3>{best ? <Badge tone="green"><Trophy size={11}/>best fit</Badge> : current ? <Badge tone="blue">current</Badge> : null}</div>
              <div className="mt-3 text-2xl font-semibold tabular-nums">{item.total == null ? "Custom" : money(item.total)}</div>
              <div className="text-[11px] text-slate-500">{item.plan.price_cents == null ? "Contract pricing" : `${money(item.plan.price_cents)} base + ${money(item.overage)} overage`}</div>
              <div className="mt-3 space-y-1.5 border-t border-white/6 pt-3 text-[11px]">
                {Object.entries(item.plan.entitlements).map(([metric, limit]) => {
                  const over = (usage[metric] ?? 0) > limit;
                  return <div key={metric} className="flex justify-between gap-2"><span className="text-slate-400">{metricLabel(metric)}</span><span className={`tabular-nums ${over ? "text-amber-300" : "text-slate-300"}`}>{compact(limit)}{over ? " ▲" : ""}</span></div>;
                })}
              </div>
              {item.lines.length > 0 && <div className="mt-2 space-y-1 text-[10px] text-amber-200/80">{item.lines.map((line) => <div key={line.metric}>+{compact(line.units)} {metricLabel(line.metric).toLowerCase()} → {money(line.cents)}</div>)}</div>}
            </article>;
          })}
        </div>
      </div>
    </Card>
  </>;
}
