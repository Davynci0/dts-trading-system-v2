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
 *
 * `preferredDirection` biases selection toward the current market structure,
 * but a strong opposite-direction setup is still returned if no aligned one
 * exists — the ranking layer decides whether to act on it.
 */
function betterFib(candidate: FibSetup, best: FibSetup | null, lastClose: number): boolean {
  if (!best) return true;
  const inZone = (s: FibSetup) => lastClose <= s.goldenTop && lastClose >= s.goldenBottom;
  const candIn = inZone(candidate);
  const bestIn = inZone(best);
  if (candIn !== bestIn) return candIn;
  const candEnd = candidate.direction === "long" ? candidate.swingHigh.index : candidate.swingLow.index;
  const bestEnd = best.direction === "long" ? best.swingHigh.index : best.swingLow.index;
  if (candEnd !== bestEnd) return candEnd > bestEnd;
  return candidate.range > best.range;
}

export function findFibSetup(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  lookbackCandles = DEFAULT_FIB_LOOKBACK,
  preferredDirection?: "long" | "short"
): FibSetup | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const minIndex = Math.max(0, candles.length - lookbackCandles);
  const recent = pivots.filter((p) => p.index >= minIndex);

  let bestAligned: FibSetup | null = null;
  let bestCounter: FibSetup | null = null;

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];
      if (a.kind === b.kind) continue;

      const low = a.kind === "low" ? a : b;
      const high = a.kind === "high" ? a : b;
      const range = high.price - low.price;
      if (range < MIN_SWING_ATR * atrValue) continue;

      let setup: FibSetup;
      if (low.index < high.index) {
        // up-swing → bullish retracement; price must be below the high
        const goldenTop = high.price - GOLDEN_LOW * range;
        const goldenBottom = high.price - GOLDEN_HIGH * range;
        if (last.close >= high.price || last.close <= low.price) continue; // not retracing / invalidated
        setup = { direction: "long", swingLow: low, swingHigh: high, goldenTop, goldenBottom, range };
      } else {
        // down-swing → bearish retracement
        const goldenBottom = low.price + GOLDEN_LOW * range;
        const goldenTop = low.price + GOLDEN_HIGH * range;
        if (last.close <= low.price || last.close >= high.price) continue;
        setup = { direction: "short", swingLow: low, swingHigh: high, goldenTop, goldenBottom, range };
      }

      const aligned = !preferredDirection || setup.direction === preferredDirection;
      if (aligned) {
        if (betterFib(setup, bestAligned, last.close)) bestAligned = setup;
      } else {
        if (betterFib(setup, bestCounter, last.close)) bestCounter = setup;
      }
    }
  }

  // Prefer the structure-aligned setup. Only fall back to a counter-trend setup
  // when no aligned setup exists, and then only if price is actually inside it.
  if (bestAligned) return bestAligned;
  if (bestCounter && last.close <= bestCounter.goldenTop && last.close >= bestCounter.goldenBottom) {
    return bestCounter;
  }
  return null;
}

/** Core trigger (Section 2.3): latest candle's range overlaps the golden zone. */
export function inGoldenZone(candles: Candle[], fib: FibSetup): boolean {
  if (candles.length === 0) return false;
  const last = candles[candles.length - 1];
  return last.low <= fib.goldenTop && last.high >= fib.goldenBottom;
}
