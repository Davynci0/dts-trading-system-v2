import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Multi-year backtest of the live rules — the trend entries
 * (lib/analysis/trend.ts) and the Fibonacci retracement
 * (lib/analysis/fibonacci.ts) — with the scanner's own detection: a signal on
 * a closed candle, filled at the next 15-minute candle's open, the full
 * spread + slippage charged once, one trade at a time in each of the two books.
 *
 * The rules were chosen on the first ten years (DESIGN) and left alone for the
 * last five, which are printed separately; a second pass doubles the costs.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--years=15] [--save]
 *   --years=N  history length (default 15, 1–15)
 *   --save     store the run in Supabase so it appears on the Backtests page
 * The first run of a day downloads the candles; later runs read the cache.
 */
import { computeMetrics, type ScopedMetrics } from "@/lib/backtest/fib";
import { ENTRY_TYPES, runSystemBacktest, type SystemTrade } from "@/lib/backtest/system";
import { FIB_MAX_HOLD_BARS, FIB_MIN_LEG_ATR, FIB_SWING_ATR, FIB_TARGET_EXTENSION, FIB_TREND_DAYS, FIB_ZONE_DEEP, FIB_ZONE_SHALLOW } from "@/lib/analysis/fibonacci";
import { TREND_ADX_MIN, TREND_BREAKOUT_BARS, TREND_DAYS, TREND_FAST_EMA, TREND_RSI_LEVEL, TREND_SLOW_EMA, TREND_STOP_ATR, TREND_TARGET_R, TREND_TRAIL_ATR } from "@/lib/analysis/trend";
import { EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Candle } from "@/lib/types";
import { loadPairData, windowEnd } from "./research-data";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`));
const YEARS = Math.max(1, Math.min(15, Number(flag("years")?.split("=")[1] ?? 15)));
const SAVE = flag("save") != null;
const PAIR = "XAU_USD";

const END = windowEnd() / 1000;
const YEAR_S = 365 * 86400;
const START = END - YEARS * YEAR_S;
/** The rules were chosen on data before this moment; everything after it is untouched. */
const DESIGN_END = END - 5 * YEAR_S;

type T = SystemTrade;
const inYear = (k: number) => (t: T) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S;
const between = (a: number, b: number) => (t: T) => t.entryTime >= a && t.entryTime < b;

/** t of the weekly R sums over the window — weeks without a trade count as zero. */
function weeklyT(trades: T[], from: number, to: number): number {
  const weeks = new Map<number, number>();
  for (const t of trades) weeks.set(Math.floor(t.exitTime / (7 * 86400)), (weeks.get(Math.floor(t.exitTime / (7 * 86400))) ?? 0) + t.rAchieved);
  const n = Math.max(2, Math.round((to - from) / (7 * 86400)));
  const mean = trades.reduce((sum, t) => sum + t.rAchieved, 0) / n;
  let v = (n - weeks.size) * mean ** 2;
  for (const x of weeks.values()) v += (x - mean) ** 2;
  v /= n - 1;
  return v > 0 ? mean / Math.sqrt(v / n) : 0;
}

function line(name: string, trades: T[], from = START, to = END): string {
  const m = computeMetrics(trades);
  if (m.trades === 0) return `${name.padEnd(26)}    0 trades`;
  const weeks = (to - from) / (7 * 86400);
  return `${name.padEnd(26)} ${String(m.trades).padStart(4)} trades ${(m.trades / weeks).toFixed(2)}/week  win ${(m.winRate * 100).toFixed(0).padStart(2)}%  pf ${m.profitFactor.toFixed(2)}  avgR ${m.avgR.toFixed(3).padStart(6)}  total ${m.totalR.toFixed(1).padStart(6)}R  maxDD ${m.maxDrawdownR.toFixed(1).padStart(5)}R  weekly t ${weeklyT(trades, from, to).toFixed(1)}`;
}

function scoped(trades: T[]): ScopedMetrics {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const cut = START + 0.7 * (END - START);
  return {
    inSample: computeMetrics(sorted.filter((t) => t.entryTime < cut)),
    outOfSample: computeMetrics(sorted.filter((t) => t.entryTime >= cut)),
    all: computeMetrics(sorted),
  };
}

async function save(trades: T[]): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) throw new Error("--save needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7);
  const scopes: Record<string, ScopedMetrics> = { combined: scoped(trades) };
  for (let k = 0; k < YEARS; k++) {
    scopes[`year:${String(k + 1).padStart(2, "0")} · ${month(START + k * YEAR_S)} → ${month(START + (k + 1) * YEAR_S)}`] = scoped(trades.filter(inYear(k)));
  }
  for (const type of ENTRY_TYPES) scopes[`strategy:${type}`] = scoped(trades.filter((t) => t.entryType === type));
  scopes["pair:buys"] = scoped(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scoped(trades.filter((t) => t.direction === "short"));

  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs: [PAIR],
      timeframes: ["H1", EXECUTION_TIMEFRAME],
      notes: `${YEARS} year${YEARS > 1 ? "s" : ""} · trend entries (1-hour breakout + RSI pullback, trailing stop) + Fibonacci retracement (${EXECUTION_TIMEFRAME}) · XAU/USD`,
      config: {
        engine: ENGINE_VERSION,
        years: YEARS,
        system: "trend + fibonacci",
        trend: {
          emas: [TREND_FAST_EMA, TREND_SLOW_EMA],
          adxMin: TREND_ADX_MIN,
          trendDays: TREND_DAYS,
          breakoutBars: TREND_BREAKOUT_BARS,
          rsiLevel: TREND_RSI_LEVEL,
          stopAtr: TREND_STOP_ATR,
          trailAtr: TREND_TRAIL_ATR,
          targetR: TREND_TARGET_R,
        },
        fibonacci: {
          trendDays: FIB_TREND_DAYS,
          swingAtr: FIB_SWING_ATR,
          minLegAtr: FIB_MIN_LEG_ATR,
          zone: [FIB_ZONE_SHALLOW, FIB_ZONE_DEEP],
          targetExtension: 1 + FIB_TARGET_EXTENSION,
          maxHoldBars: FIB_MAX_HOLD_BARS,
        },
        costs: "full spread + slippage per trade",
      },
    })
    .select("id")
    .single();
  if (error || !run) throw new Error(`could not store the run: ${error?.message ?? "no row returned"}`);
  const { error: resultsError } = await supabase
    .from("backtest_results")
    .insert(Object.entries(scopes).map(([scope, m]) => ({ run_id: run.id, scope, metrics: m })));
  if (resultsError) throw new Error(`could not store the results: ${resultsError.message}`);
  console.log(`\nSaved run ${run.id} (${Object.keys(scopes).length} scopes) — open the Backtests page.`);
}

function report(name: string, base: T[], stressed: T[]) {
  console.log(`\n${name}`);
  console.log(line("  ALL", base));
  console.log(line("  COSTS ×2", stressed));
  if (START < DESIGN_END) {
    console.log(line("  DESIGN (rules chosen)", base.filter(between(START, DESIGN_END)), START, DESIGN_END));
    console.log(line("  AFTER (untouched)", base.filter(between(DESIGN_END, END)), DESIGN_END, END));
  }
}

async function main() {
  const data = await loadPairData(PAIR, 15 * 365, true);
  const run = (costMultiplier: number) =>
    runSystemBacktest({ pair: PAIR, m15: data.m15 as Candle[], h1: data.h1 as Candle[], h4: data.h4 as Candle[], daily: data.daily as Candle[], from: START, costMultiplier });
  const base = run(1);
  const stressed = run(2);
  const book = (b: T["book"]) => (t: T) => t.book === b;

  console.log(`\nTrend entries (1-hour) + Fibonacci retracement (${EXECUTION_TIMEFRAME}), ${YEARS} year${YEARS > 1 ? "s" : ""} to ${new Date(END * 1000).toISOString().slice(0, 10)}, R multiples after full spread + slippage`);
  report("THE SYSTEM (both books)", base.all, stressed.all);
  report("TREND ENTRIES", base.all.filter(book("trend")), stressed.all.filter(book("trend")));
  report("FIBONACCI RETRACEMENT", base.all.filter(book("fibonacci")), stressed.all.filter(book("fibonacci")));

  const count = <X extends { outcome: string }>(g: X[], o: string) => g.filter((t) => t.outcome === o).length;
  console.log(`\ntrend exits: stop ${count(base.trend, "stop")}, trailing stop ${count(base.trend, "trail")}, take-profit ${count(base.trend, "target")}, still open ${count(base.trend, "open")}`);
  console.log(`fibonacci exits: target ${count(base.fib, "target")}, stop ${count(base.fib, "stop")}, five-day time limit ${count(base.fib, "time")}, still open ${count(base.fib, "open")}`);

  console.log("\nby year (oldest first), both books");
  for (let k = 0; k < YEARS; k++) console.log(line(`  ${new Date((START + k * YEAR_S) * 1000).toISOString().slice(0, 7)} →`, base.all.filter(inYear(k)), START + k * YEAR_S, START + (k + 1) * YEAR_S));
  console.log("\nby entry and side");
  for (const type of ENTRY_TYPES) console.log(line(`  ${type}`, base.all.filter((t) => t.entryType === type)));
  console.log(line("  buys", base.all.filter((t) => t.direction === "long")));
  console.log(line("  sells", base.all.filter((t) => t.direction === "short")));
  console.log("\nrecent windows (trades entered inside the window), both books");
  for (const [name, days] of [["3 years", 1095], ["1 year", 365], ["6 months", 182], ["3 months", 91], ["1 month", 30], ["1 week", 7]] as const) {
    const g = base.all.filter((t) => t.entryTime >= END - days * 86400);
    console.log(`${line(`  ${name}`, g, END - days * 86400, END)}  still open ${g.filter((t) => t.open).length}`);
  }
  if (SAVE) await save(base.all);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
