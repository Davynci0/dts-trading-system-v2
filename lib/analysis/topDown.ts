import type { Candle, SignalDirection } from "@/lib/types";
import { atr } from "./indicators";
import { detectPivots } from "./pivots";
import { classifyStructure, type StructureState } from "./structure";
import { detectTrendlines, type Trendline } from "./trendlines";

export type TopDownBias = "bullish" | "bearish" | "neutral";

export interface TopDownCandles {
  weekly: Candle[];
  daily: Candle[];
  h4: Candle[];
  h1: Candle[];
}

export interface TopDownAnalysis {
  weekly: StructureState;
  daily: StructureState;
  h4: StructureState;
  h1: StructureState;
  bias: TopDownBias;
  /** H4 line that matches the weekly/daily directional bias. */
  actionLine: Trendline | null;
  /** Opposing H4 boundary used as a safety/context line, never a trigger. */
  safetyLine: Trendline | null;
}

const ToriActionLineTouches = 3;
const ToriH4Lookback = 150;

function structureOf(candles: Candle[]): StructureState {
  return candles.length >= 10 ? classifyStructure(detectPivots(candles)) : "ranging";
}

function resolveBias(
  weekly: StructureState,
  daily: StructureState,
  h4: StructureState,
  h1: StructureState
): TopDownBias {
  const toBias = (state: StructureState): TopDownBias =>
    state === "uptrend" ? "bullish" : state === "downtrend" ? "bearish" : "neutral";
  const weeklyBias = toBias(weekly);
  const dailyBias = toBias(daily);
  const h4Bias = toBias(h4);
  const h1Bias = toBias(h1);

  // Weekly/Daily lead. A disagreement means there is no clean macro bias.
  if (weeklyBias !== "neutral" && dailyBias !== "neutral") {
    return weeklyBias === dailyBias ? weeklyBias : "neutral";
  }
  // H4/H1 refine the bias when weekly/daily are not both directional.
  if (h4Bias !== "neutral" && h1Bias !== "neutral" && h4Bias === h1Bias) {
    return h4Bias;
  }
  return dailyBias !== "neutral" ? dailyBias : weeklyBias;
}

/**
 * Tori-style top-down analysis: Weekly/Daily determine directional bias;
 * H4 defines the action line and opposing safety line; H1 is added as an
 * additional confirmation/bias timeframe; lower timeframes are reserved for
 * confirmation and execution.
 */
export function analyzeTopDown(frames: TopDownCandles): TopDownAnalysis {
  const weekly = structureOf(frames.weekly);
  const daily = structureOf(frames.daily);
  const h4 = structureOf(frames.h4);
  const h1 = structureOf(frames.h1);
  const bias = resolveBias(weekly, daily, h4, h1);

  const h4Atr = atr(frames.h4);
  if (h4Atr == null || bias === "neutral") {
    return { weekly, daily, h4, h1, bias, actionLine: null, safetyLine: null };
  }

  const h4Pivots = detectPivots(frames.h4);
  // A top-down action line needs three confirmed touches; two pivots define a
  // ray, but the third is what validates it as current market structure.
  const h4Lines = detectTrendlines(
    frames.h4,
    h4Pivots,
    h4Atr,
    false,
    ToriH4Lookback,
    ToriActionLineTouches
  );
  const actionKind = bias === "bullish" ? "support" : "resistance";
  const safetyKind = actionKind === "support" ? "resistance" : "support";
  const h4OpposesBias =
    (bias === "bullish" && h4 === "downtrend") ||
    (bias === "bearish" && h4 === "uptrend");

  return {
    weekly,
    daily,
    h4,
    h1,
    bias,
    actionLine: h4OpposesBias ? null : h4Lines.find((line) => line.kind === actionKind) ?? null,
    safetyLine: h4Lines.find((line) => line.kind === safetyKind) ?? null,
  };
}

/** A lower-timeframe setup may only count HTF agreement when the macro bias agrees. */
export function topDownAgrees(analysis: TopDownAnalysis, direction: SignalDirection): boolean {
  const macroAgrees =
    (analysis.bias === "bullish" && direction === "long") ||
    (analysis.bias === "bearish" && direction === "short");
  const h4Opposes =
    (direction === "long" && analysis.h4 === "downtrend") ||
    (direction === "short" && analysis.h4 === "uptrend");
  const h1Opposes =
    (direction === "long" && analysis.h1 === "downtrend") ||
    (direction === "short" && analysis.h1 === "uptrend");
  return macroAgrees && !h4Opposes && !h1Opposes;
}
