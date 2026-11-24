"use client";

import { isLiveSignal, type Signal } from "@/lib/types";

/** The system's read of the last closed 15-minute candle, as /api/analysis reports it. */
export interface TrendSummary {
  dailyTrend: 1 | -1 | 0;
  /** the 1-hour structure: +1 bullish, −1 bearish */
  h1Trend: 1 | -1 | 0;
  /** the 15-minute structure */
  structure: 1 | -1 | 0;
  /** the last confirmed 15-minute swing high / swing low */
  swingHigh: number | null;
  swingLow: number | null;
  /** the level a new trade's stop would go beyond right now */
  stopLevel: number | null;
  adx: number | null;
  rangePosition: number | null;
  distancePct: number | null;
  atr: number | null;
  costShare: number | null;
  side: "long" | "short" | null;
  checks: { label: string; met: boolean }[];
  blocked: string | null;
  /** the levels the next 15-minute candle has to close beyond for an entry */
  levels: { label: string; price: number; armed: boolean }[];
  minRiskAtr: number;
  maxRiskAtr: number;
  targetR: number;
  /** the profit lock, in R: at `lockAtR` in favour the stop moves to `lockToR` in profit */
  lockAtR: number;
  lockToR: number;
  maxOpen: number;
  /** no same-side trade within this many minutes of the last entry and this many R of its price */
  reentryMinutes: number;
  reentryR: number;
  zones: { low: number; high: number; touches: number }[];
  brokeZone: { low: number; high: number; touches: number } | null;
  srDays: number;
  srTouches: number;
  sdZones: { kind: "demand" | "supply"; low: number; high: number; known: number }[];
  sdAhead: { kind: "demand" | "supply"; low: number; high: number } | null;
  candleAtr: number | null;
  maxCandleAtr: number;
  sdAheadR: number;
  holdHours: number;
  readAt: number;
  setup: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number; trigger: string; lockTrigger: number; lockStop: number } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const shape = (t: number) => (t === 1 ? "bullish" : t === -1 ? "bearish" : "not known");

/**
 * The system at a glance: the conditions in the order they have to be met, the
 * open trade with the time it has left, the swings, the level a stop would go
 * beyond and the levels an entry has to close beyond.
 */
export default function TrendTracker({ trend, signals, price, digits = 2 }: { trend: TrendSummary | null; signals: Signal[]; price: number | null; digits?: number }) {
  const px = (n: number) => n.toFixed(digits);
  const open = signals.find((s) => isLiveSignal(s) && !s.outcome && s.status === "active");
  const met = trend ? trend.checks.filter((c) => c.met).length : 0;
  const total = trend?.checks.length ?? 8;
  const headline = !trend
    ? null
    : open
      ? { text: "A trade is open — no new signal until it closes", tone: "text-sky-300" }
      : trend.setup
        ? { text: `${trend.setup.direction === "long" ? "Buy" : "Sell"} signal on the last 15-minute candle (${trend.setup.trigger})`, tone: trend.setup.direction === "long" ? "text-emerald-400" : "text-rose-400" }
        : trend.blocked
          ? { text: `No setup: ${trend.blocked}`, tone: "text-amber-400" }
          : { text: `Trend confirmed — waiting for a ${trend.side === "long" ? "buy" : "sell"} entry on a 15-minute close`, tone: "text-emerald-300" };
  const up = trend?.dailyTrend === 1;
  // the level a new trade's stop would go beyond: the low (buy) / high (sell) of the last two candles
  const stopSwing = trend?.stopLevel ?? null;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">Structure scalp (15-minute)</h2>
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
                <span className={`font-medium ${open.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
                  {open.direction === "long" ? "BUY" : "SELL"} open at {px(open.entry)}
                </span>
                <span className="text-[10px] text-neutral-500">since {when(open.created_at)}</span>
              </div>
              <div className="mt-1 font-mono text-neutral-300">
                SL {px(open.trail_stop ?? open.stop_loss)} · TP {px(open.take_profit)}
              </div>
              {open.trail_stop != null ? (
                <div className="mt-0.5 font-mono text-emerald-300">Stop moved from {px(open.stop_loss)} — profit locked</div>
              ) : (
                <div className="mt-0.5 text-[10px] text-neutral-400">
                  At {px(open.entry + (open.direction === "long" ? 1 : -1) * trend.lockAtR * Math.abs(open.entry - open.stop_loss))} the stop moves to{" "}
                  {px(open.entry + (open.direction === "long" ? 1 : -1) * trend.lockToR * Math.abs(open.entry - open.stop_loss))}
                </div>
              )}
              <div className="mt-0.5 text-[10px] text-neutral-400">
                {price != null && `Now ${px(price)} · ${(((open.direction === "long" ? 1 : -1) * (price - open.entry)) / Math.abs(open.entry - open.stop_loss)).toFixed(2)}R · `}
                closes at market by {clock(new Date(open.created_at).getTime() + trend.holdHours * 3600_000)} if neither is hit
              </div>
            </div>
          )}

          <ul className="space-y-0.5 font-mono text-[11px] text-neutral-400">
            <li className="flex justify-between">
              <span>15-minute structure</span>
              <span>{shape(trend.structure)}</span>
            </li>
            {trend.swingHigh != null && trend.swingLow != null && (
              <li className="flex justify-between">
                <span>last swing high / low</span>
                <span>
                  {px(trend.swingHigh)} / {px(trend.swingLow)}
                </span>
              </li>
            )}
            {trend.levels.map((l) => (
              <li key={l.label} className={`flex justify-between ${l.armed ? "text-sky-300" : "text-neutral-600"}`}>
                <span>
                  {up ? "buy above" : "sell below"} ({l.label}){l.armed ? "" : " — already beyond"}
                </span>
                <span>{px(l.price)}</span>
              </li>
            ))}
            {[...trend.zones].reverse().map((z) => (
              <li key={`z${z.low}`} className="flex justify-between">
                <span>
                  support/resistance zone · {z.touches} touches
                  {trend.brokeZone && trend.brokeZone.low === z.low ? " — the last candle closed through it" : ""}
                </span>
                <span>
                  {px(z.low)}–{px(z.high)}
                </span>
              </li>
            ))}
            {trend.sdZones.map((z) => (
              <li key={`sd${z.kind}${z.low}`} className="flex justify-between">
                <span>fresh 1-hour {z.kind} zone</span>
                <span>
                  {px(z.low)}–{px(z.high)}
                </span>
              </li>
            ))}
            {trend.atr != null && (
              <li className="flex justify-between">
                <span>a new trade&apos;s risk (per ounce)</span>
                <span>
                  {px(trend.minRiskAtr * trend.atr)} to {px(trend.maxRiskAtr * trend.atr)}
                </span>
              </li>
            )}
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            Read on the 15-minute candle that closed at {clock(trend.readAt * 1000)}. Support/resistance zones are where {trend.srTouches} or more 1-hour swing highs or lows of the last {trend.srDays} days sit together; a candle that has just closed through one is not traded. Nor is a candle {trend.maxCandleAtr} ATR long or longer, or a {up ? "buy with a fresh 1-hour supply" : "sell with a fresh 1-hour demand"} zone less than {trend.sdAheadR}R ahead (a zone is a small base that price left with a strong candle, fresh until price comes back to it). The stop goes just beyond the {up ? "support" : "resistance"} zone behind the entry, or else beyond the {up ? "low" : "high"} of the last two candles
            {stopSwing != null ? ` (${px(stopSwing)})` : ""}, never closer than {trend.minRiskAtr} ATR or further than {trend.maxRiskAtr} ATR. Take-profit 1:{trend.targetR}; at +{trend.lockAtR}R the stop moves to +{trend.lockToR}R; closed at market after {trend.holdHours} hours. One trade at a time, and no new trade on the same side within {trend.reentryR}R of the last entry for {trend.reentryMinutes} minutes; about two in three close in profit.
          </p>
        </>
      )}
    </div>
  );
}
