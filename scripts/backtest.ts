import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Backtest of the live rules: the three strategies, each with the scanner's
 * own detection, each on its own and then side by side under the rule between
 * them (lib/strategies.ts) —
 *  - the trend scalp on the 15-minute chart (lib/analysis/trend.ts);
 *  - supply and demand: 30-minute zones entered on the 15-minute chart (lib/analysis/zones.ts);
 *  - the trendline strategy on the 1-hour chart (lib/analysis/trendline.ts).
 * A signal on a closed candle is filled at the next 15-minute open; the full
 * spread + slippage is charged once.
 *
 * The window is always the same: FIVE YEARS, with the LAST THREE printed next
 * to it, and a second pass that doubles the costs (see SOUL.md).
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--save]
 *   --save     store the run in Supabase so it appears on the Backtests page
 * The first run of a day downloads the candles; later runs read the cache.
 */
import { computeMetrics, type ScopedMetrics } from "@/lib/backtest/metrics";
import { runThree, type ThreeTrade } from "@/lib/backtest/three";
import { TREND_LOCK_AT_R, TREND_LOCK_TO_R, TREND_MAX_HOLD_BARS, TREND_TARGET_R } from "@/lib/analysis/trend";
import { ZN_ADX_MAX, ZN_MAX_DEPTH, ZN_MAX_HOLD_BARS, ZN_TARGET_R, ZN_WAIT_BARS } from "@/lib/analysis/zones";
import { TL_MAX_HOLD_BARS, TL_OPTIONS, TL_TARGET_R, TL_TIMEFRAME } from "@/lib/analysis/trendline";
import { STRATEGIES, STRATEGY_LIST } from "@/lib/strategies";
import { EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { createAdminClient } from "@/lib/supabase/admin";
import { BACKTEST_YEARS, loadPairData, RECENT_YEARS, windowEnd } from "./research-data";

const SAVE = process.argv.slice(2).some((a) => a.startsWith("--save"));
const PAIR = "XAU_USD";

const END = windowEnd() / 1000;
const YEAR_S = 365 * 86400;
const START = END - BACKTEST_YEARS * YEAR_S;
const RECENT = END - RECENT_YEARS * YEAR_S;
/** trading days in a year, for "trades a day" */
const TRADING_DAYS = 259;

type T = ThreeTrade;
const inYear = (k: number) => (t: T) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S;
const between = (a: number, b: number) => (t: T) => t.entryTime >= a && t.entryTime < b;
/** in the order the results came in */
const byExit = (trades: T[]) => [...trades].sort((a, b) => a.exitTime - b.exitTime);

function line(name: string, all: T[], from = START, to = END): string {
  const trades = byExit(all);
  const m = computeMetrics(trades);
  if (m.trades === 0) return `${name.padEnd(28)}    0 trades`;
  const days = ((to - from) / YEAR_S) * TRADING_DAYS;
  let run = 0;
  let worst = 0;
  for (const t of trades) {
    run = t.rAchieved <= 0 ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  return `${name.padEnd(28)} ${String(m.trades).padStart(4)} trades ${(m.trades / days).toFixed(2).padStart(5)}/day  win ${(m.winRate * 100).toFixed(0).padStart(2)}%  avgR ${m.avgR.toFixed(3).padStart(6)}  total ${m.totalR.toFixed(1).padStart(6)}R  maxDD ${m.maxDrawdownR.toFixed(1).padStart(5)}R  losing run ${String(worst).padStart(2)}`;
}

/** The whole five years, with the first two and the last three next to it. */
function scoped(trades: T[]): ScopedMetrics {
  const g = byExit(trades);
  return {
    inSample: computeMetrics(g.filter((t) => t.entryTime < RECENT)),
    outOfSample: computeMetrics(g.filter((t) => t.entryTime >= RECENT)),
    all: computeMetrics(g),
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
  for (const s of STRATEGY_LIST) scopes[`strategy:${s.name} (${s.chart})`] = scoped(trades.filter((t) => t.strategy === s.id));
  for (const type of [...new Set(trades.map((t) => `${STRATEGIES[t.strategy].name}: ${t.entryType}`))].sort()) {
    scopes[`entry:${type}`] = scoped(trades.filter((t) => `${STRATEGIES[t.strategy].name}: ${t.entryType}` === type));
  }
  scopes["pair:buys"] = scoped(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scoped(trades.filter((t) => t.direction === "short"));

  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs: [PAIR],
      timeframes: [EXECUTION_TIMEFRAME, "M30", TL_TIMEFRAME],
      notes: `${BACKTEST_YEARS} years · three strategies side by side (trend scalp, supply and demand, trendline), one trade each, never in opposite directions · XAU/USD`,
      config: {
        engine: ENGINE_VERSION,
        years: BACKTEST_YEARS,
        recentYears: RECENT_YEARS,
        system: "three strategies",
        rules: {
          trend: { targetR: TREND_TARGET_R, lock: [TREND_LOCK_AT_R, TREND_LOCK_TO_R], maxHoldBars: TREND_MAX_HOLD_BARS },
          zones: { zoneChart: "M30", waitBars: ZN_WAIT_BARS, maxDepth: ZN_MAX_DEPTH, adxMax: ZN_ADX_MAX, targetR: ZN_TARGET_R, maxHoldBars: ZN_MAX_HOLD_BARS },
          trendline: { chart: TL_TIMEFRAME, breakTouches: TL_OPTIONS.breakTouches, bounceTouches: TL_OPTIONS.bounceTouches, minSpanBars: TL_OPTIONS.minSpanBars, targetR: TL_TARGET_R, maxHoldBars: TL_MAX_HOLD_BARS },
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
  const base = runThree(PAIR, data, START, 1);
  const stressed = runThree(PAIR, data, START, 2);
  const recent = between(RECENT, END);

  console.log(`\nThree strategies on gold, ${BACKTEST_YEARS} years to ${new Date(END * 1000).toISOString().slice(0, 10)}, R multiples after costs`);
  console.log("\nEACH ON ITS OWN");
  for (const s of STRATEGY_LIST) {
    console.log(line(`  ${s.name}`, base.alone[s.id]));
    console.log(line("    …costs doubled", stressed.alone[s.id]));
    console.log(line(`    last ${RECENT_YEARS} years`, base.alone[s.id].filter(recent), RECENT, END));
  }

  const all = base.together;
  console.log("\nSIDE BY SIDE — one trade a strategy, never in opposite directions");
  console.log(line(`  ${BACKTEST_YEARS} YEARS`, all));
  console.log(line("  …costs doubled", stressed.together));
  console.log(line(`  LAST ${RECENT_YEARS} YEARS`, all.filter(recent), RECENT, END));
  console.log(line("  …costs doubled", stressed.together.filter(recent), RECENT, END));
  for (const s of STRATEGY_LIST) console.log(line(`  of which ${s.name}`, all.filter((t) => t.strategy === s.id)));
  const done = base.blocked.filter((t) => t.outcome !== "open");
  console.log(`\nsignals not sent because they contradicted another strategy: ${base.blocked.length} (they would have made ${done.reduce((sum, t) => sum + t.rAchieved, 0).toFixed(1)}R)`);

  // how many trades are open at once, by time
  const marks: [number, number][] = all.flatMap((t) => [[t.entryTime, 1], [t.exitTime, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const time = [0, 0, 0, 0];
  let open = 0;
  let last = START;
  for (const [t, k] of marks) {
    time[Math.min(open, 3)] += t - last;
    last = t;
    open += k;
  }
  time[0] += Math.max(0, END - last);
  const total = time.reduce((a, b) => a + b, 0);
  console.log(`time with 0 / 1 / 2 / 3 trades open: ${time.map((x) => `${((100 * x) / total).toFixed(0)}%`).join(" / ")}`);
  const daily = new Map<number, number>();
  for (const t of all) daily.set(Math.floor(t.exitTime / 86400), (daily.get(Math.floor(t.exitTime / 86400)) ?? 0) + t.rAchieved);
  console.log(`worst day ${Math.min(...daily.values()).toFixed(1)}R, best day ${Math.max(...daily.values()).toFixed(1)}R`);

  console.log("\nby year (oldest first)");
  for (let k = 0; k < BACKTEST_YEARS; k++) console.log(line(`  ${new Date((START + k * YEAR_S) * 1000).toISOString().slice(0, 7)} →`, all.filter(inYear(k)), START + k * YEAR_S, START + (k + 1) * YEAR_S));
  console.log("\nby side");
  console.log(line("  buys", all.filter((t) => t.direction === "long")));
  console.log(line("  sells", all.filter((t) => t.direction === "short")));
  console.log("\nrecent windows (trades entered inside the window)");
  for (const [name, days] of [["1 year", 365], ["6 months", 182], ["3 months", 91], ["1 month", 30], ["1 week", 7]] as const) {
    console.log(line(`  ${name}`, all.filter((t) => t.entryTime >= END - days * 86400), END - days * 86400, END));
  }
  if (SAVE) await save(all);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
