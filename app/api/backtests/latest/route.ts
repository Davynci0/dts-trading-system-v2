import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ENGINE_VERSION } from "@/lib/engine/version";

/**
 * GET /api/backtests/latest[?run=<id>] — one stored run with all its scope
 * metrics (the newest unless `run` names another), plus the recent runs so
 * the page can switch between them. Only runs of the rules that are live now
 * are listed: runs of earlier systems, and their longer test windows, stay in
 * the database but are not shown.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ configured: false, run: null, results: [], runs: [] });

  const { data: stored } = await supabase
    .from("backtest_runs")
    .select("id, created_at, range_start, range_end, pairs, timeframes, config, notes")
    .order("created_at", { ascending: false })
    .limit(60);
  const runs = (stored ?? []).filter((r) => (r.config as { engine?: string } | null)?.engine === ENGINE_VERSION).slice(0, 20);

  const wanted = req.nextUrl.searchParams.get("run");
  const run = (wanted && runs.find((r) => r.id === wanted)) || runs[0] || null;
  if (!run) return NextResponse.json({ configured: true, run: null, results: [], runs: [] });

  const { data: results } = await supabase
    .from("backtest_results")
    .select("scope, metrics")
    .eq("run_id", run.id);

  return NextResponse.json({ configured: true, run, results: results ?? [], runs });
}
