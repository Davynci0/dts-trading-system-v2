import type { Candle, SignalDirection } from "@/lib/types";
import { detectPivots, significantPivots, type Pivot } from "./pivots";
import { atr } from "./indicators";
import { detectZones, type Zone } from "./zones";
import { detectTrendlines, type Trendline } from "./trendlines";
import {
  classifyStructure,
  detectStructureEvent,
  type StructureEvent,
  type StructureState,
} from "./structure";
import { findFibSetup, type FibSetup } from "./fibonacci";
import { findSetForgetSetup, type SetForgetSetup } from "./setForget";

export const MIN_TRADEABLE_ATR = 0.0003; // ~3 pips on EUR/USD; reject spread-dominated low-volatility bars

/** Live TA and signals run on 15-minute candles only. */
export const EXECUTION_TIMEFRAME = "M15" as const;
export const EXECUTION_HTF = "H1" as const;

/** 5-bar fractal on M15 = 2.5h each side — real swings, not 45-minute noise. */
export const M15_PIVOT_K = 5;
export const M15_SWING_ATR = 0.75;
export const M15_TRENDLINE_LOOKBACK = 200;

export interface M15Analysis {
  candles: Candle[];
  pivots: Pivot[];
  structuralPivots: Pivot[];
  atrValue: number;
  zones: Zone[];
  trendlines: Trendline[];
  structureState: StructureState;
  structureEvent: StructureEvent | null;
  fib: FibSetup | null;
  setForget: SetForgetSetup | null;
  preferredDirection: SignalDirection | null;
  structureMarkers: { time: number; price: number; label: "HH" | "HL" | "LH" | "LL" }[];
}

function structureMarkers(pivots: Pivot[]): M15Analysis["structureMarkers"] {
  const markers: M15Analysis["structureMarkers"] = [];
  let priorHigh: Pivot | null = null;
  let priorLow: Pivot | null = null;

  for (const pivot of pivots) {
    if (pivot.kind === "high") {
      if (priorHigh) {
        markers.push({
          time: pivot.time,
          price: pivot.price,
          label: pivot.price > priorHigh.price ? "HH" : "LH",
        });
      }
      priorHigh = pivot;
    } else {
      if (priorLow) {
        markers.push({
          time: pivot.time,
          price: pivot.price,
          label: pivot.price > priorLow.price ? "HL" : "LL",
        });
      }
      priorLow = pivot;
    }
  }
  return markers.slice(-8);
}

/**
 * All chart overlays and strategy inputs for the execution timeframe.
 * Weekly/Daily/H4 are bias filters only — they do not supply lines or swings.
 */
export function analyzeM15(candles: Candle[]): M15Analysis | null {
  if (candles.length < 60) return null;
  const pivots = detectPivots(candles, M15_PIVOT_K);
  const atrValue = atr(candles);
  if (atrValue == null || atrValue < MIN_TRADEABLE_ATR) return null;

  const structuralPivots = significantPivots(pivots, atrValue, M15_SWING_ATR);
  const zones = detectZones(candles);
  const trendlines = detectTrendlines(candles, pivots, atrValue, false, M15_TRENDLINE_LOOKBACK);
  const structureState = classifyStructure(structuralPivots);
  const preferredDirection: SignalDirection | null =
    structureState === "uptrend" ? "long" : structureState === "downtrend" ? "short" : null;
  const structureEvent = detectStructureEvent(candles, structuralPivots, zones, atrValue);
  const fib = findFibSetup(
    candles,
    structuralPivots,
    atrValue,
    M15_TRENDLINE_LOOKBACK,
    preferredDirection ?? undefined
  );
  const setForget = findSetForgetSetup(candles, structuralPivots, atrValue, preferredDirection ?? undefined);

  return {
    candles,
    pivots,
    structuralPivots,
    atrValue,
    zones,
    trendlines,
    structureState,
    structureEvent,
    fib,
    setForget,
    preferredDirection,
    structureMarkers: structureMarkers(structuralPivots),
  };
}

/** Active zones close enough to price to matter on the M15 chart. */
export function nearbyActiveZones(zones: Zone[], price: number, atrValue: number, limit = 6): Zone[] {
  return zones
    .filter((z) => z.active && price <= z.top + 3 * atrValue && price >= z.bottom - 3 * atrValue)
    .sort((a, b) => b.startIndex - a.startIndex)
    .slice(0, limit);
}
