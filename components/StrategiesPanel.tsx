"use client";

import { STRATEGIES, STRATEGY_LIST } from "@/lib/strategies";
import { strategyOf, type Signal, type StrategyId } from "@/lib/types";

/** The trendline strategy on the 1-hour chart: the lines it trades and what the last closed 1-hour candle did. */
export interface TrendlineSummary {
  lines: { kind: "down" | "up"; touches: number; now: number; points: { time: number; price: number }[]; touchPoints: { time: number; price: number }[]; broken: "long" | "short" | null }[];
  marks: { time: number; price: number; type: "bounce" | "break" | "retest"; direction: "long" | "short"; traded: boolean }[];
  dailyTrend: 1 | -1 | 0;
  event: {
    type: "break" | "bounce" | "retest";
    direction: "long" | "short";
    kind: "down" | "up";
    touches: number;
    close: number;
    time: number;
    setup: { entry: number; stopLoss: number; takeProfit: number } | null;
    reason: string | null;
  } | null;
  readAt: number;
}

/** Set and Forget on the last closed 4-hour candle. */
export interface SetForgetSummary {
  weekly: 1 | -1 | 0;
  daily: 1 | -1 | 0;
  h4: 1 | -1 | 0;
  side: "long" | "short" | null;
  waiting: string;
  checks: { label: string; met: boolean }[];
  zones: { low: number; high: number; touches: number; tf: "weekly" | "daily"; active: boolean }[];
  pullback: number | null;
  setup: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number } | null;
  readAt: number;
}

const arrow = (d: number) => (d === 1 ? "▲" : d === -1 ? "▼" : "–");
const tone = (d: number) => (d === 1 ? "text-emerald-400" : d === -1 ? "text-rose-400" : "text-neutral-500");

/**
 * The three strategies side by side: what each holds, what each is waiting
 * for, and the rule between them. The trend scalp's own conditions are in the
 * panel above this one.
 */
export default function StrategiesPanel({
  signals,
  trendStatus,
  trendline,
  setforget,
  digits = 2,
}: {
  signals: Signal[];
  /** the trend scalp's status in a line */
  trendStatus: string | null;
  trendline: TrendlineSummary | null;
  setforget: SetForgetSummary | null;
  digits?: number;
}) {
  const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits));
  const at = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const open = (id: StrategyId) => signals.find((s) => strategyOf(s) === id && !s.outcome && s.status === "active");
  const openCount = STRATEGY_LIST.filter((s) => open(s.id)).length;

  const status: Record<StrategyId, React.ReactNode> = {
    trend: <p className="text-neutral-400">{trendStatus ?? "Reading the 15-minute chart…"}</p>,
    setforget: setforget ? (
      <>
        <p className="font-mono text-[11px] text-neutral-400">
          Weekly <span className={tone(setforget.weekly)}>{arrow(setforget.weekly)}</span> · Daily <span className={tone(setforget.daily)}>{arrow(setforget.daily)}</span> · 4-hour{" "}
          <span className={tone(setforget.h4)}>{arrow(setforget.h4)}</span>
        </p>
        <p className="text-neutral-400">{setforget.waiting}</p>
        {setforget.zones.length > 0 && (
          <p className="font-mono text-[10px] text-neutral-500">
            Areas of interest: {setforget.zones.map((z) => `${px(z.low)}–${px(z.high)} (${z.touches}, ${z.tf})`).join(" · ")}
          </p>
        )}
      </>
    ) : (
      <p className="text-neutral-500">Reading the weekly, daily and 4-hour charts…</p>
    ),
    trendline: trendline ? (
      <>
        <p className="text-neutral-400">
          Daily trend <span className={tone(trendline.dailyTrend)}>{arrow(trendline.dailyTrend)}</span> —{" "}
          {trendline.dailyTrend === 0 ? "no side" : `only ${trendline.dailyTrend === 1 ? "buys: a bounce off a rising line, or the retest of a falling line broken upwards" : "sells: a bounce off a falling line, or the retest of a rising line broken downwards"}`}.
        </p>
        {trendline.event ? (
          <p className="text-neutral-300">
            Last 1-hour candle ({at(trendline.event.time)}): {trendline.event.type} of a {trendline.event.touches}-touch {trendline.event.kind === "up" ? "rising" : "falling"} line —{" "}
            {trendline.event.setup ? `${trendline.event.direction === "long" ? "buy" : "sell"} signal` : `no trade: ${trendline.event.reason}`}
          </p>
        ) : (
          <p className="text-neutral-500">No setup on the 1-hour candle that closed {at(trendline.readAt)}.</p>
        )}
        <ul className="font-mono text-[10px] text-neutral-500">
          {trendline.lines.length === 0 && <li>no trendline with a week of data yet</li>}
          {trendline.lines.map((l, k) => (
            <li key={k} className="flex justify-between">
              <span className={l.broken ? "text-violet-300" : ""}>
                {l.broken ? `broken ${l.broken === "long" ? "upwards" : "downwards"} — retest is a ${l.broken === "long" ? "buy" : "sell"}` : `${l.kind === "up" ? "rising" : "falling"} line · ${l.touches} touches`}
              </span>
              <span>{px(l.now)}</span>
            </li>
          ))}
        </ul>
      </>
    ) : (
      <p className="text-neutral-500">Reading the 1-hour chart…</p>
    ),
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Three strategies</h2>
        <span className="text-[10px] text-neutral-500">{openCount} of 3 in a trade</span>
      </div>
      <ul className="mt-3 space-y-3">
        {STRATEGY_LIST.map((s) => {
          const o = open(s.id);
          return (
            <li key={s.id} className="space-y-1 rounded border border-neutral-800 bg-neutral-950 p-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-neutral-200">{s.name}</span>
                <span className="text-[10px] text-neutral-500">{s.chart} chart</span>
              </div>
              {o && (
                <p className={`font-mono text-[11px] ${o.direction === "long" ? "text-teal-300" : "text-red-300"}`}>
                  {o.direction === "long" ? "BUY" : "SELL"} open from {px(o.entry)} · stop {px(o.trail_stop ?? o.stop_loss)} · target {px(o.take_profit)}
                </p>
              )}
              {status[s.id]}
              <p className="text-[10px] leading-relaxed text-neutral-600">
                {STRATEGIES[s.id].exit}; {STRATEGIES[s.id].pace}. {STRATEGIES[s.id].tested}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
        Each strategy works on its own and holds one trade at a time, so up to three trades can be open — never in opposite directions: a signal against another strategy&apos;s open trade is not sent, and two opposite signals at
        the same moment cancel each other.
      </p>
    </div>
  );
}
