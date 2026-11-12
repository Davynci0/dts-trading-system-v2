import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const PAIRS: Pair[] = ["XAU_USD", "GBP_JPY", "GBP_USD", "AUD_JPY", "USD_JPY", "EUR_JPY", "GBP_AUD", "GBP_NZD"];

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const audusd = await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  const rates: Partial<Record<Pair, number>> = {
    XAU_USD: 1, GBP_USD: 1,
    GBP_JPY: 1 / usdjpy, AUD_JPY: 1 / usdjpy, USD_JPY: 1 / usdjpy, EUR_JPY: 1 / usdjpy,
    GBP_AUD: audusd, GBP_NZD: nzdusd,
  };

  const min = { zones: 5, setforget: 4, fibonacci: 6 };
  const requireChecks = ["HTF trend agrees", "M15 trend agrees"];

  console.log("Per-pair: old 5/4/6 REQUIRE trend (BEST CONFIG)");
  console.log("pair | trades | win% | avgR | totalR");
  console.log("-".repeat(60));

  for (const pair of PAIRS) {
    const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
    ]);
    const report = runBacktest({
      pair, timeframe: "M15", candles, htfCandles,
      topDownCandles: { weekly, daily, h4, h1 },
      accountBalance: 25000, minConfidence: min, oneTradePerPair: true,
      strategies: ["setforget", "zones", "fibonacci"] as never, requireChecks,
      quoteUsdRate: rates[pair] ?? 1,
    });
    const trades = report.trades as BacktestTrade[];
    const wins = trades.filter((t) => t.rAchieved > 0).length;
    const totalR = trades.reduce((s, t) => s + t.rAchieved, 0);
    const avgR = trades.length ? totalR / trades.length : 0;
    const winPct = trades.length ? (wins / trades.length * 100).toFixed(0) : "0";
    console.log(`${pair.padEnd(10)} | ${String(trades.length).padStart(3)} | ${winPct.padStart(3)}% | ${avgR.toFixed(2).padStart(6)} | ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R`);
  }
}

main().catch(console.error);
