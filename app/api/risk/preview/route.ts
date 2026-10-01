import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { detectPivots } from "@/lib/analysis/pivots";
import { computeRiskLevels } from "@/lib/analysis/risk";
import type { SignalDirection } from "@/lib/types";

/**
 * GET /api/risk/preview?instrument=XAU_USD&granularity=M15&direction=long&balance=10000
 *
 * Stage 3 verification endpoint: runs pivot detection + structure-based
 * SL/TP + risk sanity check on live OANDA data and returns the result as JSON.
 * Strategies (Stage 5/6) will call computeRiskLevels() directly; this route
 * exists so the risk engine is testable before any strategy exists.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument") ?? "XAU_USD";
  const granularity = sp.get("granularity") ?? "M15";
  const direction = (sp.get("direction") ?? "long") as SignalDirection;
  const balance = Number(sp.get("balance") ?? 10000);

  if (direction !== "long" && direction !== "short") {
    return NextResponse.json({ error: "direction must be long|short" }, { status: 400 });
  }

  try {
    const candles = await fetchCandles({ instrument, granularity, count: 500 });
    if (candles.length < 30) {
      return NextResponse.json({ error: "insufficient candles" }, { status: 422 });
    }
    const pivots = detectPivots(candles);
    const entryParam = sp.get("entry");
    const entry = entryParam != null ? Number(entryParam) : candles[candles.length - 1].close;
    const result = computeRiskLevels({
      instrument,
      direction,
      entry,
      candles,
      pivots,
      accountBalance: balance,
    });

    return NextResponse.json({
      instrument,
      granularity,
      direction,
      entry,
      candleCount: candles.length,
      pivotCount: pivots.length,
      recentPivots: pivots.slice(-6),
      result,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
