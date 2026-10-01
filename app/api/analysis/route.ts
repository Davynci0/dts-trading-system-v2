import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import {
  detectPivots,
  atr,
  detectZones,
  findFibSetup,
  findSetForgetSetup,
} from "@/lib/analysis";
import { significantPivots } from "@/lib/analysis/pivots";
import { analyzeTopDown } from "@/lib/analysis/topDown";
import { lineValueAtTime, detectTrendlines, type Trendline } from "@/lib/analysis/trendlines";

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

function structureMarkers(pivots: ReturnType<typeof detectPivots>, atrValue: number) {
  const markers: { time: number; price: number; label: "HH" | "HL" | "LH" | "LL" }[] = [];
  let priorHigh: (typeof pivots)[number] | null = null;
  let priorLow: (typeof pivots)[number] | null = null;

  for (const pivot of significantPivots(pivots, atrValue)) {
    if (pivot.kind === "high") {
      if (priorHigh) {
        markers.push({
          time: pivot.time,
          price: pivot.price,
          label: pivot.price > priorHigh.price ? "HH" : "LH",
        });
      }
      priorHigh = pivot;
    } else {
      if (priorLow) {
        markers.push({
          time: pivot.time,
          price: pivot.price,
          label: pivot.price > priorLow.price ? "HL" : "LL",
        });
      }
      priorLow = pivot;
    }
  }
  return markers.slice(-8);
}

/**
 * GET /api/analysis?instrument=XAU_USD&granularity=M15&count=500
 * Returns chart candles plus exact overlay coordinates. Weekly/Daily establish
 * direction, H4 supplies the action/safety lines, and the selected chart
 * timeframe supplies execution context.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument") ?? "XAU_USD";
  const granularity = sp.get("granularity") ?? "M15";
  const count = Math.min(Number(sp.get("count") ?? 500), 5000);

  try {
    const [candles, weekly, daily, h4] = await Promise.all([
      fetchCandles({ instrument, granularity, count }),
      fetchCandles({ instrument, granularity: "W", count: 160 }),
      fetchCandles({ instrument, granularity: "D", count: 260 }),
      fetchCandles({ instrument, granularity: "H4", count: 360 }),
    ]);
    if (candles.length < 30) {
      return NextResponse.json({ candles, trendlines: [], zones: [], structure: [], fib: null, aoi: null, topDown: null });
    }

    const pivots = detectPivots(candles);
    const atrValue = atr(candles);
    if (atrValue == null) {
      return NextResponse.json({ candles, trendlines: [], zones: [], structure: [], fib: null, aoi: null, topDown: null });
    }

    const topDown = analyzeTopDown({ weekly, daily, h4 });
    const structure = structureMarkers(pivots, atrValue);

    const zones = detectZones(candles)
      .filter((z) => z.active) // invalidated zones are greyed out — show only active ones on the live chart
      .slice(-8)
      .map((z) => ({
        kind: z.kind,
        top: z.top,
        bottom: z.bottom,
        startTime: z.startTime,
        touches: z.touches,
      }));

    const trendlines = [];
    const macroLines = [topDown.actionLine, topDown.safetyLine].filter(
      (line): line is Trendline => line != null
    );
    if (topDown.actionLine) trendlines.push(chartLine(topDown.actionLine, "action", "H4", candles));
    if (topDown.safetyLine) trendlines.push(chartLine(topDown.safetyLine, "safety", "H4", candles));

    // Chart-timeframe lines: each timeframe shows its own clean structure
    // (3-touch envelope rule). On M15, the projected H4 lines alone don't
    // line up with the visible swings and read as "crooked" — these do.
    const chartLines = detectTrendlines(candles, pivots, atrValue, false);
    const chartTime = candles[candles.length - 1].time;
    for (const cl of chartLines) {
      const overlapsMacro = macroLines.some(
        (macro) =>
          macro.kind === cl.kind &&
          Math.abs(lineValueAtTime(macro, chartTime) - lineValueAtTime(cl, chartTime)) <=
            0.5 * atrValue
      );
      if (overlapsMacro) continue;
      trendlines.push(chartLine(cl, "chart", granularity, candles));
    }

    const fib = findFibSetup(candles, significantPivots(pivots, atrValue), atrValue);
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

    // Alex G set & forget: draw the 50–61.8% AOI of the most recent
    // structure-breaking leg (also on significant structure only).
    const sf = findSetForgetSetup(candles, significantPivots(pivots, atrValue), atrValue);
    const aoiOut = sf
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
      structure,
      fib: fibOut,
      aoi: aoiOut,
      topDown: {
        weekly: topDown.weekly,
        daily: topDown.daily,
        h4: topDown.h4,
        bias: topDown.bias,
        actionLine: topDown.actionLine
          ? { kind: topDown.actionLine.kind, touches: topDown.actionLine.touches }
          : null,
        safetyLine: topDown.safetyLine
          ? { kind: topDown.safetyLine.kind, touches: topDown.safetyLine.touches }
          : null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
