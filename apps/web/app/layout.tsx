import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fluxbill — Usage Operations Cloud",
  description: "A live multi-tenant SaaS billing and usage-metering demonstration.",
};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
