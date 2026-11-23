"use client";

import { FIB_STRATEGY, type Signal } from "@/lib/types";

/** The Fibonacci system's read as /api/analysis reports it. */
export interface FibSummary {
  dailyTrend: 1 | -1 | 0;
  h4Trend: 1 | -1 | 0;
  dailyAverage: number | null;
  h4Ema: number | null;
  side: "long" | "short" | null;
  checks: { label: string; met: boolean }[];
  blocked: string | null;
  legAtr: number | null;
  tradeable: boolean;
  leg: { direction: "long" | "short"; origin: { time: number; price: number }; end: { time: number; price: number }; range: number } | null;
  levels: { level: number; price: number }[];
  zone: { shallow: number; deep: number; shallowLevel: number; deepLevel: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  targetLevel: number;
  setup: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number; rr: number; trigger: string } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * The one strategy that sends signals: the five conditions in the order they
 * have to be met, the levels of the swing being watched, and the open trade.
 */
export default function FibTracker({ fib, signals, price, digits = 2 }: { fib: FibSummary | null; signals: Signal[]; price: number | null; digits?: number }) {
  const px = (n: number) => n.toFixed(digits);
  const open = signals.find((s) => s.strategy === FIB_STRATEGY && !s.outcome && s.status === "active");
  const met = fib ? fib.checks.filter((c) => c.met).length : 0;
  const headline = !fib
    ? null
    : open
      ? { text: "A trade is open — no new signal until it closes", tone: "text-sky-300" }
      : fib.blocked
        ? { text: `No setup: ${fib.blocked}`, tone: "text-amber-400" }
        : met >= 5
          ? { text: `${fib.side === "long" ? "Buy" : "Sell"} signal on the last candle`, tone: fib.side === "long" ? "text-emerald-400" : "text-rose-400" }
          : met === 4
            ? { text: "Price is in the zone — waiting for a 15-minute rejection candle", tone: "text-emerald-300" }
            : { text: `Waiting for a pullback into the ${fib.side === "long" ? "buy" : "sell"} zone`, tone: "text-neutral-200" };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Fibonacci retracement</h2>
        <span className="text-xs text-neutral-500">{fib ? `${met}/5 conditions` : ""}</span>
      </div>
      {!fib || !headline ? (
        <p className="text-xs text-neutral-600">Loading…</p>
      ) : (
        <>
          <p className={`mb-2 text-xs font-medium ${headline.tone}`}>{headline.text}</p>
          <ul className="mb-3 space-y-0.5">
            {fib.checks.map((c) => (
              <li key={c.label} className={`flex items-start gap-2 text-xs ${c.met ? "text-teal-300" : "text-neutral-500"}`}>
                <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${c.met ? "bg-teal-400" : "bg-neutral-700"}`} />
                {c.label}
              </li>
            ))}
          </ul>

          {open && (
            <div className="mb-3 rounded border border-sky-900/60 bg-sky-950/30 p-2 text-xs">
              <div className="flex items-baseline justify-between">
                <span className={`font-medium ${open.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>{open.direction === "long" ? "BUY" : "SELL"} open</span>
                <span className="text-[10px] text-neutral-500">since {when(open.created_at)}</span>
              </div>
              <div className="mt-1 font-mono text-neutral-300">
                Entry {px(open.entry)} · SL {px(open.stop_loss)} · TP {px(open.take_profit)}
              </div>
              {price != null && (
                <div className="mt-0.5 text-[10px] text-neutral-400">
                  Now {px(price)} · {(((open.direction === "long" ? 1 : -1) * (price - open.entry)) / Math.abs(open.entry - open.stop_loss)).toFixed(2)}R
                </div>
              )}
            </div>
          )}

          {fib.leg && (
            <>
              <p className="mb-1 text-[10px] text-neutral-500">
                1-hour swing {px(fib.leg.origin.price)} → {px(fib.leg.end.price)} ({fib.leg.direction === "long" ? "up" : "down"}
                {fib.legAtr != null ? `, ${fib.legAtr.toFixed(1)} ATR` : ""}){fib.tradeable ? "" : " — not tradeable now"}
              </p>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {fib.takeProfit != null && (
                  <li className="flex justify-between text-emerald-400/90">
                    <span>{(fib.targetLevel * 100).toFixed(1)}% target</span>
                    <span>{px(fib.takeProfit)}</span>
                  </li>
                )}
                {fib.levels.map((l) => {
                  const inZone = fib.zone != null && l.level >= fib.zone.shallowLevel && l.level <= fib.zone.deepLevel;
                  return (
                    <li key={l.level} className={`flex justify-between ${inZone ? "text-yellow-300" : "text-neutral-400"}`}>
                      <span>
                        {(l.level * 100).toFixed(1).replace(/\.0$/, "")}%{inZone ? " · entry zone" : l.level === 0 ? " · swing end" : l.level === 1 ? " · swing start" : ""}
                      </span>
                      <span>{px(l.price)}</span>
                    </li>
                  );
                })}
                {fib.stopLoss != null && (
                  <li className="flex justify-between text-rose-400/90">
                    <span>stop</span>
                    <span>{px(fib.stopLoss)}</span>
                  </li>
                )}
              </ul>
            </>
          )}
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            One trade per swing, one trade at a time. A trade that reaches neither level in five trading days is closed at market.
          </p>
        </>
      )}
    </div>
  );
}
