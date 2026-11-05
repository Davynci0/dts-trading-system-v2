import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Portfolio-level gate comparison across the expanded pair list. Each config
 * is run per pair (one trade per pair, realistic spreads, USD-converted sizing)
 * and aggregated — R is comparable across pairs because every trade risks 1%.
 *
 * Run: npx tsx --env-file=.env.local scripts/research-portfolio2.ts
 */
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const PAIRS: Pair[] = [
  "GBP_JPY",
  "GBP_USD",
  "AUD_JPY",
  "NZD_JPY",
  "USD_JPY",
  "EUR_JPY",
  "GBP_AUD",
  "GBP_NZD",
];

interface Cfg {
  name: string;
  min: Record<string, number>;
  require?: string[];
  strategies: string[];
}
const CONFIGS: Cfg[] = [
  { name: "live 5/4/6 all three", min: { zones: 5, setforget: 4, fibonacci: 6 }, strategies: ["setforget", "zones", "fibonacci"] },
  { name: "5/4 zones+setforget only", min: { zones: 5, setforget: 4 }, strategies: ["setforget", "zones"] },
  { name: "5/4 zones+setforget REQUIRE HTF", min: { zones: 5, setforget: 4 }, require: ["HTF trend agrees"], strategies: ["setforget", "zones"] },
  { name: "4/4/6 all three REQUIRE HTF", min: { zones: 4, setforget: 4, fibonacci: 6 }, require: ["HTF trend agrees"], strategies: ["setforget", "zones", "fibonacci"] },
];

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const audusd = await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  const rates: Partial<Record<Pair, number>> = { GBP_JPY: 1 / usdjpy, AUD_JPY: 1 / usdjpy, NZD_JPY: 1 / usdjpy, USD_JPY: 1 / usdjpy, EUR_JPY: 1 / usdjpy, GBP_AUD: audusd, GBP_NZD: nzdusd };

  const agg = CONFIGS.map(() => ({ n: 0, wins: 0, grossWin: 0, grossLoss: 0 }));

  for (const pair of PAIRS) {
    const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
    ]);
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
        if (t.rAchieved > 0) {
          a.wins++;
          a.grossWin += t.rAchieved;
        } else a.grossLoss += -t.rAchieved;
      }
    }
  }

  console.log(`Portfolio across ${PAIRS.length} new FX pairs, ~52 days, one trade per pair, 1% risk each`);
  console.log("config | trades | win% | PF(R) | avgR");
  console.log("-".repeat(70));
  CONFIGS.forEach((cfg, ci) => {
    const a = agg[ci];
    const pf = a.grossLoss > 0 ? a.grossWin / a.grossLoss : a.grossWin > 0 ? Infinity : 0;
    const avgR = a.n ? (a.grossWin - a.grossLoss) / a.n : 0;
    console.log(
      `${cfg.name.padEnd(40)} | ${String(a.n).padStart(3)} | ${a.n ? ((a.wins / a.n) * 100).toFixed(0).padStart(3) : "  0"}% | ${pf.toFixed(2).padStart(5)} | ${avgR.toFixed(2)}`
    );
  });
}

main().catch(console.error);
