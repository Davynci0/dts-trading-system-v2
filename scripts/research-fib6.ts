import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { runBacktest, computeMetrics, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";

const PAIR = "XAU_USD";
const TIMEFRAME = "M15";

async function main() {
  const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: TIMEFRAME, count: 5000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 1000 }),
  ]);
  const topDown = { weekly, daily, h4, h1 };
  const mid = Math.floor(candles.length / 2);
  const runs: { name: string; min: Record<string, number> }[] = [
    { name: "fib=6 (confluence-grade) 5/4/6", min: { zones: 5, setforget: 4, fibonacci: 6 } },
    { name: "fib=6 with zones=4  4/4/6", min: { zones: 4, setforget: 4, fibonacci: 6 } },
    { name: "fib OFF          5/4/-", min: { zones: 5, setforget: 4 } },
  ];
  console.log(`Fib demotion candidates — ${PAIR} ${TIMEFRAME}, one trade per pair`);
  console.log("config | window | trades | win% | pf | avgR | maxDD");
  for (const r of runs) {
    for (const [w, win] of [["full", candles], ["h1", candles.slice(0, mid)], ["h2", candles.slice(mid)]] as const) {
      const strategies = Object.keys(r.min).filter((s) => ["zones", "setforget", "fibonacci"].includes(s)) as never[];
      const report = runBacktest({
        pair: PAIR,
        timeframe: TIMEFRAME,
        candles: win as never[],
        htfCandles,
        topDownCandles: topDown,
        accountBalance: 25000,
        minConfidence: r.min as never,
        oneTradePerPair: true,
        strategies,
      });
      const m = computeMetrics(report.trades as BacktestTrade[]);
      console.log(`${r.name.padEnd(34)} | ${w.padEnd(5)} | ${String(m.trades).padStart(3)} | ${(m.winRate * 100).toFixed(0)} | ${m.profitFactor.toFixed(2)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)}`);
    }
  }
}
main().catch(console.error);
