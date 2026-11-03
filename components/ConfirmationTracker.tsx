"use client";

import { useEffect, useState } from "react";
import { STRATEGIES, type StrategyId } from "@/lib/types";

const CONFIRMATIONS: Record<StrategyId, string[]> = {
  zones: [
    "Price entered zone",
    "Rejection candle in zone",
    "Zone fresh (≤1 touch)",
    "Momentum (RSI) turning",
    "HTF trend agrees",
    "M15 trend agrees",
    "Vision AI",
  ],
  setforget: [
    "AOI first touch",
    "Rejection candle in AOI",
    "AOI overlaps another POI",
    "Momentum (RSI) turning",
    "HTF trend agrees",
    "M15 trend agrees",
    "Vision AI",
  ],
  fibonacci: [
    "Price in golden zone",
    "Rejection candle in zone",
    "Zone overlaps another POI",
    "Momentum (RSI) turning",
    "HTF trend agrees",
    "M15 trend agrees",
    "Vision AI",
  ],
};

interface SetupRow {
  pair: string;
  timeframe: string;
  dedupe_key: string;
  payload: {
    confirmations: Record<string, boolean>;
    count: number;
    signaled: boolean;
  };
  updated_at: string;
}

/**
 * Live per-strategy 5-point confirmation tracker (Section 3). Reads setup
 * state written by the scanner (/api/setups); polls every 30s.
 * Shows only the selected pair/timeframe's most recent setup per strategy —
 * each pair has its own independent confirmation state.
 */
export default function ConfirmationTracker({ pair, timeframe }: { pair: string; timeframe: string }) {
  const [setups, setSetups] = useState<SetupRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/setups")
        .then((r) => r.json())
        .then((j) => {
          if (!cancelled) setSetups(j.setups ?? []);
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

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Confirmation Tracker</h2>
        <span className="text-xs text-neutral-500">
          {pair.replace("_", "/")} · {timeframe} · M15 TA
        </span>
      </div>
      <div className="space-y-4">
        {STRATEGIES.map((s) => {
          const live = setups.filter(
            (r) =>
              (r.dedupe_key.startsWith(`tori-v3:${s.id}:`) || r.dedupe_key.startsWith(`tori-v2:${s.id}:`)) &&
              r.pair === pair &&
              r.timeframe === timeframe
          );
          const latest = live[0];
          const conf = latest?.payload.confirmations ?? {};
          const count = latest?.payload.count ?? 0;
          return (
            <div key={s.id}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-medium text-neutral-300">{s.label}</span>
                <span className="font-mono text-xs text-neutral-500">{count}/7</span>
              </div>
              {!latest && (
                <div className="mb-1 text-[10px] text-neutral-600">
                  No active setup for this pair/timeframe
                </div>
              )}
              {latest && (
                <div className="mb-1 font-mono text-[10px] text-neutral-500">
                  {latest.pair.replace("_", "/")} {latest.timeframe}
                  {latest.payload.signaled ? " · SIGNALED" : ""}
                </div>
              )}
              <ul className="space-y-0.5">
                {CONFIRMATIONS[s.id].map((label) => {
                  const met = conf[label] === true;
                  return (
                    <li
                      key={label}
                      className={`flex items-center gap-2 text-xs ${met ? "text-teal-300" : "text-neutral-500"}`}
                    >
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${met ? "bg-teal-400" : "bg-neutral-700"}`}
                      />
                      {label}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
