import type { SignalDirection, StrategyId } from "@/lib/types";
import type { ScoreResult } from "@/lib/analysis/scoring";
import type { RiskResult } from "@/lib/analysis/risk";
import type { TopDownAnalysis } from "@/lib/analysis/topDown";

/**
 * The final "which setup becomes the trade" decision, shared by the live
 * scanner and the backtest so research numbers describe the system that
 * actually sends signals. Pure: no I/O, no clock.
 */
export interface SignalCandidate {
  strategy: StrategyId;
  direction: SignalDirection;
  scored: ScoreResult;
  risk: RiskResult;
}

/** Tie-break between agreeing setups: which one defines the trade's levels.
 *  Zones and set & forget measured slightly ahead of fibonacci over 12 months. */
export const STRATEGY_QUALITY_BONUS: Record<StrategyId, number> = {
  setforget: 8,
  zones: 4,
  fibonacci: 0,
};

/**
 * Send gate: tradeable structure (stop/target/R/costs), the strategy's
 * confirmation minimum, the trading session, no opposing weekly structure
 * and an agreeing M15 trend. A trend check that is switched off for the pair
 * evaluates to true.
 */
export function passesSendGate(c: SignalCandidate, minConfidence: number): boolean {
  return sendGateBlock(c, minConfidence) === null;
}

/** Why a candidate may not be sent, or null when it may. */
export function sendGateBlock(c: SignalCandidate, minConfidence: number): string | null {
  if (!c.risk.ok) return c.risk.reason;
  if (c.scored.count < minConfidence) return `only ${c.scored.count}/6 confirmations (needs ${minConfidence})`;
  if (!c.scored.inSession) return "outside the trading session (London/New York hours only)";
  if (!c.scored.topDownAligned) return `counter-trend: the weekly structure opposes the ${c.direction}`;
  if (!c.scored.m15Aligned) return `counter-trend: the M15 trend disagrees with the ${c.direction}`;
  return null;
}

export function setupQuality(c: SignalCandidate): number {
  let q = c.scored.count * 10;
  if (c.scored.topDownAligned) q += 35; // not fighting the weekly structure
  const rejection = Object.entries(c.scored.confirmations).some(
    ([k, v]) => v && /Rejection|Momentum/.test(k)
  );
  if (rejection) q += 12;
  if (c.risk.ok) {
    q += Math.min(14, c.risk.levels.rMultiple * 3); // reward potential
    q += Math.min(8, 1 / Math.max(0.1, c.risk.levels.stopDistance / c.risk.levels.atr)); // tighter stop vs ATR
  } else {
    q -= 50;
  }
  q += STRATEGY_QUALITY_BONUS[c.scored.strategy];
  return q;
}

export interface Selection<T extends SignalCandidate> {
  side: SignalDirection;
  /** every candidate on the chosen side, best first */
  winners: T[];
  primary: T;
  /** set only when both directions had a candidate */
  arbitrationNote: string | null;
}

/**
 * Reduce the candidates that passed the send gate to one trade: a single
 * direction wins (HTF bias first, summed quality as the fallback), and the
 * best setup on that side defines the levels.
 */
export function selectSignal<T extends SignalCandidate>(
  candidates: T[],
  topDown?: TopDownAnalysis
): Selection<T> | null {
  if (candidates.length === 0) return null;
  const longs = candidates.filter((c) => c.direction === "long");
  const shorts = candidates.filter((c) => c.direction === "short");

  let side: SignalDirection;
  let arbitrationNote: string | null = null;
  if (longs.length === 0 || shorts.length === 0) {
    side = longs.length > 0 ? "long" : "short";
  } else if (topDown && topDown.bias !== "neutral") {
    side = topDown.bias === "bullish" ? "long" : "short";
    arbitrationNote = `both sides present — chose ${side} via HTF bias`;
  } else {
    const sideScore = (arr: T[]) => arr.reduce((s, c) => s + setupQuality(c), 0);
    side = sideScore(longs) >= sideScore(shorts) ? "long" : "short";
    arbitrationNote = `conflict resolved by confirmation majority: ${side}`;
  }

  const winners = [...(side === "long" ? longs : shorts)].sort((a, b) => setupQuality(b) - setupQuality(a));
  return { side, winners, primary: winners[0], arbitrationNote };
}
