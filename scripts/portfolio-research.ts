import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { runBacktest, computeMetrics } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";
import type { StrategyId } from "@/lib/types";

const PAIR = "XAU_USD";
const TIMEFRAME = "M15";
const COUNT = 5000;
const ACCOUNT_BALANCE = 25000;

async function main() {
  const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: TIMEFRAME, count: COUNT }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 1000 }),
  ]);

  // NOTE: per-strategy thresholds require the `minConfidence` RECORD form.
  // A single number applies uniformly to every listed strategy — older runs
  // labelled combos like "setforget>=4 + zones>=5" were actually uniform-4.
  const configs: {
    name: string;
    strategies: StrategyId[];
    minConfidence: number | Partial<Record<StrategyId, number>>;
    oneTradePerPair?: boolean;
  }[] = [
    { name: "all three, uniform >=3 (fishing net)", strategies: ["setforget", "zones", "fibonacci"], minConfidence: 3 },
    { name: "all three, uniform >=4", strategies: ["setforget", "zones", "fibonacci"], minConfidence: 4 },
    { name: "all three, uniform >=5", strategies: ["setforget", "zones", "fibonacci"], minConfidence: 5 },
    { name: "setforget+zones, uniform >=4", strategies: ["setforget", "zones"], minConfidence: 4 },
    { name: "setforget+zones, uniform >=5", strategies: ["setforget", "zones"], minConfidence: 5 },
    { name: "LIVE gate — per-strategy 5/4/5, one trade per pair", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 5, setforget: 4, fibonacci: 5 }, oneTradePerPair: true },
    { name: "LIVE gate — per-strategy 5/4/5, per-strategy books", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 5, setforget: 4, fibonacci: 5 } },
    { name: "per-strategy 4/4/5, one trade per pair", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 4, setforget: 4, fibonacci: 5 }, oneTradePerPair: true },
  ];

  console.log(`Portfolio research: ${PAIR} ${TIMEFRAME} ${candles.length} candles`);
  console.log("config | trades | win% | pf | avgR | maxDD(R) | totalPnl");
  console.log("-".repeat(110));

  for (const cfg of configs) {
    const report = runBacktest({
      pair: PAIR,
      timeframe: TIMEFRAME,
      candles,
      htfCandles,
      topDownCandles: { weekly, daily, h4, h1 },
      accountBalance: ACCOUNT_BALANCE,
      minConfidence: cfg.minConfidence,
      oneTradePerPair: cfg.oneTradePerPair,
      strategies: cfg.strategies,
    });
    const m = computeMetrics(report.trades);
    console.log(
      `${cfg.name.padEnd(55)} | ${String(m.trades).padStart(3)} | ${(m.winRate * 100).toFixed(1)} | ${m.profitFactor.toFixed(2)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)} | ${m.totalPnl.toFixed(2)}`
    );
  }
}

main().catch(console.error);
