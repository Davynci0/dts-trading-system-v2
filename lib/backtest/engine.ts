import type { Candle, StrategyId } from "@/lib/types";
import { buildSetupKey } from "@/lib/analysis/setupKey";
import {
  analyzeM15,
  scoreSetup,
  computeRiskLevels,
  trendModeFor,
  type ScoringContext,
  type ScoreResult,
  type RiskLevels,
} from "@/lib/analysis";
import { tradeCost, SPREAD_PIPS, SLIPPAGE_PIPS } from "@/lib/analysis/instruments";
import { analyzeTopDown, type TopDownAnalysis, type TopDownCandles } from "@/lib/analysis/topDown";
import { passesSendGate, selectSignal, type SignalCandidate } from "@/lib/engine/select";

export { SPREAD_PIPS, SLIPPAGE_PIPS };
const WINDOW = 500; // rolling analysis window per step
const WARMUP = 80;
/** Live signals stay open until TP/SL or the 7-day expiry (lib/engine/outcomes.ts);
 *  5 trading days of M15 bars mirrors that. Override per run with maxHoldCandles. */
const MAX_HOLD_CANDLES = 480;
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
  /** reward-to-risk the structure offered at the signal candle's close */
  plannedR: number;
  /** every strategy that agreed on this trade (primary first) */
  confluence: StrategyId[];
  /** stop distance in ATR, and the round-trip cost as a fraction of the risk —
   *  a tight stop on a wide-spread pair pays a large share of 1R in costs */
  stopAtr: number;
  costR: number;
  /** research-only annotations from the `annotate` hook */
  features?: Record<string, unknown>;
}

/** Median spacing between bar opens = the series' nominal bar length. The
 *  median ignores weekend gaps and the 23h/25h daily bars around DST changes. */
function barSeconds(candles: Candle[], fallback: number): number {
  const diffs: number[] = [];
  for (let i = 1; i < candles.length && diffs.length < 200; i++) diffs.push(candles[i].time - candles[i - 1].time);
  if (diffs.length === 0) return fallback;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/**
 * Forward-only cursor over a higher-timeframe series: how many of its bars had
 * fully CLOSED by time `t`. `Candle.time` is the bar's OPEN, so filtering on
 * `time <= t` would hand the strategy a bar that is still forming — up to a
 * week of future price on the weekly series.
 */
export function closedBarCursor(candles: Candle[], fallbackSeconds: number): (t: number) => number {
  const span = barSeconds(candles, fallbackSeconds);
  let end = 0;
  return (t: number) => {
    while (end < candles.length && candles[end].time + span <= t) end++;
    return end;
  };
}

export interface MetricsCore {
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  /** sum of R over the trades */
  totalR: number;
  /** avgR divided by its standard error — below ~2 the average is not
   *  distinguishable from zero, whatever the profit factor says */
  tStat: number;
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
  /** the whole run; present on runs stored by the current engine */
  all?: MetricsCore;
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
    return { trades: 0, wins: 0, winRate: 0, profitFactor: 0, avgR: 0, totalR: 0, tStat: 0, maxDrawdownR: 0, totalPnl: 0, confidence3: 0, confidence4: 0, confidence5: 0 };
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

  const totalR = trades.reduce((s, t) => s + t.rAchieved, 0);
  const sd = Math.sqrt(trades.reduce((s, t) => s + (t.rAchieved - totalR / n) ** 2, 0) / Math.max(1, n - 1));

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
    avgR: totalR / n,
    totalR,
    tStat: sd > 0 ? totalR / n / (sd / Math.sqrt(n)) : 0,
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
  /** Apply the scanner's send gate: HTF bias and M15 trend must both agree
   *  (each honours the pair's trend mode). Default true — set false only to
   *  research raw setups the live system would never send. */
  requireTrendAlignment?: boolean;
  /** Bars a trade may stay open before it is closed at market. */
  maxHoldCandles?: number;
  /** Scales spread + slippage: 0 isolates the raw entry edge from trading
   *  costs, 2 stress-tests wider real-world spreads. Default 1. */
  costMultiplier?: number;
  /** Research hook: called at each entry with the full decision context; the
   *  returned object is stored on the trade as `features`. */
  annotate?: (entry: {
    ctx: ScoringContext;
    scored: ScoreResult;
    levels: RiskLevels;
    topDown?: TopDownAnalysis;
  }) => Record<string, unknown>;
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
    requireTrendAlignment = true,
    maxHoldCandles = MAX_HOLD_CANDLES,
    costMultiplier = 1,
    annotate,
  } = opts;
  const minFor = (s: StrategyId): number => {
    if (typeof minConfidence === "number") return minConfidence;
    return minConfidence[s] ?? 3;
  };
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);

  const trades: BacktestTrade[] = [];
  const open: Partial<Record<StrategyId, BacktestTrade>> = {};
  const traded = new Set<string>();
  const oosStart = Math.floor(candles.length * (1 - OUT_OF_SAMPLE_FRACTION));

  const stepSeconds = barSeconds(candles, 900);
  const trendMode = trendModeFor(pair);
  const htfClosed = closedBarCursor(htfCandles, 3600);
  const tdClosed = topDownCandles
    ? {
        weekly: closedBarCursor(topDownCandles.weekly, 7 * 86400),
        daily: closedBarCursor(topDownCandles.daily, 86400),
        h4: closedBarCursor(topDownCandles.h4, 4 * 3600),
        h1: closedBarCursor(topDownCandles.h1, 3600),
      }
    : null;
  let topDownKey = "";
  let topDownCached: TopDownAnalysis | undefined;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    // 1) manage open trades on this candle (SL/TP/timeout)
    for (const strategy of Object.keys(open) as StrategyId[]) {
      const t = open[strategy]!;
      const c = candles[i];
      const hitSl = t.direction === "long" ? c.low <= t.stopLoss : c.high >= t.stopLoss;
      const hitTp = t.direction === "long" ? c.high >= t.takeProfit : c.low <= t.takeProfit;

      if (hitSl || hitTp || i - t.entryIndex >= maxHoldCandles) {
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
    if (oneTradePerPair && Object.keys(open).length > 0) continue; // live parity: one trade per pair
    const windowCandles = candles.slice(Math.max(0, i - WINDOW), i + 1);
    const m15 = analyzeM15(windowCandles, pair);
    if (!m15) continue;
    const { pivots, atrValue, zones, fib, setForget } = m15;

    // Higher timeframes: only bars that had CLOSED when this candle closed.
    const closeTime = candles[i].time + stepSeconds;
    const htfEnd = htfClosed(closeTime);
    const htfSlice = htfCandles.slice(Math.max(0, htfEnd - 300), htfEnd);
    let topDown: TopDownAnalysis | undefined;
    if (topDownCandles && tdClosed) {
      const w = tdClosed.weekly(closeTime);
      const d = tdClosed.daily(closeTime);
      const h4 = tdClosed.h4(closeTime);
      const h1 = tdClosed.h1(closeTime);
      const key = `${w}:${d}:${h4}:${h1}`;
      if (key !== topDownKey) {
        topDownKey = key;
        topDownCached = analyzeTopDown({
          weekly: topDownCandles.weekly.slice(Math.max(0, w - 52), w),
          daily: topDownCandles.daily.slice(Math.max(0, d - 90), d),
          h4: topDownCandles.h4.slice(Math.max(0, h4 - 120), h4),
          h1: topDownCandles.h1.slice(Math.max(0, h1 - 120), h1),
        });
      }
      topDown = topDownCached;
    }

    const ctx: ScoringContext = {
      instrument: pair,
      candles: windowCandles,
      htfCandles: htfSlice,
      pivots,
      structuralPivots: m15.structuralPivots,
      atrValue,
      zones,
      fib,
      setForget,
      topDown,
      trendMode,
      headShoulders: m15.headShoulders,
    };

    // Every strategy that reaches its gate on this candle, with the same
    // one-signal-per-setup rule as the live scanner.
    const candidates: (SignalCandidate & { setupKey: string })[] = [];
    for (const strategy of ALL_STRATEGIES) {
      if (!strategies.includes(strategy)) continue;
      if (open[strategy]) continue; // one open trade per strategy
      const scored = scoreSetup(strategy, ctx);
      if (!scored.hasTrigger || !scored.fired) continue;
      if (scored.count < minFor(strategy)) continue;
      // research filters: measure individual checks' marginal value
      if (requireChecks.some((c) => scored.confirmations[c] !== true)) continue;
      if (excludeChecks.some((c) => scored.confirmations[c] === true)) continue;

      const setupKey = buildSetupKey("bt", scored);
      if (traded.has(setupKey)) continue;

      const risk = computeRiskLevels({
        instrument: pair,
        direction: scored.direction,
        entry: windowCandles[windowCandles.length - 1].close,
        candles: windowCandles,
        pivots,
        zones,
        trigger: scored.trigger,
        accountBalance,
        quoteUsdRate,
      });
      const candidate = { strategy, direction: scored.direction, scored, risk, setupKey };
      // skipped-for-risk / counter-trend: logged in live mode, excluded here
      if (requireTrendAlignment ? !passesSendGate(candidate, minFor(strategy)) : !risk.ok) continue;
      candidates.push(candidate);
    }
    if (candidates.length === 0) continue;

    // Live parity: agreeing strategies collapse into ONE trade defined by the
    // best setup. Otherwise each strategy books its own trade.
    const selection = oneTradePerPair ? selectSignal(candidates, topDown) : null;
    const entries = selection
      ? [{ primary: selection.primary, group: selection.winners }]
      : candidates.map((c) => ({ primary: c, group: [c] }));

    for (const { primary, group } of entries) {
      if (!primary.risk.ok) continue;
      const levels = primary.risk.levels;
      // position size: fixed lots override risk-based sizing
      const units = fixedUnits ?? levels.positionUnits;
      if (!units || units <= 0) continue;
      for (const c of group) traded.add(c.setupKey);

      // fill at NEXT candle open ± costs (signal known only after close)
      const next = candles[i + 1];
      const entry = primary.direction === "long" ? next.open + cost : next.open - cost;
      // a gap through the stop or target before the fill leaves nothing to trade
      const stopSide = primary.direction === "long" ? entry <= levels.stopLoss : entry >= levels.stopLoss;
      const targetSide = primary.direction === "long" ? entry >= levels.takeProfit : entry <= levels.takeProfit;
      if (stopSide || targetSide) continue;

      open[primary.strategy] = {
        strategy: primary.strategy,
        direction: primary.direction,
        entryIndex: i + 1,
        exitIndex: -1,
        entry,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        exitPrice: 0,
        rAchieved: 0,
        checks: primary.scored.confirmations,
        confirmations: primary.scored.count,
        outcome: "timeout",
        inSample: i + 1 < oosStart,
        units,
        plannedR: levels.rMultiple,
        confluence: group.map((c) => c.strategy),
        stopAtr: levels.stopDistance / levels.atr,
        costR: cost / Math.abs(entry - levels.stopLoss),
        features: annotate?.({ ctx, scored: primary.scored, levels, topDown }),
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
      all: computeMetrics(trades, quoteUsdRate),
    },
  };
  for (const strategy of ALL_STRATEGIES) {
    scopes[`strategy:${strategy}`] = {
      inSample: computeMetrics(inSample.filter((t) => t.strategy === strategy), quoteUsdRate),
      outOfSample: computeMetrics(outOfSample.filter((t) => t.strategy === strategy), quoteUsdRate),
      all: computeMetrics(trades.filter((t) => t.strategy === strategy), quoteUsdRate),
    };
  }

  return {
    pair,
    timeframe,
    candles: candles.length,
    generatedAt: new Date().toISOString(),
    limitation:
      "Deterministic 6-point checklist and send gate, same as the live scanner; higher timeframes use closed bars only. Confidence buckets are 3, 4 and ≥5 out of 6. Costs (spread + slippage) are applied at entry; a candle touching both SL and TP settles as a loss. Confluent setups book separately per strategy unless oneTradePerPair is enabled (live parity).",
    scopes,
    trades,
  };
}
