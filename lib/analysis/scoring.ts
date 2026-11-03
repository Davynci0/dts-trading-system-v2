import type { Candle, SignalDirection, StrategyId } from "@/lib/types";
import type { Pivot } from "./pivots";
import type { Zone } from "./zones";
import type { Trendline } from "./trendlines";
import type { StructureEvent } from "./structure";
import type { FibSetup } from "./fibonacci";
import { topDownAgrees, type TopDownAnalysis } from "./topDown";
import {
  goldenZoneHasPoi,
  htfAgrees,
  isConvictionCandle,
  isRejectionCandle,
  rsiTurning,
  zoneIsFresh,
} from "./confirmations";
import { inGoldenZone } from "./fibonacci";
import { trendlineTouch, bounceConfirmed } from "./trendlines";
import { detectZoneEntry } from "./zones";
import { setForgetEntry, type SetForgetSetup } from "./setForget";

export interface ScoringContext {
  instrument: string;
  candles: Candle[];
  htfCandles: Candle[];
  pivots: Pivot[];
  atrValue: number;
  zones: Zone[];
  trendlines: Trendline[];
  structureEvent: StructureEvent | null;
  fib: FibSetup | null;
  /** Alex G set-and-forget AOI setup (optional). */
  setForget?: SetForgetSetup | null;
  /** Present in live/top-down runs; absent only for legacy test callers. */
  topDown?: TopDownAnalysis;
}

export interface ScoreResult {
  strategy: StrategyId;
  direction: SignalDirection;
  /** the 5 checks, keyed by label; #5 (vision) is filled by the caller */
  confirmations: Record<string, boolean>;
  /** how many of the 5 are currently true */
  count: number;
  /** signal fires at >= 3 */
  fired: boolean;
  /** False when Weekly/Daily direction conflicts with this setup. */
  topDownAligned: boolean;
  /** true when no core trigger exists at all — caller should not track state */
  hasTrigger: boolean;
  /** the setup's trigger for vision + risk context */
  trigger: {
    line?: Trendline;
    event?: StructureEvent;
    fib?: FibSetup;
    zone?: Zone;
    setForget?: SetForgetSetup;
  } | null;
}

export const SIGNAL_THRESHOLD = 3; // Section 3 — majority of 5, deliberately not unanimous

/**
 * 5-point confirmation scoring (Section 3). Deterministic checks only —
 * the vision check (#5) is set by the caller from the Gemini result, since
 * it's async and unavailable in backtests (Section 7: 4-of-5 there).
 */
export function scoreSetup(
  strategy: StrategyId,
  ctx: ScoringContext,
  visionOk: boolean | null
): ScoreResult {
  const { candles, htfCandles } = ctx;

  let direction: SignalDirection | null = null;
  const confirmations: Record<string, boolean> = {};
  let trigger: ScoreResult["trigger"] = null;

  if (strategy === "trendline") {
    // Execution-timeframe lines only. HTF (H4) action lines are a bias filter,
    // not the M15 trigger — projecting them onto 15m candles mis-reads structure.
    const hit = trendlineTouch(candles, ctx.trendlines, ctx.atrValue);
    if (!hit) {
      return noTrigger(strategy);
    }
    direction = hit.direction;
    trigger = { line: hit.line };
    confirmations["Valid trendline touch"] = true; // core trigger now includes close-on-correct-side
    // rejection candle or explicit bounce confirmation (either satisfies #2)
    confirmations["Rejection candle"] =
      isRejectionCandle(candles, direction) || bounceConfirmed(candles, hit.line, direction, ctx.atrValue);
    confirmations["Momentum (RSI) turning"] = rsiTurning(candles, direction);
    confirmations["HTF trend agrees"] = ctx.topDown
      ? topDownAgrees(ctx.topDown, direction)
      : htfAgrees(htfCandles, direction);
    confirmations["Vision AI"] = visionOk === true;
  } else if (strategy === "structure") {
    const event = ctx.structureEvent;
    if (!event) {
      return noTrigger(strategy);
    }
    direction = event.direction;
    trigger = { event };
    confirmations["Structure event"] = true; // core trigger (BOS / CHoCH / zone bounce)
    confirmations["Conviction close"] = isConvictionCandle(candles, direction);
    confirmations["Zone freshness"] =
      event.type === "zone_reentry" ? zoneIsFresh(event.zone?.touches ?? 0) : true;
    confirmations["HTF structure agrees"] = ctx.topDown
      ? topDownAgrees(ctx.topDown, direction)
      : htfAgrees(htfCandles, direction);
    confirmations["Vision AI"] = visionOk === true;
  } else if (strategy === "zones") {
    const entry = detectZoneEntry(candles, ctx.zones);
    if (!entry) {
      return noTrigger(strategy);
    }
    direction = entry.direction;
    trigger = { zone: entry.zone };
    confirmations["Price entered zone"] = true; // core trigger
    confirmations["Rejection candle in zone"] = isRejectionCandle(candles, direction);
    confirmations["Zone fresh (few touches)"] = entry.zone.touches <= 2;
    confirmations["HTF trend agrees"] = ctx.topDown
      ? topDownAgrees(ctx.topDown, direction)
      : htfAgrees(htfCandles, direction);
    confirmations["Vision AI"] = visionOk === true;
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
    confirmations["HTF trend agrees"] = ctx.topDown
      ? topDownAgrees(ctx.topDown, direction)
      : htfAgrees(htfCandles, direction);
    confirmations["Vision AI"] = visionOk === true;
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
    confirmations["HTF trend agrees"] = ctx.topDown
      ? topDownAgrees(ctx.topDown, direction)
      : htfAgrees(htfCandles, direction);
    confirmations["Vision AI"] = visionOk === true;
  }

  const count = Object.values(confirmations).filter(Boolean).length;
  // Top-down agreement is a confirmation point, not a veto — a single
  // strategy reaching the threshold can fire on its own (user requirement).
  const topDownAligned = !ctx.topDown || topDownAgrees(ctx.topDown, direction);
  return {
    strategy,
    direction,
    confirmations,
    count,
    fired: count >= SIGNAL_THRESHOLD,
    topDownAligned,
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
    hasTrigger: false,
    trigger: null,
  };
}
