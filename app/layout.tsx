import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Clock from "@/components/Clock";
import { EXECUTION_BAR_SECONDS, EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DTS — Gold Signals",
  description: "Signal-only gold trading system: trend entries on the 1-hour chart and Fibonacci retracements on the 15-minute chart, with the daily trend",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="flex min-h-full flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-neutral-800 bg-neutral-950 px-4 py-2.5">
          <span className="text-sm font-bold tracking-wide text-neutral-100">
            DTS <span className="font-normal text-neutral-500">· gold signals</span>
          </span>
          <nav className="flex gap-4 text-sm text-neutral-400">
            <Link href="/" className="hover:text-neutral-100">Dashboard</Link>
            <Link href="/backtests" className="hover:text-neutral-100">Backtests</Link>
            <Link href="/login" className="hover:text-neutral-100">Login</Link>
          </nav>
          <Clock barSeconds={EXECUTION_BAR_SECONDS} timeframe={EXECUTION_TIMEFRAME} />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
