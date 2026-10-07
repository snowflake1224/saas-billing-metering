"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function Result() {
  const params = useSearchParams();
  const checkout = params.get("checkout");
  const success = checkout?.includes("success");
  const demo = checkout === "demo-success";
  return <main className="grid min-h-screen place-items-center p-6"><section className="glass max-w-lg rounded-3xl p-10 text-center"><div className={`mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full text-3xl ${success ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{success ? "✓" : "!"}</div><h1>{demo ? "Demo checkout" : success ? "Checkout complete" : "Checkout canceled"}</h1><p className="text-slate-400">{demo ? "This workspace uses sample billing data. No card was charged." : success ? "Stripe is finalizing your subscription. The verified webhook will update your workspace shortly." : "No billing changes were made."}</p><Link href="/" className="mt-5 inline-block rounded-xl bg-blue-500 px-6 py-3 font-semibold">Return to billing</Link></section></main>;
}

export default function CheckoutResultPage() {
  return <Suspense fallback={<main className="grid min-h-screen place-items-center">Loading…</main>}><Result/></Suspense>;
}
