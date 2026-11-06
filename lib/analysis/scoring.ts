import type { Candle, SignalDirection, StrategyId } from "@/lib/types";
import type { Pivot } from "./pivots";
import type { Zone } from "./zones";
import type { StructureState } from "./structure";
import type { FibSetup } from "./fibonacci";
import { classifyStructure } from "./structure";
import { topDownAgrees, type TopDownAnalysis } from "./topDown";
import {
  goldenZoneHasPoi,
  htfAgrees,
  isRejectionCandle,
  rsiTurning,
  zoneIsVeryFresh,
} from "./confirmations";
import { inGoldenZone } from "./fibonacci";
import { detectZoneEntry } from "./zones";
import { setForgetEntry, type SetForgetSetup } from "./setForget";

const REQUIRE_HTF_TREND = (process.env.REQUIRE_HTF_TREND ?? "true") !== "false";
const REQUIRE_M15_TREND = (process.env.REQUIRE_M15_TREND ?? "true") !== "false";

export interface ScoringContext {
  instrument: string;
  candles: Candle[];
  htfCandles: Candle[];
  pivots: Pivot[];
  atrValue: number;
  zones: Zone[];
  fib: FibSetup | null;
  /** Alex G set-and-forget AOI setup (optional). */
  setForget?: SetForgetSetup | null;
  /** Present in live/top-down runs; absent only for legacy test callers. */
  topDown?: TopDownAnalysis;
}

export interface ScoreResult {
  strategy: StrategyId;
  direction: SignalDirection;
  /** the 6 deterministic checks, keyed by label */
  confirmations: Record<string, boolean>;
  /** how many of the 6 are currently true */
  count: number;
  /** signal fires at >= 3 */
  fired: boolean;
  /** False when Weekly/Daily direction conflicts with this setup. */
  topDownAligned: boolean;
  /** False when M15 structure conflicts with this setup. */
  m15Aligned: boolean;
  /** true when no core trigger exists at all — caller should not track state */
  hasTrigger: boolean;
  /** the setup's trigger for risk context */
  trigger: {
    fib?: FibSetup;
    zone?: Zone;
    setForget?: SetForgetSetup;
  } | null;
}

export const SIGNAL_THRESHOLD = 3; // threshold that makes a setup "watchable" / tracked

/** M15 execution-timeframe trend alignment: avoid counter-M15 trades. */
export function m15Agrees(structureState: StructureState, direction: SignalDirection): boolean {
  return (
    (structureState === "uptrend" && direction === "long") ||
    (structureState === "downtrend" && direction === "short")
  );
}

function htfTrendAgrees(ctx: ScoringContext, direction: SignalDirection): boolean {
  if (!REQUIRE_HTF_TREND) return true;
  return ctx.topDown ? topDownAgrees(ctx.topDown, direction) : htfAgrees(ctx.htfCandles, direction);
}

function m15TrendAgrees(pivots: Pivot[], direction: SignalDirection): boolean {
  if (!REQUIRE_M15_TREND) return true;
  return m15Agrees(classifyStructure(pivots), direction);
}

/**
 * 6-point confirmation scoring. Deterministic checks only.
 */
export function scoreSetup(
  strategy: StrategyId,
  ctx: ScoringContext
): ScoreResult {
  const { candles, htfCandles } = ctx;

  let direction: SignalDirection | null = null;
  const confirmations: Record<string, boolean> = {};
  let trigger: ScoreResult["trigger"] = null;

  if (strategy === "zones") {
    const entry = detectZoneEntry(candles, ctx.zones);
    if (!entry) {
      return noTrigger(strategy);
    }
    direction = entry.direction;
    trigger = { zone: entry.zone };
    confirmations["Price entered zone"] = true; // core trigger
    confirmations["Rejection candle in zone"] = isRejectionCandle(candles, direction);
    confirmations["Zone fresh (≤1 touch)"] = zoneIsVeryFresh(entry.zone.touches);
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = htfTrendAgrees(ctx, direction);
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx.pivots, direction);
  } else if (strategy === "setforget") {
    const entry = setForgetEntry(candles, ctx.setForget ?? null);
    if (!entry) {
      return noTrigger(strategy);
    }
    direction = entry.direction;
    trigger = { setForget: entry.setup };
    confirmations["AOI first touch"] = true; // core trigger: untested 50–61.8% area
    confirmations["Rejection candle in AOI"] = isRejectionCandle(candles, direction);
    confirmations["AOI overlaps another POI"] = goldenZoneHasPoi(
      { goldenTop: entry.setup.aoiTop, goldenBottom: entry.setup.aoiBottom },
      { zones: ctx.zones, pivots: ctx.pivots, instrument: ctx.instrument, atrValue: ctx.atrValue }
    );
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = htfTrendAgrees(ctx, direction);
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx.pivots, direction);
  } else {
    const fib = ctx.fib;
    if (!fib || !inGoldenZone(candles, fib)) {
      return noTrigger(strategy);
    }
    direction = fib.direction;
    trigger = { fib };
    confirmations["Price in golden zone"] = true; // core trigger
    confirmations["Rejection candle in zone"] = isRejectionCandle(candles, direction);
    confirmations["Zone overlaps another POI"] = goldenZoneHasPoi(fib, {
      zones: ctx.zones,
      pivots: ctx.pivots,
      instrument: ctx.instrument,
      atrValue: ctx.atrValue,
    });
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = htfTrendAgrees(ctx, direction);
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx.pivots, direction);
  }

  const count = Object.values(confirmations).filter(Boolean).length;
  // Top-down / M15 agreement are confirmation points, not vetoes — a single
  // strategy reaching the threshold can fire on its own (user requirement).
  const topDownAligned = !REQUIRE_HTF_TREND || !ctx.topDown || topDownAgrees(ctx.topDown, direction);
  const m15Aligned = m15TrendAgrees(ctx.pivots, direction);
  return {
    strategy,
    direction,
    confirmations,
    count,
    fired: count >= SIGNAL_THRESHOLD,
    topDownAligned,
    m15Aligned,
    hasTrigger: true,
    trigger,
  };
}

function noTrigger(strategy: StrategyId): ScoreResult {
  return {
    strategy,
    direction: "long",
    confirmations: {},
    count: 0,
    fired: false,
    topDownAligned: false,
    m15Aligned: false,
    hasTrigger: false,
    trigger: null,
  };
}
