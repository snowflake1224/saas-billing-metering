"use client";

import { CreditCard } from "lucide-react";
import { Dashboard, compact, metricLabel, money, number } from "../lib/api";
import { Card } from "./ui";

export function BillingSection({ dashboard }: { dashboard: Dashboard }) {
  const plan = dashboard.plan;
  const used = Object.fromEntries(dashboard.usage.map((row) => [row.metric, Number(row.used)]));
  const metrics = Object.keys(plan?.entitlements ?? {}).filter((metric) => metric !== "seats");
  return <Card title="This month" icon={<CreditCard size={16} className="text-blue-300"/>}
    subtitle={`${plan?.name ?? "Free"} plan${plan?.price_cents != null ? ` · ${money(plan.price_cents)} / month` : ""}. Totals are the sum of this month's hourly buckets.`}>
    <table className="w-full text-left text-sm">
      <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="py-2 font-medium">Metric</th><th className="text-right font-medium">Used</th><th className="text-right font-medium">Included</th></tr></thead>
      <tbody>{metrics.map((metric) => <tr key={metric} className="border-t border-white/5">
        <td className="py-3">{metricLabel(metric)}</td>
        <td className="text-right font-semibold tabular-nums">{number(used[metric] ?? 0)}</td>
        <td className="text-right tabular-nums text-slate-400">{compact(Number(plan?.entitlements[metric] ?? 0))}</td>
      </tr>)}</tbody>
    </table>
  </Card>;
}
