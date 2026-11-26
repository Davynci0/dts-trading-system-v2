import type { Candle } from "@/lib/types";
import { btcStateAt, buildBtcSeries, BTC_CHART_SECONDS, BTC_COST, BTC_LOCK_AT_R, BTC_LOCK_TO_R, BTC_MAX_ENTRY_DELAY, BTC_MAX_HOLD_BARS, BTC_MIN_CANDLES } from "@/lib/analysis/btc";

/**
 * Backtest of the Bitcoin system (lib/analysis/btc.ts): a signal on a CLOSED
 * 4-hour candle, filled at the open of the 15-minute candle that follows, the
 * spread + slippage charged once. The trade is then followed on 15-minute
 * candles: the stop is tested first, then the take-profit, then the profit
 * lock moves the stop for the candles that follow, then the time limit. One
 * trade at a time.
 */
export interface BtcTrade {
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
}

export function runBtcBacktest(opts: {
  /** closed candles, oldest first, with history before `from` for the indicators */
  m15: Candle[];
  h1: Candle[];
  daily: Candle[];
  /** only trades entered at or after this time are kept (epoch seconds) */
  from?: number;
  costMultiplier?: number;
}): BtcTrade[] {
  const { m15, from = 0, costMultiplier = 1 } = opts;
  const s = buildBtcSeries(opts);
  const cost = BTC_COST * Math.max(0, costMultiplier);
  const trades: BtcTrade[] = [];
  /** the first 15-minute candle a new trade may be entered on: the one after the last trade's exit candle */
  let free = 0;
  let e = 0;
  for (let j = BTC_MIN_CANDLES; j < s.n; j++) {
    const closed = s.h4[j].time + BTC_CHART_SECONDS;
    // the 15-minute candle the trade is filled on: the first one at or after the 4-hour close
    while (e < m15.length && m15[e].time < closed) e++;
    if (e >= m15.length) break;
    if (m15[e].time < from || e < free) continue;
    // the market was closed at the 4-hour close (the weekend): no trade
    if (m15[e].time - closed > BTC_MAX_ENTRY_DELAY) continue;
    const setup = btcStateAt(s, j, m15[e].open).setup;
    if (!setup) continue;
    const dir = setup.direction === "long" ? 1 : -1;
    let stop = setup.stopLoss;
    let exitPrice = NaN;
    let outcome: BtcTrade["outcome"] = "open";
    let k = e;
    for (; k < m15.length; k++) {
      const cd = m15[k];
      if (dir === 1 ? cd.low <= stop : cd.high >= stop) {
        // a candle that opens beyond the stop fills at the open
        exitPrice = dir === 1 ? Math.min(stop, cd.open) : Math.max(stop, cd.open);
        outcome = stop === setup.stopLoss ? "stop" : "lock";
        break;
      }
      if (dir === 1 ? cd.high >= setup.takeProfit : cd.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      if (dir === 1 ? cd.high >= setup.entry + BTC_LOCK_AT_R * setup.risk : cd.low <= setup.entry - BTC_LOCK_AT_R * setup.risk) {
        const locked = setup.entry + dir * BTC_LOCK_TO_R * setup.risk;
        if (dir === 1 ? locked > stop : locked < stop) stop = locked;
      }
      if (k - e + 1 >= BTC_MAX_HOLD_BARS) {
        exitPrice = cd.close;
        outcome = "time";
        break;
      }
    }
    if (!Number.isFinite(exitPrice)) {
      k = m15.length - 1;
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
      rAchieved: (dir * (exitPrice - setup.entry) - cost) / setup.risk,
      bars: k - e + 1,
      outcome,
    });
    free = outcome === "open" ? Infinity : k + 1;
  }
  return trades;
}

/** The measures every result is reported with. */
export interface BtcStats {
  trades: number;
  won: number;
  winRate: number;
  totalR: number;
  avgR: number;
  maxDrawdownR: number;
  longestLosingRun: number;
  runsOf3: number;
  runsOf4: number;
}
export function btcStats(g: BtcTrade[]): BtcStats {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  let run = 0;
  let longest = 0;
  let n3 = 0;
  let n4 = 0;
  for (const t of g) {
    eq += t.rAchieved;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    if (t.rAchieved > 0) {
      if (run >= 3) n3++;
      if (run >= 4) n4++;
      run = 0;
    } else {
      run++;
      longest = Math.max(longest, run);
    }
  }
  if (run >= 3) n3++;
  if (run >= 4) n4++;
  const won = g.filter((t) => t.rAchieved > 0).length;
  return { trades: g.length, won, winRate: g.length ? won / g.length : 0, totalR: eq, avgR: g.length ? eq / g.length : 0, maxDrawdownR: dd, longestLosingRun: longest, runsOf3: n3, runsOf4: n4 };
}
