import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";

/**
 * GET /api/candles?instrument=EUR_USD&granularity=M15&count=500
 * Server-side proxy to OANDA so the API key never reaches the browser.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument");
  const granularity = sp.get("granularity") ?? "M15";
  const count = Math.min(Number(sp.get("count") ?? 500), 5000);

  if (!instrument) {
    return NextResponse.json({ error: "instrument is required" }, { status: 400 });
  }

  try {
    const candles = await fetchCandles({ instrument, granularity, count });
    return NextResponse.json({ candles });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
