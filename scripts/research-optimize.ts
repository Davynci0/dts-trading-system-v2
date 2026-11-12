import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const ALL_PAIRS: Pair[] = ["XAU_USD", "GBP_JPY", "GBP_USD", "AUD_JPY", "USD_JPY", "EUR_JPY", "GBP_AUD", "GBP_NZD"];

async function main() {
  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const audusd = await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);
  const rates: Partial<Record<Pair, number>> = {
    XAU_USD: 1, GBP_USD: 1,
    GBP_JPY: 1 / usdjpy, AUD_JPY: 1 / usdjpy, USD_JPY: 1 / usdjpy, EUR_JPY: 1 / usdjpy,
    GBP_AUD: audusd, GBP_NZD: nzdusd,
  };

  console.log("Fetching data (parallel)...");
  const allData = await Promise.all(ALL_PAIRS.map(async (pair) => {
    const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument: pair, granularity: "M15", count: 5000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "W", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "D", count: 500 }),
      fetchCandles({ instrument: pair, granularity: "H4", count: 1000 }),
      fetchCandles({ instrument: pair, granularity: "H1", count: 1000 }),
    ]);
    return { pair, candles, htfCandles, weekly, daily, h4, h1, mid: Math.floor(candles.length / 2) };
  }));
  const data = Object.fromEntries(allData.map((d) => [d.pair, d]));
  console.log("Done.\n");

  const metrics = (trades: BacktestTrade[]) => {
    const wins = trades.filter((t) => t.rAchieved > 0).length;
    const grossWin = trades.filter((t) => t.rAchieved > 0).reduce((s, t) => s + t.rAchieved, 0);
    const grossLoss = trades.filter((t) => t.rAchieved <= 0).reduce((s, t) => s + Math.abs(t.rAchieved), 0);
    const totalR = trades.reduce((s, t) => s + t.rAchieved, 0);
    return { n: trades.length, wins, totalR, avgR: trades.length ? totalR / trades.length : 0, pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0 };
  };

  const runBt = (pair: string, strategies: string[], min: Record<string, number>, window?: any[]) => {
    const d = data[pair];
    const report = runBacktest({
      pair, timeframe: "M15", candles: window ?? d.candles, htfCandles: d.htfCandles,
      topDownCandles: { weekly: d.weekly, daily: d.daily, h4: d.h4, h1: d.h1 },
      accountBalance: 25000, minConfidence: min, oneTradePerPair: true,
      strategies: strategies as never, requireChecks: ["HTF trend agrees", "M15 trend agrees"],
      quoteUsdRate: rates[pair as Pair] ?? 1,
    });
    return report.trades as BacktestTrade[];
  };

  // REDUCED GRID: only the most promising combos and gates
  const combos: { name: string; strategies: string[]; gate: number }[] = [
    // Per-strategy at the researched gates
    { name: "all 5/4/6", strategies: ["zones", "setforget", "fibonacci"], gate: -1 },
    { name: "all 4/4/5", strategies: ["zones", "setforget", "fibonacci"], gate: -2 },
    { name: "zones+sf 5/4", strategies: ["zones", "setforget"], gate: -1 },
    { name: "zones+sf 4/4", strategies: ["zones", "setforget"], gate: -2 },
    // Uniform gates
    { name: "all @ 4", strategies: ["zones", "setforget", "fibonacci"], gate: 4 },
    { name: "all @ 5", strategies: ["zones", "setforget", "fibonacci"], gate: 5 },
    { name: "all @ 6", strategies: ["zones", "setforget", "fibonacci"], gate: 6 },
    { name: "zones+sf @ 5", strategies: ["zones", "setforget"], gate: 5 },
    { name: "zones+sf @ 4", strategies: ["zones", "setforget"], gate: 4 },
    { name: "zones only @ 5", strategies: ["zones"], gate: 5 },
    { name: "zones only @ 4", strategies: ["zones"], gate: 4 },
    { name: "sf only @ 4", strategies: ["setforget"], gate: 4 },
    { name: "sf only @ 5", strategies: ["setforget"], gate: 5 },
    { name: "fib only @ 5", strategies: ["fibonacci"], gate: 5 },
    { name: "fib only @ 6", strategies: ["fibonacci"], gate: 6 },
  ];

  console.log(`Testing ${combos.length} configs × ${ALL_PAIRS.length} pairs = ${combos.length * ALL_PAIRS.length} backtests\n`);

  interface Row {
    pair: string; cfg: string; strategies: string[]; min: Record<string, number>;
    n: number; totalR: number; avgR: number; pf: number; isR: number; isN: number; oosR: number; oosN: number;
  }
  const rows: Row[] = [];

  for (const pair of ALL_PAIRS) {
    const d = data[pair];
    for (const c of combos) {
      let min: Record<string, number>;
      if (c.gate === -1) min = { zones: 5, setforget: 4, fibonacci: 6 };
      else if (c.gate === -2) min = { zones: 4, setforget: 4, fibonacci: 5 };
      else if (c.gate === -2) min = { zones: 4, setforget: 4 };
      else { min = {}; for (const s of c.strategies) min[s] = c.gate; }

      const full = metrics(runBt(pair, c.strategies, min));
      const is = metrics(runBt(pair, c.strategies, min, d.candles.slice(0, d.mid)));
      const oos = metrics(runBt(pair, c.strategies, min, d.candles.slice(d.mid)));

      rows.push({ pair, cfg: c.name, strategies: c.strategies, min, n: full.n, totalR: full.totalR, avgR: full.avgR, pf: full.pf, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
    }
    process.stdout.write(`  ${pair} done\n`);
  }

  // Find viable per pair
  console.log("\n=== PER-PAIR VIABLE (n≥3, R>0, PF≥1, IS≥0, OOS≥0) ===\n");
  const viable = rows.filter((r) => r.n >= 3 && r.totalR > 0 && r.pf >= 1 && r.isR >= 0 && r.oosR >= 0);
  for (const r of viable.sort((a, b) => b.totalR - a.totalR)) {
    console.log(`  ${r.pair.padEnd(10)} ${r.cfg.padEnd(20)} ${String(r.n).padStart(3)}tr  PF=${r.pf.toFixed(2).padStart(5)}  R=${r.totalR >= 0 ? "+" : ""}${r.totalR.toFixed(2).padStart(6)}  IS=${r.isR >= 0 ? "+" : ""}${r.isR.toFixed(1)}  OOS=${r.oosR >= 0 ? "+" : ""}${r.oosR.toFixed(1)}`);
  }

  // Best per pair
  console.log("\n=== BEST CONFIG PER PAIR ===\n");
  const best: Record<string, Row> = {};
  for (const pair of ALL_PAIRS) {
    const pv = viable.filter((r) => r.pair === pair);
    if (pv.length > 0) {
      best[pair] = pv.sort((a, b) => b.totalR - a.totalR)[0];
      console.log(`  ${pair.padEnd(10)} ✓ ${best[pair].cfg.padEnd(20)} ${best[pair].n}tr  +${best[pair].totalR.toFixed(2)}R`);
    } else {
      const pr = rows.filter((r) => r.pair === pair).sort((a, b) => b.totalR - a.totalR);
      console.log(`  ${pair.padEnd(10)} ✗ (best: ${pr[0]?.cfg ?? "none"} ${pr[0]?.totalR.toFixed(2) ?? "?"}R)`);
    }
  }

  // Portfolio summary
  console.log("\n=== FINAL PORTFOLIO ===\n");
  const portfolio = Object.entries(best).filter(([_, r]) => r.n >= 3);
  const totN = portfolio.reduce((s, [_, r]) => s + r.n, 0);
  const totR = portfolio.reduce((s, [_, r]) => s + r.totalR, 0);
  const totIS = portfolio.reduce((s, [_, r]) => s + r.isR, 0);
  const totOOS = portfolio.reduce((s, [_, r]) => s + r.oosR, 0);
  console.log(`Pairs: ${portfolio.map(([p]) => p).join(", ")}`);
  console.log(`Trades: ${totN} (~${(totN / 52).toFixed(1)}/day)`);
  console.log(`Total R: ${totR >= 0 ? "+" : ""}${totR.toFixed(2)}R | IS: ${totIS >= 0 ? "+" : ""}${totIS.toFixed(2)}R | OOS: ${totOOS >= 0 ? "+" : ""}${totOOS.toFixed(2)}R`);
  console.log(`At 1% risk: ${totR >= 0 ? "+" : ""}${totR.toFixed(1)}% return over ~52 days`);

  // Unique gates across portfolio
  const allZonesGates = [...new Set(portfolio.filter(([_, r]) => r.min.zones).map(([_, r]) => r.min.zones))];
  const allFibGates = [...new Set(portfolio.filter(([_, r]) => r.min.fibonacci).map(([_, r]) => r.min.fibonacci))];
  console.log(`\nZones gates used: ${allZonesGates.join(", ")}`);
  console.log(`Fib gates used: ${allFibGates.join(", ")}`);

  console.log("\n=== RECOMMENDED PRODUCTION SETTINGS ===\n");
  console.log(`SIGNAL_PAIRS=${portfolio.map(([p]) => p).join(",")}`);
  console.log(`ZONES_MIN_CONFIDENCE=${Math.max(...allZonesGates, 5)}`);
  console.log(`FIB_MIN_CONFIDENCE=${Math.max(...allFibGates, 6)}`);
  console.log(`REQUIRE_HTF_TREND=true`);
  console.log(`REQUIRE_M15_TREND=true`);
  console.log(`MIN_R_MULTIPLE=2`);
}

main().catch(console.error);
