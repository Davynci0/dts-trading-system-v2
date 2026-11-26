/**
 * Backtest of the Bitcoin system (BTC/USD): five years, with the last three
 * next to them — the same window and measures as the gold backtest.
 *
 *   npx tsx --env-file=.env.local scripts/backtest-btc.ts           # print
 *   npx tsx --env-file=.env.local scripts/backtest-btc.ts --save    # …and write lib/backtest/btc-results.json for the Bitcoin page
 *
 * BACKTEST_END=2026-11-24 repeats an earlier day's window on its cached candles.
 */
import { writeFileSync } from "node:fs";
import { BTC_COST, BTC_PAIR } from "@/lib/analysis/btc";
import { btcStats, runBtcBacktest, type BtcStats, type BtcTrade } from "@/lib/backtest/btc";
import { BACKTEST_YEARS, loadPairData, RECENT_YEARS, windowEnd } from "./research-data";

const YEAR = 365 * 86400;

function line(name: string, g: BtcTrade[], k: BtcStats = btcStats(g)) {
  console.log(
    "  " +
      name.padEnd(22) +
      String(k.trades).padStart(4) +
      " trades  win " +
      (k.winRate * 100).toFixed(0).padStart(3) +
      "%  avgR " +
      k.avgR.toFixed(3).padStart(6) +
      "  total " +
      k.totalR.toFixed(1).padStart(6) +
      "R  maxDD " +
      k.maxDrawdownR.toFixed(1).padStart(5) +
      "R  losing run " +
      k.longestLosingRun +
      "  runs of 3+: " +
      k.runsOf3 +
      ", of 4+: " +
      k.runsOf4
  );
}

async function main() {
  const end = windowEnd() / 1000;
  const start = end - BACKTEST_YEARS * YEAR;
  const data = await loadPairData(BTC_PAIR);
  const run = (costMultiplier: number) => runBtcBacktest({ m15: data.m15, h1: data.h1, daily: data.daily, from: start, costMultiplier });
  const g = run(1);
  const g2 = run(2);
  const recent = (q: BtcTrade[], years: number) => q.filter((t) => t.entryTime >= end - years * YEAR);
  const endDate = new Date(end * 1000).toISOString().slice(0, 10);

  console.log(`\nBitcoin range breakout on 4-hour candles, 1:3 target, one trade at a time, ${BACKTEST_YEARS} years to ${endDate}, R multiples after $${BTC_COST} a coin`);
  line(`${BACKTEST_YEARS} YEARS`, g);
  line("…costs doubled", g2);
  line(`LAST ${RECENT_YEARS} YEARS`, recent(g, RECENT_YEARS));
  line("…costs doubled", recent(g2, RECENT_YEARS));

  const count = (o: BtcTrade["outcome"]) => g.filter((t) => t.outcome === o).length;
  const wins = g.filter((t) => t.rAchieved > 0);
  const losses = g.filter((t) => t.rAchieved <= 0);
  const mean = (q: BtcTrade[]) => (q.length ? q.reduce((s, t) => s + t.rAchieved, 0) / q.length : 0);
  const hours = g.map((t) => (t.bars * 15) / 60).sort((a, b) => a - b);
  console.log(`\nexits: first stop ${count("stop")}, moved stop (profit locked) ${count("lock")}, take-profit ${count("target")}, time limit ${count("time")}, still open ${count("open")}`);
  console.log(`average win ${mean(wins).toFixed(2)}R, average loss ${mean(losses).toFixed(2)}R`);
  console.log(`trading hours held: median ${hours[Math.floor(hours.length / 2)]?.toFixed(1)}, three in four under ${hours[Math.floor(hours.length * 0.75)]?.toFixed(1)}, longest ${hours[hours.length - 1]?.toFixed(1)}`);

  console.log("\nby year (oldest first)");
  const years: { from: string; stats: BtcStats }[] = [];
  for (let y = 0; y < BACKTEST_YEARS; y++) {
    const q = g.filter((t) => t.entryTime >= start + y * YEAR && t.entryTime < start + (y + 1) * YEAR);
    const from = new Date((start + y * YEAR) * 1000).toISOString().slice(0, 7);
    years.push({ from, stats: btcStats(q) });
    line(from + " →", q);
  }
  console.log("\nby side");
  line("buys", g.filter((t) => t.direction === "long"));
  line("sells", g.filter((t) => t.direction === "short"));
  console.log("\nrecent windows");
  line("1 year", recent(g, 1));
  line("6 months", recent(g, 0.5));
  line("1 month", g.filter((t) => t.entryTime >= end - 30 * 86400));
  const risks = recent(g, 1)
    .map((t) => Math.abs(t.entry - t.stopLoss))
    .sort((a, b) => a - b);
  console.log(`\nstop distance in the last 12 months: $${risks[0]?.toFixed(0)} to $${risks[risks.length - 1]?.toFixed(0)} a coin, $${risks[Math.floor(risks.length / 2)]?.toFixed(0)} in the middle`);

  if (process.argv.includes("--save")) {
    const out = {
      pair: BTC_PAIR,
      end: endDate,
      years: BACKTEST_YEARS,
      recentYears: RECENT_YEARS,
      cost: BTC_COST,
      all: btcStats(g),
      allCostsDoubled: btcStats(g2),
      recent: btcStats(recent(g, RECENT_YEARS)),
      recentCostsDoubled: btcStats(recent(g2, RECENT_YEARS)),
      lastYear: btcStats(recent(g, 1)),
      byYear: years,
      buys: btcStats(g.filter((t) => t.direction === "long")),
      sells: btcStats(g.filter((t) => t.direction === "short")),
      exits: { stop: count("stop"), lock: count("lock"), target: count("target"), time: count("time") },
      averageWin: mean(wins),
      averageLoss: mean(losses),
      medianHours: hours[Math.floor(hours.length / 2)] ?? 0,
      stop: { low: risks[0] ?? 0, high: risks[risks.length - 1] ?? 0, median: risks[Math.floor(risks.length / 2)] ?? 0 },
    };
    writeFileSync("lib/backtest/btc-results.json", JSON.stringify(out, null, 2) + "\n");
    console.log("\nSaved lib/backtest/btc-results.json — the Bitcoin page reads it.");
  }
}
main();
