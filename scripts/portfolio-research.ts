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
  const [candles, htfCandles, weekly, daily, h4] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: TIMEFRAME, count: COUNT }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
  ]);

  const configs: { name: string; strategies: StrategyId[]; minConfidence: number }[] = [
    { name: "setforget>=4 + zones>=4 + fib>=5", strategies: ["setforget", "zones", "fibonacci"], minConfidence: 4 },
    { name: "setforget>=4 + zones>=5", strategies: ["setforget", "zones"], minConfidence: 4 },
    { name: "setforget>=4 only", strategies: ["setforget"], minConfidence: 4 },
    { name: "zones>=4 only", strategies: ["zones"], minConfidence: 4 },
    { name: "fib>=5 only", strategies: ["fibonacci"], minConfidence: 5 },
    { name: "all>=5", strategies: ["zones", "setforget", "fibonacci"], minConfidence: 5 },
  ];

  console.log(`Portfolio research: ${PAIR} ${TIMEFRAME} ${candles.length} candles`);
  console.log("config | trades | win% | pf | avgR | maxDD(R) | totalPnl");
  console.log("-".repeat(90));

  for (const cfg of configs) {
    const report = runBacktest({
      pair: PAIR,
      timeframe: TIMEFRAME,
      candles,
      htfCandles,
      topDownCandles: { weekly, daily, h4 },
      accountBalance: ACCOUNT_BALANCE,
      minConfidence: cfg.minConfidence,
      strategies: cfg.strategies,
    });
    const m = computeMetrics(report.trades);
    console.log(
      `${cfg.name.padEnd(40)} | ${String(m.trades).padStart(3)} | ${(m.winRate * 100).toFixed(1)} | ${m.profitFactor.toFixed(2)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)} | ${m.totalPnl.toFixed(2)}`
    );
  }
}

main().catch(console.error);
