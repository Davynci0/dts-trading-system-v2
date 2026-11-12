import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Comprehensive post-fix research: tests every gate combination INCLUDING
 * trendline confluence, per-pair, on ~52 days of M15 data.
 *
 * Configurations tested:
 *  1. Old gate (5/4/6, all 3 strategies)
 *  2. Current gate (3/4/5, all 3 strategies) — deployed today
 *  3. Old gate + REQUIRE both HTF+M15 trend
 *  4. Old gate zones+setforget only (fib OFF) — best previous result PF 1.57
 *  5. Current gate + REQUIRE both HTF+M15 trend
 *  6. Fib-only at 5/6 with trend
 *  7. Fib-only at 6/6 with trend (confluence-grade)
 *  8. All strategies at 4/4/5 with trend
 *
 * Also measures: per-pair breakdown, trade count, win%, PF, avgR, maxDD.
 *
 * Run: npx tsx --env-file=.env.local scripts/research-comprehensive.ts
 */
import { runBacktest, computeMetrics, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const PAIRS: Pair[] = ["XAU_USD", "GBP_JPY", "GBP_USD", "AUD_JPY", "USD_JPY", "EUR_JPY", "GBP_AUD", "GBP_NZD"];

interface Cfg {
  name: string;
  min: Record<string, number>;
  require?: string[];
  strategies: string[];
}

const CONFIGS: Cfg[] = [
  { name: "old 5/4/6 all", min: { zones: 5, setforget: 4, fibonacci: 6 }, strategies: ["setforget", "zones", "fibonacci"] },
  { name: "old 5/4/6 REQUIRE trend", min: { zones: 5, setforget: 4, fibonacci: 6 }, require: ["HTF trend agrees", "M15 trend agrees"], strategies: ["setforget", "zones", "fibonacci"] },
  { name: "old 5/4 zones+setforget only", min: { zones: 5, setforget: 4 }, strategies: ["setforget", "zones"] },
  { name: "old 5/4 zones+setforget REQUIRE trend", min: { zones: 5, setforget: 4 }, require: ["HTF trend agrees", "M15 trend agrees"], strategies: ["setforget", "zones"] },
  { name: "current 3/4/5 all", min: { zones: 3, setforget: 4, fibonacci: 5 }, strategies: ["setforget", "zones", "fibonacci"] },
  { name: "current 3/4/5 REQUIRE trend", min: { zones: 3, setforget: 4, fibonacci: 5 }, require: ["HTF trend agrees", "M15 trend agrees"], strategies: ["setforget", "zones", "fibonacci"] },
  { name: "fib-only 5/6 REQUIRE trend", min: { fibonacci: 5 }, require: ["HTF trend agrees", "M15 trend agrees"], strategies: ["fibonacci"] },
  { name: "fib-only 6/6 (confluence)", min: { fibonacci: 6 }, strategies: ["fibonacci"] },
  { name: "4/4/5 all REQUIRE trend", min: { zones: 4, setforget: 4, fibonacci: 5 }, require: ["HTF trend agrees", "M15 trend agrees"], strategies: ["setforget", "zones", "fibonacci"] },
];

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const audusd = await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  const rates: Partial<Record<Pair, number>> = {
    XAU_USD: 1, GBP_USD: 1,
    GBP_JPY: 1 / usdjpy, AUD_JPY: 1 / usdjpy, USD_JPY: 1 / usdjpy, EUR_JPY: 1 / usdjpy,
    GBP_AUD: audusd, GBP_NZD: nzdusd,
  };

  console.log(`Comprehensive research — ${PAIRS.length} pairs, ~52 days, one trade per pair, 1% risk`);
  console.log(`Configs: ${CONFIGS.length}\n`);
  console.log("config | trades | win% | PF(R) | avgR | maxDD");
  console.log("-".repeat(75));

  const agg = CONFIGS.map(() => ({ n: 0, wins: 0, grossWin: 0, grossLoss: 0, allR: [] as number[] }));
  const perPair: Record<string, number[]> = {};
  const perPairTrades: Record<string, number> = {};

  for (const pair of PAIRS) {
    const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
    ]);
    perPair[pair] = [];

    for (let ci = 0; ci < CONFIGS.length; ci++) {
      const cfg = CONFIGS[ci];
      const report = runBacktest({
        pair,
        timeframe: "M15",
        candles,
        htfCandles,
        topDownCandles: { weekly, daily, h4, h1 },
        accountBalance: 25000,
        minConfidence: cfg.min,
        oneTradePerPair: true,
        strategies: cfg.strategies as never,
        requireChecks: cfg.require,
        quoteUsdRate: rates[pair] ?? 1,
      });
      const a = agg[ci];
      for (const t of report.trades as BacktestTrade[]) {
        a.n++;
        if (t.rAchieved > 0) { a.wins++; a.grossWin += t.rAchieved; }
        else a.grossLoss += -t.rAchieved;
        a.allR.push(t.rAchieved);
        perPair[pair].push(t.rAchieved);
      }
      if (ci === 3) { // best config (old gate zones+setforget with trend) — track per pair
        perPairTrades[pair] = report.trades.length;
      }
    }
    process.stdout.write(`  ${pair.padEnd(8)} done\n`);
  }

  console.log("\n=== AGGREGATED RESULTS ===\n");
  CONFIGS.forEach((cfg, ci) => {
    const a = agg[ci];
    const pf = a.grossLoss > 0 ? a.grossWin / a.grossLoss : a.grossWin > 0 ? Infinity : 0;
    const avgR = a.n ? (a.grossWin - a.grossLoss) / a.n : 0;
    let peak = 0, cum = 0, dd = 0;
    for (const r of a.allR) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    console.log(
      `${cfg.name.padEnd(40)} | ${String(a.n).padStart(3)} | ${a.n ? ((a.wins / a.n) * 100).toFixed(0).padStart(3) : "  0"}% | ${pf.toFixed(2).padStart(5)} | ${avgR.toFixed(2).padStart(5)} | ${dd.toFixed(1)}`
    );
  });

  console.log("\n=== PER-PAIR R (best config: old 5/4 zones+setforget REQUIRE trend) ===\n");
  for (const [pair, rs] of Object.entries(perPair)) {
    const total = rs.reduce((s, r) => s + r, 0);
    const trades = rs.length;
    const avg = trades ? total / trades : 0;
    console.log(`  ${pair.padEnd(10)} ${String(trades).padStart(3)} trades  ${total >= 0 ? "+" : ""}${total.toFixed(2)}R  avg ${avg.toFixed(2)}R`);
  }

  // Split-half validation for top 2 configs
  console.log("\n=== SPLIT-HALF VALIDATION (best configs) ===\n");
  const topCfs = [CONFIGS[1], CONFIGS[4]]; // old gate w/ trend, current gate w/ trend
  for (const cfg of topCfs) {
    let isR = 0, isN = 0, oosR = 0, oosN = 0;
    for (const pair of PAIRS) {
      const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
      ]);
      const mid = Math.floor(candles.length / 2);
      for (const [half, name] of [["is", "IS"], ["oos", "OOS"]] as const) {
        const window = name === "IS" ? candles.slice(0, mid) : candles.slice(mid);
        const report = runBacktest({
          pair, timeframe: "M15", candles: window, htfCandles,
          topDownCandles: { weekly, daily, h4, h1 },
          accountBalance: 25000,
          minConfidence: cfg.min, oneTradePerPair: true,
          strategies: cfg.strategies as never, requireChecks: cfg.require,
          quoteUsdRate: rates[pair] ?? 1,
        });
        for (const t of report.trades as BacktestTrade[]) {
          const r = t.rAchieved;
          if (name === "IS") { isR += r; isN++; } else { oosR += r; oosN++; }
        }
      }
    }
    console.log(`  ${cfg.name}`);
    console.log(`    IS:  ${isN} trades, ${isR >= 0 ? "+" : ""}${isR.toFixed(2)}R`);
    console.log(`    OOS: ${oosN} trades, ${oosR >= 0 ? "+" : ""}${oosR.toFixed(2)}R`);
    console.log();
  }
}

main().catch(console.error);
