"use client";

import { useEffect, useState } from "react";
import { FIB_STRATEGY, LIVE_STRATEGIES, TREND_STRATEGY, type Signal } from "@/lib/types";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const px = (n: number) => n.toFixed(2);
const signedR = (r: number | null) => (r == null ? "" : `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`);

const strategyName = (strategy: string) => (strategy === FIB_STRATEGY ? "Fibonacci" : strategy === TREND_STRATEGY ? "Trend" : `${strategy} (removed strategy)`);

/** Closed trades of the live strategies: how many, how many won, and the total in R. */
function record(signals: Signal[]) {
  const closed = signals.filter((s) => LIVE_STRATEGIES.includes(s.strategy) && s.outcome != null && s.outcome_r != null);
  if (closed.length === 0) return null;
  const won = closed.filter((s) => (s.outcome_r ?? 0) > 0).length;
  const total = closed.reduce((sum, s) => sum + (s.outcome_r ?? 0), 0);
  return { closed: closed.length, won, total };
}

/**
 * Signal feed. Reads the signals written by the scanner via /api/signals
 * (service role server-side; the anon key never sees them). Signals from the
 * strategies that were removed stay in the list, marked as such, until they
 * drop off the end.
 */
export default function SignalFeed() {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/signals")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) setError(j.error);
          else setSignals((j.signals ?? []) as Signal[]);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const stats = signals ? record(signals) : null;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Signal feed</h2>
        {stats && (
          <span className="text-[10px] text-neutral-400">
            {stats.won}/{stats.closed} won · {signedR(stats.total)}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-amber-400">{error}</p>}
      {!error && signals?.length === 0 && <p className="text-xs text-neutral-500">No signals yet.</p>}
      <ul className="space-y-2">
        {signals?.map((s) => {
          const live = LIVE_STRATEGIES.includes(s.strategy);
          const hasLevels = s.stop_loss > 0;
          const risk = Math.abs(s.entry - s.stop_loss);
          return (
            <li key={s.id} className={`rounded border border-neutral-800 bg-neutral-950 p-2 text-xs ${live ? "" : "opacity-60"}`}>
              <div className="flex justify-between gap-2">
                <span className="font-medium text-neutral-200">
                  {s.pair.replace("_", "/")}{" "}
                  <span className={s.direction === "long" ? "text-teal-400" : "text-red-400"}>{s.direction === "long" ? "BUY" : "SELL"}</span>
                </span>
                <span className="text-right text-neutral-500">
                  {fmtTime(s.created_at)} · {strategyName(s.strategy)}
                </span>
              </div>
              {hasLevels && (
                <div className="mt-1 font-mono text-neutral-400">
                  E {px(s.entry)} · SL {px(s.stop_loss)}
                  {s.take_profit > 0 ? ` · TP ${px(s.take_profit)}` : ""}
                  {s.r_multiple != null && ` · ${s.r_multiple.toFixed(1)}R`}
                  {s.trail_distance != null && !s.outcome && s.trail_stop != null && ` · stop now ${px(s.trail_stop)}`}
                </div>
              )}
              {hasLevels && s.take_profit > 0 && (
                <div className="mt-0.5 text-neutral-300">
                  Risk ${px(risk)} per ounce → make ${px(Math.abs(s.take_profit - s.entry))}
                </div>
              )}
              {(s.sl_basis || s.tp_basis) && (
                <div className="mt-0.5 text-neutral-500">
                  Stop {s.sl_basis ?? "—"} · target {s.tp_basis ?? "—"}
                </div>
              )}
              {s.outcome ? (
                <div className={`mt-1 font-medium ${(s.outcome_r ?? 0) > 0 ? "text-teal-400" : (s.outcome_r ?? 0) < 0 ? "text-red-400" : "text-neutral-500"}`}>
                  ↳ {s.outcome === "win" ? "Closed in profit" : s.outcome === "loss" ? "Stopped out" : "Closed at the time limit"}
                  {s.outcome_price != null ? ` at ${px(s.outcome_price)}` : ""} · {signedR(s.outcome_r)}
                  {s.outcome_at && ` · ${fmtTime(s.outcome_at)}`}
                </div>
              ) : (
                hasLevels && <div className="mt-1 text-neutral-600">↳ open</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
