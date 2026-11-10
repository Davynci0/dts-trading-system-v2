import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Per-pair readiness check for the expanded PAIRS list. For every instrument:
 *  1. TA sanity — analyzeM15 detects zones/structure/fib on real data (the M15
 *     pipeline is price-agnostic, this proves it end to end per instrument);
 *  2. the LIVE gate (per-strategy 5/4/6, one trade per pair, realistic spread,
 *     correct USD conversion for JPY/cross quotes) run on full/half windows.
 *
 * Run: npx tsx --env-file=.env.local scripts/research-pairs.ts
 */
import { runBacktest, computeMetrics, SPREAD_PIPS, type BacktestTrade } from "@/lib/backtest/engine";
import { analyzeM15 } from "@/lib/analysis/execution";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const PAIRS: Pair[] = [
  "XAU_USD",
  "GBP_JPY",
  "GBP_USD",
  "AUD_JPY",
  "USD_JPY",
  "EUR_JPY",
  "GBP_AUD",
  "GBP_NZD",
];

const LIVE_GATE = { zones: 5, setforget: 4, fibonacci: 6 } as const;

/** approximate USD value of one quote-currency unit for research sizing */
async function quoteRate(pair: string, usdjpy: number): Promise<number> {
  if (pair.endsWith("_USD")) return 1;
  if (pair.endsWith("JPY")) return 1 / usdjpy;
  if (pair.endsWith("_AUD")) return await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  if (pair.endsWith("_NZD")) return await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  return 1;
}

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);

  console.log(`Per-pair readiness — live gate ${JSON.stringify(LIVE_GATE)}, one trade per pair, realistic spreads`);
  console.log(`USD_JPY ≈ ${usdjpy.toFixed(2)} (quote conversions for JPY pairs)`);
  console.log("pair | TA: zones active/fib swing | window | trades | win% | pf | avgR | maxDD");
  console.log("-".repeat(100));

  for (const pair of PAIRS) {
    try {
      const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
      ]);

      // 1) TA sanity on the freshest window
      const m15 = analyzeM15(candles.slice(-500));
      const ta = m15
        ? `zones ${m15.zones.filter((z) => z.active).length}/${m15.zones.length}, fib ${m15.fib ? "ok" : "-"}, sf ${m15.setForget ? "ok" : "-"}`
        : "NO M15 ANALYSIS";

      // 2) live gate, full + halves
      const rate = await quoteRate(pair, usdjpy);
      const mid = Math.floor(candles.length / 2);
      const wins: [string, typeof candles][] = [
        ["full", candles],
        ["h1", candles.slice(0, mid)],
        ["h2", candles.slice(mid)],
      ];
      for (const [wname, window] of wins) {
        const report = runBacktest({
          pair,
          timeframe: "M15",
          candles: window,
          htfCandles,
          topDownCandles: { weekly, daily, h4, h1 },
          accountBalance: 25000,
          minConfidence: { ...LIVE_GATE },
          oneTradePerPair: true,
          strategies: ["setforget", "zones", "fibonacci"],
          quoteUsdRate: rate,
        });
        void SPREAD_PIPS[pair];
        const m = computeMetrics(report.trades as BacktestTrade[], rate);
        console.log(
          `${pair.padEnd(8)} | ${ta.padEnd(26)} | ${wname.padEnd(5)} | ${String(m.trades).padStart(3)} | ${(m.winRate * 100).toFixed(0).padStart(3)} | ${m.profitFactor.toFixed(2).padStart(5)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)}`
        );
      }
    } catch (e) {
      console.log(`${pair.padEnd(8)} | FETCH FAILED: ${(e as Error).message.slice(0, 70)}`);
    }
  }
}

main().catch(console.error);
