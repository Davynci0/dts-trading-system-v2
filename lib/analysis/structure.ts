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
  type: "bos" | "choch" | "zone_reentry";
  direction: "long" | "short";
  /** price level that was broken (bos/choch) or zone that was re-entered */
  level: number;
  /** size of the break in ATR (only set for bos/choch) */
  breakSizeAtr?: number;
  /** the zone involved, for zone re-entry (drives the freshness confirmation) */
  zone?: Zone;
}

const MIN_BOS_ATR = 0.15; // a break must be at least this many ATR beyond the level to be real, not spread noise
/**
 * Core trigger (Section 2.2): a break of structure — the latest candle closed
 * through the most recent relevant swing point in the trend direction — a
 * change-of-character (CHoCH) against the prior trend, or price re-entering a
 * still-active supply/demand zone from outside. A break must exceed a small
 * ATR margin so spread noise doesn't fire the strategy.
 */
export function detectStructureEvent(
  candles: Candle[],
  pivots: Pivot[],
  zones: Zone[],
  atrValue?: number
): StructureEvent | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const state = classifyStructure(pivots);

  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const prevHigh = highs[highs.length - 2];
  const prevLow = lows[lows.length - 2];

  const margin = (atrValue ?? 0) * MIN_BOS_ATR;

  // Trend-following BOS: close beyond the most recent swing in trend direction
  if (state === "uptrend" && lastHigh && prev.close <= lastHigh.price && last.close > lastHigh.price + margin) {
    return {
      type: "bos",
      direction: "long",
      level: lastHigh.price,
      breakSizeAtr: atrValue ? (last.close - lastHigh.price) / atrValue : undefined,
    };
  }
  if (state === "downtrend" && lastLow && prev.close >= lastLow.price && last.close < lastLow.price - margin) {
    return {
      type: "bos",
      direction: "short",
      level: lastLow.price,
      breakSizeAtr: atrValue ? (lastLow.price - last.close) / atrValue : undefined,
    };
  }

  // CHoCH: price takes out the prior swing in the opposite direction, signalling
  // a probable trend reversal on the execution timeframe.
  if (state === "downtrend" && prevHigh && last.close > prevHigh.price + margin) {
    return {
      type: "choch",
      direction: "long",
      level: prevHigh.price,
      breakSizeAtr: atrValue ? (last.close - prevHigh.price) / atrValue : undefined,
    };
  }
  if (state === "uptrend" && prevLow && last.close < prevLow.price - margin) {
    return {
      type: "choch",
      direction: "short",
      level: prevLow.price,
      breakSizeAtr: atrValue ? (prevLow.price - last.close) / atrValue : undefined,
    };
  }

  // zone re-entry: previous candle fully outside, latest candle back inside
  for (const z of zones) {
    if (!z.active) continue;
    const wasOutside = prev.low > z.top || prev.high < z.bottom;
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
