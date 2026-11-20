import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";

/**
 * GET /api/candles?instrument=EUR_USD&granularity=H4&count=500
 * Server-side proxy to OANDA so the API key never reaches the browser.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument");
  const granularity = sp.get("granularity") ?? EXECUTION_TIMEFRAME;
  const count = Math.min(Number(sp.get("count") ?? 500), 5000);

  if (!instrument) {
    return NextResponse.json({ error: "instrument is required" }, { status: 400 });
  }

  // Dashboard TA is H4-only; reject other granularities early so callers can't drift.
  if (granularity !== EXECUTION_TIMEFRAME) {
    return NextResponse.json({ error: `Trading analysis runs on ${EXECUTION_TIMEFRAME} only` }, { status: 400 });
  }

  try {
    const candles = await fetchCandles({ instrument, granularity, count });
    return NextResponse.json({ candles });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
