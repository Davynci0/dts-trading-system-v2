import type { Candle } from "@/lib/types";

export interface Pivot {
  /** index into the candles array */
  index: number;
  /** epoch seconds */
  time: number;
  /** high (for swing highs) or low (for swing lows) of the pivot candle */
  price: number;
  kind: "high" | "low";
}

/**
 * Fractal swing-point detection: a candle is a pivot high when its high is
 * strictly greater than the k candles on either side (mirror for lows).
 * These pivots are THE structural reference points for the whole system —
 * stop placement (Section 4), trendline construction (2.1), market structure
 * (2.2), and fib swings (2.3) all consume this same output, so detection and
 * rendering can never drift apart (Section 9).
 */
export function detectPivots(candles: Candle[], k = 3): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ index: i, time: c.time, price: c.high, kind: "high" });
    if (isLow) pivots.push({ index: i, time: c.time, price: c.low, kind: "low" });
  }
  return pivots;
}

/**
 * Zigzag filter over the fractal pivots: keeps alternating highs/lows whose
 * swing is at least `minAtr` × ATR, so micro zig-zags don't become structure.
 * Consecutive pivots of the same kind collapse to the more extreme one.
 * `detectPivots` itself stays raw for the structure/trendline code.
 */
export function significantPivots(pivots: Pivot[], atrValue: number, minAtr = 0.5): Pivot[] {
  const minMove = minAtr * atrValue;
  const out: Pivot[] = [];
  for (const p of pivots) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
    } else if (last.kind === p.kind) {
      // same direction continues: keep the further extreme
      if (p.kind === "high" ? p.price > last.price : p.price < last.price) out[out.length - 1] = p;
    } else if (Math.abs(p.price - last.price) >= minMove) {
      out.push(p);
    }
  }
  return out;
}
