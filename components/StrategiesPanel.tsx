"use client";

import { STRATEGIES, STRATEGY_LIST } from "@/lib/strategies";
import { strategyOf, type Signal, type StrategyId } from "@/lib/types";

/** The trendline strategy on the 1-hour chart: the lines it trades and what the last closed 1-hour candle did. */
export interface TrendlineSummary {
  lines: { kind: "down" | "up"; touches: number; now: number; points: { time: number; price: number }[]; touchPoints: { time: number; price: number }[]; broken: "long" | "short" | null }[];
  marks: { time: number; price: number; type: "bounce" | "break" | "retest"; direction: "long" | "short"; traded: boolean }[];
  blocks: string[];
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

/** Supply and demand: the fresh 30-minute zones and what the last 15-minute candle did at them. */
export interface ZonesSummary {
  dailyTrend: 1 | -1 | 0;
  blocks: string[];
  zones: { kind: "demand" | "supply"; low: number; high: number; proximal: number; known: number; touched: boolean; tradable: boolean }[];
  marks: { time: number; price: number; kind: "demand" | "supply"; direction: "long" | "short"; traded: boolean }[];
  event: { kind: "demand" | "supply"; direction: "long" | "short"; low: number; high: number; time: number; setup: { entry: number; stopLoss: number; takeProfit: number } | null; reason: string | null } | null;
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
  zones,
  price,
  digits = 2,
}: {
  signals: Signal[];
  /** the trend scalp's status in a line */
  trendStatus: string | null;
  trendline: TrendlineSummary | null;
  zones: ZonesSummary | null;
  price: number | null;
  digits?: number;
}) {
  const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits));
  const at = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const open = (id: StrategyId) => signals.find((s) => strategyOf(s) === id && !s.outcome && s.status === "active");
  const openCount = STRATEGY_LIST.filter((s) => open(s.id)).length;

  const status: Record<StrategyId, React.ReactNode> = {
    trend: <p className="text-neutral-400">{trendStatus ?? "Reading the 15-minute chart…"}</p>,
    zones: zones ? (
      (() => {
        const side = zones.dailyTrend === 1 ? "demand" : zones.dailyTrend === -1 ? "supply" : null;
        const mine = zones.zones.filter((z) => z.tradable);
        // the nearest zone on the trend's side: under price for demand, over it for supply
        const nearest = [...mine].sort((a, b) => Math.abs((price ?? 0) - a.proximal) - Math.abs((price ?? 0) - b.proximal));
        return (
          <>
            <p className="text-neutral-400">
              Daily trend <span className={tone(zones.dailyTrend)}>{arrow(zones.dailyTrend)}</span> —{" "}
              {side ? `only ${side === "demand" ? "buys at fresh demand zones" : "sells at fresh supply zones"}` : "no side"}.
            </p>
            {zones.blocks.length > 0 && <p className="text-amber-400/90">No zone trade today: {zones.blocks.join("; ")}.</p>}
            {zones.event ? (
              <p className="text-neutral-300">
                Last 15-minute candle ({at(zones.event.time)}): rejected the {zones.event.kind} zone {px(zones.event.low)}–{px(zones.event.high)} —{" "}
                {zones.event.setup ? `${zones.event.direction === "long" ? "buy" : "sell"} signal` : `no trade: ${zones.event.reason}`}
              </p>
            ) : (
              <p className="text-neutral-500">{mine.length > 0 ? `Waiting for price to come back to a fresh ${side} zone and be rejected.` : `No fresh ${side ?? ""} zone right now — waiting for one to form.`}</p>
            )}
            <ul className="font-mono text-[10px] text-neutral-500">
              {nearest.slice(0, 4).map((z, k) => (
                <li key={k} className="flex justify-between">
                  <span>
                    {z.kind} zone{z.touched ? " · price is at it" : " · fresh"}
                  </span>
                  <span>
                    {px(z.low)}–{px(z.high)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        );
      })()
    ) : (
      <p className="text-neutral-500">Reading the 30-minute zones…</p>
    ),
    trendline: trendline ? (
      <>
        <p className="text-neutral-400">
          Daily trend <span className={tone(trendline.dailyTrend)}>{arrow(trendline.dailyTrend)}</span> —{" "}
          {trendline.dailyTrend === 0 ? "no side" : `only ${trendline.dailyTrend === 1 ? "buys: a bounce off a rising line, or the retest of a falling line broken upwards" : "sells: a bounce off a falling line, or the retest of a rising line broken downwards"}`}.
        </p>
        {trendline.blocks.length > 0 && <p className="text-amber-400/90">No trendline trade now: {trendline.blocks.join("; ")}.</p>}
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
