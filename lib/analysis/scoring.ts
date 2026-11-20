import type { Candle, SignalDirection, StrategyId } from "@/lib/types";
import type { Pivot } from "./pivots";
import type { Zone } from "./zones";
import type { StructureState } from "./structure";
import type { FibSetup } from "./fibonacci";
import { classifyStructure } from "./structure";
import { topDownAgrees, topDownOpposes, type TopDownAnalysis } from "./topDown";
import { inTradingSession } from "./session";
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
import type { HeadShouldersPattern } from "./headshoulders";
import { detectBreakout, type BreakoutSetup } from "./breakout";

const REQUIRE_HTF_TREND = (process.env.REQUIRE_HTF_TREND ?? "true") !== "false";
const REQUIRE_M15_TREND = (process.env.REQUIRE_M15_TREND ?? "true") !== "false";

/** Per-pair trend filter mode. Override the global REQUIRE_* settings per pair.
 *  Values: BOTH (default from global), M15 (M15 only), HTF (HTF only), NONE.
 *  Set via TREND_MODE_XAU_USD=M15, TREND_MODE_GBP_JPY=BOTH, etc. */
export type TrendMode = "BOTH" | "M15" | "HTF" | "NONE";

export function trendModeFor(instrument: string): { htf: boolean; m15: boolean } {
  const raw = process.env[`TREND_MODE_${instrument}`]?.toUpperCase();
  if (raw === "M15") return { htf: false, m15: true };
  if (raw === "HTF") return { htf: true, m15: false };
  if (raw === "NONE") return { htf: false, m15: false };
  if (raw === "BOTH") return { htf: true, m15: true };
  return { htf: REQUIRE_HTF_TREND, m15: REQUIRE_M15_TREND };
}

export interface ScoringContext {
  instrument: string;
  candles: Candle[];
  htfCandles: Candle[];
  pivots: Pivot[];
  /** Zigzag-filtered swings (analyzeM15.structuralPivots). The M15 trend and
   *  prior-level checks read these so scoring sees the same structure the
   *  setups were built from; falls back to `pivots` for legacy callers. */
  structuralPivots?: Pivot[];
  atrValue: number;
  zones: Zone[];
  fib: FibSetup | null;
  /** Alex G set-and-forget AOI setup (optional). */
  setForget?: SetForgetSetup | null;
  /** Present in live/top-down runs; absent only for legacy test callers. */
  topDown?: TopDownAnalysis;
  /** Per-pair trend filter override; defaults from REQUIRE_* env vars. */
  trendMode?: { htf: boolean; m15: boolean };
  /** Active H&S / inverse-H&S reversal patterns (neckline break just fired). */
  headShoulders?: HeadShouldersPattern[];
  /** Closed daily candles — the trend breakout's daily-trend filter. */
  daily?: Candle[];
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
  /** False when the weekly structure opposes this setup (send-gate veto). */
  topDownAligned: boolean;
  /** False when M15 structure conflicts with this setup. */
  m15Aligned: boolean;
  /** False when the entry would fall outside the trading session. */
  inSession: boolean;
  /** true when no core trigger exists at all — caller should not track state */
  hasTrigger: boolean;
  /** the setup's trigger for risk context */
  trigger: {
    fib?: FibSetup;
    zone?: Zone;
    setForget?: SetForgetSetup;
    breakout?: BreakoutSetup;
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
  const mode = ctx.trendMode ?? { htf: REQUIRE_HTF_TREND, m15: REQUIRE_M15_TREND };
  if (!mode.htf) return true;
  return ctx.topDown ? topDownAgrees(ctx.topDown, direction) : htfAgrees(ctx.htfCandles, direction);
}

/** Send-gate veto: nothing on the higher timeframes argues against the trade.
 *  Looser than the confirmation point above — a ranging weekly passes. */
function htfTrendPermits(ctx: ScoringContext, direction: SignalDirection): boolean {
  const mode = ctx.trendMode ?? { htf: REQUIRE_HTF_TREND, m15: REQUIRE_M15_TREND };
  if (!mode.htf) return true;
  return ctx.topDown ? !topDownOpposes(ctx.topDown, direction) : htfAgrees(ctx.htfCandles, direction);
}

/** The moment the latest candle closed — when a signal from it would be entered. */
function entryTime(candles: Candle[]): number {
  const last = candles[candles.length - 1];
  const step = candles.length > 1 ? last.time - candles[candles.length - 2].time : 900;
  // a weekend/holiday gap before the last bar is not the bar length
  return last.time + (step > 0 && step <= 4 * 3600 ? step : 900);
}

/**
 * M15 trend = the M15 swing structure (HH+HL / LH+LL on the zigzag-filtered
 * swings the setups are built from). It deliberately does NOT also require
 * price beyond a rising EMA50: every strategy here buys a pullback, and a
 * 50–79% retracement sits on the wrong side of a fast EMA by construction.
 */
function m15TrendAgrees(ctx: ScoringContext, direction: SignalDirection): boolean {
  const mode = ctx.trendMode ?? { htf: REQUIRE_HTF_TREND, m15: REQUIRE_M15_TREND };
  if (!mode.m15) return true;
  return m15Agrees(classifyStructure(ctx.structuralPivots ?? ctx.pivots), direction);
}

/**
 * 6-point confirmation scoring. Deterministic checks only.
 */
export function scoreSetup(
  strategy: StrategyId,
  ctx: ScoringContext
): ScoreResult {
  const { candles } = ctx;
  const structural = ctx.structuralPivots ?? ctx.pivots;

  let direction: SignalDirection | null = null;
  const confirmations: Record<string, boolean> = {};
  let trigger: ScoreResult["trigger"] = null;

  if (strategy === "breakout") {
    // The breakout is all-or-nothing: detectBreakout only returns a setup when
    // the close, the daily trend and the entry window all line up, so every
    // check is met whenever there is a trigger. Its session and trend rules are
    // its own — the pullback strategies' gates do not apply.
    const setup = detectBreakout(candles, ctx.daily ?? [], ctx.atrValue);
    if (!setup) return noTrigger(strategy);
    const confirmations = {
      [setup.kind === "asian" ? "Closed beyond the Asian range" : "Closed beyond the 1-week channel"]: true,
      "Daily trend agrees": true,
      "Inside the entry window": true,
    };
    return {
      strategy,
      direction: setup.direction,
      confirmations,
      count: 3,
      fired: true,
      topDownAligned: true,
      m15Aligned: true,
      inSession: true,
      hasTrigger: true,
      trigger: { breakout: setup },
    };
  }

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
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx, direction);
  } else if (strategy === "setforget") {
    const entry = setForgetEntry(candles, ctx.setForget ?? null);
    if (!entry) {
      return noTrigger(strategy);
    }
    direction = entry.direction;
    trigger = { setForget: entry.setup };
    confirmations["AOI first touch"] = true; // core trigger: untested 50–61.8% area
    confirmations["Rejection candle in AOI"] = isRejectionCandle(candles, direction);
    // H&S neckline break at the same direction as the AOI = structural confluence.
    const hsAligned = (ctx.headShoulders ?? []).some(
      (hs) => hs.direction === (entry.direction === "long" ? "long" : "short")
    );
    confirmations["AOI overlaps another POI"] =
      hsAligned ||
      goldenZoneHasPoi(
        { goldenTop: entry.setup.aoiTop, goldenBottom: entry.setup.aoiBottom },
        {
          direction,
          zones: ctx.zones,
          pivots: structural,
          legStartIndex: Math.min(entry.setup.legLow.index, entry.setup.legHigh.index),
          instrument: ctx.instrument,
          atrValue: ctx.atrValue,
        }
      );
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = htfTrendAgrees(ctx, direction);
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx, direction);
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
      direction,
      zones: ctx.zones,
      pivots: structural,
      legStartIndex: Math.min(fib.swingLow.index, fib.swingHigh.index),
      instrument: ctx.instrument,
      atrValue: ctx.atrValue,
    });
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = htfTrendAgrees(ctx, direction);
    confirmations["M15 trend agrees"] = m15TrendAgrees(ctx, direction);
  }

  const count = Object.values(confirmations).filter(Boolean).length;
  // Top-down / M15 agreement are confirmation points here, not vetoes — a
  // strategy reaching the threshold still "fires" for tracking. The send gate
  // (lib/engine/select.ts) is what requires these flags. Both honour the
  // pair's trend mode, so a pair with a check switched off is never vetoed
  // by it.
  const topDownAligned = htfTrendPermits(ctx, direction);
  const m15Aligned = m15TrendAgrees(ctx, direction);
  return {
    strategy,
    direction,
    confirmations,
    count,
    fired: count >= SIGNAL_THRESHOLD,
    topDownAligned,
    m15Aligned,
    inSession: inTradingSession(entryTime(candles)),
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
    inSession: false,
    hasTrigger: false,
    trigger: null,
  };
}
