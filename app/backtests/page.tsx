"use client";

import { useEffect, useState } from "react";
import { STRATEGIES } from "@/lib/types";
import type { MetricsCore, ScopedMetrics } from "@/lib/backtest/engine";

interface RunRow {
  id: string;
  created_at: string;
  pairs: string[];
  timeframes: string[];
  notes: string | null;
}
interface ResultRow {
  scope: string;
  metrics: ScopedMetrics;
}

const fmt = {
  pct: (n: number) => `${(n * 100).toFixed(1)}%`,
  r: (n: number) => `${n.toFixed(2)}R`,
  pf: (n: number) => (n >= 999.99 ? "∞" : n.toFixed(2)),
};

function MetricTable({ rows, segment }: { rows: ResultRow[]; segment: keyof ScopedMetrics }) {
  const cols = ["Scope", "Trades", "Win rate", "Profit factor", "Avg R", "Max DD", "3 of 4", "4 of 4"];
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-neutral-800 text-neutral-500">
          {cols.map((c) => (
            <th key={c} className="px-4 py-2 font-medium">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const m: MetricsCore = r.metrics[segment];
          return (
            <tr key={r.scope} className="border-b border-neutral-900 text-neutral-300">
              <td className="px-4 py-2 font-mono">{r.scope}</td>
              <td className="px-4 py-2">{m.trades}</td>
              <td className="px-4 py-2">{fmt.pct(m.winRate)}</td>
              <td className="px-4 py-2">{fmt.pf(m.profitFactor)}</td>
              <td className="px-4 py-2">{fmt.r(m.avgR)}</td>
              <td className="px-4 py-2">{fmt.r(m.maxDrawdownR)}</td>
              <td className="px-4 py-2">{m.confidence3}</td>
              <td className="px-4 py-2">{m.confidence4}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Backtest results view (Section 7): combined + per-strategy + per-pair
 * metrics from the latest run, with in-sample and walk-forward
 * out-of-sample segments and the vision-AI limitation noted.
 */
export default function BacktestsPage() {
  const [run, setRun] = useState<RunRow | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/backtests/latest")
      .then((r) => r.json())
      .then((j) => {
        setRun(j.run);
        setResults(j.results ?? []);
      })
      .catch(() => undefined);
  }, []);

  async function runBacktest() {
    setRunning(true);
    setStatus("running backtest (this can take a minute)…");
    try {
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: ["XAU_USD"], timeframe: "M15", count: 2000 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setStatus(`run complete — id ${json.runId ?? "not persisted"}`);
      const latest = await fetch("/api/backtests/latest").then((r) => r.json());
      setRun(latest.run);
      setResults(latest.results ?? []);
    } catch (e) {
      setStatus(`backtest failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  const strategyRows = results.filter((r) => r.scope.startsWith("strategy:"));
  const pairRows = results.filter((r) => r.scope.startsWith("pair:"));
  const combinedRows = results.filter((r) => r.scope === "combined");

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Backtest Results</h1>
          <p className="mt-1 max-w-2xl text-xs text-neutral-500">
            Historical scoring uses the 4 non-AI confirmations only (threshold 3) — the vision
            model cannot be queried retroactively. Realistic fill model: half-spread + slippage,
            conservative same-candle SL-first. No optimization toward any target win rate.
          </p>
        </div>
        <button
          onClick={runBacktest}
          disabled={running}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {running ? "Running…" : "Run backtest"}
        </button>
      </div>

      {status && <p className="font-mono text-xs text-neutral-400">{status}</p>}
      {run && (
        <p className="text-xs text-neutral-500">
          Latest run: {new Date(run.created_at).toLocaleString()} · pairs {run.pairs.join(", ")} ·{" "}
          {run.timeframes.join(", ")}
          {run.notes ? ` · ${run.notes}` : ""}
        </p>
      )}

      {results.length === 0 ? (
        <p className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-10 text-center text-sm text-neutral-600">
          No runs yet — click “Run backtest”.
        </p>
      ) : (
        <>
          {([
            ["combined", combinedRows],
            ["per strategy", strategyRows],
            ["per pair", pairRows],
          ] as const).map(([title, rows]) =>
            rows.length === 0 ? null : (
              <section key={title} className="rounded-lg border border-neutral-800 bg-neutral-900">
                <h2 className="border-b border-neutral-800 px-4 py-3 text-sm font-semibold capitalize text-neutral-200">
                  {title}
                </h2>
                <div className="grid gap-0 lg:grid-cols-2">
                  <div>
                    <h3 className="px-4 pt-3 text-xs font-medium text-neutral-500">In-sample (70%)</h3>
                    <MetricTable rows={rows} segment="inSample" />
                  </div>
                  <div>
                    <h3 className="px-4 pt-3 text-xs font-medium text-neutral-500">
                      Walk-forward out-of-sample (30%)
                    </h3>
                    <MetricTable rows={rows} segment="outOfSample" />
                  </div>
                </div>
              </section>
            )
          )}
          <p className="text-xs text-neutral-600">
            Strategies: {STRATEGIES.map((s) => s.label).join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}
