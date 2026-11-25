import { readTrendlines, tlDailyTrend, tlSetup, TL_MAX_HOLD_BARS, TL_OPTIONS, TL_SECONDS, type TlSetup } from "@/lib/analysis/trendline";
import { tradeCost } from "@/lib/analysis/instruments";
import type { Candle } from "@/lib/types";

/**
 * The trendline strategy, replayed. A setup is read on a CLOSED 1-hour candle
 * and filled at the open of the 15-minute candle that follows it. The trade is
 * then followed on 15-minute candles exactly as the live system settles it:
 * the stop first (a candle that touches both counts as the stop; a gap
 * through it fills at the candle's open), then the target, then the profit
 * lock, which moves the stop for the candles that follow, then the five-day
 * limit. The full spread plus slippage is charged once.
 */
export interface TlTrade {
  direction: "long" | "short";
  type: TlSetup["type"];
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  /** result in R after costs */
  rAchieved: number;
  /** 15-minute candles held */
  bars: number;
  /** stop = the first stop · lock = the stop after the profit lock moved it */
  outcome: "target" | "stop" | "lock" | "time" | "open";
}

/** Every setup from `from` on, each followed on its own — whether or not another trade was open. */
export function tlCandidates(opts: { pair: string; m15: Candle[]; h1: Candle[]; daily: Candle[]; from?: number; costMultiplier?: number }): TlTrade[] {
  const { pair, m15, h1, daily, from = 0, costMultiplier = 1 } = opts;
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const out: TlTrade[] = [];
  let e = 0;
  for (const ev of readTrendlines(h1, TL_OPTIONS, 0).events) {
    if (ev.time < from) continue;
    while (e < m15.length && m15[e].time < ev.time) e++;
    if (e >= m15.length) break;
    const { setup } = tlSetup(ev, h1[ev.index], tlDailyTrend(daily, ev.time), m15[e].open, pair);
    if (!setup) continue;
    const dir = setup.direction === "long" ? 1 : -1;
    let exitPrice = NaN;
    let outcome: TlTrade["outcome"] = "open";
    let stop = setup.stopLoss;
    let k = e;
    for (; k < m15.length; k++) {
      const c = m15[k];
      if (dir === 1 ? c.low <= stop : c.high >= stop) {
        exitPrice = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
        outcome = stop === setup.stopLoss ? "stop" : "lock";
        break;
      }
      if (dir === 1 ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      if (dir === 1 ? c.high >= setup.lockTrigger : c.low <= setup.lockTrigger) stop = setup.lockStop;
      if (k - e + 1 >= TL_MAX_HOLD_BARS) {
        exitPrice = c.close;
        outcome = "time";
        break;
      }
    }
    if (outcome === "open") {
      k = m15.length - 1;
      exitPrice = m15[k].close;
    }
    out.push({
      direction: setup.direction,
      type: setup.type,
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
  }
  return out;
}

/** The trades the strategy takes on its own: one at a time. Trades still open at the end of the data are left out. */
export function runTlBacktest(opts: Parameters<typeof tlCandidates>[0]): TlTrade[] {
  const taken: TlTrade[] = [];
  let busy = 0;
  for (const t of tlCandidates(opts)) {
    if (t.entryTime < busy) continue;
    busy = t.exitTime;
    if (t.outcome !== "open") taken.push(t);
  }
  return taken;
}

export { TL_SECONDS };
