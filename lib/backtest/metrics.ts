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

/** The figures of a list of trades, in the order given (the drawdown follows that order). */
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
