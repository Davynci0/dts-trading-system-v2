import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Multi-year backtest of the live rules — the trend system
 * (lib/analysis/trend.ts) with the scanner's own detection: signal on a closed
 * candle of the chart timeframe, fill at the next candle's open plus the full spread + slippage,
 * one position per entry type, a fixed-distance trailing stop and no target.
 * Prints the whole window next to each of its years; a second pass doubles
 * the costs.
 *
 * Positions overlap and point the same way, so trades are not independent:
 * read the WEEKLY t (the last column of the summary) rather than a per-trade one.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest.ts [--years=15] [--save]
 *   --years=N  history length (default 15, 1–15)
 *   --save     store the run in Supabase so it appears on the Backtests page
 * The chart candles are built from cached M15 history (the first run of a day downloads it).
 */
import { computeMetrics, type BacktestTrade, type ScopedMetrics } from "@/lib/backtest/engine";
import { maxOpenPositions, runTrendBacktest, type TrendTrade } from "@/lib/backtest/trend";
import { EXECUTION_BAR_SECONDS, EXECUTION_TIMEFRAME } from "@/lib/analysis";
import { TREND_ADX_MAX, TREND_ENTRIES, TREND_FAST_DAYS, TREND_SLOW_DAYS, TREND_STOP_ATR, TREND_TRAIL_ATR } from "@/lib/analysis/trend";
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

const metrics = (trades: TrendTrade[]) => computeMetrics(trades as unknown as BacktestTrade[]);
const inYear = (k: number) => (t: TrendTrade) => t.entryTime >= START + k * YEAR_S && t.entryTime < START + (k + 1) * YEAR_S;

/** t of the weekly R sums — overlapping trades are not independent, weeks nearly are. */
function weeklyT(trades: TrendTrade[], from: number, to: number): number {
  const weeks = new Map<number, number>();
  for (const t of trades) weeks.set(Math.floor(t.exitTime / (7 * 86400)), (weeks.get(Math.floor(t.exitTime / (7 * 86400))) ?? 0) + t.rAchieved);
  const n = Math.max(2, Math.round((to - from) / (7 * 86400)));
  const mean = trades.reduce((s, t) => s + t.rAchieved, 0) / n;
  let v = (n - weeks.size) * mean ** 2;
  for (const x of weeks.values()) v += (x - mean) ** 2;
  v /= n - 1;
  return v > 0 ? mean / Math.sqrt(v / n) : 0;
}

function line(name: string, trades: TrendTrade[], from = START, to = END): string {
  const m = metrics(trades);
  if (m.trades === 0) return `${name.padEnd(26)}    0`;
  const weeks = (to - from) / (7 * 86400);
  return `${name.padEnd(26)} ${String(m.trades).padStart(5)} trades ${(m.trades / (weeks * 5)).toFixed(1)}/day  win ${(m.winRate * 100).toFixed(0).padStart(2)}%  pf ${m.profitFactor.toFixed(2)}  avgR ${m.avgR.toFixed(3).padStart(6)}  total ${m.totalR.toFixed(0).padStart(5)}R  maxDD ${m.maxDrawdownR.toFixed(0).padStart(3)}R  weekly t ${weeklyT(trades, from, to).toFixed(1)}`;
}

function scoped(trades: TrendTrade[]): ScopedMetrics {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const cut = START + 0.7 * (END - START);
  return {
    inSample: metrics(sorted.filter((t) => t.entryTime < cut)),
    outOfSample: metrics(sorted.filter((t) => t.entryTime >= cut)),
    all: metrics(sorted),
  };
}

async function save(trades: TrendTrade[]): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) throw new Error("--save needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7);
  const scopes: Record<string, ScopedMetrics> = { combined: scoped(trades) };
  for (let k = 0; k < YEARS; k++) {
    scopes[`year:${String(k + 1).padStart(2, "0")} · ${month(START + k * YEAR_S)} → ${month(START + (k + 1) * YEAR_S)}`] = scoped(trades.filter(inYear(k)));
  }
  for (const e of TREND_ENTRIES) scopes[`strategy:${e.label}`] = scoped(trades.filter((t) => t.entryId === e.id));
  scopes["pair:buys"] = scoped(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scoped(trades.filter((t) => t.direction === "short"));

  const { data: run, error } = await supabase
    .from("backtest_runs")
    .insert({
      range_start: new Date(START * 1000).toISOString(),
      range_end: new Date(END * 1000).toISOString(),
      pairs: [PAIR],
      timeframes: [EXECUTION_TIMEFRAME],
      notes: `${YEARS} year${YEARS > 1 ? "s" : ""} · ${EXECUTION_TIMEFRAME} · trend system (${TREND_ENTRIES.length} entries, trailing stop) · XAU/USD`,
      config: {
        engine: ENGINE_VERSION,
        years: YEARS,
        system: "trend",
        entries: TREND_ENTRIES.map((e) => e.id),
        filters: { fastDays: TREND_FAST_DAYS, slowDays: TREND_SLOW_DAYS, adxMax: TREND_ADX_MAX },
        stopAtr: TREND_STOP_ATR,
        trailAtr: TREND_TRAIL_ATR,
        trailFollowedOn: EXECUTION_TIMEFRAME,
        costs: "full spread + slippage per trade",
        mostOpenAtOnce: maxOpenPositions(trades),
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

/** Build candles of `seconds` length from finer ones (aligned to the clock, as OANDA's are). */
function aggregate(fine: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const b of fine) {
    const t = Math.floor(b.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

async function main() {
  const data = await loadPairData(PAIR, 15 * 365, true);
  // chart candles built from M15, with history before the window for the indicators (240-candle channels, EMAs)
  const candles = aggregate(data.m15 as Candle[], EXECUTION_BAR_SECONDS).filter((c) => c.time >= START - 60 * 86400);
  const run = (costMultiplier: number) => runTrendBacktest({ pair: PAIR, candles, daily: data.daily as Candle[], from: START, costMultiplier });
  const base = run(1);
  const stressed = run(2);

  console.log(`\nTrend system on ${EXECUTION_TIMEFRAME}, ${YEARS} year${YEARS > 1 ? "s" : ""} to ${new Date(END * 1000).toISOString().slice(0, 10)}, R multiples after full spread + slippage`);
  console.log(line("ALL", base));
  console.log(line("COSTS ×2", stressed));
  console.log(`most positions open at once: ${maxOpenPositions(base)}`);
  console.log("\nby year (oldest first)");
  for (let k = 0; k < YEARS; k++) console.log(line(`  ${new Date((START + k * YEAR_S) * 1000).toISOString().slice(0, 7)} →`, base.filter(inYear(k)), START + k * YEAR_S, START + (k + 1) * YEAR_S));
  console.log("\nby entry type");
  for (const e of TREND_ENTRIES) console.log(line(`  ${e.label}`, base.filter((t) => t.entryId === e.id)));
  console.log("\nrecent windows (trades entered inside the window)");
  for (const [name, days] of [["3 years", 1095], ["6 months", 182], ["3 months", 91], ["2 weeks", 14], ["1 week", 7]] as const) {
    const g = base.filter((t) => t.entryTime >= END - days * 86400);
    console.log(`${line(`  ${name}`, g, END - days * 86400, END)}  still open ${g.filter((t) => t.outcome === "open").length}`);
  }
  if (SAVE) await save(base);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
