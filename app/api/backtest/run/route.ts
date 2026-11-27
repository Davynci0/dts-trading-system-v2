import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { computeMetrics } from "@/lib/backtest/metrics";
import { entryTypeOf, runTrendBacktest, trendSetupWindows, TREND_ENTRY_TYPES, type TrendTrade } from "@/lib/backtest/trend";
import { fetchMinuteWindows } from "@/lib/backtest/minutes";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAuthorizedMutation } from "@/lib/apiGuard";
import { EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { ENGINE_VERSION } from "@/lib/engine/version";
import type { Candle } from "@/lib/types";

export const maxDuration = 300;

const DAY_MS = 86_400_000;
/** Days of trades the quick run covers; the candles before them only warm up the indicators. */
const TRADED_DAYS = 180;
const WARMUP_DAYS = 20;
/** 1-hour candles read: the 180 traded days (about 4,300) and the ones before them that settle the 1-hour structure. */
const H1_COUNT = 5000;

/** 15-minute candles for a date range, paged — OANDA returns at most 5000 a request. */
async function fetchM15(pair: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let a = fromMs; a < toMs; a += 40 * DAY_MS) {
    out.push(...(await fetchCandles({ instrument: pair, granularity: "M15", from: new Date(a).toISOString(), to: new Date(Math.min(toMs, a + 40 * DAY_MS)).toISOString() })));
  }
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((x, y) => x.time - y.time);
}

/**
 * POST /api/backtest/run
 *
 * Quick backtest of the system on the last six months, with the scanner's own
 * detection. Stored for the Backtests page. Six months is one market mood — a
 * check that the rules run, not evidence about them. The five-year run lives
 * in scripts/backtest.ts. The multi-year run lives in scripts/backtest.ts.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const pair = "XAU_USD";
  const to = Date.now();
  const from = to - TRADED_DAYS * DAY_MS;

  let trades: TrendTrade[];
  try {
    const [m15, h1, daily] = await Promise.all([
      fetchM15(pair, from - WARMUP_DAYS * DAY_MS, to),
      fetchCandles({ instrument: pair, granularity: "H1", count: H1_COUNT }),
      fetchCandles({ instrument: pair, granularity: "D", count: 400 }),
    ]);
    if (m15.length < 1000) throw new Error("not enough candles returned");
    // followed minute by minute, like the five-year run: the minute candles of every setup's life
    const minutes = await fetchMinuteWindows(pair, trendSetupWindows({ pair, m15, h1, daily, from: from / 1000 }));
    trades = runTrendBacktest({ pair, m15, h1, daily, from: from / 1000, minutes: (t) => minutes.get(t) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const cut = (from + 0.7 * (to - from)) / 1000;
  const scope = (g: TrendTrade[]) => ({
    inSample: computeMetrics(g.filter((t) => t.entryTime < cut)),
    outOfSample: computeMetrics(g.filter((t) => t.entryTime >= cut)),
    all: computeMetrics(g),
  });
  const scopes: Record<string, unknown> = { combined: scope(trades) };
  for (const type of TREND_ENTRY_TYPES) scopes[`strategy:${type}`] = scope(trades.filter((t) => entryTypeOf(t) === type));
  scopes["pair:buys"] = scope(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scope(trades.filter((t) => t.direction === "short"));

  const supabase = createAdminClient();
  let runId: string | null = null;
  if (supabase) {
    const { data } = await supabase
      .from("backtest_runs")
      .insert({
        range_start: new Date(from).toISOString(),
        range_end: new Date(to).toISOString(),
        pairs: [pair],
        timeframes: [EXECUTION_TIMEFRAME],
        config: { engine: ENGINE_VERSION, system: "market-structure scalp", days: TRADED_DAYS },
        notes: `Quick run · last ${TRADED_DAYS} days · market-structure scalp, 1:3, one trade at a time`,
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
    if (runId) {
      const { error } = await supabase
        .from("backtest_results")
        .upsert(Object.entries(scopes).map(([s, m]) => ({ run_id: runId, scope: s, metrics: m })), { onConflict: "run_id,scope" });
      if (error) console.error("persist backtest_results:", error.message);
    }
  }

  return NextResponse.json({ runId, trades: trades.length, combined: scopes.combined });
}
