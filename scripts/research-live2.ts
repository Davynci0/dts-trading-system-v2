import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Candidate-gate research, run on the SAME window twice (first half / second
 * half) so a config that only works in one regime is visible. The per-check
 * analysis showed: HTF alignment is the strongest edge; RSI-turning and the
 * strict rejection-candle check are anti-predictive; the fib POI check never
 * fails. These runs measure the practical versions of those conclusions.
 *
 * Run: npx tsx --env-file=.env.local scripts/research-live2.ts
 */
import { runBacktest, computeMetrics, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";
import type { StrategyId } from "@/lib/types";

const PAIR = "XAU_USD";
const TIMEFRAME = "M15";

interface Cfg {
  name: string;
  strategies: StrategyId[];
  minConfidence: Partial<Record<StrategyId, number>>;
  requireChecks?: string[];
  excludeChecks?: string[];
}

const CONFIGS: Cfg[] = [
  { name: "baseline 5/4/5 all three (current live)", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 5, setforget: 4, fibonacci: 5 } },
  { name: "no fib: 5/4 sf+zones", strategies: ["setforget", "zones"], minConfidence: { zones: 5, setforget: 4 } },
  { name: "no fib + REQUIRE HTF agrees", strategies: ["setforget", "zones"], minConfidence: { zones: 5, setforget: 4 }, requireChecks: ["HTF trend agrees"] },
  { name: "no fib + REQUIRE HTF+M15 agrees", strategies: ["setforget", "zones"], minConfidence: { zones: 5, setforget: 4 }, requireChecks: ["HTF trend agrees", "M15 trend agrees"] },
  { name: "no fib min4/4 REQUIRE HTF (more trades)", strategies: ["setforget", "zones"], minConfidence: { zones: 4, setforget: 4 }, requireChecks: ["HTF trend agrees"] },
  { name: "all three min4 REQUIRE HTF (fib gated by trend)", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 4, setforget: 4, fibonacci: 4 }, requireChecks: ["HTF trend agrees"] },
  { name: "all three min4 REQUIRE HTF, EXCLUDE RSI-turning", strategies: ["setforget", "zones", "fibonacci"], minConfidence: { zones: 4, setforget: 4, fibonacci: 4 }, requireChecks: ["HTF trend agrees"], excludeChecks: ["Momentum (RSI) turning"] },
  { name: "zones only min4 REQUIRE HTF+M15", strategies: ["zones"], minConfidence: { zones: 4 }, requireChecks: ["HTF trend agrees", "M15 trend agrees"] },
];

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
  const halves: [string, typeof candles][] = [
    ["full", candles],
    [`h1:0-${mid}`, candles.slice(0, mid)],
    [`h2:${mid}-${candles.length}`, candles.slice(mid)],
  ];

  console.log(`Candidate gates — ${PAIR} ${TIMEFRAME}, split-window validation, one trade per pair`);
  console.log("config | window | trades | win% | pf | avgR | maxDD(R)");
  console.log("-".repeat(105));

  for (const cfg of CONFIGS) {
    for (const [wname, window] of halves) {
      const report = runBacktest({
        pair: PAIR,
        timeframe: TIMEFRAME,
        candles: window,
        htfCandles,
        topDownCandles: topDown,
        accountBalance: 25000,
        minConfidence: cfg.minConfidence,
        oneTradePerPair: true,
        strategies: cfg.strategies,
        requireChecks: cfg.requireChecks,
        excludeChecks: cfg.excludeChecks,
      });
      const m = computeMetrics(report.trades as BacktestTrade[]);
      console.log(
        `${cfg.name.padEnd(48)} | ${wname.padEnd(12)} | ${String(m.trades).padStart(3)} | ${(m.winRate * 100).toFixed(0)} | ${m.profitFactor.toFixed(2)} | ${m.avgR.toFixed(2)} | ${m.maxDrawdownR.toFixed(1)}`
      );
    }
  }
}

main().catch(console.error);
