import { Suspense } from "react";
import DashboardApp from "./dashboard";

export default function DashboardPage() {
  return <Suspense fallback={<main className="grid min-h-screen place-items-center text-slate-400">Loading Fluxbill…</main>}><DashboardApp/></Suspense>;
}
