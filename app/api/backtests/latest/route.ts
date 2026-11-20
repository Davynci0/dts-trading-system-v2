import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/backtests/latest[?run=<id>] — one stored run with all its scope
 * metrics (the newest unless `run` names another), plus the recent runs so
 * the page can switch between them.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ configured: false, run: null, results: [], runs: [] });

  const { data: runs } = await supabase
    .from("backtest_runs")
    .select("id, created_at, range_start, range_end, pairs, timeframes, config, notes")
    .order("created_at", { ascending: false })
    .limit(20);

  const wanted = req.nextUrl.searchParams.get("run");
  const run = (wanted && runs?.find((r) => r.id === wanted)) || runs?.[0] || null;
  if (!run) return NextResponse.json({ configured: true, run: null, results: [], runs: [] });

  const { data: results } = await supabase
    .from("backtest_results")
    .select("scope, metrics")
    .eq("run_id", run.id);

  return NextResponse.json({ configured: true, run, results: results ?? [], runs: runs ?? [] });
}
