import type { Candle, SignalDirection } from "@/lib/types";
import { detectPivots, significantPivots, type Pivot } from "./pivots";
import { atr } from "./indicators";
import { detectZones, type Zone } from "./zones";
import { findFibSetup, type FibSetup } from "./fibonacci";
import { findSetForgetSetup, type SetForgetSetup } from "./setForget";
import { classifyStructure, type StructureState } from "./structure";
import { detectTrendlines, type Trendline } from "./trendlines";
import { detectHeadShoulders, type HeadShouldersPattern } from "./headshoulders";
import { typicalSpread } from "./instruments";

/** A market is only worth analysing when a typical bar is several spreads
 *  wide; below this the spread dominates every stop. (An absolute price floor
 *  can't do this job — 0.0003 is 3 pips on EUR/USD but nothing on JPY or gold.) */
export const MIN_ATR_SPREADS = 2.5;

/** Live TA and signals run on 4-hour candles only; daily candles are the
 *  higher timeframe (key levels, the daily trend). */
export const EXECUTION_TIMEFRAME = "H4" as const;
export const EXECUTION_HTF = "D" as const;
/** Length of one execution bar. */
export const EXECUTION_BAR_SECONDS = 4 * 3600;
/** Candles of each series the scanner, the chart and the backtest analyse. */
export const EXECUTION_CANDLES = 500;
export const HTF_CANDLES = 300;

/** 5-bar fractal on H4 = 20h each side — swings that took about a day to form. */
export const PIVOT_K = 5;
export const SWING_ATR = 0.75;
export const TRENDLINE_LOOKBACK = 200;


export interface ExecutionAnalysis {
  candles: Candle[];
  pivots: Pivot[];
  structuralPivots: Pivot[];
  atrValue: number;
  zones: Zone[];
  fib: FibSetup | null;
  setForget: SetForgetSetup | null;
  trendlines: Trendline[];
  /** Head-and-shoulders/inverse-H&S patterns currently active. Empty most scans. */
  headShoulders: HeadShouldersPattern[];
  preferredDirection: SignalDirection | null;
  structureState: StructureState;
}

/**
 * Full execution-timeframe (H4) read of one instrument. `instrument` enables the spread-relative
 * volatility floor; without it only a zero/unknown ATR is rejected.
 */
export function analyzeExecution(candles: Candle[], instrument?: string): ExecutionAnalysis | null {
  if (candles.length < 60) return null;
  const pivots = detectPivots(candles, PIVOT_K);
  const atrValue = atr(candles);
  if (atrValue == null || atrValue <= 0) return null;
  if (instrument && atrValue < MIN_ATR_SPREADS * typicalSpread(instrument)) return null;

  const structuralPivots = significantPivots(pivots, atrValue, SWING_ATR);
  const zones = detectZones(candles);
  const structureState = classifyStructure(structuralPivots);
  const preferredDirection: SignalDirection | null =
    structureState === "uptrend" ? "long" : structureState === "downtrend" ? "short" : null;
  const fib = findFibSetup(
    candles,
    structuralPivots,
    atrValue,
    TRENDLINE_LOOKBACK,
    preferredDirection ?? undefined
  );
  const setForget = findSetForgetSetup(candles, structuralPivots, atrValue, preferredDirection ?? undefined);
  const trendlines = detectTrendlines(candles, structuralPivots, atrValue, true, TRENDLINE_LOOKBACK, 3);
  const headShoulders: HeadShouldersPattern[] = [];
  {
    const hs = detectHeadShoulders(candles, structuralPivots, atrValue);
    if (hs) headShoulders.push(hs);
  }

  return {
    candles,
    pivots,
    structuralPivots,
    atrValue,
    zones,
    fib,
    setForget,
    trendlines,
    headShoulders,
    preferredDirection,
    structureState,
  };
}

/** Active zones close enough to price to matter on the chart. */
export function nearbyActiveZones(zones: Zone[], price: number, atrValue: number, limit = 6): Zone[] {
  return zones
    .filter((z) => z.active && price <= z.top + 3 * atrValue && price >= z.bottom - 3 * atrValue)
    .sort((a, b) => b.startIndex - a.startIndex)
    .slice(0, limit);
}
