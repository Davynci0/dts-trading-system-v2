import type { Candle } from "@/lib/types";
import { tradeCost } from "@/lib/analysis/instruments";
import { buildTrendSeries, trendStateAt, TREND_MIN_CANDLES, type TrendTrigger } from "@/lib/analysis/trend";

/**
 * Backtest of the trend entries (lib/analysis/trend.ts) with the scanner's own
 * detection: a signal on a CLOSED 1-hour candle, filled at the open of the
 * next 15-minute candle, the full spread + slippage charged once. The open
 * position is then followed on 15-minute candles exactly as the live system
 * settles it: the stop is tested first, then the take-profit, then the stop
 * trails behind the candle's best price. One trend trade at a time.
 */
export interface TrendTrade {
  direction: "long" | "short";
  /** when the position was opened / closed (epoch seconds) */
  entryTime: number;
  exitTime: number;
  entry: number;
  /** the initial stop — 1R is the distance from the entry to it */
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  /** result in R after costs */
  rAchieved: number;
  /** stop = the initial stop; trail = the trailing stop, in profit or not; target = the take-profit */
  outcome: "target" | "stop" | "trail" | "open";
  trigger: TrendTrigger;
}

export function runTrendBacktest(opts: {
  pair: string;
  /** closed candles, oldest first, with history before `from` for the indicators */
  h1: Candle[];
  m15: Candle[];
  daily: Candle[];
  /** only trades entered at or after this time are kept (epoch seconds) */
  from?: number;
  costMultiplier?: number;
}): TrendTrade[] {
  const { pair, m15, from = 0, costMultiplier = 1 } = opts;
  const s = buildTrendSeries(opts);
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const trades: TrendTrade[] = [];
  /** nothing new until the open trade has closed */
  let freeAt = 0;
  let p = 0;

  for (let i = TREND_MIN_CANDLES; i < s.n; i++) {
    const closeTime = s.candles[i].time + 3600;
    if (closeTime < freeAt) continue;
    // cheap gate before the full read
    if (s.dailyTrend[i] === 0 || !(s.adx[i] > 0)) continue;
    while (p < m15.length && m15[p].time < closeTime) p++;
    if (p >= m15.length) break;
    if (m15[p].time < from) continue;
    const setup = trendStateAt(s, i, pair, m15[p].open).setup;
    if (!setup) continue;

    const dir = setup.direction === "long" ? 1 : -1;
    let stop = setup.stopLoss;
    let exitPrice = NaN;
    let outcome: TrendTrade["outcome"] = "open";
    let k = p;
    for (; k < m15.length; k++) {
      const c = m15[k];
      if (dir === 1 ? c.low <= stop : c.high >= stop) {
        // a gap through the stop fills at the open, not at the stop
        exitPrice = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
        outcome = stop === setup.stopLoss ? "stop" : "trail";
        break;
      }
      if (dir === 1 ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      const next = (dir === 1 ? c.high : c.low) - dir * setup.trailDistance;
      stop = dir === 1 ? Math.max(stop, next) : Math.min(stop, next);
    }
    if (k >= m15.length) {
      k = m15.length - 1;
      exitPrice = m15[k].close;
    }
    trades.push({
      direction: setup.direction,
      entryTime: m15[p].time,
      exitTime: m15[k].time + 900,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      rAchieved: (dir * (exitPrice - setup.entry) - cost) / setup.risk,
      outcome,
      trigger: setup.trigger,
    });
    freeAt = m15[k].time + 900;
  }
  return trades;
}
