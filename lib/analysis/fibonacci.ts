import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";

export interface FibSetup {
  /** long = retracement of an up-swing (buy the dip), short = retracement of a down-swing */
  direction: "long" | "short";
  swingLow: Pivot;
  swingHigh: Pivot;
  /** golden zone bounds (Section 2.3: 61.8%–78.6% retracement) */
  goldenTop: number;
  goldenBottom: number;
  range: number;
}

const GOLDEN_LOW = 0.618;
const GOLDEN_HIGH = 0.786;
const MIN_SWING_ATR = 2.5; // swing must be a "clear recent swing", not noise
// candles a swing leg's pivots must fall within — keeps the fib retracement
// anchored to a genuinely recent swing (Section 2.3) instead of one picked
// from anywhere in the whole fetch window.
const DEFAULT_FIB_LOOKBACK = 150;

/**
 * Fibonacci retracement on the most recent significant swing (Section 2.3).
 * Finds the latest pivot leg (low→high for longs, high→low for shorts) whose
 * range is meaningful vs ATR, and computes the 61.8%–78.6% golden zone box.
 * The setup stays valid until price closes beyond the swing origin.
 */
export function findFibSetup(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  lookbackCandles = DEFAULT_FIB_LOOKBACK
): FibSetup | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const minIndex = Math.max(0, candles.length - lookbackCandles);
  const recent = pivots.filter((p) => p.index >= minIndex);

  let best: FibSetup | null = null;

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];
      if (a.kind === b.kind) continue;

      const low = a.kind === "low" ? a : b;
      const high = a.kind === "high" ? a : b;
      const range = high.price - low.price;
      if (range < MIN_SWING_ATR * atrValue) continue;

      if (low.index < high.index) {
        // up-swing → bullish retracement; price must be below the high
        const goldenTop = high.price - GOLDEN_LOW * range;
        const goldenBottom = high.price - GOLDEN_HIGH * range;
        if (last.close >= high.price || last.close <= low.price) continue; // not retracing / invalidated
        const setup: FibSetup = { direction: "long", swingLow: low, swingHigh: high, goldenTop, goldenBottom, range };
        if (!best || high.index > best.swingHigh.index) best = setup;
      } else {
        // down-swing → bearish retracement
        const goldenBottom = low.price + GOLDEN_LOW * range;
        const goldenTop = low.price + GOLDEN_HIGH * range;
        if (last.close <= low.price || last.close >= high.price) continue;
        const setup: FibSetup = { direction: "short", swingLow: low, swingHigh: high, goldenTop, goldenBottom, range };
        if (!best || low.index > best.swingLow.index) best = setup;
      }
    }
  }

  return best;
}

/** Core trigger (Section 2.3): latest candle's range overlaps the golden zone. */
export function inGoldenZone(candles: Candle[], fib: FibSetup): boolean {
  if (candles.length === 0) return false;
  const last = candles[candles.length - 1];
  return last.low <= fib.goldenTop && last.high >= fib.goldenBottom;
}
