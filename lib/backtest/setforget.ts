import { buildSfSeries, sfSetupAt, SF_DEFAULTS, type SfOptions } from "@/lib/analysis/setforget";
import { tradeCost } from "@/lib/analysis/instruments";
import type { Candle } from "@/lib/types";

/**
 * Set and Forget, replayed. A signal is read on a CLOSED entry-timeframe
 * candle and filled at the open of the 15-minute candle that follows it. The
 * trade is then followed on 15-minute candles and ends in one of two ways,
 * exactly as the method says: the stop (tested first, so a candle that touches
 * both counts as the stop; a gap through it fills at the candle's open) or the
 * target. Nothing is moved in between.
 *
 * Costs: the full spread plus slippage once, and a financing charge for every
 * night the trade is held — swing trades last days, and a broker charges for
 * that.
 */

const M15 = 900;
const DAY = 86_400;

/** Financing charged on a held position, as a share of its value per year. A broker's markup makes it a cost on either side on average. */
export const SF_FINANCING_RATE = 0.025;

export interface SfTrade {
  pair: string;
  direction: "long" | "short";
  /** when the position was opened / closed (epoch seconds) */
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  /** planned reward ÷ risk */
  plannedR: number;
  /** result in R after spread, slippage and financing */
  rAchieved: number;
  /** what the costs took, in R (spread and slippage / financing) */
  costR: number;
  financingR: number;
  /** days the trade was held */
  days: number;
  outcome: "target" | "stop" | "open";
  /** the chart the area of interest was read on, and its touches */
  zoneTf: "weekly" | "daily";
  touches: number;
}

export interface SfMarket {
  /** 15-minute candles: fills and exits */
  m15: Candle[];
  /** the entry timeframe's candles */
  entry: Candle[];
  h4: Candle[];
  daily: Candle[];
  weekly: Candle[];
}

/** Every signal of one market, each followed on its own to its stop or target — whether or not another trade was open. */
export function sfCandidates(pair: string, m: SfMarket, entrySeconds: number, opts: SfOptions = SF_DEFAULTS, from = 0, costMultiplier = 1, financingRate = SF_FINANCING_RATE): SfTrade[] {
  const s = buildSfSeries({ entry: m.entry, h4: m.h4, daily: m.daily, weekly: m.weekly, entrySeconds }, opts);
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const out: SfTrade[] = [];
  const x = m.m15;
  let e = 0;
  for (let i = 2; i < s.n; i++) {
    const closed = s.candles[i].time + entrySeconds;
    if (closed < from) continue;
    if (!sfSetupAt(s, i, pair, opts)) continue;
    while (e < x.length && x[e].time < closed) e++;
    if (e >= x.length) break;
    // filled at the next open; the stop stays where the structure put it, the target keeps its reward-to-risk
    const setup = sfSetupAt(s, i, pair, opts, x[e].open);
    if (!setup) continue;
    const long = setup.direction === "long";
    const dir = long ? 1 : -1;
    let exitPrice = NaN;
    let exitTime = NaN;
    let outcome: SfTrade["outcome"] = "open";
    for (let k = e; k < x.length; k++) {
      const c = x[k];
      if (long ? c.low <= setup.stopLoss : c.high >= setup.stopLoss) {
        exitPrice = long ? Math.min(setup.stopLoss, c.open) : Math.max(setup.stopLoss, c.open);
        exitTime = c.time + M15;
        outcome = "stop";
        break;
      }
      if (long ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        exitTime = c.time + M15;
        outcome = "target";
        break;
      }
    }
    if (outcome === "open") {
      exitPrice = x[x.length - 1].close;
      exitTime = x[x.length - 1].time + M15;
    }
    const days = (exitTime - x[e].time) / DAY;
    const financing = setup.entry * financingRate * (days / 365) * Math.max(0, costMultiplier);
    out.push({
      pair,
      direction: setup.direction,
      entryTime: x[e].time,
      exitTime,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      plannedR: setup.targetR,
      rAchieved: (dir * (exitPrice - setup.entry) - cost - financing) / setup.risk,
      costR: cost / setup.risk,
      financingR: financing / setup.risk,
      days,
      outcome,
      zoneTf: setup.zone.tf,
      touches: setup.zone.touches,
    });
  }
  return out;
}

/**
 * The trades that are actually taken out of every market's signals, in time
 * order: a signal is skipped while `maxOpen` trades are open, and a market
 * never holds two trades at once. Trades still open at the end of the data
 * are left out.
 */
export function takeTrades(candidates: SfTrade[], maxOpen = 1): SfTrade[] {
  const sorted = [...candidates].sort((a, b) => a.entryTime - b.entryTime || a.pair.localeCompare(b.pair));
  const open: SfTrade[] = [];
  const taken: SfTrade[] = [];
  for (const t of sorted) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitTime <= t.entryTime) open.splice(k, 1);
    if (open.length >= maxOpen || open.some((o) => o.pair === t.pair)) continue;
    open.push(t);
    if (t.outcome !== "open") taken.push(t);
  }
  return taken;
}

export function runSfBacktest(opts: {
  markets: Record<string, SfMarket>;
  entrySeconds: number;
  /** only signals at or after this time are kept (epoch seconds) */
  from?: number;
  options?: SfOptions;
  costMultiplier?: number;
  maxOpen?: number;
}): SfTrade[] {
  const all: SfTrade[] = [];
  for (const [pair, m] of Object.entries(opts.markets)) {
    all.push(...sfCandidates(pair, m, opts.entrySeconds, opts.options ?? SF_DEFAULTS, opts.from ?? 0, opts.costMultiplier ?? 1));
  }
  return takeTrades(all, opts.maxOpen ?? 1);
}
