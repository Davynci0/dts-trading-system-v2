import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { analyzeM15, M15_TRENDLINE_LOOKBACK } from "@/lib/analysis/execution";
import { findRecentSwing } from "@/lib/analysis/fibonacci";
import { analyzeTopDown } from "@/lib/analysis/topDown";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&granularity=M15&count=500
 * Chart TA is always M15. Weekly/Daily/H4/H1 are bias context only.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument") ?? "XAU_USD";
  const granularity = sp.get("granularity") ?? "M15";
  const count = Math.min(Number(sp.get("count") ?? 500), 5000);

  if (granularity !== "M15") {
    return NextResponse.json({ error: "Chart technical analysis is locked to M15" }, { status: 400 });
  }

  try {
    const [candles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument, granularity: "M15", count }),
      fetchCandles({ instrument, granularity: "W", count: 52 }),
      fetchCandles({ instrument, granularity: "D", count: 90 }),
      fetchCandles({ instrument, granularity: "H4", count: 120 }),
      fetchCandles({ instrument, granularity: "H1", count: 120 }),
    ]);
    const analysis = analyzeM15(candles);
    if (!analysis) {
      return NextResponse.json({ candles, zones: [], fib: null, aoi: null, topDown: null });
    }

    const topDown = analyzeTopDown({ weekly, daily, h4, h1 });
    const last = candles[candles.length - 1];
    // Draw all active zones on the chart, not just the ones near current price,
    // so the user can see the full technical landscape.
    const zones = analysis.zones
      .filter((z) => z.active)
      .sort((a, b) => b.startIndex - a.startIndex)
      .slice(0, 12)
      .map((z) => ({
        kind: z.kind,
        top: z.top,
        bottom: z.bottom,
        startTime: z.startTime,
        touches: z.touches,
      }));

    // Always draw the most recent significant swing's Fibonacci levels, even
    // when price is not currently inside the golden zone. Uses the SAME
    // structural pivots and lookback as the engine's findFibSetup so the
    // drawn swing is one the scanner would actually trade.
    const swingFib = findRecentSwing(candles, analysis.structuralPivots, analysis.atrValue, M15_TRENDLINE_LOOKBACK);
    const fib = swingFib
      ? {
          direction: swingFib.direction,
          goldenTop: swingFib.goldenTop,
          goldenBottom: swingFib.goldenBottom,
          swingLow: { time: swingFib.swingLow.time, price: swingFib.swingLow.price },
          swingHigh: { time: swingFib.swingHigh.time, price: swingFib.swingHigh.price },
          level50:
            swingFib.direction === "long"
              ? swingFib.swingHigh.price - 0.5 * swingFib.range
              : swingFib.swingLow.price + 0.5 * swingFib.range,
          level618:
            swingFib.direction === "long"
              ? swingFib.swingHigh.price - 0.618 * swingFib.range
              : swingFib.swingLow.price + 0.618 * swingFib.range,
          level786:
            swingFib.direction === "long"
              ? swingFib.swingHigh.price - 0.786 * swingFib.range
              : swingFib.swingLow.price + 0.786 * swingFib.range,
          range: swingFib.range,
        }
      : null;

    const sf = analysis.setForget;
    const aoiOut =
      sf && !sf.tested
        ? {
            direction: sf.direction,
            top: sf.aoiTop,
            bottom: sf.aoiBottom,
            startTime: sf.legLow.time,
            legEndTime: candles[Math.min(sf.legEndIndex, candles.length - 1)].time,
            tested: sf.tested,
          }
        : null;

    const trendlines = analysis.trendlines.map((l) => ({
      kind: l.kind,
      origin: { time: l.origin.time, price: l.origin.price },
      definitionAnchor: { time: l.definitionAnchor.time, price: l.definitionAnchor.price },
      anchors: l.anchors.map((a) => ({ time: a.time, price: a.price })),
      touches: l.touches,
      broken: l.broken,
    }));

    return NextResponse.json({
      candles,
      zones,
      fib,
      aoi: aoiOut,
      trendlines,
      topDown: {
        weekly: topDown.weekly,
        daily: topDown.daily,
        h4: topDown.h4,
        h1: topDown.h1,
        bias: topDown.bias,
        m15: analysis.structureState,
        actionLine: null,
        safetyLine: null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
