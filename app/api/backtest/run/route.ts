import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { computeMetrics, type BacktestTrade } from "@/lib/backtest/engine";
import { maxOpenPositions, runTrendBacktest, type TrendTrade } from "@/lib/backtest/trend";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAuthorizedMutation } from "@/lib/apiGuard";
import { EXECUTION_BAR_SECONDS, EXECUTION_HTF, EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { TREND_ENTRIES } from "@/lib/analysis/trend";

export const maxDuration = 300;

/**
 * POST /api/backtest/run   Body: { count?: number }   (chart candles, 1000–5000; default 5000)
 *
 * Quick backtest of the trend system on the most recent candles of the chart
 * timeframe, with the scanner's own detection and the trailing stop followed
 * on those same candles.
 * The first 400 candles only warm up the indicators. Stored for the Backtests
 * page. The multi-year run lives in scripts/backtest.ts.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { count?: number };
  const count = Math.min(Math.max(body.count ?? 5000, 1000), 5000);
  const pair = "XAU_USD";
  const WARMUP = 400;

  let trades: TrendTrade[];
  let from: number;
  let to: number;
  try {
    const [candles, daily] = await Promise.all([
      fetchCandles({ instrument: pair, granularity: EXECUTION_TIMEFRAME, count }),
      // the 100-day trend needs history before the first traded candle
      fetchCandles({ instrument: pair, granularity: EXECUTION_HTF, count: Math.min(5000, Math.ceil((count * EXECUTION_BAR_SECONDS) / 86400) + 200) }),
    ]);
    if (candles.length <= WARMUP + 10) throw new Error("not enough candles returned");
    from = candles[WARMUP].time;
    to = candles[candles.length - 1].time + EXECUTION_BAR_SECONDS;
    trades = runTrendBacktest({ pair, candles, daily, from });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const metrics = (g: TrendTrade[]) => computeMetrics(g as unknown as BacktestTrade[]);
  const cut = from + 0.7 * (to - from);
  const scope = (g: TrendTrade[]) => ({
    inSample: metrics(g.filter((t) => t.entryTime < cut)),
    outOfSample: metrics(g.filter((t) => t.entryTime >= cut)),
    all: metrics(g),
  });
  const scopes: Record<string, unknown> = { combined: scope(trades) };
  for (const e of TREND_ENTRIES) scopes[`strategy:${e.label}`] = scope(trades.filter((t) => t.entryId === e.id));
  scopes["pair:buys"] = scope(trades.filter((t) => t.direction === "long"));
  scopes["pair:sells"] = scope(trades.filter((t) => t.direction === "short"));

  const supabase = createAdminClient();
  let runId: string | null = null;
  if (supabase) {
    const days = Math.round((to - from) / 86400);
    const { data } = await supabase
      .from("backtest_runs")
      .insert({
        range_start: new Date(from * 1000).toISOString(),
        range_end: new Date(to * 1000).toISOString(),
        pairs: [pair],
        timeframes: [EXECUTION_TIMEFRAME],
        config: { system: "trend", count, trailFollowedOn: EXECUTION_TIMEFRAME, mostOpenAtOnce: maxOpenPositions(trades) },
        notes: `Quick run · last ${days} days · ${EXECUTION_TIMEFRAME} · trend system`,
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

  return NextResponse.json({ runId, count, trades: trades.length, combined: scopes.combined });
}
