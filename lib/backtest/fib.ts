import type { Candle } from "@/lib/types";
import { tradeCost } from "@/lib/analysis/instruments";
import { buildFibSeries, fibStateAt, FIB_MAX_HOLD_BARS, type FibLeg } from "@/lib/analysis/fibonacci";

/**
 * Backtest of the Fibonacci system (lib/analysis/fibonacci.ts) with the
 * scanner's own detection: a signal on a CLOSED 15-minute candle, filled at the
 * next candle's open, the full spread + slippage charged once. One trade per
 * leg and one trade at a time. Inside a candle the stop is tested before the
 * target, so a candle that touches both is a loss.
 */
export interface FibTrade {
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
  outcome: "target" | "stop" | "time" | "open";
  trigger: string;
  /** planned reward ÷ risk */
  plannedR: number;
  leg: FibLeg;
}

export function runFibBacktest(opts: {
  pair: string;
  /** closed candles, oldest first, with history before `from` for the indicators */
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  daily: Candle[];
  /** only trades entered at or after this time are kept (epoch seconds) */
  from?: number;
  costMultiplier?: number;
}): FibTrade[] {
  const { pair, m15, from = 0, costMultiplier = 1 } = opts;
  const s = buildFibSeries(opts);
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const trades: FibTrade[] = [];
  const used = new Set<string>();

  for (let i = 1; i < s.n - 1; i++) {
    if (m15[i + 1].time < from) continue;
    // cheap gate before the full read: a live leg must be in force
    if (s.legAt[i] < 0 || s.dead[i] === 1) continue;
    const key = s.legs[s.legAt[i]].key;
    if (used.has(key)) continue;
    const setup = fibStateAt(s, i, pair, m15[i + 1].open).setup;
    if (!setup) continue;
    used.add(key);

    const dir = setup.direction === "long" ? 1 : -1;
    const entryIndex = i + 1;
    let exitPrice = NaN;
    let outcome: FibTrade["outcome"] = "open";
    let k = entryIndex;
    for (; k < s.n; k++) {
      const c = m15[k];
      if (dir === 1 ? c.low <= setup.stopLoss : c.high >= setup.stopLoss) {
        // a gap through the stop fills at the open, not at the stop
        exitPrice = dir === 1 ? Math.min(setup.stopLoss, c.open) : Math.max(setup.stopLoss, c.open);
        outcome = "stop";
        break;
      }
      if (dir === 1 ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      if (k - entryIndex >= FIB_MAX_HOLD_BARS) {
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
      entryTime: m15[entryIndex].time,
      exitTime: m15[k].time + 900,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      rAchieved: (dir * (exitPrice - setup.entry) - cost) / setup.risk,
      outcome,
      trigger: setup.trigger,
      plannedR: setup.rr,
      leg: setup.leg,
    });
    // one trade at a time: nothing new until this one has closed
    i = Math.max(i, k);
  }
  return trades;
}

export interface MetricsCore {
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  totalR: number;
  tStat: number;
  maxDrawdownR: number;
  totalPnl: number;
  confidence3: number;
  confidence4: number;
  confidence5: number;
}

/** The whole run next to its first 70% (in-sample) and last 30% (out-of-sample). */
export interface ScopedMetrics {
  inSample: MetricsCore;
  outOfSample: MetricsCore;
  all: MetricsCore;
}

export function computeMetrics(trades: { rAchieved: number }[]): MetricsCore {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, wins: 0, winRate: 0, profitFactor: 0, avgR: 0, totalR: 0, tStat: 0, maxDrawdownR: 0, totalPnl: 0, confidence3: 0, confidence4: 0, confidence5: 0 };
  }
  const wins = trades.filter((t) => t.rAchieved > 0);
  const grossWin = wins.reduce((sum, t) => sum + t.rAchieved, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rAchieved <= 0).reduce((sum, t) => sum + t.rAchieved, 0));
  // JSONB can't store Infinity — clamp to a sentinel the UI renders as ∞
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999.99 : 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    equity += t.rAchieved;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const totalR = equity;
  const sd = Math.sqrt(trades.reduce((sum, t) => sum + (t.rAchieved - totalR / n) ** 2, 0) / Math.max(1, n - 1));
  return {
    trades: n,
    wins: wins.length,
    winRate: wins.length / n,
    profitFactor,
    avgR: totalR / n,
    totalR,
    tStat: sd > 0 ? totalR / n / (sd / Math.sqrt(n)) : 0,
    maxDrawdownR,
    totalPnl: 0,
    confidence3: 0,
    confidence4: 0,
    confidence5: n,
  };
}
