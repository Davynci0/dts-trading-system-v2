import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";

/**
 * Head-and-Shoulders / Inverse Head-and-Shoulders reversal pattern.
 * Structure requires 5 consecutive alternating structural pivots
 * (LS → N1 → H → N2 → RS). Fires on a CLOSED break of the neckline, not a touch.
 */

export interface HeadShouldersPattern {
  direction: "short" | "long"; // bearish or bullish
  ls: Pivot;      // left shoulder
  n1: Pivot;      // first neckline point
  h: Pivot;       // head (most extreme)
  n2: Pivot;      // second neckline point
  rs: Pivot;      // right shoulder
  necklineSlope: number; // (price at n2 - price at n1) / (n2.time - n1.time)
  necklineStartPrice: number;
  necklineEndPrice: number;
  /** distance from neckline to head, projected to give the target */
  target: number;
  triggerTime: number;    // time of neckline break close
}

/** A neckline break older than this many bars is history, not a signal. */
const BREAK_ACTIVE_BARS = 12;
/** The right shoulder must be this recent for the formation to matter. */
const MAX_BARS_SINCE_SHOULDER = 120;
/** Shoulders may differ by at most this share of the taller shoulder's depth. */
const SHOULDER_SYMMETRY = 0.5;
/** Neckline points may differ by at most this many ATR (roughly horizontal). */
const NECKLINE_FLAT_ATR = 0.75;

/**
 * Find the most recent H&S / inverse H&S formation in the latest structural
 * pivots and report it while its neckline break is still fresh.
 *
 * The pattern is active when a candle CLOSED through the neckline after the
 * right shoulder, that break is at most BREAK_ACTIVE_BARS old, and price has
 * not closed back across the neckline since. `triggerTime` is the break
 * candle. (All spans are counted in bars — `Candle.time` is in seconds, so a
 * millisecond-style window here once made every old formation "recent".)
 */
export function detectHeadShoulders(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number
): HeadShouldersPattern | null {
  if (candles.length < 40 || pivots.length < 5 || atrValue <= 0) return null;
  const lastIndex = candles.length - 1;
  const recent = pivots.slice(-7);

  // newest 5-pivot run first
  for (let start = recent.length - 5; start >= 0; start--) {
    const [ls, n1, h, n2, rs] = recent.slice(start, start + 5);
    const bearish =
      ls.kind === "high" && n1.kind === "low" && h.kind === "high" && n2.kind === "low" && rs.kind === "high";
    const bullish =
      ls.kind === "low" && n1.kind === "high" && h.kind === "low" && n2.kind === "high" && rs.kind === "low";
    if (!bearish && !bullish) continue;
    if (lastIndex - rs.index > MAX_BARS_SINCE_SHOULDER) continue;

    // sign = +1 for the bearish (top) pattern, −1 for the inverse
    const sign = bearish ? 1 : -1;
    const lsDepth = sign * (h.price - ls.price);
    const rsDepth = sign * (h.price - rs.price);
    if (lsDepth <= 0 || rsDepth <= 0) continue; // head must be the extreme
    if (Math.abs(lsDepth - rsDepth) > Math.max(lsDepth, rsDepth) * SHOULDER_SYMMETRY) continue;
    if (Math.abs(n2.price - n1.price) > NECKLINE_FLAT_ATR * atrValue) continue;

    const span = n2.time - n1.time;
    const slopePerSec = span > 0 ? (n2.price - n1.price) / span : 0;
    const necklineAt = (time: number) => n2.price + slopePerSec * (time - n2.time);
    const beyond = (c: Candle) => sign * (necklineAt(c.time) - c.close) > 0;

    // first close through the neckline after the right shoulder
    let breakIndex = -1;
    for (let k = rs.index + 1; k <= lastIndex; k++) {
      if (beyond(candles[k])) {
        breakIndex = k;
        break;
      }
    }
    if (breakIndex < 0 || lastIndex - breakIndex > BREAK_ACTIVE_BARS) continue;
    // a close back across the neckline cancels the break
    let held = true;
    for (let k = breakIndex + 1; k <= lastIndex; k++) {
      if (!beyond(candles[k])) {
        held = false;
        break;
      }
    }
    if (!held) continue;

    const breakCandle = candles[breakIndex];
    const necklinePrice = necklineAt(breakCandle.time);
    const headToNeckline = Math.abs(h.price - necklineAt(h.time));
    return {
      direction: bearish ? "short" : "long",
      ls,
      n1,
      h,
      n2,
      rs,
      necklineSlope: slopePerSec,
      necklineStartPrice: n1.price,
      necklineEndPrice: n2.price,
      target: necklinePrice - sign * headToNeckline,
      triggerTime: breakCandle.time,
    };
  }

  return null;
}
