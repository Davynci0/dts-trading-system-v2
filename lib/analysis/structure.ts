import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";
import type { Zone } from "./zones";

export type StructureState = "uptrend" | "downtrend" | "ranging";

/**
 * Swing-structure classification (Section 2.2): HH+HL → uptrend,
 * LH+LL → downtrend, otherwise ranging.
 */
export function classifyStructure(pivots: Pivot[]): StructureState {
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");
  if (highs.length < 2 || lows.length < 2) return "ranging";

  const [prevH, lastH] = highs.slice(-2);
  const [prevL, lastL] = lows.slice(-2);

  const up = lastH.price > prevH.price && lastL.price > prevL.price;
  const down = lastH.price < prevH.price && lastL.price < prevL.price;
  return up ? "uptrend" : down ? "downtrend" : "ranging";
}

export interface StructureEvent {
  type: "bos" | "zone_reentry";
  direction: "long" | "short";
  /** price level that was broken (bos) or zone that was re-entered */
  level: number;
  /** the zone involved, for zone re-entry (drives the freshness confirmation) */
  zone?: Zone;
}

/**
 * Core trigger (Section 2.2): a break of structure — the latest candle closed
 * through the most recent relevant swing point in the trend direction — or
 * price re-entering a still-active supply/demand zone from outside.
 */
export function detectStructureEvent(
  candles: Candle[],
  pivots: Pivot[],
  zones: Zone[]
): StructureEvent | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const state = classifyStructure(pivots);

  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  // BOS gets priority over zone re-entry
  if (state === "uptrend" && lastHigh && prev.close <= lastHigh.price && last.close > lastHigh.price) {
    return { type: "bos", direction: "long", level: lastHigh.price };
  }
  if (state === "downtrend" && lastLow && prev.close >= lastLow.price && last.close < lastLow.price) {
    return { type: "bos", direction: "short", level: lastLow.price };
  }

  // zone re-entry: previous candle fully outside, latest candle back inside
  for (const z of zones) {
    if (!z.active) continue;
    const wasOutside =
      prev.low > z.top || prev.high < z.bottom;
    const nowInside = last.low <= z.top && last.high >= z.bottom;
    if (wasOutside && nowInside) {
      return {
        type: "zone_reentry",
        direction: z.kind === "demand" ? "long" : "short",
        level: z.kind === "demand" ? z.top : z.bottom,
        zone: z,
      };
    }
  }

  return null;
}
