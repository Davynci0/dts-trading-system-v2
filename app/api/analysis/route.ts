import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { analyzeM15, nearbyActiveZones } from "@/lib/analysis/execution";
import { analyzeTopDown } from "@/lib/analysis/topDown";
import { lineValueAtTime, type Trendline } from "@/lib/analysis/trendlines";

export const maxDuration = 60;

function chartLine(line: Trendline, role: "action" | "safety" | "chart", sourceTimeframe: string, candles: Awaited<ReturnType<typeof fetchCandles>>) {
  const firstVisibleTime = candles[0].time;
  const lastVisibleTime = candles[candles.length - 1].time;
  const startTime = Math.max(line.origin.time, firstVisibleTime);

  return {
    kind: line.kind,
    role,
    sourceTimeframe,
    broken: line.broken,
    touches: line.touches,
    origin: { time: line.origin.time, price: line.origin.price },
    definitionAnchor: {
      time: line.definitionAnchor.time,
      price: line.definitionAnchor.price,
    },
    start: { time: startTime, price: lineValueAtTime(line, startTime) },
    end: { time: lastVisibleTime, price: lineValueAtTime(line, lastVisibleTime) },
    anchors: line.anchors.map((anchor) => ({
      time: anchor.time,
      price: anchor.price,
      index: anchor.index,
    })),
  };
}

/**
 * GET /api/analysis?instrument=XAU_USD&granularity=M15&count=500
 * Chart TA is always M15. Weekly/Daily/H4 are bias context only — they are
 * not drawn as action/safety lines on the 15-minute chart.
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
    const [candles, weekly, daily, h4] = await Promise.all([
      fetchCandles({ instrument, granularity: "M15", count }),
      fetchCandles({ instrument, granularity: "W", count: 160 }),
      fetchCandles({ instrument, granularity: "D", count: 260 }),
      fetchCandles({ instrument, granularity: "H4", count: 360 }),
    ]);
    const analysis = analyzeM15(candles);
    if (!analysis) {
      return NextResponse.json({ candles, trendlines: [], zones: [], structure: [], fib: null, aoi: null, topDown: null });
    }

    const topDown = analyzeTopDown({ weekly, daily, h4 });
    const last = candles[candles.length - 1];
    const zones = nearbyActiveZones(analysis.zones, last.close, analysis.atrValue).map((z) => ({
      kind: z.kind,
      top: z.top,
      bottom: z.bottom,
      startTime: z.startTime,
      touches: z.touches,
    }));

    const trendlines = analysis.trendlines.map((line) => chartLine(line, "chart", "M15", candles));

    const fib = analysis.fib;
    const fibOut = fib
      ? {
          direction: fib.direction,
          goldenTop: fib.goldenTop,
          goldenBottom: fib.goldenBottom,
          swingLow: { time: fib.swingLow.time, price: fib.swingLow.price },
          swingHigh: { time: fib.swingHigh.time, price: fib.swingHigh.price },
          level618:
            fib.direction === "long"
              ? fib.swingHigh.price - 0.618 * fib.range
              : fib.swingLow.price + 0.618 * fib.range,
          level786:
            fib.direction === "long"
              ? fib.swingHigh.price - 0.786 * fib.range
              : fib.swingLow.price + 0.786 * fib.range,
          range: fib.range,
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

    return NextResponse.json({
      candles,
      trendlines,
      zones,
      structure: analysis.structureMarkers,
      fib: fibOut,
      aoi: aoiOut,
      topDown: {
        weekly: topDown.weekly,
        daily: topDown.daily,
        h4: topDown.h4,
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
