import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";

/**
 * Alex G "set & forget": a strong impulse leg that breaks structure leaves an
 * area of interest (AOI) — the 50%–61.8% retracement of that leg. Price is
 * expected to return to the AOI exactly once; the FIRST (untested) touch is
 * the set-and-forget entry. If price has already visited the AOI, the order
 * flow is spent and there is no setup.
 */
export interface SetForgetSetup {
  direction: "long" | "short";
  /** AOI bounds (top/bottom price) */
  aoiTop: number;
  aoiBottom: number;
  /** the impulse leg */
  legLow: Pivot;
  legHigh: Pivot;
  /** level whose break confirmed the leg (prior swing high for longs) */
  brokenLevel: number;
  /** true once price has already traded into the AOI after the impulse */
  tested: boolean;
  /** index of the impulse leg's end pivot */
  legEndIndex: number;
}

const AOI_SHALLOW = 0.5;
const AOI_DEEP = 0.618;
const MIN_LEG_ATR = 2.5;
const LEG_LOOKBACK = 10; // legs among the last N pivots

/**
 * Find the most recent structure-breaking impulse and its AOI. Long: a leg
 * from a swing low that broke a prior swing high. Short mirrors it.
 */
export function findSetForgetSetup(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  preferredDirection?: "long" | "short"
): SetForgetSetup | null {
  if (candles.length === 0) return null;
  const recent = pivots.slice(-LEG_LOOKBACK * 2);

  let best: SetForgetSetup | null = null;

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];
      if (a.kind === b.kind) continue;
      const low = a.kind === "low" ? a : b;
      const high = a.kind === "high" ? a : b;
      const range = high.price - low.price;
      if (range < MIN_LEG_ATR * atrValue) continue;

      let setup: SetForgetSetup | null = null;
      if (low.index < high.index) {
        // bullish leg: must break a prior swing high that sits between the two
        const priorHigh = pivots
          .filter((p) => p.kind === "high" && p.index > low.index && p.index < high.index)
          .sort((x, y) => y.price - x.price)[0];
        if (!priorHigh || high.price <= priorHigh.price) continue;
        setup = {
          direction: "long",
          aoiTop: high.price - AOI_SHALLOW * range,
          aoiBottom: high.price - AOI_DEEP * range,
          legLow: low,
          legHigh: high,
          brokenLevel: priorHigh.price,
          tested: false,
          legEndIndex: high.index,
        };
      } else {
        const priorLow = pivots
          .filter((p) => p.kind === "low" && p.index > high.index && p.index < low.index)
          .sort((x, y) => x.price - y.price)[0];
        if (!priorLow || low.price >= priorLow.price) continue;
        setup = {
          direction: "short",
          aoiBottom: low.price + AOI_SHALLOW * range,
          aoiTop: low.price + AOI_DEEP * range,
          legLow: low,
          legHigh: high,
          brokenLevel: priorLow.price,
          tested: false,
          legEndIndex: low.index,
        };
      }

      // was the AOI already visited by any candle after the leg? Exclude the
      // final (current) candle — its entry IS the first touch we're detecting.
      for (let k = setup.legEndIndex + 1; k < candles.length - 1; k++) {
        const c = candles[k];
        if (c.low <= setup.aoiTop && c.high >= setup.aoiBottom) {
          setup.tested = true;
          break;
        }
      }

      if (preferredDirection && setup.direction !== preferredDirection) continue;
      if (!best || setup.legEndIndex > best.legEndIndex) best = setup;
    }
  }
  return best;
}

/**
 * Core trigger: an UNTESTED AOI that price is entering for the first time on
 * the latest candle.
 */
export function setForgetEntry(
  candles: Candle[],
  setup: SetForgetSetup | null
): { setup: SetForgetSetup; direction: "long" | "short" } | null {
  if (!setup || setup.tested || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const inside = last.low <= setup.aoiTop && last.high >= setup.aoiBottom;
  if (!inside) return null;
  return { setup, direction: setup.direction };
}
