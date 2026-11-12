import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * 1-week lookback: run the CURRENT PRODUCTION settings on the most recent
 * 7 days of M15 data for the 4 live pairs. Shows what one week of trading
 * would have looked like.
 *
 * XAU_USD: fibonacci @ 4/6, trend = M15 only
 * GBP_JPY: all @ 6/6/6, trend = both
 * USD_JPY: zones+setforget @ 4/4, trend = both
 * GBP_NZD: all @ 4/4/4, trend = both
 *
 * Run: npx tsx --env-file=.env.local scripts/research-1week.ts
 */
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

interface PairCfg {
  pair: Pair;
  strategies: string[];
  min: Record<string, number>;
  require?: string[];
}

const CONFIGS: PairCfg[] = [
  { pair: "XAU_USD", strategies: ["fibonacci"], min: { fibonacci: 4 }, require: ["M15 trend agrees"] },
  { pair: "GBP_JPY", strategies: ["zones", "setforget", "fibonacci"], min: { zones: 6, setforget: 6, fibonacci: 6 }, require: ["HTF trend agrees", "M15 trend agrees"] },
  { pair: "USD_JPY", strategies: ["zones", "setforget"], min: { zones: 4, setforget: 4 }, require: ["HTF trend agrees", "M15 trend agrees"] },
  { pair: "GBP_NZD", strategies: ["zones", "setforget", "fibonacci"], min: { zones: 4, setforget: 4, fibonacci: 4 }, require: ["HTF trend agrees", "M15 trend agrees"] },
];

// M15 candles per week: 24h × 5 trading days × 4/h = 480. Use 7 calendar days
// of data and let the backtester slice what it needs. We take the last 700
// M15 candles (~7 days of market time) as the 1-week window.
const WEEK_CANDLES = 700;

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  const rates: Partial<Record<Pair, number>> = {
    XAU_USD: 1,
    GBP_JPY: 1 / usdjpy,
    USD_JPY: 1 / usdjpy,
    GBP_NZD: nzdusd,
  };

  const metrics = (trades: BacktestTrade[]) => {
    const wins = trades.filter((t) => t.rAchieved > 0).length;
    const totalR = trades.reduce((s, t) => s + t.rAchieved, 0);
    let peak = 0, cum = 0, dd = 0;
    for (const t of trades) { cum += t.rAchieved; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { n: trades.length, wins, totalR, dd };
  };

  console.log(`=== LAST ~1 WEEK (last ${WEEK_CANDLES} M15 candles ≈ 7 market days) ===\n`);
  console.log("pair | config | trades | win% | totalR | avgR | maxDD");
  console.log("-".repeat(85));

  let totN = 0, totR = 0;
  for (const cfg of CONFIGS) {
    const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument: cfg.pair, granularity: "M15", count: WEEK_CANDLES }),
      fetchCandles({ instrument: cfg.pair, granularity: "H1", count: 300 }),
      fetchCandles({ instrument: cfg.pair, granularity: "W", count: 30 }),
      fetchCandles({ instrument: cfg.pair, granularity: "D", count: 30 }),
      fetchCandles({ instrument: cfg.pair, granularity: "H4", count: 200 }),
      fetchCandles({ instrument: cfg.pair, granularity: "H1", count: 600 }),
    ]);

    const report = runBacktest({
      pair: cfg.pair, timeframe: "M15", candles, htfCandles,
      topDownCandles: { weekly, daily, h4, h1 },
      accountBalance: 25000,
      minConfidence: cfg.min,
      oneTradePerPair: true,
      strategies: cfg.strategies as never,
      requireChecks: cfg.require,
      quoteUsdRate: rates[cfg.pair] ?? 1,
    });

    const m = metrics(report.trades as BacktestTrade[]);
    totN += m.n; totR += m.totalR;
    const winPct = m.n ? Math.round((m.wins / m.n) * 100) : 0;
    const cfgName = `${cfg.strategies.join("+")} @ ${Object.values(cfg.min).join("/")} trend:${cfg.require?.length === 2 ? "both" : "M15"}`;
    console.log(
      `${cfg.pair.padEnd(10)} | ${cfgName.padEnd(35)} | ${String(m.n).padStart(3)} | ${String(winPct).padStart(3)}% | ${m.totalR >= 0 ? "+" : ""}${m.totalR.toFixed(2).padStart(6)}R | ${(m.n ? m.totalR / m.n : 0).toFixed(2).padStart(5)} | ${m.dd.toFixed(1).padStart(5)}`
    );

    // Show individual trades
    if (m.n > 0) {
      for (const t of report.trades as BacktestTrade[]) {
        console.log(`    ${t.direction.toUpperCase().padEnd(5)} ${t.strategy.padEnd(10)} entry=${t.entry.toFixed(4)} R=${t.rAchieved >= 0 ? "+" : ""}${t.rAchieved.toFixed(2)}  ${t.inSample ? "" : ""}`);
      }
    } else {
      console.log(`    (no trades this week)`);
    }
  }

  console.log("-".repeat(85));
  console.log(`PORTFOLIO  | ${String(totN).padStart(49)} | ${totR >= 0 ? "+" : ""}${totR.toFixed(2)}R`);
  console.log(`\nAt 1% risk per trade: ${totR >= 0 ? "+" : ""}${totR.toFixed(1)}% in 1 week`);
  console.log(`At 0.5% risk per trade: ${totR >= 0 ? "+" : ""}${(totR * 0.5).toFixed(1)}% in 1 week`);
}

main().catch(console.error);