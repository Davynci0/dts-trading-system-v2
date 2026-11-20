import type { SignalDirection, StrategyId } from "@/lib/types";
import type { ScoreResult } from "@/lib/analysis/scoring";
import type { RiskResult } from "@/lib/analysis/risk";

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

/**
 * Which setup becomes the trade when several are ready on the same candle.
 * The breakout first, then set & forget, zones, the
 * support/resistance retest and fibonacci — the order the combined system
 * was validated in.
 */
const DEFAULT_PRIORITY: StrategyId[] = ["breakout", "setforget", "zones", "sr", "fibonacci"];
/** Override the order with STRATEGY_PRIORITY=breakout,sr,… (unlisted strategies keep their place after). */
export const STRATEGY_PRIORITY: StrategyId[] = (() => {
  const raw = (process.env.STRATEGY_PRIORITY ?? "").split(",").map((x) => x.trim()) as StrategyId[];
  const listed = raw.filter((x) => DEFAULT_PRIORITY.includes(x));
  return [...listed, ...DEFAULT_PRIORITY.filter((x) => !listed.includes(x))];
})();
const priorityOf = (s: StrategyId) => {
  const i = STRATEGY_PRIORITY.indexOf(s);
  return i < 0 ? STRATEGY_PRIORITY.length : i;
};

/** Strategies that may only send grade A signals (a flipped key level behind the entry). Default: none. */
export const REQUIRE_KEY_LEVEL = new Set((process.env.REQUIRE_KEY_LEVEL ?? "").split(",").map((x) => x.trim()).filter(Boolean));

/**
 * Send gate: tradeable levels (stop, target, costs), the strategy's
 * confirmation minimum, the trading session and the strategy's trend rule.
 */
export function passesSendGate(c: SignalCandidate, minConfidence: number): boolean {
  return sendGateBlock(c, minConfidence) === null;
}

/** Why a candidate may not be sent, or null when it may. */
export function sendGateBlock(c: SignalCandidate, minConfidence: number): string | null {
  if (!c.risk.ok) return c.risk.reason;
  if (c.scored.count < minConfidence) return `only ${c.scored.count} confirmations (needs ${minConfidence})`;
  if (!c.scored.inSession) return "outside the trading session (London/New York hours only)";
  if (!c.scored.topDownAligned) return `against the trend: the daily trend or the weekly structure opposes the ${c.direction}`;
  if (REQUIRE_KEY_LEVEL.has(c.strategy) && !c.scored.keyLevel) return "no key level behind the entry (grade B)";
  return null;
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
 * Reduce the candidates that passed the send gate to one trade: the
 * highest-priority strategy defines the direction and the levels, and any
 * other candidate in the same direction is recorded as confluence.
 */
export function selectSignal<T extends SignalCandidate>(candidates: T[]): Selection<T> | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort(
    (a, b) => priorityOf(a.strategy) - priorityOf(b.strategy) || b.scored.count - a.scored.count
  );
  const primary = ranked[0];
  const winners = ranked.filter((c) => c.direction === primary.direction);
  const opposed = ranked.length - winners.length;
  return {
    side: primary.direction,
    winners,
    primary,
    arbitrationNote: opposed > 0 ? `${opposed} opposite setup${opposed > 1 ? "s" : ""} set aside — ${primary.strategy} takes priority` : null,
  };
}
