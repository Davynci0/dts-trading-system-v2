import type { Candle, SignalDirection } from "@/lib/types";
import { rsiSeries } from "./indicators";
import { classifyStructure } from "./structure";
import { detectPivots } from "./pivots";

/** Rejection candle: pin bar / engulfing / strong wick rejection in the trade direction.
 *  For a high-probability signal the candle must also close in the trade direction
 *  and near the appropriate extreme — a doji or close back through the level is not
 *  a genuine rejection.
 */
export function isRejectionCandle(candles: Candle[], direction: SignalDirection): boolean {
  if (candles.length < 2) return false;
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;

  // The candle must be net in the trade direction and close in the top/bottom half.
  const longDirection = c.close > c.open;
  const shortDirection = c.close < c.open;
  const closeInUpperHalf = c.close > (c.high + c.low) / 2;
  const closeInLowerHalf = c.close < (c.high + c.low) / 2;

  // pin bar / strong wick rejection
  if (
    direction === "long" &&
    longDirection &&
    closeInUpperHalf &&
    lowerWick >= body
  ) {
    return true;
  }
  if (
    direction === "short" &&
    shortDirection &&
    closeInLowerHalf &&
    upperWick >= body
  ) {
    return true;
  }

  // engulfing: current body fully consumes prior body and closes in the right half
  const pBody = Math.abs(p.close - p.open);
  if (
    direction === "long" &&
    longDirection &&
    closeInUpperHalf &&
    p.close < p.open &&
    body > pBody &&
    c.close > p.open
  ) {
    return true;
  }
  if (
    direction === "short" &&
    shortDirection &&
    closeInLowerHalf &&
    p.close > p.open &&
    body > pBody &&
    c.close < p.open
  ) {
    return true;
  }
  return false;
}

/** Conviction close: decisive body in the trigger direction (not a doji). */
export function isConvictionCandle(candles: Candle[], direction: SignalDirection): boolean {
  if (candles.length === 0) return false;
  const c = candles[candles.length - 1];
  const range = c.high - c.low;
  if (range === 0) return false;
  const body = Math.abs(c.close - c.open);
  if (body / range < 0.6) return false;
  return direction === "long" ? c.close > c.open : c.close < c.open;
}

/** RSI turning from a non-extreme level in the trade direction.
 *  Long: RSI was below 50 and is rising (avoid buying overbought bounces).
 *  Short: RSI was above 50 and is falling (avoid selling oversold bounces).
 */
export function rsiTurning(candles: Candle[], direction: SignalDirection): boolean {
  const s = rsiSeries(candles, 14);
  const cur = s[s.length - 1];
  const prev = s[s.length - 2];
  if (cur == null || prev == null) return false;
  if (direction === "long") return cur > prev && prev < 50;
  return cur < prev && prev > 50;
}

/** EMA trend alignment: price closes above/below a 20-period EMA in the trade direction. */
export function emaAligned(candles: Candle[], direction: SignalDirection): boolean {
  if (candles.length < 20) return false;
  const ema20 = ema(candles, 20);
  const lastEma = ema20[ema20.length - 1];
  const lastClose = candles[candles.length - 1].close;
  if (lastEma == null) return false;
  return direction === "long" ? lastClose > lastEma : lastClose < lastEma;
}

/** Simple EMA series. */
function ema(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < candles.length; i++) {
    e = candles[i].close * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/**
 * Higher-timeframe agreement. Lenient by design (Section 3 intent): ranging
 * HTF is neutral and does not block a signal; only an opposing HTF trend fails.
 */
export function htfAgrees(htfCandles: Candle[], direction: SignalDirection): boolean {
  const pivots = detectPivots(htfCandles);
  const state = classifyStructure(pivots);
  const opposing = direction === "long" ? "downtrend" : "uptrend";
  return state !== opposing;
}

/** Zone freshness: a zone tested ≤1 time is strongest; ≤3 is still usable. */
export function zoneIsFresh(touches: number): boolean {
  return touches <= 3;
}

/** High-quality zone freshness for scoring: untested or first-touch only. */
export function zoneIsVeryFresh(touches: number): boolean {
  return touches <= 1;
}

/** Pip size per instrument (round-number POI detection + spread config). */
export function pipSize(instrument: string): number {
  if (instrument.includes("JPY")) return 0.01;
  if (instrument.startsWith("XAU")) return 0.1;
  return 0.0001;
}

/**
 * Golden-zone overlap with another point of interest (Section 3, fib #3):
 * an active supply/demand zone, a round number, or a prior swing level.
 */
export function goldenZoneHasPoi(
  fib: { goldenTop: number; goldenBottom: number },
  opts: {
    zones: { top: number; bottom: number; active: boolean }[];
    pivots: { price: number }[];
    instrument: string;
    atrValue: number;
  }
): boolean {
  const { zones, pivots, instrument, atrValue } = opts;

  // overlap with an active zone
  for (const z of zones) {
    if (z.active && !(fib.goldenTop < z.bottom || fib.goldenBottom > z.top)) return true;
  }

  // round number (50-pip grid) inside the golden zone
  const step = 50 * pipSize(instrument);
  const lo = Math.min(fib.goldenBottom, fib.goldenTop);
  const hi = Math.max(fib.goldenBottom, fib.goldenTop);
  const k0 = Math.ceil(lo / step);
  if (k0 * step <= hi) return true;

  // prior swing level within a small tolerance of the zone
  const tol = 0.2 * atrValue;
  for (const p of pivots) {
    if (p.price > lo - tol && p.price < hi + tol) return true;
  }
  return false;
}
