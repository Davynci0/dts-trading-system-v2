import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";

/**
 * GET /api/live?instrument=EUR_USD&granularity=M15
 * Returns ONLY the current (possibly still-forming) candle so the chart can
 * tick its last bar cheaply. Poll this at a fast interval; the full analysis
 * (overlays, TA) refreshes separately on a slower cadence.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument");
  const granularity = sp.get("granularity") ?? "M15";
  if (!instrument) {
    return NextResponse.json({ error: "instrument is required" }, { status: 400 });
  }
  try {
    const [candle] = await fetchCandles({
      instrument,
      granularity,
      count: 1,
      includeIncomplete: true,
    });
    return NextResponse.json({ candle: candle ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
