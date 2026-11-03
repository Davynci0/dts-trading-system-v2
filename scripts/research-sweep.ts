import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { runBacktest, computeMetrics } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";
import type { StrategyId } from "@/lib/types";

const PAIR = "XAU_USD";
const TIMEFRAME = "M15";
const COUNT = 5000;
const ACCOUNT_BALANCE = 25000;

const STRATEGIES: StrategyId[] = ["zones", "setforget", "fibonacci"];
const CONFIDENCES = [3, 4, 5];

async function main() {
  const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: TIMEFRAME, count: COUNT }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 1000 }),
  ]);

  console.log(`Research sweep: ${PAIR} ${TIMEFRAME} ${candles.length} candles`);
  console.log("strategy | conf | trades | win% | pf | avgR | maxDD(R) | totalPnl");
  console.log("-".repeat(90));

  for (const strategy of STRATEGIES) {
    for (const minConfidence of CONFIDENCES) {
      const report = runBacktest({
        pair: PAIR,
        timeframe: TIMEFRAME,
        candles,
        htfCandles,
        topDownCandles: { weekly, daily, h4, h1 },
        accountBalance: ACCOUNT_BALANCE,
        minConfidence,
        strategies: [strategy],
      });
      const all = report.trades;
      const m = computeMetrics(all);
      console.log(
        `${strategy.padEnd(10)} | ${minConfidence}    | ${String(m.trades).padStart(3)}    | ${(m.winRate * 100).toFixed(1)} | ${m.profitFactor.toFixed(2)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)}       | ${m.totalPnl.toFixed(2)}`
      );
    }
  }

  // combined best combos
  console.log("\nBest combinations:");
  const combo = runBacktest({
    pair: PAIR,
    timeframe: TIMEFRAME,
    candles,
    htfCandles,
    topDownCandles: { weekly, daily, h4, h1 },
    accountBalance: ACCOUNT_BALANCE,
    minConfidence: 4,
    strategies: ["setforget", "zones"],
  });
  const cm = computeMetrics(combo.trades);
  console.log(`setforget+zones conf>=4: trades=${cm.trades} win%=${(cm.winRate * 100).toFixed(1)} pf=${cm.profitFactor.toFixed(2)} avgR=${cm.avgR.toFixed(2)} pnl=${cm.totalPnl.toFixed(2)}`);

  const combo5 = runBacktest({
    pair: PAIR,
    timeframe: TIMEFRAME,
    candles,
    htfCandles,
    topDownCandles: { weekly, daily, h4, h1 },
    accountBalance: ACCOUNT_BALANCE,
    minConfidence: 5,
    strategies: ["setforget", "zones"],
  });
  const cm5 = computeMetrics(combo5.trades);
  console.log(`setforget+zones conf>=5: trades=${cm5.trades} win%=${(cm5.winRate * 100).toFixed(1)} pf=${cm5.profitFactor.toFixed(2)} avgR=${cm5.avgR.toFixed(2)} pnl=${cm5.totalPnl.toFixed(2)}`);
}

main().catch(console.error);
