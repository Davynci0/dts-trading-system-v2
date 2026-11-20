/**
 * Walk-forward validation of the LIVE configuration on three years of M15 data.
 *
 * Runs the backtest exactly as the scanner sends signals — the shared send
 * gate (session, weekly veto, M15 structure), closed-bar higher timeframes,
 * one trade per pair, the live per-strategy confirmation minimums — and prints
 * the whole window next to each of its three years, so a result that only
 * held in one regime is visible. A second pass doubles spread and slippage.
 *
 * Read the t column before the profit factor: |t| under 2 means the average
 * is not distinguishable from zero.
 *
 * Usage: npx tsx --env-file=.env.local scripts/research-validate.ts [PAIR ...]
 *        (no pairs = every pair in PAIRS)
 * Any gate setting can be overridden from the environment for a what-if run,
 * e.g. TRADING_HOURS_UTC=6-21 ZONES_MIN_CONFIDENCE=5 npx tsx ...
 */
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { minConfidenceFor } from "@/lib/engine/scanner";
import { PAIRS } from "@/lib/types";
import { DAY_MS, loadPairData, windowEnd, type PairData } from "./research-data";

const YEARS = 3;
const SPAN_DAYS = YEARS * 365;
const START = (windowEnd() - SPAN_DAYS * DAY_MS) / 1000;
const YEAR_S = 365 * 86400;

type Trade = BacktestTrade & { pair: string; entryTime: number; exitTime: number };

function metrics(trades: Trade[]): string {
  const n = trades.length;
  if (n === 0) return "   0".padEnd(41);
  const total = trades.reduce((s, t) => s + t.rAchieved, 0);
  const mean = total / n;
  const sd = Math.sqrt(trades.reduce((s, t) => s + (t.rAchieved - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = trades.filter((t) => t.rAchieved > 0);
  const grossWin = wins.reduce((s, t) => s + t.rAchieved, 0);
  const grossLoss = grossWin - total;
  const pf = grossLoss > 0 ? grossWin / grossLoss : 99;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return `${String(n).padStart(4)} win ${((100 * wins.length) / n).toFixed(0).padStart(2)}% pf ${pf.toFixed(2).padStart(5)} avgR ${mean.toFixed(3).padStart(6)} t ${t.toFixed(1).padStart(4)}`;
}

function row(name: string, trades: Trade[]): void {
  const year = (k: number) => trades.filter((t) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S);
  const cols = Array.from({ length: YEARS }, (_, k) => `Y${k + 1} ${metrics(year(k))}`);
  console.log(`${name.padEnd(12)} ALL ${metrics(trades)} | ${cols.join(" | ")}`);
}

function simulate(pair: string, data: PairData, costMultiplier: number): Trade[] {
  const report = runBacktest({
    pair,
    timeframe: "M15",
    candles: data.m15,
    htfCandles: data.h1,
    topDownCandles: { weekly: data.weekly, daily: data.daily, h4: data.h4, h1: data.h1 },
    minConfidence: {
      zones: minConfidenceFor(pair, "zones"),
      setforget: minConfidenceFor(pair, "setforget"),
      fibonacci: minConfidenceFor(pair, "fibonacci"),
    },
    oneTradePerPair: true,
    costMultiplier,
  });
  return report.trades.map((t) => ({
    ...t,
    pair,
    entryTime: data.m15[t.entryIndex].time,
    exitTime: data.m15[t.exitIndex].time,
  }));
}

async function main() {
  const pairs = process.argv.slice(2).length ? process.argv.slice(2) : [...PAIRS];
  const base: Trade[] = [];
  const stressed: Trade[] = [];
  for (const pair of pairs) {
    const data = await loadPairData(pair, SPAN_DAYS);
    base.push(...simulate(pair, data, 1));
    stressed.push(...simulate(pair, data, 2));
  }

  console.log(`\nLive gate, ${YEARS} years to ${new Date(windowEnd()).toISOString().slice(0, 10)} (Y1 oldest), R multiples after spread + slippage`);
  row("PORTFOLIO", base);
  for (const s of ["zones", "setforget", "fibonacci"]) row(` ${s}`, base.filter((t) => t.strategy === s));
  for (const p of pairs) row(` ${p}`, base.filter((t) => t.pair === p));
  const cost = base.reduce((s, t) => s + t.costR, 0) / Math.max(1, base.length);
  const perDay = base.length / (YEARS * 260);
  console.log(`\n${perDay.toFixed(1)} trades per trading day; costs average ${(cost * 100).toFixed(1)}% of the risk per trade.`);
  row("COSTS ×2", stressed);
  console.log("\nA row with under ~200 trades is mostly noise (±0.1R per trade at 200). Judge the portfolio row, every year of it.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
