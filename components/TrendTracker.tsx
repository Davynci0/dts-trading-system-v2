"use client";

import { isLiveSignal, type Signal } from "@/lib/types";

/** The system's read of the last closed 15-minute candle, as /api/analysis reports it. */
export interface TrendSummary {
  dailyTrend: 1 | -1 | 0;
  maTrend: 1 | -1 | 0;
  emaFast: number | null;
  emaSlow: number | null;
  plusDi: number | null;
  minusDi: number | null;
  adx: number | null;
  momentumAgree: number;
  costShare: number | null;
  atr: number | null;
  side: "long" | "short" | null;
  checks: { label: string; met: boolean }[];
  blocked: string | null;
  /** the levels the next 15-minute candle has to close beyond for a breakout */
  levels: { bars: number; price: number; armed: boolean }[];
  stopAtr: number;
  targetR: number;
  maxOpen: number;
  holdHours: number;
  readAt: number;
  setup: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number; trigger: string } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * The system at a glance: the trend readings in the order they have to agree,
 * the levels a breakout has to close beyond, and the open trades.
 */
export default function TrendTracker({ trend, signals, price, digits = 2 }: { trend: TrendSummary | null; signals: Signal[]; price: number | null; digits?: number }) {
  const px = (n: number) => n.toFixed(digits);
  const open = signals.filter((s) => isLiveSignal(s) && !s.outcome && s.status === "active");
  const met = trend ? trend.checks.filter((c) => c.met).length : 0;
  const total = trend?.checks.length ?? 7;
  const full = !!trend && open.length >= trend.maxOpen;
  const headline = !trend
    ? null
    : trend.setup
      ? { text: `${trend.setup.direction === "long" ? "Buy" : "Sell"} signal on the last 15-minute candle (${trend.setup.trigger})`, tone: trend.setup.direction === "long" ? "text-emerald-400" : "text-rose-400" }
      : full
        ? { text: `${open.length} trades are open — no new signal until one closes`, tone: "text-sky-300" }
        : trend.blocked
          ? { text: `No setup: ${trend.blocked}`, tone: "text-amber-400" }
          : { text: `Trend confirmed — waiting for a ${trend.side === "long" ? "buy" : "sell"} entry on a 15-minute close`, tone: "text-emerald-300" };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Trend breakouts (15-minute)</h2>
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

          {open.length > 0 && (
            <div className="mb-3 rounded border border-sky-900/60 bg-sky-950/30 p-2 text-xs">
              <div className="mb-1 flex items-baseline justify-between text-[10px] text-neutral-400">
                <span>
                  Open trades {open.length}/{trend.maxOpen}
                </span>
                {price != null && <span>now {px(price)}</span>}
              </div>
              <ul className="space-y-1.5">
                {open.map((s) => (
                  <li key={s.id}>
                    <div className="flex items-baseline justify-between">
                      <span className={`font-medium ${s.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
                        {s.direction === "long" ? "BUY" : "SELL"} {px(s.entry)}
                      </span>
                      <span className="text-[10px] text-neutral-500">
                        {when(s.created_at)}
                        {price != null && ` · ${(((s.direction === "long" ? 1 : -1) * (price - s.entry)) / Math.abs(s.entry - s.stop_loss)).toFixed(2)}R`}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-neutral-300">
                      SL {px(s.stop_loss)} · TP {px(s.take_profit)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="space-y-0.5 font-mono text-[11px] text-neutral-400">
            {trend.levels.map((l) => (
              <li key={l.bars} className={`flex justify-between ${l.armed ? "text-sky-300" : "text-neutral-600"}`}>
                <span>
                  {trend.dailyTrend === 1 ? "buy above" : "sell below"} ({(l.bars * 15) / 60}-hour {trend.dailyTrend === 1 ? "high" : "low"}){l.armed ? "" : " — already beyond"}
                </span>
                <span>{px(l.price)}</span>
              </li>
            ))}
            {trend.emaFast != null && trend.emaSlow != null && (
              <li className="flex justify-between">
                <span>1-hour 50 EMA / 200 EMA</span>
                <span>
                  {px(trend.emaFast)} / {px(trend.emaSlow)}
                </span>
              </li>
            )}
            {trend.atr != null && (
              <li className="flex justify-between">
                <span>a new trade&apos;s stop / target</span>
                <span>
                  {px(trend.stopAtr * trend.atr)} / {px(trend.stopAtr * trend.targetR * trend.atr)}
                </span>
              </li>
            )}
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            Read on the 15-minute candle that closed at {clock(trend.readAt)}. Stop {trend.stopAtr} ATR, take-profit 1:{trend.targetR}, closed at market after {trend.holdHours} hours. Up to {trend.maxOpen} trades open together; about one in three wins.
          </p>
        </>
      )}
    </div>
  );
}
