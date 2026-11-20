/**
 * Trading rules for the three pullback strategies — supply/demand zones,
 * set & forget AOIs and the Fibonacci golden zone. Each strategy still finds
 * its own setup; these rules decide when a setup becomes a trade and where its
 * levels go:
 *
 *  - the daily trend must agree: the last closed daily close above the average
 *    of the last PULLBACK_TREND_DAYS means buys only, below means sells only,
 *  - the weekly swing structure must not oppose the trade,
 *  - the entry falls inside the trading session (lib/analysis/session.ts),
 *  - the stop sits PULLBACK_STOP_ATR × ATR from the entry and the target at
 *    PULLBACK_TARGET_R × that risk.
 *
 * A pullback entered against the daily trend has no edge on gold whatever the
 * confirmations say, and a stop inside the setup's own noise gets hit before
 * the trend resumes — so the trend filter and the wide stop are the rules, and
 * the 6-point checklist is context for the trader, not a gate.
 */

/** Days in the pullback strategies' daily-trend average. */
export const PULLBACK_TREND_DAYS = 100;

const envNumber = (name: string, fallback: number, min: number, max: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
};

/** Stop distance in ATR. Override with PULLBACK_STOP_ATR. */
export const PULLBACK_STOP_ATR = envNumber("PULLBACK_STOP_ATR", 3, 1, 6);
/** Target as a multiple of the risk. Override with PULLBACK_TARGET_R. */
export const PULLBACK_TARGET_R = envNumber("PULLBACK_TARGET_R", 2, 0.5, 5);
