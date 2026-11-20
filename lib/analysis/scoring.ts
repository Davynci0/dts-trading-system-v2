import type { Candle, SignalDirection, StrategyId } from "@/lib/types";
import type { Pivot } from "./pivots";
import type { Zone } from "./zones";
import type { StructureState } from "./structure";
import type { FibSetup } from "./fibonacci";
import { classifyStructure } from "./structure";
import { topDownOpposes, type TopDownAnalysis } from "./topDown";
import { inTradingSession } from "./session";
import {
  goldenZoneHasPoi,
  isRejectionCandle,
  rsiTurning,
  zoneIsVeryFresh,
} from "./confirmations";
import { inGoldenZone } from "./fibonacci";
import { detectZoneEntry } from "./zones";
import { setForgetEntry, type SetForgetSetup } from "./setForget";
import type { HeadShouldersPattern } from "./headshoulders";
import { closeTimeOf, detectBreakout, dailyTrend, type BreakoutSetup } from "./breakout";
import { PULLBACK_TREND_DAYS } from "./pullback";
import { backingLevel, detectLevelRetest, type KeyLevel, type LevelRetest } from "./levels";

export interface ScoringContext {
  instrument: string;
  candles: Candle[];
  htfCandles: Candle[];
  pivots: Pivot[];
  /** Zigzag-filtered swings (analyzeExecution.structuralPivots). The chart's trend and
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
  /** Active H&S / inverse-H&S reversal patterns (neckline break just fired). */
  headShoulders?: HeadShouldersPattern[];
  /** Closed daily candles — every strategy's daily-trend filter reads these. */
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
  /** Send gate: the strategy's higher-timeframe trend rule is satisfied. For the
   *  pullback strategies that is "daily trend agrees and the weekly structure
   *  does not oppose"; a breakout only exists when its own trend rule holds. */
  topDownAligned: boolean;
  /** Whether the chart's swing structure agrees — shown on the checklist, not a gate. */
  structureAligned: boolean;
  /** False when the entry would fall outside the trading session. */
  inSession: boolean;
  /** The flipped support/resistance level just behind the entry, when there is
   *  one. It is one confirmation on the checklist (KEY_LEVEL_CHECK). */
  keyLevel: KeyLevel | null;
  /** true when no core trigger exists at all — caller should not track state */
  hasTrigger: boolean;
  /** the setup's trigger for risk context */
  trigger: {
    fib?: FibSetup;
    zone?: Zone;
    setForget?: SetForgetSetup;
    breakout?: BreakoutSetup;
    level?: LevelRetest;
  } | null;
}

/** The one checklist item that separated better trades from the rest in
 *  testing: a flipped support/resistance level just behind the entry. */
export const KEY_LEVEL_CHECK = "Key level behind the entry";

/** Checks met at which the tracker treats a pullback setup as well confirmed. Not a send gate. */
export const SIGNAL_THRESHOLD = 3;

/** Execution-timeframe trend alignment. */
export function structureAgrees(structureState: StructureState, direction: SignalDirection): boolean {
  return (
    (structureState === "uptrend" && direction === "long") ||
    (structureState === "downtrend" && direction === "short")
  );
}

/** Daily trend for the pullback strategies: +1 / −1 / 0 (unknown). */
function pullbackTrend(ctx: ScoringContext): 1 | -1 | 0 {
  return dailyTrend(ctx.daily ?? [], PULLBACK_TREND_DAYS);
}

/** The pullback strategies' trend gate: the daily trend agrees with the trade
 *  and the weekly swing structure does not oppose it. */
function trendPermits(ctx: ScoringContext, direction: SignalDirection): boolean {
  if (pullbackTrend(ctx) !== (direction === "long" ? 1 : -1)) return false;
  return !ctx.topDown || !topDownOpposes(ctx.topDown, direction);
}

/** The moment the latest candle closed — when a signal from it would be entered. */
const entryTime = closeTimeOf;

/** Chart trend = the chart's swing structure (HH+HL / LH+LL on the zigzag-filtered
 *  swings the setups are built from). */
function structureTrendAgrees(ctx: ScoringContext, direction: SignalDirection): boolean {
  return structureAgrees(classifyStructure(ctx.structuralPivots ?? ctx.pivots), direction);
}

/** "HTF trend agrees" on the checklist = the daily trend the gate uses. */
function htfTrendAgrees(ctx: ScoringContext, direction: SignalDirection): boolean {
  return pullbackTrend(ctx) === (direction === "long" ? 1 : -1);
}

/**
 * Find a strategy's setup on the latest candle and score its checklist.
 * Deterministic checks only.
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
    const keyLevel = backingLevel(candles, ctx.htfCandles, setup.direction);
    const confirmations = {
      "Closed beyond the 30-candle channel": true,
      "Daily trend agrees": true,
      "Inside the entry window": true,
      [KEY_LEVEL_CHECK]: keyLevel != null,
    };
    return {
      strategy,
      direction: setup.direction,
      confirmations,
      count: Object.values(confirmations).filter(Boolean).length,
      fired: true,
      topDownAligned: true,
      structureAligned: true,
      inSession: true,
      keyLevel,
      hasTrigger: true,
      trigger: { breakout: setup },
    };
  }

  if (strategy === "sr") {
    const retest = detectLevelRetest(candles, ctx.htfCandles);
    if (!retest) return noTrigger(strategy);
    const last = candles[candles.length - 1];
    const confirmations = {
      "Retest of a broken level": true, // core trigger
      "Level turned price 3+ times": retest.level.touches >= 3,
      "Candle closes with the trade": retest.direction === "long" ? last.close > last.open : last.close < last.open,
      "HTF trend agrees": htfTrendAgrees(ctx, retest.direction),
      [KEY_LEVEL_CHECK]: retest.level.flipped,
    };
    const count = Object.values(confirmations).filter(Boolean).length;
    return {
      strategy,
      direction: retest.direction,
      confirmations,
      count,
      fired: count >= SIGNAL_THRESHOLD,
      topDownAligned: trendPermits(ctx, retest.direction),
      structureAligned: structureTrendAgrees(ctx, retest.direction),
      inSession: inTradingSession(entryTime(candles)),
      keyLevel: retest.level.flipped ? retest.level : null,
      hasTrigger: true,
      trigger: { level: retest },
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
    confirmations["Chart trend agrees"] = structureTrendAgrees(ctx, direction);
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
    confirmations["Chart trend agrees"] = structureTrendAgrees(ctx, direction);
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
    confirmations["Chart trend agrees"] = structureTrendAgrees(ctx, direction);
  }

  const keyLevel = backingLevel(candles, ctx.htfCandles, direction);
  confirmations[KEY_LEVEL_CHECK] = keyLevel != null;
  const count = Object.values(confirmations).filter(Boolean).length;
  // The checklist is context for the trader. What decides whether the setup
  // may be sent is the trend gate and the session (lib/analysis/pullback.ts,
  // enforced in lib/engine/select.ts).
  const topDownAligned = trendPermits(ctx, direction);
  const structureAligned = structureTrendAgrees(ctx, direction);
  return {
    strategy,
    direction,
    confirmations,
    count,
    fired: count >= SIGNAL_THRESHOLD,
    topDownAligned,
    structureAligned,
    inSession: inTradingSession(entryTime(candles)),
    keyLevel,
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
    structureAligned: false,
    inSession: false,
    keyLevel: null,
    hasTrigger: false,
    trigger: null,
  };
}
