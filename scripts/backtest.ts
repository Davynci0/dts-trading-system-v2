import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Multi-year backtest of the live rules.
 *
 * Runs the backtest exactly as the scanner sends signals — the shared send
 * gate (session, weekly veto, M15 structure), closed-bar higher timeframes,
 * one trade per pair, the per-strategy confirmation minimums, full spread +
 * slippage — and prints the whole window next to each of its years. A second
 * pass doubles the costs.
 *
 * Read the t column before the profit factor: |t| under 2 means the average
 * is not distinguishable from zero.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--years=3] [--save] [PAIR ...]
 *   --years=N  history length (default 3, up to 15 — judge the rules on the long run)
 *   --save     store the run in Supabase so it appears on the Backtests page
 *   PAIR ...   instruments (default: PAIRS, i.e. XAU_USD)
 * Settings come from the environment, exactly as in production, e.g.
 *   SIGNAL_STRATEGIES=breakout,setforget BREAKOUT_TARGET_R=1 npx tsx ...
 */
import { computeMetrics, runBacktest, type BacktestTrade, type ScopedMetrics } from "@/lib/backtest/engine";
import { BREAKOUT_TARGET_R, KEY_LEVEL_CHECK, PULLBACK_STOP_ATR, PULLBACK_TARGET_R, PULLBACK_TREND_DAYS } from "@/lib/analysis";
import { tradingHoursUtc } from "@/lib/analysis/session";
import { MAX_COST_SHARE } from "@/lib/analysis/risk";
import { minConfidenceFor, signalPairs, signalStrategies } from "@/lib/engine/scanner";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, STRATEGIES } from "@/lib/types";
import { loadPairData, windowEnd, type PairData } from "./research-data";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`));
const YEARS = Math.max(1, Math.min(15, Number(flag("years")?.split("=")[1] ?? 3)));
const SAVE = flag("save") != null;
const pairs = args.filter((a) => !a.startsWith("--")).length ? args.filter((a) => !a.startsWith("--")) : [...PAIRS];

const SPAN_DAYS = YEARS * 365;
const END = windowEnd() / 1000;
const START = END - SPAN_DAYS * 86400;
const YEAR_S = 365 * 86400;

type Trade = BacktestTrade & { pair: string; entryTime: number };

/** The strategies that send live signals (SIGNAL_STRATEGIES) — the backtest runs the same ones. */
const strategies = [...signalStrategies()];

const gateFor = (pair: string) => ({
  breakout: minConfidenceFor(pair, "breakout"),
  sr: minConfidenceFor(pair, "sr"),
  zones: minConfidenceFor(pair, "zones"),
  setforget: minConfidenceFor(pair, "setforget"),
  fibonacci: minConfidenceFor(pair, "fibonacci"),
});

function simulate(pair: string, data: PairData, costMultiplier: number): Trade[] {
  const report = runBacktest({
    pair,
    timeframe: "M15",
    candles: data.m15,
    htfCandles: data.h1,
    topDownCandles: { weekly: data.weekly, daily: data.daily, h4: data.h4, h1: data.h1 },
    minConfidence: gateFor(pair),
    oneTradePerPair: true,
    strategies,
    costMultiplier,
  });
  return report.trades.map((t) => ({ ...t, pair, entryTime: data.m15[t.entryIndex].time }));
}

/** Grade A = a flipped support/resistance level sat just behind the entry. */
const gradeA = (t: Trade) => t.checks[KEY_LEVEL_CHECK] === true;
const inYear = (k: number) => (t: Trade) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S;
const byTime = (trades: Trade[]) => [...trades].sort((a, b) => a.entryTime - b.entryTime);

function cell(trades: Trade[]): string {
  const m = computeMetrics(byTime(trades));
  if (m.trades === 0) return "   0".padEnd(41);
  return `${String(m.trades).padStart(4)} win ${(m.winRate * 100).toFixed(0).padStart(2)}% pf ${m.profitFactor.toFixed(2).padStart(5)} avgR ${m.avgR.toFixed(3).padStart(6)} t ${m.tStat.toFixed(1).padStart(4)}`;
}

function row(name: string, trades: Trade[]): void {
  const cols = Array.from({ length: YEARS }, (_, k) => `Y${k + 1} ${cell(trades.filter(inYear(k)))}`);
  console.log(`${name.padEnd(12)} ALL ${cell(trades)} | ${cols.join(" | ")}`);
}

function scoped(trades: Trade[]): ScopedMetrics {
  const sorted = byTime(trades);
  return {
    inSample: computeMetrics(sorted.filter((t) => t.inSample)),
    outOfSample: computeMetrics(sorted.filter((t) => !t.inSample)),
    all: computeMetrics(sorted),
  };
}

async function save(trades: Trade[]): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) throw new Error("--save needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

  const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7);
  const scopes: Record<string, ScopedMetrics> = { combined: scoped(trades) };
  for (let k = 0; k < YEARS; k++) {
    // zero-padded so ten or more years still sort in order on the Backtests page
    scopes[`year:${String(k + 1).padStart(2, "0")} · ${month(START + k * YEAR_S)} → ${month(START + (k + 1) * YEAR_S)}`] = scoped(trades.filter(inYear(k)));
  }
  for (const s of STRATEGIES) if (strategies.includes(s.id)) scopes[`strategy:${s.id}`] = scoped(trades.filter((t) => t.strategy === s.id));
  scopes["grade:A · key level behind the entry"] = scoped(trades.filter(gradeA));
  scopes["grade:B · no key level"] = scoped(trades.filter((t) => !gradeA(t)));
  for (const p of pairs) scopes[`pair:${p}`] = scoped(trades.filter((t) => t.pair === p));

  const live = signalPairs();
  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs,
      timeframes: ["M15"],
      notes: `${YEARS} year${YEARS > 1 ? "s" : ""} · ${strategies.join(" + ")} · ${pairs.map((p) => p.replace("_", "/")).join(", ")}`,
      config: {
        engine: ENGINE_VERSION,
        years: YEARS,
        tradingHoursUtc: tradingHoursUtc().join("-"),
        maxCostShare: MAX_COST_SHARE,
        costs: "full spread + slippage per trade",
        oneTradePerPair: true,
        signalPairs: [...live],
        strategies,
        breakoutTargetR: BREAKOUT_TARGET_R,
        pullback: { trendDays: PULLBACK_TREND_DAYS, stopAtr: PULLBACK_STOP_ATR, targetR: PULLBACK_TARGET_R },
      },
    })
    .select("id")
    .single();
  if (error || !run) throw new Error(`could not store the run: ${error?.message ?? "no row returned"}`);

  const { error: resultsError } = await supabase
    .from("backtest_results")
    .insert(Object.entries(scopes).map(([scope, metrics]) => ({ run_id: run.id, scope, metrics })));
  if (resultsError) throw new Error(`could not store the results: ${resultsError.message}`);
  console.log(`\nSaved run ${run.id} (${Object.keys(scopes).length} scopes) — open the Backtests page.`);
}

async function main() {
  const base: Trade[] = [];
  const stressed: Trade[] = [];
  for (const pair of pairs) {
    const data = await loadPairData(pair, SPAN_DAYS);
    base.push(...simulate(pair, data, 1));
    stressed.push(...simulate(pair, data, 2));
  }

  console.log(`\nLive rules, ${YEARS} year${YEARS > 1 ? "s" : ""} to ${new Date(END * 1000).toISOString().slice(0, 10)} (Y1 oldest), R multiples after full spread + slippage`);
  row("PORTFOLIO", base);
  for (const s of STRATEGIES) if (strategies.includes(s.id)) row(` ${s.id}`, base.filter((t) => t.strategy === s.id));
  row(" grade A", base.filter(gradeA));
  row(" grade B", base.filter((t) => !gradeA(t)));
  if (pairs.length > 1) for (const p of pairs) row(` ${p}`, base.filter((t) => t.pair === p));
  const cost = base.reduce((s, t) => s + t.costR, 0) / Math.max(1, base.length);
  console.log(`\n${(base.length / (YEARS * 260)).toFixed(1)} trades per trading day; costs average ${(cost * 100).toFixed(1)}% of the risk per trade.`);
  row("COSTS ×2", stressed);
  console.log("\nA row with under ~200 trades is mostly noise (±0.1R per trade at 200). Judge the portfolio row, every year of it.");

  if (SAVE) await save(base);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
