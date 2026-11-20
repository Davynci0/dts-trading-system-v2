"use client";

import type { Signal } from "@/lib/types";

/** The trend system's state as /api/analysis reports it. */
export interface TrendSummary {
  state: { fast: number; slow: number; adx: number | null; side: "long" | "short" | null; blocked: string | null };
  adxMax: number;
  atr: number | null;
  stopAtr: number;
  watch: { id: string; label: string; level: number | null; note: string }[];
  ema20: { time: number; value: number }[];
  ema50: { time: number; value: number }[];
}

const arrow = (t: number) => (t === 1 ? "▲ up" : t === -1 ? "▼ down" : "unknown");

/**
 * The strategies that send signals: the three filters every trend trade must
 * pass, and for each of the eleven entries either its open position (with the
 * trailing stop as it stands now) or what it is waiting for.
 */
export default function TrendTracker({ trend, signals, digits = 2 }: { trend: TrendSummary | null; signals: Signal[]; digits?: number }) {
  const px = (n: number) => n.toFixed(digits);
  const open = signals.filter((s) => s.strategy === "trend" && !s.outcome && s.status === "active");
  const byVariant = new Map(open.map((s) => [s.variant ?? "", s]));
  const st = trend?.state;
  const agree = !!st && st.fast !== 0 && st.fast === st.slow;
  const calm = !!st && st.adx != null && st.adx < (trend?.adxMax ?? 27);
  const checks: [string, boolean][] = st
    ? [
        [`50-day trend ${arrow(st.fast)}`, st.fast !== 0],
        [`100-day trend ${arrow(st.slow)}${st.fast !== 0 && st.slow !== 0 && !agree ? " — disagrees" : ""}`, agree],
        [`Move not stretched: ADX ${st.adx != null ? st.adx.toFixed(0) : "?"} (limit ${trend?.adxMax ?? 27})`, calm],
      ]
    : [];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Trend system</h2>
        <span className="text-xs text-neutral-500">sends signals · {open.length} open</span>
      </div>
      {!trend || !st ? (
        <p className="text-xs text-neutral-600">Loading…</p>
      ) : (
        <>
          <p className={`mb-2 text-xs font-medium ${st.side === "long" ? "text-emerald-400" : st.side === "short" ? "text-rose-400" : "text-amber-400"}`}>
            {st.side ? `${st.side === "long" ? "Buys" : "Sells"} only — an entry below sends a signal when its candle closes` : `No new entries: ${st.blocked}`}
          </p>
          <ul className="mb-3 space-y-0.5">
            {checks.map(([label, met]) => (
              <li key={label} className={`flex items-center gap-2 text-xs ${met ? "text-teal-300" : "text-neutral-500"}`}>
                <span className={`inline-block h-2 w-2 rounded-full ${met ? "bg-teal-400" : "bg-neutral-700"}`} />
                {label}
              </li>
            ))}
          </ul>
          {trend.atr != null && (
            <p className="mb-2 text-[10px] text-neutral-500">
              Stop and trailing distance for a new trade: {px(trend.stopAtr * trend.atr)} ({trend.stopAtr} × ATR). No take-profit.
            </p>
          )}
          <ul className="space-y-1.5">
            {trend.watch.map((w) => {
              const pos = byVariant.get(w.id);
              return (
                <li key={w.id} className="text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={pos ? "font-medium text-neutral-100" : "text-neutral-300"}>{w.label}</span>
                    {pos ? (
                      <span className={`font-mono text-[10px] ${pos.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
                        {pos.direction === "long" ? "BUY" : "SELL"} open
                      </span>
                    ) : (
                      w.level != null && <span className="font-mono text-[10px] text-neutral-500">{px(w.level)}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-neutral-500">
                    {pos
                      ? `entry ${px(pos.entry)} · trailing stop now ${px(pos.trail_stop ?? pos.stop_loss)}`
                      : w.note}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
