import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Backtest of the live rules — the market-structure scalp on the 15-minute
 * chart (lib/analysis/trend.ts) — with the scanner's own detection: a signal
 * on a closed 15-minute candle, filled at the next candle's open, the full
 * spread + slippage charged once, one trade at a time.
 *
 * The window is always the same: FIVE YEARS, with the LAST THREE printed next
 * to it, and a second pass that doubles the costs (see SOUL.md).
 *
 * Each trade is followed MINUTE BY MINUTE, with the stop moved a few minutes
 * after price touches the profit-lock trigger (TREND_LOCK_DELAY_SECONDS) — the
 * way the one-minute check and a hand on the order do it.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--save] [--15min]
 *   --save     store the run in Supabase so it appears on the Backtests page
 *   --15min    follow trades on 15-minute candles, the stop moved at the next candle (how it was before 27 November 2026)
 * The first run of a day downloads the candles; later runs read the cache.
 */
import { computeMetrics, type ScopedMetrics } from "@/lib/backtest/metrics";
import { entryTypeOf, runTrendBacktest, trendSetupWindows, TREND_ENTRY_TYPES, type TrendTrade } from "@/lib/backtest/trend";
import {
  TREND_ADX_MAX,
  TREND_BREAKOUT_BARS,
  TREND_DAYS,
  TREND_CONFIRMATIONS_MIN,
  TREND_LOCK_AT_R,
  TREND_LOCK_DELAY_SECONDS,
  TREND_LOCK_TO_R,
  TREND_MAX_COST_SHARE,
  TREND_MAX_HOLD_BARS,
  TREND_MAX_OPEN,
  TREND_MAX_RISK_ATR,
  TREND_MIN_RISK_ATR,
  TREND_MOMENTUM_ATR,
  TREND_SWING,
  TREND_TARGET_R,
} from "@/lib/analysis/trend";
import { EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Candle } from "@/lib/types";
import { BACKTEST_YEARS, loadMinuteCandles, loadPairData, RECENT_YEARS, windowEnd } from "./research-data";

const SAVE = process.argv.slice(2).some((a) => a.startsWith("--save"));
const COARSE = process.argv.slice(2).includes("--15min");
const PAIR = "XAU_USD";

const END = windowEnd() / 1000;
const YEAR_S = 365 * 86400;
const START = END - BACKTEST_YEARS * YEAR_S;
const RECENT = END - RECENT_YEARS * YEAR_S;

type T = TrendTrade;
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
  let run = 0;
  let worst = 0;
  for (const t of trades) {
    run = t.rAchieved <= 0 ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  return `${name.padEnd(26)} ${String(m.trades).padStart(4)} trades ${(m.trades / weeks).toFixed(2).padStart(5)}/week  win ${(m.winRate * 100).toFixed(0).padStart(2)}%  avgR ${m.avgR.toFixed(3).padStart(6)}  total ${m.totalR.toFixed(1).padStart(6)}R  maxDD ${m.maxDrawdownR.toFixed(1).padStart(5)}R  losing run ${String(worst).padStart(2)}  weekly t ${weeklyT(trades, from, to).toFixed(1)}`;
}

/** The whole five years, with the first two and the last three next to it. */
function scoped(trades: T[]): ScopedMetrics {
  return {
    inSample: computeMetrics(trades.filter((t) => t.entryTime < RECENT)),
    outOfSample: computeMetrics(trades.filter((t) => t.entryTime >= RECENT)),
    all: computeMetrics(trades),
  };
}

async function save(trades: T[]): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) throw new Error("--save needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7);
  const scopes: Record<string, ScopedMetrics> = { combined: scoped(trades) };
  for (let k = 0; k < BACKTEST_YEARS; k++) {
    scopes[`year:${String(k + 1).padStart(2, "0")} · ${month(START + k * YEAR_S)} → ${month(START + (k + 1) * YEAR_S)}`] = scoped(trades.filter(inYear(k)));
  }
  for (const type of TREND_ENTRY_TYPES) scopes[`strategy:${type}`] = scoped(trades.filter((t) => entryTypeOf(t) === type));
  scopes["pair:buys"] = scoped(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scoped(trades.filter((t) => t.direction === "short"));

  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs: [PAIR],
      timeframes: [EXECUTION_TIMEFRAME],
      notes: `${BACKTEST_YEARS} years · market-structure scalp, 1:${TREND_TARGET_R} with a profit lock moved within ${TREND_LOCK_DELAY_SECONDS / 60} minutes, one trade at a time · XAU/USD`,
      config: {
        engine: ENGINE_VERSION,
        years: BACKTEST_YEARS,
        recentYears: RECENT_YEARS,
        system: "market-structure scalp",
        rules: {
          swing: TREND_SWING,
          trendDays: TREND_DAYS,
          breakoutBars: [...TREND_BREAKOUT_BARS],
          momentumAtr: TREND_MOMENTUM_ATR,
          riskAtr: [TREND_MIN_RISK_ATR, TREND_MAX_RISK_ATR],
          targetR: TREND_TARGET_R,
          lock: [TREND_LOCK_AT_R, TREND_LOCK_TO_R],
          lockDelaySeconds: TREND_LOCK_DELAY_SECONDS,
          confirmationsMin: TREND_CONFIRMATIONS_MIN,
          adxMax: TREND_ADX_MAX,
          maxHoldBars: TREND_MAX_HOLD_BARS,
          maxOpen: TREND_MAX_OPEN,
          maxCostShare: TREND_MAX_COST_SHARE,
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

async function main() {
  const data = await loadPairData(PAIR);
  const candles = { pair: PAIR, m15: data.m15 as Candle[], h1: data.h1 as Candle[], daily: data.daily as Candle[], from: START };
  // the minute candles of every setup's life: which setups become trades depends on how the trades before them ended
  const minutes = COARSE ? null : await loadMinuteCandles(PAIR, trendSetupWindows(candles));
  if (SAVE && COARSE) throw new Error("--save stores the run the site shows: it cannot be combined with --15min");
  const run = (costMultiplier: number) => runTrendBacktest({ ...candles, costMultiplier, minutes: minutes ? (t) => minutes.get(t) : undefined });
  const base = run(1);
  const stressed = run(2);

  console.log(COARSE ? "\nTrades followed on 15-minute candles, the stop moved at the next candle (--15min)." : `\nTrades followed minute by minute (${minutes!.size} setups), the stop moved ${TREND_LOCK_DELAY_SECONDS / 60} minutes after price touches +${TREND_LOCK_AT_R}R.`);
  console.log(`Market-structure scalp on ${EXECUTION_TIMEFRAME} candles, 1:${TREND_TARGET_R} target, one trade at a time, ${BACKTEST_YEARS} years to ${new Date(END * 1000).toISOString().slice(0, 10)}, R multiples after full spread + slippage`);
  console.log(line(`  ${BACKTEST_YEARS} YEARS`, base));
  console.log(line("  …costs doubled", stressed));
  console.log(line(`  LAST ${RECENT_YEARS} YEARS`, base.filter(between(RECENT, END)), RECENT, END));
  console.log(line("  …costs doubled", stressed.filter(between(RECENT, END)), RECENT, END));

  const count = (o: T["outcome"]) => base.filter((t) => t.outcome === o).length;
  console.log(`\nexits: first stop ${count("stop")}, moved stop (profit locked) ${count("lock")}, take-profit ${count("target")}, five-hour limit ${count("time")}, still open ${count("open")}`);
  const wins = base.filter((t) => t.rAchieved > 0);
  const losses = base.filter((t) => t.rAchieved <= 0);
  const mean = (g: T[]) => (g.length ? g.reduce((sum, t) => sum + t.rAchieved, 0) / g.length : 0);
  console.log(`average win ${mean(wins).toFixed(2)}R, average loss ${mean(losses).toFixed(2)}R`);
  // in trading hours: a trade open over the weekend is not held for the hours the market is shut
  const held = base.map((t) => t.bars / 4).sort((a, b) => a - b);
  if (held.length) console.log(`trading hours held: median ${held[Math.floor(held.length / 2)].toFixed(2)}, longest ${held[held.length - 1].toFixed(2)}`);

  console.log("\nby year (oldest first)");
  for (let k = 0; k < BACKTEST_YEARS; k++) console.log(line(`  ${new Date((START + k * YEAR_S) * 1000).toISOString().slice(0, 7)} →`, base.filter(inYear(k)), START + k * YEAR_S, START + (k + 1) * YEAR_S));
  console.log("\nby entry and side");
  for (const type of TREND_ENTRY_TYPES) console.log(line(`  ${type}`, base.filter((t) => entryTypeOf(t) === type)));
  console.log(line("  buys", base.filter((t) => t.direction === "long")));
  console.log(line("  sells", base.filter((t) => t.direction === "short")));
  // the owner's windows (SOUL.md): five years above, then one year, three months, two weeks and one week
  console.log("\nthe other windows (trades entered inside the window)");
  for (const [name, days] of [["1 year", 365], ["3 months", 91], ["2 weeks", 14], ["1 week", 7]] as const) {
    const g = base.filter((t) => t.entryTime >= END - days * 86400);
    console.log(`${line(`  ${name}`, g, END - days * 86400, END)}  still open ${g.filter((t) => t.outcome === "open").length}`);
    console.log(line("  …costs doubled", stressed.filter((t) => t.entryTime >= END - days * 86400), END - days * 86400, END));
  }
  if (SAVE) await save(base);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
