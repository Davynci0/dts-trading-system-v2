import type { Candle, SignalDirection } from "@/lib/types";
import { rsiSeries } from "./indicators";
import { classifyStructure } from "./structure";
import { detectPivots } from "./pivots";

/** Rejection candle: pin bar / engulfing / strong wick rejection in the trade direction. */
export function isRejectionCandle(candles: Candle[], direction: SignalDirection): boolean {
  if (candles.length < 2) return false;
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;

  // pin bar / strong wick rejection
  if (direction === "long" && lowerWick >= 2 * body && c.close > (c.high + c.low) / 2) return true;
  if (direction === "short" && upperWick >= 2 * body && c.close < (c.high + c.low) / 2) return true;

  // engulfing
  const pBody = Math.abs(p.close - p.open);
  if (
    direction === "long" &&
    c.close > c.open &&
    p.close < p.open &&
    body > pBody &&
    c.close > p.open
  ) {
    return true;
  }
  if (
    direction === "short" &&
    c.close < c.open &&
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

/** RSI turning in the trade direction (latest vs previous reading). */
export function rsiTurning(candles: Candle[], direction: SignalDirection): boolean {
  const s = rsiSeries(candles, 14);
  const cur = s[s.length - 1];
  const prev = s[s.length - 2];
  if (cur == null || prev == null) return false;
  return direction === "long" ? cur > prev : cur < prev;
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

/** Zone freshness: a zone tested ≤3 times still has unfilled orders (Section 3, structure #3). */
export function zoneIsFresh(touches: number): boolean {
  return touches <= 3;
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
