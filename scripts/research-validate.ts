/**
 * Walk-forward validation of the LIVE configuration on 12 months of M15 data.
 *
 * Runs the backtest exactly as the scanner sends signals — the shared send
 * gate (session, weekly veto, M15 structure), closed-bar higher timeframes,
 * one trade per pair, the live per-strategy confirmation minimums — and prints
 * the whole window next to its first eight and last four months, so a result
 * that only held in one regime is visible. A second pass doubles spread and
 * slippage: an edge that does not survive that is not an edge.
 *
 * Candles are cached under .cache/candles (git-ignored) so repeat runs are
 * instant and offline, and two code versions can be compared on identical data.
 *
 * Usage: npx tsx --env-file=.env.local scripts/research-validate.ts [PAIR ...]
 *        (no pairs = every pair in PAIRS)
 * Any gate setting can be overridden from the environment for a what-if run,
 * e.g. TRADING_HOURS_UTC=6-21 ZONES_MIN_CONFIDENCE=5 npx tsx ...
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";
import { minConfidenceFor } from "@/lib/engine/scanner";
import { PAIRS, type Candle } from "@/lib/types";

const DAY = 86_400_000;
const SPAN_DAYS = 365;
const CACHE_DIR = ".cache/candles";
// whole UTC days, so every run on the same day reads the same cache
const END = Math.floor(Date.now() / DAY) * DAY;
const START = END - SPAN_DAYS * DAY;
const SPLIT = (START + (SPAN_DAYS * 2 * DAY) / 3) / 1000; // first 8 months | last 4

interface PairData {
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  daily: Candle[];
  weekly: Candle[];
}
type Trade = BacktestTrade & { pair: string; entryTime: number; exitTime: number };

/** OANDA caps a request at 5000 candles, so each series is paged by date. */
async function fetchRange(instrument: string, granularity: string, days: number, pageDays: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let from = END - days * DAY; from < END; from += pageDays * DAY) {
    const to = Math.min(END, from + pageDays * DAY);
    out.push(...(await fetchCandles({ instrument, granularity, from: new Date(from).toISOString(), to: new Date(to).toISOString() })));
  }
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((a, b) => a.time - b.time);
}

async function load(pair: string): Promise<PairData> {
  const file = `${CACHE_DIR}/${pair}-${new Date(END).toISOString().slice(0, 10)}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as PairData;
  // higher timeframes reach further back so the first M15 bar already has context
  const data: PairData = {
    m15: await fetchRange(pair, "M15", SPAN_DAYS, 40),
    h1: await fetchRange(pair, "H1", SPAN_DAYS + 15, 90),
    h4: await fetchRange(pair, "H4", SPAN_DAYS + 35, 300),
    daily: await fetchRange(pair, "D", SPAN_DAYS + 155, 600),
    weekly: await fetchRange(pair, "W", SPAN_DAYS + 435, 900),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

function metrics(trades: Trade[]): string {
  const n = trades.length;
  if (n === 0) return "   0".padEnd(52);
  const total = trades.reduce((s, t) => s + t.rAchieved, 0);
  const wins = trades.filter((t) => t.rAchieved > 0);
  const grossWin = wins.reduce((s, t) => s + t.rAchieved, 0);
  const grossLoss = grossWin - total;
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.rAchieved;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  const pf = grossLoss > 0 ? grossWin / grossLoss : 99;
  return `${String(n).padStart(4)} win ${((100 * wins.length) / n).toFixed(0).padStart(2)}% pf ${pf.toFixed(2).padStart(5)} avgR ${(total / n).toFixed(2).padStart(5)} totR ${total.toFixed(1).padStart(6)} dd ${drawdown.toFixed(1).padStart(5)}`;
}

function row(name: string, trades: Trade[]): void {
  console.log(
    `${name.padEnd(18)} ALL ${metrics(trades)} | first 8m ${metrics(trades.filter((t) => t.entryTime < SPLIT))} | last 4m ${metrics(trades.filter((t) => t.entryTime >= SPLIT))}`
  );
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
    const data = await load(pair);
    base.push(...simulate(pair, data, 1));
    stressed.push(...simulate(pair, data, 2));
  }

  console.log(`\nLive gate, ${SPAN_DAYS} days to ${new Date(END).toISOString().slice(0, 10)}, R multiples after spread + slippage`);
  row("PORTFOLIO", base);
  for (const s of ["zones", "setforget", "fibonacci"]) row(` ${s}`, base.filter((t) => t.strategy === s));
  for (const p of pairs) row(` ${p}`, base.filter((t) => t.pair === p));
  const cost = base.reduce((s, t) => s + t.costR, 0) / Math.max(1, base.length);
  console.log(`\nEntry cost averages ${(cost * 100).toFixed(1)}% of the risk per trade.`);
  row("COSTS ×2", stressed);
  console.log(
    "\nA pair or strategy row with under ~200 trades is mostly noise (±0.1R per trade at 200); judge the portfolio row, and both halves of it."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
