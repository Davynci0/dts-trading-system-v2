import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/backtests/latest — most recent run + all scope metrics. */
export async function GET() {
  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ configured: false, run: null, results: [] });

  const { data: run } = await supabase
    .from("backtest_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) return NextResponse.json({ configured: true, run: null, results: [] });

  const { data: results } = await supabase
    .from("backtest_results")
    .select("scope, metrics")
    .eq("run_id", run.id);

  return NextResponse.json({ configured: true, run, results: results ?? [] });
}
