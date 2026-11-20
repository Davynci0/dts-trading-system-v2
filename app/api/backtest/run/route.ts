import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { runBacktest, computeMetrics, LOT_SIZES, type BacktestTrade } from "@/lib/backtest/engine";
import { createAdminClient } from "@/lib/supabase/admin";
import { minConfidenceFor, signalPairs, signalStrategies } from "@/lib/engine/scanner";
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
 *   pairs?: string[],        // omit for the pairs that send live signals
 *   timeframe?: "M15",
 *   count?: number,          // M15 candles, 500–5000 (OANDA's per-request cap, ~7 weeks)
 *   accountBalance?: number,
 *   lotSize?: "0.01" | "0.1" | "1",
 *   riskPercent?: number,
 *   minConfidence?: number,   // omit to use the live per-strategy gate
 *   strategies?: ("breakout"|"zones"|"setforget"|"fibonacci")[]  // omit for the live ones
 * }
 * Runs in live-parity mode: the scanner's send gate, one trade per pair, and
 * (unless minConfidence is given) the same per-strategy confirmation minimums.
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
  const pairs = body.pairs?.length ? body.pairs : [...signalPairs()];
  const timeframe = body.timeframe ?? "M15";
  const count = Math.min(Math.max(body.count ?? 5000, 500), 5000);
  const accountBalance = body.accountBalance ?? 25000;
  const lotSize = body.lotSize;
  const riskPercent = body.riskPercent ?? 0.01;
  const minConfidence = body.minConfidence; // undefined → live per-strategy gate
  const fixedUnits = lotSize ? LOT_SIZES[lotSize] ?? undefined : undefined;
  const validStrategies: StrategyId[] = ["breakout", "zones", "setforget", "fibonacci"];
  // default: exactly the strategies that send live signals
  const strategies = body.strategies?.filter((s): s is StrategyId => validStrategies.includes(s as StrategyId)) ?? [...signalStrategies()];
  const horizonHours = count * (TIMEFRAME_HOURS[timeframe] ?? 1 / 4);
  const topDownCounts = {
    weekly: Math.min(5000, Math.max(52, Math.ceil(horizonHours / (24 * 7)) + 10)),
    daily: Math.min(5000, Math.max(90, Math.ceil(horizonHours / 24) + 10)),
    h4: Math.min(5000, Math.max(120, Math.ceil(horizonHours / 4) + 10)),
    h1: Math.min(5000, Math.max(120, Math.ceil(horizonHours) + 10)),
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
          minConfidence: minConfidence ?? "live gate",
          strategies,
          fixedUnits,
          engine:
            "live send gate (session, weekly veto, M15 structure), closed-bar HTF, one trade per pair, 6-point checklist (no vision), spread+slippage, conservative same-candle SL",
        },
        notes: `Quick run · last ${count} M15 candles (~${Math.round(horizonHours / 24)} days) · live rules`,
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  const summaries: { pair: string; combined: unknown; error?: string }[] = [];
  const allTrades: { pair: string; trade: BacktestTrade }[] = [];

  for (const pair of pairs) {
    try {
      const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: timeframe, count }),
        fetchCandles({ instrument: pair, granularity: HTF_OF[timeframe] ?? "H4", count: 500 }),
        fetchCandles({ instrument: pair, granularity: "W", count: topDownCounts.weekly }),
        fetchCandles({ instrument: pair, granularity: "D", count: topDownCounts.daily }),
        fetchCandles({ instrument: pair, granularity: "H4", count: topDownCounts.h4 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: topDownCounts.h1 }),
      ]);
      const report = runBacktest({
        pair,
        timeframe,
        candles,
        htfCandles,
        topDownCandles: { weekly, daily, h4, h1 },
        accountBalance,
        fixedUnits,
        riskPercent,
        minConfidence: minConfidence ?? {
          breakout: minConfidenceFor(pair, "breakout"),
          zones: minConfidenceFor(pair, "zones"),
          setforget: minConfidenceFor(pair, "setforget"),
          fibonacci: minConfidenceFor(pair, "fibonacci"),
        },
        oneTradePerPair: true,
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
    all: computeMetrics(rows.map((r) => r.trade)),
  });

  const scopes: Record<string, unknown> = {
    combined: scope(allTrades),
  };
  for (const strategy of validStrategies) {
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
    minConfidence: minConfidence ?? "live gate",
    strategies,
    summaries,
  });
}
