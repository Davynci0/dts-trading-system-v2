import type { Candle } from "@/lib/types";
import { tradeCost } from "@/lib/analysis/instruments";
import { buildTrendSeries, reentryBlock, trendStateAt, TREND_MAX_HOLD_BARS, TREND_MAX_OPEN, TREND_MIN_CANDLES, type LastEntry, type TrendTrigger } from "@/lib/analysis/trend";

/**
 * Backtest of the system (lib/analysis/trend.ts) with the scanner's own
 * detection: a signal on a CLOSED 15-minute candle, filled at the next
 * candle's open, the full spread + slippage charged once. Each trade is then
 * followed candle by candle exactly as the live system settles it: the stop is
 * tested first, then the take-profit, then the profit lock moves the stop for
 * the candles that follow, then the time limit. One trade at a time
 * (TREND_MAX_OPEN), and no duplicate entry of the last one (reentryBlock).
 */
export interface TrendTrade {
  direction: "long" | "short";
  /** when the position was opened / closed (epoch seconds) */
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  /** result in R after costs */
  rAchieved: number;
  /** 15-minute candles the trade was held for, the entry candle included */
  bars: number;
  /** stop = the first stop · lock = the stop after the profit lock moved it · time = closed at market at the time limit */
  outcome: "target" | "stop" | "lock" | "time" | "open";
  trigger: TrendTrigger;
  /** how many of the six trend confirmations it had */
  confirmed: number;
}

/** The two entries, as the results are grouped. */
export const TREND_ENTRY_TYPES = ["Break of structure", "Breakout", "Momentum candle"] as const;
/** Which entry a trade counts under — a candle that is both a breakout and a momentum candle counts as a breakout. */
export const entryTypeOf = (t: { trigger: TrendTrigger }): (typeof TREND_ENTRY_TYPES)[number] =>
  t.trigger === "break of structure" ? "Break of structure" : t.trigger === "momentum candle" ? "Momentum candle" : "Breakout";

export function runTrendBacktest(opts: {
  pair: string;
  /** closed candles, oldest first, with history before `from` for the indicators */
  m15: Candle[];
  h1: Candle[];
  daily: Candle[];
  /** only trades entered at or after this time are kept (epoch seconds) */
  from?: number;
  costMultiplier?: number;
}): TrendTrade[] {
  const { pair, m15, from = 0, costMultiplier = 1 } = opts;
  const s = buildTrendSeries(opts);
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const trades: TrendTrade[] = [];
  /** the trades still open: the candle each one closes on, and its side */
  let open: { exitIndex: number; dir: number }[] = [];
  /** nothing can be entered while the limit is full, so those candles need no read */
  let busyUntil = 0;
  /** the last trade entered, for the re-entry rule */
  let last: LastEntry | null = null;

  for (let i = TREND_MIN_CANDLES; i < s.n - 1; i++) {
    if (m15[i + 1].time < from || i < busyUntil) continue;
    // cheap gate before the full read
    if (s.dailyTrend[i] === 0 || s.dailyTrend[i] !== s.h1Trend[i]) continue;
    const setup = trendStateAt(s, i, pair, m15[i + 1].open).setup;
    if (!setup) continue;
    const dir = setup.direction === "long" ? 1 : -1;
    // a trade that closed on or before the signal candle has been settled by the time the signal is read
    open = open.filter((t) => t.exitIndex > i);
    if (open.length >= TREND_MAX_OPEN || open.some((t) => t.dir !== dir)) continue;
    if (reentryBlock(last, { direction: setup.direction, time: m15[i + 1].time, entry: setup.entry })) continue;

    const e = i + 1;
    let stop = setup.stopLoss;
    let exitPrice = NaN;
    let outcome: TrendTrade["outcome"] = "open";
    let k = e;
    for (; k < s.n; k++) {
      const c = m15[k];
      if (dir === 1 ? c.low <= stop : c.high >= stop) {
        // a gap through the stop fills at the open, not at the stop
        exitPrice = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
        outcome = stop === setup.stopLoss ? "stop" : "lock";
        break;
      }
      if (dir === 1 ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      // the profit lock: a candle that reaches the trigger moves the stop for the candles after it
      if (dir === 1 ? c.high >= setup.lockTrigger : c.low <= setup.lockTrigger) stop = setup.lockStop;
      // the close of the last candle the trade may be held for
      if (k - e + 1 >= TREND_MAX_HOLD_BARS) {
        exitPrice = c.close;
        outcome = "time";
        break;
      }
    }
    if (k >= s.n) {
      k = s.n - 1;
      exitPrice = m15[k].close;
    }
    trades.push({
      direction: setup.direction,
      entryTime: m15[e].time,
      exitTime: m15[k].time + 900,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      bars: k - e + 1,
      rAchieved: (dir * (exitPrice - setup.entry) - cost) / setup.risk,
      outcome,
      trigger: setup.trigger,
      confirmed: setup.confirmed,
    });
    open.push({ exitIndex: outcome === "open" ? Infinity : k, dir });
    last = { direction: setup.direction, time: m15[e].time, entry: setup.entry, risk: setup.risk };
    if (open.length >= TREND_MAX_OPEN) busyUntil = Math.min(...open.map((t) => t.exitIndex));
  }
  return trades;
}
