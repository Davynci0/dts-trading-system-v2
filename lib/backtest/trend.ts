import type { Candle } from "@/lib/types";
import { tradeCost } from "@/lib/analysis/instruments";
import {
  buildTrendSeries,
  trailThrough,
  trendSetupsAt,
  TREND_MAX_HOLD_BARS,
  type TrendSetup,
} from "@/lib/analysis/trend";

/**
 * Backtest of the trend system (lib/analysis/trend.ts), with the scanner's own
 * detection: signal on a CLOSED H4 candle, fill at the next candle's open plus
 * the full spread + slippage, at most one position per entry type, several
 * types side by side.
 *
 * The trailing stop is followed on `fine` candles (M15) when they are given —
 * the closest thing to the broker's tick-by-tick trailing stop — and on the H4
 * candles themselves otherwise. Within a candle the stop is always tested
 * before the candle's own extreme may move it.
 */
export interface TrendTrade {
  /** entry type id (TREND_ENTRIES) */
  entryId: string;
  strategy: "trend";
  direction: "long" | "short";
  /** when the position was opened / closed (epoch seconds) */
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  exitPrice: number;
  rAchieved: number;
  outcome: "stop" | "trail" | "time" | "open";
  /** best and worst point reached, in R */
  mfe: number;
  mae: number;
  // the fields computeMetrics reads
  confirmations: number;
  units: number;
}


export function runTrendBacktest(opts: {
  pair: string;
  /** closed H4 candles, oldest first, with history before `from` for the indicators */
  candles: Candle[];
  /** closed daily candles covering the whole run plus ~150 days before it */
  daily: Candle[];
  /** optional M15 candles for the trailing stop */
  fine?: Candle[];
  /** only trades entered at or after this time are kept (epoch seconds) */
  from?: number;
  costMultiplier?: number;
}): TrendTrade[] {
  const { pair, candles, daily, fine, from = 0, costMultiplier = 1 } = opts;
  const s = buildTrendSeries(candles, daily);
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const trades: TrendTrade[] = [];
  /** entry type → time its position closes */
  const busy = new Map<string, number>();

  for (let i = 0; i + 1 < s.n; i++) {
    const entryTime = s.t[i + 1];
    if (entryTime < from) continue;
    let setups: TrendSetup[];
    try {
      setups = trendSetupsAt(s, i, pair);
    } catch {
      continue;
    }
    for (const setup of setups) {
      if ((busy.get(setup.id) ?? 0) > entryTime) continue;
      const trade = follow(setup, i);
      if (!trade) continue;
      busy.set(setup.id, trade.exitTime);
      trades.push(trade);
    }
  }
  return trades.sort((a, b) => a.exitTime - b.exitTime);

  function follow(setup: TrendSetup, i: number): TrendTrade | null {
    const dir = setup.direction === "long" ? 1 : -1;
    const e = i + 1;
    const entry = s.o[e] + dir * cost;
    const risk = setup.stopDistance;
    const initialStop = entry - dir * risk;
    const deadline = s.t[e] + TREND_MAX_HOLD_BARS * s.bar;
    const bars = fine ?? candles;
    const barLen = fine ? 900 : s.bar;

    // first bar at or after the entry
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time < s.t[e]) lo = mid + 1;
      else hi = mid;
    }
    if (bars[lo].time < s.t[e]) return null;

    let stop = initialStop;
    let mfe = 0;
    let mae = 0;
    let exitPrice = NaN;
    let exitTime = 0;
    let outcome: TrendTrade["outcome"] = "open";
    for (let k = lo; k < bars.length; k++) {
      const b = bars[k];
      mae = Math.max(mae, (dir === 1 ? entry - b.low : b.high - entry) / risk);
      const step = trailThrough(setup.direction, stop, setup.trailDistance, [b]);
      if (step.exit) {
        exitPrice = step.exit.price;
        exitTime = b.time + barLen;
        outcome = stop === initialStop ? "stop" : "trail";
        break;
      }
      mfe = Math.max(mfe, (dir === 1 ? b.high - entry : entry - b.low) / risk);
      stop = step.stop;
      if (b.time + barLen >= deadline) {
        exitPrice = b.close;
        exitTime = b.time + barLen;
        outcome = "time";
        break;
      }
    }
    if (outcome === "open") {
      const b = bars[bars.length - 1];
      exitPrice = b.close;
      exitTime = b.time + barLen;
    }
    return {
      entryId: setup.id,
      strategy: "trend",
      direction: setup.direction,
      entryTime: s.t[e],
      exitTime,
      entry,
      stopLoss: initialStop,
      exitPrice,
      rAchieved: (dir * (exitPrice - entry)) / risk,
      outcome,
      mfe,
      mae,
      confirmations: 3,
      units: 0,
    };
  }
}

/** Most positions open at the same moment. */
export function maxOpenPositions(trades: TrendTrade[]): number {
  const events: [number, number][] = [];
  for (const t of trades) {
    events.push([t.entryTime, 1]);
    events.push([t.exitTime, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let most = 0;
  for (const [, d] of events) {
    open += d;
    most = Math.max(most, open);
  }
  return most;
}
