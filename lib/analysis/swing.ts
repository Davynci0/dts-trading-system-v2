import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";

/**
 * Is the leg between these two pivots still a real, standing swing?
 *
 * Any low/high pair of pivots is not automatically a "swing leg". For an
 * up-leg (low first) it must hold that:
 *  - the low is the lowest point and the high the highest point INSIDE the leg
 *    (otherwise the true swing starts or ends somewhere else),
 *  - price has not traded above the high since (the swing would have
 *    extended, so retracement levels measured from the old high are stale),
 *  - no candle has CLOSED below the low since (the swing is invalidated).
 * A down-leg mirrors it. Retracement setups (fib golden zone, set & forget
 * AOI) are only meaningful on legs that pass this.
 */
export function legIsIntact(candles: Candle[], low: Pivot, high: Pivot): boolean {
  const up = low.index < high.index;
  const start = up ? low.index : high.index;
  const end = up ? high.index : low.index;
  if (start < 0 || end >= candles.length) return false;

  for (let k = start + 1; k < end; k++) {
    const c = candles[k];
    if (c.low < low.price || c.high > high.price) return false;
  }
  for (let k = end + 1; k < candles.length; k++) {
    const c = candles[k];
    if (up) {
      if (c.high > high.price || c.close < low.price) return false;
    } else {
      if (c.low < low.price || c.close > high.price) return false;
    }
  }
  return true;
}
