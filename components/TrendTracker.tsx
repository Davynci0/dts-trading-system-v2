"use client";

import { isLiveSignal, type Signal } from "@/lib/types";

/** The trend entries' read of the last closed 1-hour candle, as /api/analysis reports it. */
export interface TrendSummary {
  dailyTrend: 1 | -1 | 0;
  maTrend: 1 | -1 | 0;
  emaFast: number | null;
  emaSlow: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  rsi: number | null;
  atr: number | null;
  side: "long" | "short" | null;
  checks: { label: string; met: boolean }[];
  blocked: string | null;
  breakoutLevel: number | null;
  breakoutBars: number;
  stopAtr: number;
  trailAtr: number;
  targetR: number;
  readAt: number;
  setup: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number; trailDistance: number; trigger: string } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * The trend entries: the trend readings in the order they have to agree, what
 * the two entries are waiting for, and the open trade with its trailing stop.
 */
export default function TrendTracker({ trend, signals, price, digits = 2 }: { trend: TrendSummary | null; signals: Signal[]; price: number | null; digits?: number }) {
  const px = (n: number) => n.toFixed(digits);
  const open = signals.find((s) => isLiveSignal(s) && !s.outcome && s.status === "active");
  const met = trend ? trend.checks.filter((c) => c.met).length : 0;
  const total = trend?.checks.length ?? 5;
  const headline = !trend
    ? null
    : open
      ? { text: "A trade is open — no new trend signal until it closes", tone: "text-sky-300" }
      : trend.setup
        ? { text: `${trend.setup.direction === "long" ? "Buy" : "Sell"} signal on the last 1-hour candle (${trend.setup.trigger})`, tone: trend.setup.direction === "long" ? "text-emerald-400" : "text-rose-400" }
        : trend.blocked
          ? { text: `No setup: ${trend.blocked}`, tone: "text-amber-400" }
          : { text: `Trend confirmed — waiting for a ${trend.side === "long" ? "buy" : "sell"} entry on a 1-hour close`, tone: "text-emerald-300" };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Trend (1-hour)</h2>
        <span className="text-xs text-neutral-500">{trend ? `${met}/${total} conditions` : ""}</span>
      </div>
      {!trend || !headline ? (
        <p className="text-xs text-neutral-600">Loading…</p>
      ) : (
        <>
          <p className={`mb-2 text-xs font-medium ${headline.tone}`}>{headline.text}</p>
          <ul className="mb-3 space-y-0.5">
            {trend.checks.map((c) => (
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
              {open.trail_stop != null && open.trail_stop !== open.stop_loss && (
                <div className="mt-0.5 font-mono text-rose-300">Stop now {px(open.trail_stop)} (trailing)</div>
              )}
              {open.trail_distance != null && <div className="mt-0.5 text-[10px] text-neutral-400">Trailing stop: {px(open.trail_distance)} behind the best price</div>}
              {price != null && (
                <div className="mt-0.5 text-[10px] text-neutral-400">
                  Now {px(price)} · {(((open.direction === "long" ? 1 : -1) * (price - open.entry)) / Math.abs(open.entry - open.stop_loss)).toFixed(2)}R
                </div>
              )}
            </div>
          )}

          <ul className="space-y-0.5 font-mono text-[11px] text-neutral-400">
            {trend.breakoutLevel != null && (
              <li className="flex justify-between text-sky-300">
                <span>
                  {trend.dailyTrend === 1 ? "buy above" : "sell below"} ({trend.breakoutBars}-candle {trend.dailyTrend === 1 ? "high" : "low"})
                </span>
                <span>{px(trend.breakoutLevel)}</span>
              </li>
            )}
            {trend.emaFast != null && trend.emaSlow != null && (
              <li className="flex justify-between">
                <span>50 EMA / 200 EMA</span>
                <span>
                  {px(trend.emaFast)} / {px(trend.emaSlow)}
                </span>
              </li>
            )}
            {trend.atr != null && (
              <li className="flex justify-between">
                <span>a new trade&apos;s stop / trailing</span>
                <span>
                  {px(trend.stopAtr * trend.atr)} / {px(trend.trailAtr * trend.atr)}
                </span>
              </li>
            )}
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            Read on the 1-hour candle that closed at {clock(trend.readAt)}. Stop {trend.stopAtr} ATR, trailing stop {trend.trailAtr} ATR, take-profit {trend.targetR}R. One trend trade at a time; about one in three wins.
          </p>
        </>
      )}
    </div>
  );
}
