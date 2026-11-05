import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Pair ranking on ~6 months of M15 data at the live gate (5/4/6, one trade
 * per pair, realistic spreads, USD-converted sizing). Each pair reports the
 * full window plus the built-in in-sample (first 70%) / out-of-sample (last
 * 30%) splits, so a pair that only worked in one regime is visible.
 *
 * Usage: npx tsx --env-file=.env.local scripts/research-rank.ts PAIR1 PAIR2 ...
 * OANDA caps a request at 5000 candles, so each granularity is paginated.
 */
import { runBacktest, computeMetrics, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles, fetchLatestPrice } from "@/lib/oanda";
import type { Pair } from "@/lib/types";

const SPAN_DAYS = 182; // ~6 months
const LIVE_GATE = { zones: 5, setforget: 4, fibonacci: 6 } as const;

async function fetchRange(instrument: string, granularity: string, days: number, windowDays: number) {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const out = [];
  for (let from = start; from < end; from += windowDays * 86_400_000) {
    const to = Math.min(end, from + windowDays * 86_400_000);
    out.push(
      ...(await fetchCandles({
        instrument,
        granularity,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      }))
    );
  }
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time);
}

async function main() {
  const pairs = process.argv.slice(2) as Pair[];
  if (!pairs.length) throw new Error("usage: research-rank.ts PAIR1 PAIR2 ...");

  const usdjpy = await fetchLatestPrice("USD_JPY").then((p) => p?.close ?? 152).catch(() => 152);
  const audusd = await fetchLatestPrice("AUD_USD").then((p) => p?.close ?? 0.65).catch(() => 0.65);
  const nzdusd = await fetchLatestPrice("NZD_USD").then((p) => p?.close ?? 0.58).catch(() => 0.58);

  for (const pair of pairs) {
    const t0 = Date.now();
    try {
      const [candles, h1, weekly, daily, h4] = await Promise.all([
        fetchRange(pair, "M15", SPAN_DAYS, 40),
        fetchRange(pair, "H1", SPAN_DAYS, 90),
        fetchRange(pair, "W", 210, 400),
        fetchRange(pair, "D", 200, 400),
        fetchRange(pair, "H4", SPAN_DAYS, 300),
      ]);
      const rate = pair.endsWith("_USD")
        ? 1
        : pair.endsWith("JPY")
          ? 1 / usdjpy
          : pair.endsWith("_AUD")
            ? audusd
            : pair.endsWith("_NZD")
              ? nzdusd
              : 1;
      const report = runBacktest({
        pair,
        timeframe: "M15",
        candles,
        htfCandles: h1,
        topDownCandles: { weekly, daily, h4, h1 },
        accountBalance: 25000,
        minConfidence: { ...LIVE_GATE },
        oneTradePerPair: true,
        strategies: ["setforget", "zones", "fibonacci"],
        quoteUsdRate: rate,
      });
      const m = computeMetrics(report.trades as BacktestTrade[], rate);
      const is = report.scopes.combined.inSample;
      const os = report.scopes.combined.outOfSample;
      console.log(
        `RESULT ${pair} candles=${candles.length} trades=${m.trades} win=${(m.winRate * 100).toFixed(0)} pf=${m.profitFactor.toFixed(2)} avgR=${m.avgR.toFixed(2)} ddR=${m.maxDrawdownR.toFixed(1)} | IS(${is.trades}) pf ${is.profitFactor.toFixed(2)} avgR ${is.avgR.toFixed(2)} | OOS(${os.trades}) pf ${os.profitFactor.toFixed(2)} avgR ${os.avgR.toFixed(2)} | ${((Date.now() - t0) / 1000).toFixed(0)}s`
      );
    } catch (e) {
      console.log(`RESULT ${pair} FETCH_FAILED ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

main().catch(console.error);
