import type { Candle, StrategyId } from "@/lib/types";
import { buildSetupKey } from "@/lib/analysis/setupKey";
import {
  analyzeM15,
  scoreSetup,
  computeRiskLevels,
  type ScoringContext,
} from "@/lib/analysis";
import { pipSize } from "@/lib/analysis/confirmations";
import { analyzeTopDown, type TopDownCandles } from "@/lib/analysis/topDown";

/** Typical spread per instrument, in pips (Section 7: realistic conditions). */
export const SPREAD_PIPS: Record<string, number> = {
  XAU_USD: 3.0,
  EUR_USD: 1.0,
  GBP_USD: 1.2,
  USD_JPY: 1.0,
};
export const SLIPPAGE_PIPS = 0.5; // per side
const WINDOW = 500; // rolling analysis window per step
const WARMUP = 80;
const MAX_HOLD_CANDLES = 100;
const OUT_OF_SAMPLE_FRACTION = 0.3; // last 30% = walk-forward segment

export interface BacktestTrade {
  strategy: StrategyId;
  direction: "long" | "short";
  entryIndex: number;
  exitIndex: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  rAchieved: number;
  confirmations: number; // of the 4 non-AI checks
  /** which individual checks were true at entry (Vision excluded) */
  checks: Record<string, boolean>;
  outcome: "tp" | "sl" | "timeout";
  /** true when entered in the first 70% of the series (walk-forward split) */
  inSample: boolean;
}

export interface MetricsCore {
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  maxDrawdownR: number;
  /** Section 7 confidence split. Vision can't be queried retroactively, so
   * counts are out of 4 non-AI checks: "3" and "4" buckets; "5" is impossible. */
  confidence3: number;
  confidence4: number;
}

export interface ScopedMetrics {
  inSample: MetricsCore;
  outOfSample: MetricsCore;
}

export interface BacktestReport {
  pair: string;
  timeframe: string;
  candles: number;
  generatedAt: string;
  limitation: string;
  scopes: Record<string, ScopedMetrics>; // per-pair combined + per-strategy (this pair only)
  trades: BacktestTrade[]; // raw trades for cross-pair aggregation by the caller
}

export function computeMetrics(trades: BacktestTrade[]): MetricsCore {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, wins: 0, winRate: 0, profitFactor: 0, avgR: 0, maxDrawdownR: 0, confidence3: 0, confidence4: 0 };
  }
  const wins = trades.filter((t) => t.rAchieved > 0);
  const grossWin = wins.reduce((s, t) => s + t.rAchieved, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rAchieved <= 0).reduce((s, t) => s + t.rAchieved, 0));
  // JSONB can't store Infinity — clamp to a sentinel the UI renders as ∞
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999.99 : 0;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.rAchieved;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  return {
    trades: n,
    wins: wins.length,
    winRate: wins.length / n,
    profitFactor: pf,
    avgR: trades.reduce((s, t) => s + t.rAchieved, 0) / n,
    maxDrawdownR: maxDd,
    confidence3: trades.filter((t) => t.confirmations === 3).length,
    confidence4: trades.filter((t) => t.confirmations >= 4).length,
  };
}

/**
 * Backtest (Section 7). Walks the series forward evaluating all three
 * strategies on a rolling window of CLOSED candles only (no lookahead).
 * Vision AI is excluded (can't be queried retroactively at scale), so scoring
 * runs 4-of-5 with the threshold still at 3 — noted in the report.
 * Entry fills at the next candle's open ± half-spread + slippage; if a candle
 * touches both SL and TP, the stop is assumed hit first (conservative).
 * Results are NOT optimized toward any target — reported as produced.
 */
export function runBacktest(opts: {
  pair: string;
  timeframe: string;
  candles: Candle[];
  htfCandles: Candle[];
  /** Optional only for compatibility with existing deterministic test callers. */
  topDownCandles?: TopDownCandles;
  accountBalance?: number;
}): BacktestReport {
  const { pair, timeframe, candles, htfCandles, topDownCandles, accountBalance = 10000 } = opts;
  const pip = pipSize(pair);
  const spread = (SPREAD_PIPS[pair] ?? 1.5) * pip;
  const slip = SLIPPAGE_PIPS * pip;
  const cost = spread / 2 + slip;

  const trades: BacktestTrade[] = [];
  const open: Partial<Record<StrategyId, BacktestTrade>> = {};
  const traded = new Set<string>();
  const oosStart = Math.floor(candles.length * (1 - OUT_OF_SAMPLE_FRACTION));

  for (let i = WARMUP; i < candles.length - 1; i++) {
    // 1) manage open trades on this candle (SL/TP/timeout)
    for (const strategy of Object.keys(open) as StrategyId[]) {
      const t = open[strategy]!;
      const c = candles[i];
      const hitSl = t.direction === "long" ? c.low <= t.stopLoss : c.high >= t.stopLoss;
      const hitTp = t.direction === "long" ? c.high >= t.takeProfit : c.low <= t.takeProfit;

      if (hitSl || hitTp || i - t.entryIndex >= MAX_HOLD_CANDLES || i === candles.length - 1) {
        let exitPrice: number;
        let outcome: BacktestTrade["outcome"];
        if (hitSl) {
          exitPrice = t.stopLoss; // conservative: both hit → stop first
          outcome = "sl";
        } else if (hitTp) {
          exitPrice = t.takeProfit;
          outcome = "tp";
        } else {
          exitPrice = c.close;
          outcome = "timeout";
        }
        const stopDist = Math.abs(t.entry - t.stopLoss);
        t.exitIndex = i;
        t.exitPrice = exitPrice;
        t.rAchieved =
          (t.direction === "long" ? exitPrice - t.entry : t.entry - exitPrice) / stopDist;
        t.outcome = outcome;
        trades.push(t);
        delete open[strategy];
      }
    }

    // 2) evaluate strategies on the closed-candle window (no lookahead)
    const windowCandles = candles.slice(Math.max(0, i - WINDOW), i + 1);
    const m15 = analyzeM15(windowCandles);
    if (!m15) continue;
    const { pivots, atrValue, zones, trendlines, structureEvent, fib, setForget } = m15;

    // HTF agreement uses only HTF candles closed before this candle's time
    const cutoff = windowCandles[windowCandles.length - 1].time;
    const htfSlice = htfCandles.filter((c) => c.time <= cutoff).slice(-300);
    const topDown = topDownCandles
      ? analyzeTopDown({
          weekly: topDownCandles.weekly.filter((c) => c.time <= cutoff).slice(-160),
          daily: topDownCandles.daily.filter((c) => c.time <= cutoff).slice(-260),
          h4: topDownCandles.h4.filter((c) => c.time <= cutoff).slice(-360),
        })
      : undefined;

    const ctx: ScoringContext = {
      instrument: pair,
      candles: windowCandles,
      htfCandles: htfSlice,
      pivots,
      atrValue,
      zones,
      trendlines,
      structureEvent,
      fib,
      setForget,
      topDown,
    };

    for (const strategy of ["trendline", "structure", "zones", "setforget", "fibonacci"] as StrategyId[]) {
      if (open[strategy]) continue; // one open trade per strategy
      const scored = scoreSetup(strategy, ctx, null); // vision excluded (Section 7)
      if (!scored.hasTrigger || !scored.fired) continue;

      // same one-signal-per-setup rule as the live scanner
      const setupKey = buildSetupKey("bt", scored);
      if (traded.has(setupKey)) continue;

      const risk = computeRiskLevels({
        instrument: pair,
        direction: scored.direction,
        entry: windowCandles[windowCandles.length - 1].close,
        candles: windowCandles,
        pivots,
        zones,
        accountBalance,
      });
      if (!risk.ok) continue; // skipped-for-risk: logged in live mode, excluded here
      traded.add(setupKey);

      // fill at NEXT candle open ± costs (signal known only after close)
      const next = candles[i + 1];
      const entry =
        scored.direction === "long" ? next.open + cost : next.open - cost;
      const count = Object.entries(scored.confirmations)
        .filter(([k, v]) => k !== "Vision AI" && v)
        .length;

      open[strategy] = {
        strategy,
        direction: scored.direction,
        entryIndex: i + 1,
        exitIndex: -1,
        entry,
        stopLoss: risk.levels.stopLoss,
        takeProfit: risk.levels.takeProfit,
        exitPrice: 0,
        rAchieved: 0,
        checks: Object.fromEntries(Object.entries(scored.confirmations).filter(([k]) => k !== "Vision AI")),
        confirmations: count,
        outcome: "timeout",
        inSample: i + 1 < oosStart,
      };
    }
  }

  const inSample = trades.filter((t) => t.inSample);
  const outOfSample = trades.filter((t) => !t.inSample);

  const scopes: Record<string, ScopedMetrics> = {
    combined: { inSample: computeMetrics(inSample), outOfSample: computeMetrics(outOfSample) },
  };
  for (const strategy of ["trendline", "structure", "zones", "setforget", "fibonacci"] as StrategyId[]) {
    scopes[`strategy:${strategy}`] = {
      inSample: computeMetrics(inSample.filter((t) => t.strategy === strategy)),
      outOfSample: computeMetrics(outOfSample.filter((t) => t.strategy === strategy)),
    };
  }

  return {
    pair,
    timeframe,
    candles: candles.length,
    generatedAt: new Date().toISOString(),
    limitation:
      "Confirmation scoring used the 4 non-AI checks only (3-of-4 threshold applied as 3-of-5-minus-vision); Gemini vision check cannot be queried retroactively on historical charts. Confidence buckets are 3 and 4 of 4; 5-of-5 is impossible in backtest.",
    scopes,
    trades,
  };
}
