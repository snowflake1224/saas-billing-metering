import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "FB-3 Metering", description: "Usage-based billing operations" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
