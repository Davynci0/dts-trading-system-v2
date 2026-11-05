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
  GBP_JPY: 2.5,
  EUR_JPY: 1.4,
  AUD_JPY: 1.6,
  NZD_JPY: 2.0,
  GBP_AUD: 3.5,
  GBP_NZD: 4.5,
};
export const SLIPPAGE_PIPS = 0.5; // per side
const WINDOW = 500; // rolling analysis window per step
const WARMUP = 80;
const MAX_HOLD_CANDLES = 100;
const OUT_OF_SAMPLE_FRACTION = 0.3; // last 30% = walk-forward segment

/** Standard lot sizes in units. 0.1 lot = 10,000 units for most brokers. */
export const LOT_SIZES: Record<string, number> = {
  "0.01": 1000,
  "0.1": 10000,
  "1": 100000,
};
const ALL_STRATEGIES: StrategyId[] = ["zones", "setforget", "fibonacci"];

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
  confirmations: number; // of the 6 deterministic checks
  /** which individual checks were true at entry */
  checks: Record<string, boolean>;
  outcome: "tp" | "sl" | "timeout";
  /** true when entered in the first 70% of the series (walk-forward split) */
  inSample: boolean;
  /** position size in units used for P&L (risk-based or fixed) */
  units: number;
}

export interface MetricsCore {
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  maxDrawdownR: number;
  /** Absolute P&L in account currency using the fixed position size. */
  totalPnl: number;
  /** Confidence split out of the 6 deterministic checks: "3", "4" and "≥5". */
  confidence3: number;
  confidence4: number;
  confidence5: number;
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

export function computeMetrics(trades: BacktestTrade[], quoteUsdRate = 1): MetricsCore {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, wins: 0, winRate: 0, profitFactor: 0, avgR: 0, maxDrawdownR: 0, totalPnl: 0, confidence3: 0, confidence4: 0, confidence5: 0 };
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

  const totalPnl =
    trades.reduce(
      (s, t) => s + t.rAchieved * Math.abs(t.entry - t.stopLoss) * t.units,
      0
    ) * quoteUsdRate; // P&L is in the quote currency; convert to USD for reporting

  return {
    trades: n,
    wins: wins.length,
    winRate: wins.length / n,
    profitFactor: pf,
    avgR: trades.reduce((s, t) => s + t.rAchieved, 0) / n,
    maxDrawdownR: maxDd,
    totalPnl,
    confidence3: trades.filter((t) => t.confirmations === 3).length,
    confidence4: trades.filter((t) => t.confirmations === 4).length,
    confidence5: trades.filter((t) => t.confirmations >= 5).length,
  };
}

/**
 * Backtest (Section 7). Walks the series forward evaluating the strategies
 * on a rolling window of CLOSED candles only (no lookahead), using the same
 * deterministic 6-point checklist as the live scanner. Entry fills at the
 * next candle's open ± half-spread + slippage; if a candle touches both SL
 * and TP, the stop is assumed hit first (conservative). Results are NOT
 * optimized toward any target — reported as produced.
 */
export function runBacktest(opts: {
  pair: string;
  timeframe: string;
  candles: Candle[];
  htfCandles: Candle[];
  /** Optional only for compatibility with existing deterministic test callers. */
  topDownCandles?: TopDownCandles;
  accountBalance?: number;
  /** Fixed position size in units (e.g. 10000 = 0.1 lot). If omitted, risk-based sizing is used. */
  fixedUnits?: number;
  /** Risk percent of account balance per trade (default 0.01 = 1%). Only used when fixedUnits is omitted. */
  riskPercent?: number;
  /** Minimum confirmations to enter a trade. A single number applies to all
   *  strategies; a per-strategy record mirrors the live scanner's gate. Default 3. */
  minConfidence?: number | Partial<Record<StrategyId, number>>;
  /** Live-parity mode: at most ONE open trade at a time (per pair), regardless
   *  of strategy — mirrors the scanner's one-trade-per-pair rule. When false
   *  (default), each strategy books its own concurrent trades. */
  oneTradePerPair?: boolean;
  /** Strategies to run in the backtest. Defaults to all enabled. */
  strategies?: StrategyId[];
  /** Research-only entry filter: these checks must all be TRUE at entry.
   *  Used to measure the marginal value of individual confirmations. */
  requireChecks?: string[];
  /** Research-only entry filter: these checks must all be FALSE at entry. */
  excludeChecks?: string[];
  /** USD value of 1 unit of the quote currency — sizes USD risks correctly on
   *  JPY pairs and crosses (GBP_JPY, GBP_AUD, ...). Defaults to 1 (USD-quoted). */
  quoteUsdRate?: number;
}): BacktestReport {
  const {
    pair,
    timeframe,
    candles,
    htfCandles,
    topDownCandles,
    accountBalance = 10000,
    fixedUnits,
    minConfidence = 3,
    oneTradePerPair = false,
    strategies = ALL_STRATEGIES,
    requireChecks = [],
    excludeChecks = [],
    quoteUsdRate = 1,
  } = opts;
  const minFor = (s: StrategyId): number => {
    if (typeof minConfidence === "number") return minConfidence;
    return minConfidence[s] ?? 3;
  };
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

      if (hitSl || hitTp || i - t.entryIndex >= MAX_HOLD_CANDLES) {
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
        const { pivots, atrValue, zones, fib, setForget } = m15;

    // HTF agreement uses only HTF candles closed before this candle's time
    const cutoff = windowCandles[windowCandles.length - 1].time;
    const htfSlice = htfCandles.filter((c) => c.time <= cutoff).slice(-300);
    const topDown = topDownCandles
      ? analyzeTopDown({
          weekly: topDownCandles.weekly.filter((c) => c.time <= cutoff).slice(-52),
          daily: topDownCandles.daily.filter((c) => c.time <= cutoff).slice(-90),
          h4: topDownCandles.h4.filter((c) => c.time <= cutoff).slice(-120),
          h1: topDownCandles.h1.filter((c) => c.time <= cutoff).slice(-120),
        })
      : undefined;

    const ctx: ScoringContext = {
      instrument: pair,
      candles: windowCandles,
      htfCandles: htfSlice,
      pivots,
      atrValue,
      zones,
      fib,
      setForget,
      topDown,
    };

    for (const strategy of ALL_STRATEGIES) {
      if (!strategies.includes(strategy)) continue;
      if (open[strategy]) continue; // one open trade per strategy
      if (oneTradePerPair && Object.keys(open).length > 0) continue; // live parity: one trade per pair
      const scored = scoreSetup(strategy, ctx);
      if (!scored.hasTrigger || !scored.fired) continue;

      // Only enter if confidence meets the configured (per-strategy) minimum.
      const count = Object.values(scored.confirmations).filter(Boolean).length;
      if (count < minFor(strategy)) continue;
      // research filters: measure individual checks' marginal value
      if (requireChecks.some((c) => scored.confirmations[c] !== true)) continue;
      if (excludeChecks.some((c) => scored.confirmations[c] === true)) continue;

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
        quoteUsdRate,
      });
      if (!risk.ok) continue; // skipped-for-risk: logged in live mode, excluded here

      // position size: fixed lots override risk-based sizing
      const units = fixedUnits ?? risk.levels.positionUnits;
      if (!units || units <= 0) continue;
      traded.add(setupKey);

      // fill at NEXT candle open ± costs (signal known only after close)
      const next = candles[i + 1];
      const entry =
        scored.direction === "long" ? next.open + cost : next.open - cost;

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
             checks: scored.confirmations,
        confirmations: count,
        outcome: "timeout",
        inSample: i + 1 < oosStart,
        units,
      };
    }
  }

  // close out any trade still open at the end of the series at the final
  // close — dropping them would bias the metrics against recent entries.
  const lastIndex = candles.length - 1;
  for (const strategy of Object.keys(open) as StrategyId[]) {
    const t = open[strategy]!;
    const c = candles[lastIndex];
    const stopDist = Math.abs(t.entry - t.stopLoss);
    t.exitIndex = lastIndex;
    t.exitPrice = c.close;
    t.rAchieved = (t.direction === "long" ? c.close - t.entry : t.entry - c.close) / stopDist;
    t.outcome = "timeout";
    trades.push(t);
    delete open[strategy];
  }

  const inSample = trades.filter((t) => t.inSample);
  const outOfSample = trades.filter((t) => !t.inSample);

  const scopes: Record<string, ScopedMetrics> = {
    combined: {
      inSample: computeMetrics(inSample, quoteUsdRate),
      outOfSample: computeMetrics(outOfSample, quoteUsdRate),
    },
  };
  for (const strategy of ALL_STRATEGIES) {
    scopes[`strategy:${strategy}`] = {
      inSample: computeMetrics(inSample.filter((t) => t.strategy === strategy), quoteUsdRate),
      outOfSample: computeMetrics(outOfSample.filter((t) => t.strategy === strategy), quoteUsdRate),
    };
  }

  return {
    pair,
    timeframe,
    candles: candles.length,
    generatedAt: new Date().toISOString(),
    limitation:
      "Deterministic 6-point checklist, same as the live scanner. Confidence buckets are 3, 4 and ≥5 out of 6. Costs (spread + slippage) are applied at entry; a candle touching both SL and TP settles as a loss. Confluent setups book separately per strategy unless oneTradePerPair is enabled (live parity).",
    scopes,
    trades,
  };
}
