"use client";

import type { Signal } from "@/lib/types";

/** The trend system's state as /api/analysis reports it. */
export interface TrendSummary {
  state: { fast: number; slow: number; adx: number | null; ema: number | null; emaAgrees: boolean; side: "long" | "short" | null; blocked: string | null };
  /** null when there is no ADX cap */
  adxMax: number | null;
  fastDays: number;
  slowDays: number;
  emaBars: number;
  atr: number | null;
  stopAtr: number;
  trailAtr: number;
  targetR: number;
  watch: { id: string; label: string; level: number | null; note: string }[];
  ema20: { time: number; value: number }[];
  ema50: { time: number; value: number }[];
  emaTrend: { time: number; value: number }[];
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
  // one position stands for every entry type that fired on its candle
  const byVariant = new Map(open.flatMap((s) => (s.confluence_strategies?.length ? s.confluence_strategies : [s.variant ?? ""]).map((id) => [id, s] as const)));
  const st = trend?.state;
  const agree = !!st && st.fast !== 0 && st.fast === st.slow;
  const checks: [string, boolean][] =
    st && trend
      ? [
          [`${trend.fastDays}-day trend ${arrow(st.fast)}`, st.fast !== 0],
          [`${trend.slowDays}-day trend ${arrow(st.slow)}${st.fast !== 0 && st.slow !== 0 && !agree ? " — disagrees" : ""}`, agree],
          ...(trend.emaBars > 0
            ? ([[`Price ${st.fast === -1 ? "below" : "above"} its ${trend.emaBars}-candle average${st.ema != null ? ` (${px(st.ema)})` : ""}`, st.emaAgrees]] as [string, boolean][])
            : []),
          ...(trend.adxMax != null
            ? ([[`Move not stretched: ADX ${st.adx != null ? st.adx.toFixed(0) : "?"} (limit ${trend.adxMax})`, st.adx != null && st.adx < trend.adxMax]] as [string, boolean][])
            : []),
        ]
      : [];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Trend system</h2>
        <span className="text-xs text-neutral-500">
          sends signals · {open.length} position{open.length === 1 ? "" : "s"} open
        </span>
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
              New trade: stop loss {px(trend.stopAtr * trend.atr)} from entry ({trend.stopAtr} × ATR = 1R) · take profit{" "}
              {trend.targetR > 0 ? `${px(trend.targetR * trend.stopAtr * trend.atr)} away (${trend.targetR}R)` : "none"} · trailing stop{" "}
              {px(trend.trailAtr * trend.atr)} behind the best price ({trend.trailAtr} × ATR).
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
                      ? `entry ${px(pos.entry)} · stop now ${px(pos.trail_stop ?? pos.stop_loss)}${pos.take_profit > 0 ? ` · target ${px(pos.take_profit)}` : ""}`
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
