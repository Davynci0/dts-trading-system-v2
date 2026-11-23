import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Multi-year backtest of the live rules — the Fibonacci retracement system
 * (lib/analysis/fibonacci.ts) with the scanner's own detection: a signal on a
 * closed 15-minute candle, filled at the next candle's open, the full spread +
 * slippage charged once, one trade per leg and one trade at a time.
 *
 * The rules were chosen on the first ten years (DESIGN) and left alone for the
 * last five, which are printed separately; a second pass doubles the costs.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--years=15] [--save]
 *   --years=N  history length (default 15, 1–15)
 *   --save     store the run in Supabase so it appears on the Backtests page
 * The first run of a day downloads the candles; later runs read the cache.
 */
import { computeMetrics, runFibBacktest, type FibTrade, type ScopedMetrics } from "@/lib/backtest/fib";
import { FIB_MAX_HOLD_BARS, FIB_MIN_LEG_ATR, FIB_SWING_ATR, FIB_TARGET_EXTENSION, FIB_TREND_DAYS, FIB_ZONE_DEEP, FIB_ZONE_SHALLOW } from "@/lib/analysis/fibonacci";
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

const inYear = (k: number) => (t: FibTrade) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S;

/** t of the weekly R sums over the window — weeks without a trade count as zero. */
function weeklyT(trades: FibTrade[], from: number, to: number): number {
  const weeks = new Map<number, number>();
  for (const t of trades) weeks.set(Math.floor(t.exitTime / (7 * 86400)), (weeks.get(Math.floor(t.exitTime / (7 * 86400))) ?? 0) + t.rAchieved);
  const n = Math.max(2, Math.round((to - from) / (7 * 86400)));
  const mean = trades.reduce((sum, t) => sum + t.rAchieved, 0) / n;
  let v = (n - weeks.size) * mean ** 2;
  for (const x of weeks.values()) v += (x - mean) ** 2;
  v /= n - 1;
  return v > 0 ? mean / Math.sqrt(v / n) : 0;
}

function line(name: string, trades: FibTrade[], from = START, to = END): string {
  const m = computeMetrics(trades);
  if (m.trades === 0) return `${name.padEnd(24)}    0 trades`;
  const weeks = (to - from) / (7 * 86400);
  return `${name.padEnd(24)} ${String(m.trades).padStart(4)} trades ${(m.trades / weeks).toFixed(2)}/week  win ${(m.winRate * 100).toFixed(0).padStart(2)}%  pf ${m.profitFactor.toFixed(2)}  avgR ${m.avgR.toFixed(3).padStart(6)}  total ${m.totalR.toFixed(1).padStart(6)}R  maxDD ${m.maxDrawdownR.toFixed(1).padStart(5)}R  weekly t ${weeklyT(trades, from, to).toFixed(1)}`;
}

function scoped(trades: FibTrade[]): ScopedMetrics {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const cut = START + 0.7 * (END - START);
  return {
    inSample: computeMetrics(sorted.filter((t) => t.entryTime < cut)),
    outOfSample: computeMetrics(sorted.filter((t) => t.entryTime >= cut)),
    all: computeMetrics(sorted),
  };
}

async function save(trades: FibTrade[]): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) throw new Error("--save needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7);
  const scopes: Record<string, ScopedMetrics> = { combined: scoped(trades) };
  for (let k = 0; k < YEARS; k++) {
    scopes[`year:${String(k + 1).padStart(2, "0")} · ${month(START + k * YEAR_S)} → ${month(START + (k + 1) * YEAR_S)}`] = scoped(trades.filter(inYear(k)));
  }
  scopes["strategy:Engulfing candle entries"] = scoped(trades.filter((t) => t.trigger === "engulfing candle"));
  scopes["strategy:Pin bar entries"] = scoped(trades.filter((t) => t.trigger === "pin bar"));
  scopes["pair:buys"] = scoped(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scoped(trades.filter((t) => t.direction === "short"));

  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs: [PAIR],
      timeframes: [EXECUTION_TIMEFRAME],
      notes: `${YEARS} year${YEARS > 1 ? "s" : ""} · ${EXECUTION_TIMEFRAME} entries · Fibonacci retracement (daily + 4-hour trend, 1-hour swing) · XAU/USD`,
      config: {
        engine: ENGINE_VERSION,
        years: YEARS,
        system: "fibonacci",
        trendDays: FIB_TREND_DAYS,
        swingAtr: FIB_SWING_ATR,
        minLegAtr: FIB_MIN_LEG_ATR,
        zone: [FIB_ZONE_SHALLOW, FIB_ZONE_DEEP],
        targetExtension: 1 + FIB_TARGET_EXTENSION,
        maxHoldBars: FIB_MAX_HOLD_BARS,
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

async function main() {
  const data = await loadPairData(PAIR, 15 * 365, true);
  const run = (costMultiplier: number) =>
    runFibBacktest({ pair: PAIR, m15: data.m15 as Candle[], h1: data.h1 as Candle[], h4: data.h4 as Candle[], daily: data.daily as Candle[], from: START, costMultiplier });
  const base = run(1);
  const stressed = run(2);
  const between = (a: number, b: number) => (t: FibTrade) => t.entryTime >= a && t.entryTime < b;

  console.log(`\nFibonacci retracement system, ${EXECUTION_TIMEFRAME} entries, ${YEARS} year${YEARS > 1 ? "s" : ""} to ${new Date(END * 1000).toISOString().slice(0, 10)}, R multiples after full spread + slippage`);
  console.log(line("ALL", base));
  console.log(line("COSTS ×2", stressed));
  if (START < DESIGN_END) {
    console.log(line("DESIGN (rules chosen)", base.filter(between(START, DESIGN_END)), START, DESIGN_END));
    console.log(line("AFTER (untouched)", base.filter(between(DESIGN_END, END)), DESIGN_END, END));
  }
  const count = (o: FibTrade["outcome"]) => base.filter((t) => t.outcome === o).length;
  console.log(`exits: target ${count("target")}, stop ${count("stop")}, five-day time limit ${count("time")}, still open ${count("open")}`);
  console.log("\nby year (oldest first)");
  for (let k = 0; k < YEARS; k++) console.log(line(`  ${new Date((START + k * YEAR_S) * 1000).toISOString().slice(0, 7)} →`, base.filter(inYear(k)), START + k * YEAR_S, START + (k + 1) * YEAR_S));
  console.log("\nby side and entry candle");
  console.log(line("  buys", base.filter((t) => t.direction === "long")));
  console.log(line("  sells", base.filter((t) => t.direction === "short")));
  console.log(line("  engulfing candle", base.filter((t) => t.trigger === "engulfing candle")));
  console.log(line("  pin bar", base.filter((t) => t.trigger === "pin bar")));
  console.log("\nrecent windows (trades entered inside the window)");
  for (const [name, days] of [["3 years", 1095], ["1 year", 365], ["6 months", 182], ["3 months", 91], ["1 month", 30], ["1 week", 7]] as const) {
    const g = base.filter((t) => t.entryTime >= END - days * 86400);
    console.log(`${line(`  ${name}`, g, END - days * 86400, END)}  still open ${g.filter((t) => t.outcome === "open").length}`);
  }
  if (SAVE) await save(base);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
