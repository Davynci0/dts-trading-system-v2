"use client";

import { useCallback, useEffect, useState } from "react";
import type { MetricsCore, ScopedMetrics } from "@/lib/backtest/metrics";

interface RunRow {
  id: string;
  created_at: string;
  range_start: string | null;
  range_end: string | null;
  pairs: string[];
  timeframes: string[];
  notes: string | null;
  config?: { years?: number; recentYears?: number } | null;
}
interface ResultRow {
  scope: string;
  metrics: ScopedMetrics;
}
type Segment = keyof ScopedMetrics;

const fmt = {
  pct: (n: number) => `${(n * 100).toFixed(0)}%`,
  r: (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}R`,
  pf: (n: number) => (n >= 999.99 ? "∞" : n.toFixed(2)),
  day: (iso: string | null) => (iso ? iso.slice(0, 10) : "?"),
  /** local date and time a run was made, e.g. "20 Nov, 14:04" */
  stamp: (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "?"),
};

const scopeLabel = (scope: string) => scope.replace(/^(strategy|entry|pair|year|grade):/, "").replace("_", "/");

/** Colour by sign only when the average is statistically distinguishable from zero. */
function verdict(m: MetricsCore): string {
  if (m.trades === 0 || Math.abs(m.tStat ?? 0) < 2) return "text-neutral-300";
  return m.avgR > 0 ? "text-emerald-400" : "text-rose-400";
}

function MetricTable({ rows, segment }: { rows: ResultRow[]; segment: Segment }) {
  // the confirmation-count columns only mean something for the 6-point pullback strategies
  const counts = rows.some((r) => (r.metrics[segment]?.confidence4 ?? 0) > 0);
  const cols = ["", "Trades", "Win rate", "Profit factor", "Avg R", "Total R", "t", "Max DD", ...(counts ? ["4/6", "5–6/6"] : [])];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-neutral-800 text-neutral-500">
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-4 py-2 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const m = r.metrics[segment];
            if (!m) return null;
            return (
              <tr key={r.scope} className="border-b border-neutral-900 text-neutral-300">
                <td className="whitespace-nowrap px-4 py-2 font-mono">{scopeLabel(r.scope)}</td>
                <td className="px-4 py-2">{m.trades}</td>
                <td className="px-4 py-2">{m.trades ? fmt.pct(m.winRate) : "—"}</td>
                <td className="px-4 py-2">{m.trades ? fmt.pf(m.profitFactor) : "—"}</td>
                <td className={`px-4 py-2 ${verdict(m)}`}>{m.trades ? fmt.r(m.avgR, 3) : "—"}</td>
                <td className={`px-4 py-2 ${verdict(m)}`}>{m.trades ? fmt.r(m.totalR ?? m.avgR * m.trades, 1) : "—"}</td>
                <td className="px-4 py-2">{m.trades ? (m.tStat ?? 0).toFixed(1) : "—"}</td>
                <td className="px-4 py-2">{m.trades ? `${m.maxDrawdownR.toFixed(1)}R` : "—"}</td>
                {counts && <td className="px-4 py-2">{m.confidence4}</td>}
                {counts && <td className="px-4 py-2">{m.confidence5}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Backtest results: stored runs of the three strategies that send live
 * signals, side by side — five years, with the first two and the last three
 * next to it.
 */
export default function BacktestsPage() {
  const [run, setRun] = useState<RunRow | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback((id?: string) => {
    return fetch(`/api/backtests/latest${id ? `?run=${id}` : ""}`)
      .then((r) => r.json())
      .then((j) => {
        setRun(j.run ?? null);
        setRuns(j.runs ?? []);
        setResults(j.results ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runBacktest() {
    setRunning(true);
    setStatus("running the quick backtest on the last six months (up to a minute)…");
    try {
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setStatus(json.runId ? "quick run complete" : "quick run complete — not saved (database unavailable)");
      await load(json.runId ?? undefined);
    } catch (e) {
      setStatus(`backtest failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  const rowsOf = (prefix: string) => results.filter((r) => r.scope.startsWith(prefix)).sort((a, b) => a.scope.localeCompare(b.scope));
  const sections: [string, ResultRow[], boolean][] = [
    ["Combined", results.filter((r) => r.scope === "combined"), true],
    ["Per year", rowsOf("year:"), false],
    ["By strategy", rowsOf("strategy:"), true],
    ["By entry", rowsOf("entry:"), true],
    ["By key level", rowsOf("grade:"), true],
    ["Buys and sells", rowsOf("pair:"), true],
  ];
  const hasAll = results.some((r) => r.metrics.all);
  // the five-year run splits at its last three years; the quick run at its last 30%
  const years = run?.config?.years ?? null;
  const recent = run?.config?.recentYears ?? null;
  const wholeLabel = years ? `All ${years} years` : "Whole run";
  const firstLabel = years && recent ? `First ${years - recent} years` : "First 70%";
  const lastLabel = years && recent ? `Last ${recent} years` : "Last 30%";

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Backtest Results</h1>
          <p className="mt-1 max-w-3xl text-xs text-neutral-500">
            The three strategies — the trend scalp (15-minute chart), supply and demand (30-minute zones) and the
            trendline strategy (1-hour chart) — replayed side by side on five years of gold with the scanner&apos;s own detection:
            each holds one trade at a time and none is taken against another&apos;s open trade. A signal on a closed
            candle fills at the next 15-minute open, the full spread + slippage is charged once, and a candle that
            touches both the stop and the target counts as a loss.
          </p>
        </div>
        <button
          onClick={runBacktest}
          disabled={running}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {running ? "Running…" : "Quick run (last 6 months)"}
        </button>
      </div>

      {status && <p className="font-mono text-xs text-neutral-400">{status}</p>}

      {runs.length > 0 && run && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
          <label htmlFor="run" className="text-neutral-500">Run</label>
          <select
            id="run"
            value={run.id}
            onChange={(e) => void load(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-neutral-100"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmt.stamp(r.created_at)} · {r.notes ?? `${r.pairs.length} pairs`}
              </option>
            ))}
          </select>
          <span>
            {run.range_start ? `${fmt.day(run.range_start)} → ${fmt.day(run.range_end)} · ` : ""}
            {run.pairs.map((p) => p.replace("_", "/")).join(", ")}
          </span>
        </div>
      )}

      {results.length === 0 ? (
        <p className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-10 text-center text-sm text-neutral-600">
          No stored runs. Use “Quick run”, or store a multi-year run with{" "}
          <code className="text-neutral-400">npx tsx --env-file=.env.local scripts/backtest.ts --save</code>.
        </p>
      ) : (
        <>
          {sections.map(([title, rows, split]) =>
            rows.length === 0 ? null : (
              <section key={title} className="rounded-lg border border-neutral-800 bg-neutral-900">
                <h2 className="border-b border-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-200">{title}</h2>
                {hasAll && (
                  <div>
                    {split && <h3 className="px-4 pt-3 text-xs font-medium text-neutral-500">{wholeLabel}</h3>}
                    <MetricTable rows={rows} segment="all" />
                  </div>
                )}
                {split && (
                  <div className="grid gap-0 xl:grid-cols-2">
                    <div>
                      <h3 className="px-4 pt-3 text-xs font-medium text-neutral-500">{firstLabel}</h3>
                      <MetricTable rows={rows} segment="inSample" />
                    </div>
                    <div>
                      <h3 className="px-4 pt-3 text-xs font-medium text-neutral-500">{lastLabel}</h3>
                      <MetricTable rows={rows} segment="outOfSample" />
                    </div>
                  </div>
                )}
              </section>
            )
          )}
          <p className="text-xs text-neutral-600">
            R is the risk of one trade: the distance from its entry to its stop.
          </p>
        </>
      )}
    </div>
  );
}
