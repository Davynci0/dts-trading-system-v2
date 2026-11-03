import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { runBacktest, computeMetrics, LOT_SIZES, type BacktestTrade } from "@/lib/backtest/engine";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StrategyId } from "@/lib/types";

export const maxDuration = 300;

const HTF_OF: Record<string, string> = { M5: "M15", M15: "H1", H1: "H4", H4: "D", D: "W" };
const TIMEFRAME_HOURS: Record<string, number> = {
  M5: 1 / 12,
  M15: 1 / 4,
  H1: 1,
  H4: 4,
  D: 24,
};

/**
 * POST /api/backtest/run
 * Body: {
 *   pairs?: string[],
 *   timeframe?: "M15",
 *   count?: number,
 *   accountBalance?: number,
 *   lotSize?: "0.01" | "0.1" | "1",
 *   riskPercent?: number,
 *   minConfidence?: number,
 *   strategies?: ("zones"|"setforget"|"fibonacci")[]
 * }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    pairs?: string[];
    timeframe?: string;
    count?: number;
    accountBalance?: number;
    lotSize?: "0.01" | "0.1" | "1";
    riskPercent?: number;
    minConfidence?: number;
    strategies?: string[];
  };
  const pairs = body.pairs?.length ? body.pairs : ["XAU_USD"];
  const timeframe = body.timeframe ?? "M15";
  const count = Math.min(Math.max(body.count ?? 2000, 500), 5000);
  const accountBalance = body.accountBalance ?? 25000;
  const lotSize = body.lotSize;
  const riskPercent = body.riskPercent ?? 0.01;
  const minConfidence = body.minConfidence ?? 4;
  const fixedUnits = lotSize ? LOT_SIZES[lotSize] ?? undefined : undefined;
  const validStrategies: StrategyId[] = ["zones", "setforget", "fibonacci"];
  const strategies = body.strategies?.filter((s): s is StrategyId => validStrategies.includes(s as StrategyId)) ?? validStrategies;
  const horizonHours = count * (TIMEFRAME_HOURS[timeframe] ?? 1 / 4);
  const topDownCounts = {
    weekly: Math.min(5000, Math.max(160, Math.ceil(horizonHours / (24 * 7)) + 40)),
    daily: Math.min(5000, Math.max(260, Math.ceil(horizonHours / 24) + 40)),
    h4: Math.min(5000, Math.max(360, Math.ceil(horizonHours / 4) + 40)),
  };

  const supabase = createAdminClient();

  let runId: string | null = null;
  if (supabase) {
    const { data } = await supabase
      .from("backtest_runs")
      .insert({
        pairs,
        timeframes: [timeframe],
        config: {
          count,
          accountBalance,
          lotSize,
          riskPercent,
          minConfidence,
          strategies,
          fixedUnits,
          engine: "top-down W/D/H4, 6-point checklist (no vision), spread+slippage, conservative same-candle SL",
        },
        notes:
          "Vision AI excluded — cannot be queried retroactively (Section 7). Confidence buckets: 3 vs 4+ of the 6 non-AI checks.",
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  const summaries: { pair: string; combined: unknown; error?: string }[] = [];
  const allTrades: { pair: string; trade: BacktestTrade }[] = [];

  for (const pair of pairs) {
    try {
      const [candles, htfCandles, weekly, daily, h4] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: timeframe, count }),
        fetchCandles({ instrument: pair, granularity: HTF_OF[timeframe] ?? "H4", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "W", count: topDownCounts.weekly }),
        fetchCandles({ instrument: pair, granularity: "D", count: topDownCounts.daily }),
        fetchCandles({ instrument: pair, granularity: "H4", count: topDownCounts.h4 }),
      ]);
      const report = runBacktest({
        pair,
        timeframe,
        candles,
        htfCandles,
        topDownCandles: { weekly, daily, h4 },
        accountBalance,
        fixedUnits,
        riskPercent,
        minConfidence,
        strategies,
      });
      for (const t of report.trades) allTrades.push({ pair, trade: t });
      summaries.push({ pair, combined: report.scopes.combined });
    } catch (e) {
      summaries.push({ pair, combined: null, error: (e as Error).message });
    }
  }

  // aggregate scopes across all pairs: combined, per-strategy, per-pair
  const seg = (rows: { pair: string; trade: BacktestTrade }[], inSample: boolean) =>
    computeMetrics(rows.filter((r) => r.trade.inSample === inSample).map((r) => r.trade));
  const scope = (rows: { pair: string; trade: BacktestTrade }[]) => ({
    inSample: seg(rows, true),
    outOfSample: seg(rows, false),
  });

  const scopes: Record<string, unknown> = {
    combined: scope(allTrades),
  };
  for (const strategy of ["zones", "setforget", "fibonacci"] as const) {
    scopes[`strategy:${strategy}`] = scope(allTrades.filter((r) => r.trade.strategy === strategy));
  }
  for (const pair of pairs) {
    scopes[`pair:${pair}`] = scope(allTrades.filter((r) => r.pair === pair));
  }

  if (supabase && runId) {
    const { error } = await supabase.from("backtest_results").upsert(
      Object.entries(scopes).map(([s, metrics]) => ({ run_id: runId, scope: s, metrics })),
      { onConflict: "run_id,scope" }
    );
    if (error) console.error("persist backtest_results:", error.message);
  }

  return NextResponse.json({
    runId,
    timeframe,
    count,
    accountBalance,
    lotSize,
    riskPercent,
    minConfidence,
    strategies,
    summaries,
  });
}
