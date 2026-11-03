/**
 * H4 research backtest: multi-year, multi-pair, per strategy and per check, split in/out-of-sample.
 * Run: npx tsx --env-file=.env.local scripts/research-h4.ts [years] [pair,pair,...]
 */
import { fetchCandles } from "../lib/oanda";
import { runBacktest, computeMetrics, type BacktestTrade } from "../lib/backtest/engine";
import { STRATEGIES } from "../lib/types";
import type { Candle } from "../lib/types";

const YEARS = Number(process.argv[2] ?? 4);
const RESEARCH_PAIRS = (process.argv[3] ?? "XAU_USD,EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CHF,NZD_USD,USD_CAD").split(",");

const f = (n: number, d = 2) => n.toFixed(d);
const line = (ts: BacktestTrade[]) => {
  const m = computeMetrics(ts);
  return `n=${String(m.trades).padStart(3)} win ${f(m.winRate * 100, 0).padStart(3)}% avgR ${f(m.avgR).padStart(5)} PF ${f(m.profitFactor).padStart(5)}`;
};

/** OANDA caps a request at 5000 candles, so page by from/to windows. */
async function fetchRange(instrument: string, granularity: string, years: number, windowDays: number): Promise<Candle[]> {
  const end = Date.now();
  const start = end - years * 365 * 86400_000;
  const out: Candle[] = [];
  for (let from = start; from < end; from += windowDays * 86400_000) {
    const to = Math.min(end, from + windowDays * 86400_000);
    const part = await fetchCandles({ instrument, granularity, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    out.push(...part);
  }
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((a, b) => a.time - b.time);
}

async function main() {
  const data: Record<string, { h4: Candle[]; h1: Candle[]; d: Candle[]; w: Candle[] }> = {};
  for (const pair of RESEARCH_PAIRS) {
    const [h4, h1, d, w] = await Promise.all([
      fetchRange(pair, "H4", YEARS, 600),
      fetchRange(pair, "H1", YEARS, 300),
      fetchRange(pair, "D", YEARS + 1, 3000),
      fetchRange(pair, "W", YEARS + 2, 3000),
    ]);
    data[pair] = { h4, h1, d, w };
  }

  report(data);
}

function report(data: Record<string, { h4: Candle[]; h1: Candle[]; d: Candle[]; w: Candle[] }>) {
  const all: { pair: string; t: BacktestTrade }[] = [];
  for (const pair of RESEARCH_PAIRS) {
    const { h4, h1, d, w } = data[pair];
    const r = runBacktest({ pair, timeframe: "H4", candles: h4, htfCandles: d, topDownCandles: { weekly: w, daily: d, h4, h1 } });
    for (const t of r.trades) all.push({ pair, t });
    console.log(`${pair.padEnd(8)} ${h4.length} candles  ${line(r.trades)}`);
  }

  const get = (pred: (x: { pair: string; t: BacktestTrade }) => boolean) => all.filter(pred).map((x) => x.t);

  console.log("\nPer strategy:  [all]  |  in-sample  |  out-of-sample");
  for (const s of STRATEGIES) {
    const ts = get((x) => x.t.strategy === s.id);
    console.log(
      `  ${s.id.padEnd(10)} ${line(ts)} | IS ${line(ts.filter((t) => t.inSample))} | OS ${line(ts.filter((t) => !t.inSample))}`
    );
  }

  console.log("\nPer check, pooled across strategies that have it (true vs false):");
  const labels = new Set<string>();
  for (const x of all) for (const k of Object.keys(x.t.checks)) labels.add(k);
  for (const label of labels) {
    const yes = get((x) => x.t.checks[label] === true);
    const no = get((x) => x.t.checks[label] === false);
    if (no.length < 5) continue;
    console.log(`  ${label.padEnd(30)} true ${line(yes)} | false ${line(no)}`);
  }

  const total = get(() => true);
  console.log(`\nTOTAL ${line(total)} maxDD ${f(computeMetrics(total).maxDrawdownR, 1)}R`);
  console.log(`      IS ${line(total.filter((t) => t.inSample))} | OS ${line(total.filter((t) => !t.inSample))}`);

  console.log("\nBy pair:");
  for (const pair of RESEARCH_PAIRS) console.log(`  ${pair.padEnd(8)} ${line(all.filter((x) => x.pair === pair).map((x) => x.t))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
