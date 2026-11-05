import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Marginal value of each confirmation check. Runs a per-strategy-book backtest
 * at a low uniform threshold (max sample size), then splits the trades by
 * whether each individual check was true at entry. A check that barely moves
 * the win rate is dead weight in the checklist; one that moves it strongly
 * deserves its point (and possibly a stricter gate).
 *
 * Run: npx tsx --env-file=.env.local scripts/research-checks.ts
 */
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";
import type { StrategyId } from "@/lib/types";

const PAIR = "XAU_USD";
const TIMEFRAME = "M15";

const stats = (ts: BacktestTrade[]) => {
  const wins = ts.filter((t) => t.rAchieved > 0).length;
  const grossWin = ts.filter((t) => t.rAchieved > 0).reduce((s, t) => s + t.rAchieved, 0);
  const grossLoss = Math.abs(ts.filter((t) => t.rAchieved <= 0).reduce((s, t) => s + t.rAchieved, 0));
  return {
    n: ts.length,
    wr: ts.length ? (wins / ts.length) * 100 : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: ts.length ? ts.reduce((s, t) => s + t.rAchieved, 0) / ts.length : 0,
  };
};

async function main() {
  const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: TIMEFRAME, count: 5000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 1000 }),
  ]);

  const report = runBacktest({
    pair: PAIR,
    timeframe: TIMEFRAME,
    candles,
    htfCandles,
    topDownCandles: { weekly, daily, h4, h1 },
    accountBalance: 25000,
    minConfidence: 3, // low gate: maximise the trade sample
    strategies: ["setforget", "zones", "fibonacci"],
  });

  const trades = report.trades;
  console.log(`\nPer-check marginal value — ${PAIR} ${TIMEFRAME}, ${trades.length} trades at uniform >=3`);
  console.log("(strategy | check | on: n/win%/pf/avgR | off: n/win%/pf/avgR)");
  console.log("-".repeat(110));

  const label = (s: StrategyId) => ({ setforget: "sf", zones: "zn", fibonacci: "fb" })[s];
  const allChecks = new Set<string>();
  for (const t of trades) for (const k of Object.keys(t.checks)) allChecks.add(k);

  for (const strategy of ["setforget", "zones", "fibonacci"] as StrategyId[]) {
    const strat = trades.filter((t) => t.strategy === strategy);
    const base = stats(strat);
    console.log(`\n${strategy}: baseline n=${base.n} win ${base.wr.toFixed(0)}% pf ${base.pf === Infinity ? "inf" : base.pf.toFixed(2)} avgR ${base.avgR.toFixed(2)}`);
    for (const check of allChecks) {
      const on = strat.filter((t) => t.checks[check] === true);
      const off = strat.filter((t) => t.checks[check] !== true);
      const a = stats(on);
      const b = stats(off);
      if (a.n === 0 || b.n === 0) continue;
      console.log(
        `  ${label(strategy)} | ${check.padEnd(32)} | ${String(a.n).padStart(3)} ${a.wr.toFixed(0).padStart(3)}% pf ${a.pf === Infinity ? "inf" : a.pf.toFixed(2).padStart(5)} R ${a.avgR.toFixed(2)} | ${String(b.n).padStart(3)} ${b.wr.toFixed(0).padStart(3)}% pf ${b.pf === Infinity ? "inf" : b.pf.toFixed(2).padStart(5)} R ${b.avgR.toFixed(2)}`
      );
    }
  }
}

main().catch(console.error);
