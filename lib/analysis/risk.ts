import type { Candle, SignalDirection } from "@/lib/types";
import { atr } from "./indicators";
import { tradeCost, pipSize } from "./instruments";
import { significantPivots, type Pivot } from "./pivots";

export const STOP_BUFFER_ATR_FRACTION = 0.25; // room beyond the swing so the stop isn't on the wick
export const MIN_STOP_ATR = 0.5; // a stop inside half an ATR sits within normal candle noise
export const MAX_STOP_ATR_MULT = 3; // structure further than this × ATR away is too much risk, skip
// Minimum structural reward-to-risk. Override with MIN_R_MULTIPLE env var.
// Set to 0 to let market structure alone decide the target (no fixed R:R floor).
export const MIN_RR = Math.max(0, Number(process.env.MIN_R_MULTIPLE ?? 2.0));
export const RISK_PCT_PER_TRADE = 0.01; // 1% account risk per trade
const STRUCTURE_SWING_ATR = 0.5; // only swings this many ATR in size count as structure
// Trading costs (spread + slippage) may be at most this share of the risk.
// A year of M15 backtests put the average at 13% of risk per trade — the
// entire loss of the system — because stops sat a few pips from entry on
// pairs with multi-pip spreads. Override with MAX_COST_SHARE (0 disables).
export const MAX_COST_SHARE = Math.max(0, Number(process.env.MAX_COST_SHARE ?? 0.1));
/** Fib depth past which a retracement has stopped being a pullback. */
const DEEP_RETRACE = 0.786;

export interface RiskLevels {
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  stopDistance: number;
  rMultiple: number;
  atr: number;
  /** units of base currency, sized so the stop costs riskAmount in USD
   *  (converted from the quote currency via quoteUsdRate) */
  positionUnits: number;
  riskAmount: number;
  tpSource: "swing" | "zone" | "measured_move";
  /** the market structure each level is anchored to, e.g. "below swing low 4149.634" */
  stopBasis: string;
  targetBasis: string;
  /** reported for convenience (1 pip = 0.0001, JPY 0.01, gold 0.1); never used to gate a trade */
  riskPips: number;
  rewardPips: number;
}

export type RiskResult =
  | { ok: true; levels: RiskLevels }
  | { ok: false; reason: string; levels: RiskLevels | null };

export interface ZoneRef {
  kind: "demand" | "supply";
  top: number;
  bottom: number;
  active: boolean;
}

/** Structural identity of the setup being traded (ScoreResult.trigger). */
export interface SetupTrigger {
  zone?: { kind: "demand" | "supply"; top: number; bottom: number };
  fib?: { direction: "long" | "short"; swingLow: { price: number }; swingHigh: { price: number }; goldenTop: number; goldenBottom: number };
  setForget?: { direction: "long" | "short"; legLow: { price: number }; legHigh: { price: number }; aoiTop: number; aoiBottom: number };
}

interface Candidate {
  price: number;
  basis: string;
  source: "swing" | "zone";
}

/**
 * The price that proves the setup wrong, when the setup defines one:
 *  - supply/demand zone → the zone's far (distal) edge,
 *  - fib golden zone    → its deep (78.6%) edge,
 *  - set & forget AOI   → the 78.6% retracement of the impulse leg.
 * A stop anywhere short of this sits INSIDE the area the trade expects price
 * to work in, and is hit by the ordinary fill of that area.
 */
function invalidationLevel(trigger: SetupTrigger | null | undefined, long: boolean): { price: number; label: string } | null {
  if (!trigger) return null;
  if (trigger.zone) {
    return long
      ? { price: trigger.zone.bottom, label: "demand zone low" }
      : { price: trigger.zone.top, label: "supply zone high" };
  }
  if (trigger.fib) {
    return long
      ? { price: trigger.fib.goldenBottom, label: "78.6% retracement" }
      : { price: trigger.fib.goldenTop, label: "78.6% retracement" };
  }
  if (trigger.setForget) {
    const { legLow, legHigh } = trigger.setForget;
    const range = legHigh.price - legLow.price;
    return long
      ? { price: legHigh.price - DEEP_RETRACE * range, label: "78.6% retracement of the impulse leg" }
      : { price: legLow.price + DEEP_RETRACE * range, label: "78.6% retracement of the impulse leg" };
  }
  return null;
}

/**
 * Stop and target come from market structure; ATR (volatility) and trading
 * costs only decide whether the structure is tradeable.
 *
 * - Stop: beyond the setup's own invalidation level when the caller passes the
 *   `trigger` (see invalidationLevel); otherwise beyond the nearest
 *   significant swing. Either way it must clear MIN_STOP_ATR of noise and be
 *   wide enough that entry costs stay under MAX_COST_SHARE of the risk — a
 *   stop that is too tight is widened to that floor, never left in the noise.
 * - Target: the nearest structural level ahead — a swing extreme or an
 *   opposing supply/demand zone. With no level ahead (e.g. price at new highs)
 *   it falls back to a measured move of the last swing leg.
 * - Skipped when the stop ends up too far away. When MIN_RR > 0, it also
 *   requires the chosen target to pay at least MIN_RR.
 */
export function computeRiskLevels(opts: {
  instrument: string;
  direction: SignalDirection;
  entry: number;
  candles: Candle[];
  pivots: Pivot[];
  zones?: ZoneRef[];
  /** The setup that fired (zone / fib swing / AOI leg). */
  trigger?: SetupTrigger | null;
  accountBalance: number;
  /** USD value of 1 unit of the quote currency (JPY pairs, GBP_AUD, GBP_NZD...).
   *  Defaults to 1 (USD-quoted pairs incl. XAU). 0/missing conversion refuses sizing. */
  quoteUsdRate?: number;
}): RiskResult {
  const { instrument, direction, entry, candles, pivots, accountBalance } = opts;
  const quoteUsdRate = opts.quoteUsdRate ?? 1;
  const zones = opts.zones ?? [];
  const long = direction === "long";
  const pip = pipSize(instrument);
  const pips = (price: number) => price / pip;
  const digits = pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
  const fmt = (n: number) => n.toFixed(digits);

  const atrValue = atr(candles, 14);
  if (atrValue == null || atrValue <= 0) {
    return { ok: false, reason: "ATR unavailable (not enough candles)", levels: null };
  }

  const swings = significantPivots(pivots, atrValue, STRUCTURE_SWING_ATR);
  const highs = swings.filter((p) => p.kind === "high");
  const lows = swings.filter((p) => p.kind === "low");

  const buffer = STOP_BUFFER_ATR_FRACTION * atrValue;
  // the closest a stop may sit: clear of candle noise AND far enough that the
  // spread + slippage paid at entry is a small share of what is being risked
  const costFloor = MAX_COST_SHARE > 0 ? tradeCost(instrument) / MAX_COST_SHARE : 0;
  const minStop = Math.max(MIN_STOP_ATR * atrValue, costFloor);
  const widenedNote = costFloor > MIN_STOP_ATR * atrValue ? "widened so costs stay a small share of the risk" : "widened to clear candle noise";

  let stopLoss: number;
  let stopBasis: string;
  const invalidation = invalidationLevel(opts.trigger, long);
  if (invalidation) {
    // --- stop: beyond the level that proves this setup wrong ---
    if (long ? entry <= invalidation.price : entry >= invalidation.price) {
      return {
        ok: false,
        reason: `price has already closed through the setup's invalidation (${invalidation.label} ${fmt(invalidation.price)})`,
        levels: null,
      };
    }
    stopLoss = long ? invalidation.price - buffer : invalidation.price + buffer;
    stopBasis = `${long ? "below" : "above"} ${invalidation.label} ${fmt(invalidation.price)}`;
    if (Math.abs(entry - stopLoss) < minStop) {
      stopLoss = long ? entry - minStop : entry + minStop;
      stopBasis += ` (${widenedNote})`;
    }
  } else if (long) {
    // --- stop: beyond the price-nearest significant swing that clears the
    // minimum distance. Anchoring to the nearest swing in PRICE (not the most
    // recent one) keeps the stop proportional to the structure around entry. ---
    const swing = lows
      .filter((p) => p.price < entry)
      .sort((a, b) => b.price - a.price) // nearest below entry first
      .find((p) => entry - (p.price - buffer) >= minStop);
    if (!swing) {
      return { ok: false, reason: "no swing low far enough below entry — no structure to anchor the stop", levels: null };
    }
    stopLoss = swing.price - buffer;
    stopBasis = `below swing low ${fmt(swing.price)}`;
  } else {
    const swing = highs
      .filter((p) => p.price > entry)
      .sort((a, b) => a.price - b.price) // nearest above entry first
      .find((p) => p.price + buffer - entry >= minStop);
    if (!swing) {
      return { ok: false, reason: "no swing high far enough above entry — no structure to anchor the stop", levels: null };
    }
    stopLoss = swing.price + buffer;
    stopBasis = `above swing high ${fmt(swing.price)}`;
  }
  const stopDistance = Math.abs(entry - stopLoss);

  // --- target: structural levels ahead of entry, nearest first ---
  const candidates: Candidate[] = [];
  const ahead = long ? highs.filter((p) => p.price > entry) : lows.filter((p) => p.price < entry);
  for (const p of ahead) {
    candidates.push({ price: p.price, basis: `${long ? "swing high" : "swing low"} ${fmt(p.price)}`, source: "swing" });
  }
  for (const z of zones) {
    if (!z.active) continue;
    if (long && z.kind === "supply" && z.bottom > entry) {
      candidates.push({ price: z.bottom, basis: `supply zone ${fmt(z.bottom)}`, source: "zone" });
    }
    if (!long && z.kind === "demand" && z.top < entry) {
      candidates.push({ price: z.top, basis: `demand zone ${fmt(z.top)}`, source: "zone" });
    }
  }
  candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const rOf = (price: number) => Math.abs(price - entry) / stopDistance;

  let target: Candidate | null = null;
  if (candidates.length > 0) {
    target = candidates.find((c) => rOf(c.price) >= MIN_RR) ?? candidates[0];
  } else {
    // nothing ahead (price at fresh highs/lows): project the last impulse leg in the trade's direction
    const extreme = long ? highs[highs.length - 1] : lows[lows.length - 1];
    const origin = extreme
      ? [...swings].reverse().find((p) => p.index < extreme.index && p.kind !== extreme.kind)
      : undefined;
    if (extreme && origin) {
      const leg = Math.abs(extreme.price - origin.price);
      target = {
        price: long ? entry + leg : entry - leg,
        basis: `measured move of last impulse leg (${fmt(leg)})`,
        source: "swing",
      };
    }
  }
  if (!target) {
    return { ok: false, reason: "no structural target ahead and no completed swing to project", levels: null };
  }

  const measured = candidates.length === 0;
  const takeProfit = target.price;
  const rMultiple = rOf(takeProfit);
  if (!(quoteUsdRate > 0)) {
    return {
      ok: false,
      reason: "USD conversion rate for the quote currency is unavailable — cannot size the position",
      levels: null,
    };
  }
  const riskAmount = accountBalance * RISK_PCT_PER_TRADE;
  const levels: RiskLevels = {
    direction,
    entry,
    stopLoss,
    takeProfit,
    stopDistance,
    rMultiple,
    atr: atrValue,
    // loss per unit = stopDistance (quote currency) → × quoteUsdRate = USD
    positionUnits: Math.floor(riskAmount / (stopDistance * quoteUsdRate)),
    riskAmount,
    tpSource: measured ? "measured_move" : target.source,
    stopBasis,
    targetBasis: target.basis,
    riskPips: pips(stopDistance),
    rewardPips: pips(Math.abs(takeProfit - entry)),
  };

  if (stopDistance > MAX_STOP_ATR_MULT * atrValue) {
    return {
      ok: false,
      reason: `structure puts the stop ${pips(stopDistance).toFixed(1)} pips away (${(stopDistance / atrValue).toFixed(1)}× ATR, max ${MAX_STOP_ATR_MULT}×) — ${stopBasis}`,
      levels,
    };
  }
  if (rMultiple < MIN_RR) {
    return {
      ok: false,
      reason: `structure only pays ${rMultiple.toFixed(2)}R: stop ${stopBasis} (${pips(stopDistance).toFixed(1)} pips) vs target ${target.basis} (${pips(Math.abs(takeProfit - entry)).toFixed(1)} pips), min 1:${MIN_RR}`,
      levels,
    };
  }
  return { ok: true, levels };
}
