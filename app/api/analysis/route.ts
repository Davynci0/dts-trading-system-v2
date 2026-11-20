import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { analyzeM15, M15_TRENDLINE_LOOKBACK } from "@/lib/analysis/execution";
import { findRecentSwing, inGoldenZone } from "@/lib/analysis/fibonacci";
import { analyzeTopDown, topDownOpposes } from "@/lib/analysis/topDown";
import { inTradingSession, tradingHoursUtc } from "@/lib/analysis/session";
import {
  breakoutLevels,
  ASIAN_END_HOUR,
  ASIAN_ENTRY_END_HOUR,
  CHANNEL_ENTRY_START_HOUR,
  CHANNEL_ENTRY_END_HOUR,
} from "@/lib/analysis/breakout";
import { signalStrategies } from "@/lib/engine/scanner";

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
    const analysis = analyzeM15(candles, instrument);
    if (!analysis) {
      return NextResponse.json({ candles, zones: [], fib: null, aoi: null, topDown: null, structure: [], breakout: null, gate: null });
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

    // Fibonacci: draw the swing the SCANNER would trade (analysis.fib — an
    // intact leg, chosen with the M15 structure) so the chart and the engine
    // can never show different retracements. Only when the engine has no
    // setup does the chart fall back to the most recent intact swing, marked
    // as a reference rather than a trade zone.
    const engineFib = analysis.fib;
    const swingFib =
      engineFib ?? findRecentSwing(candles, analysis.structuralPivots, analysis.atrValue, M15_TRENDLINE_LOOKBACK);
    const retrace = (f: NonNullable<typeof swingFib>, ratio: number) =>
      f.direction === "long" ? f.swingHigh.price - ratio * f.range : f.swingLow.price + ratio * f.range;
    const fib = swingFib
      ? {
          direction: swingFib.direction,
          goldenTop: swingFib.goldenTop,
          goldenBottom: swingFib.goldenBottom,
          swingLow: { time: swingFib.swingLow.time, price: swingFib.swingLow.price },
          swingHigh: { time: swingFib.swingHigh.time, price: swingFib.swingHigh.price },
          level50: retrace(swingFib, 0.5),
          level618: retrace(swingFib, 0.618),
          level786: retrace(swingFib, 0.786),
          range: swingFib.range,
          isSetup: engineFib != null,
          inZone: engineFib != null && inGoldenZone(candles, engineFib),
        }
      : null;

    // Market structure: the zigzag-filtered swings every strategy is built
    // on, each labelled against the previous swing of its kind.
    const structure: { time: number; price: number; kind: "high" | "low"; label: string }[] = [];
    {
      let prevHigh: number | null = null;
      let prevLow: number | null = null;
      for (const p of analysis.structuralPivots) {
        if (p.kind === "high") {
          structure.push({ time: p.time, price: p.price, kind: "high", label: prevHigh == null ? "H" : p.price > prevHigh ? "HH" : "LH" });
          prevHigh = p.price;
        } else {
          structure.push({ time: p.time, price: p.price, kind: "low", label: prevLow == null ? "L" : p.price > prevLow ? "HL" : "LL" });
          prevLow = p.price;
        }
      }
    }

    // Trend breakout: the levels it is waiting on. Only the trend-side level
    // of each pair is a trigger. The next candle to close is the one that can
    // break out, so the windows are judged at its open (= this candle's close).
    const waiting = breakoutLevels(candles, daily);
    const nextHour = new Date((last.time + 900) * 1000).getUTCHours();
    const breakout = {
      trend: waiting.trend,
      asian: waiting.asian,
      channel: waiting.channel,
      asianWindowOpen: nextHour >= ASIAN_END_HOUR && nextHour < ASIAN_ENTRY_END_HOUR,
      channelWindowOpen: nextHour >= CHANNEL_ENTRY_START_HOUR && nextHour < CHANNEL_ENTRY_END_HOUR,
    };

    // The pullback strategies' send gate (lib/engine/select.ts) — only shown
    // when one of them is allowed to send.
    const [sessionStart, sessionEnd] = tradingHoursUtc();
    const sending = signalStrategies();
    const gate = {
      strategies: [...sending],
      pullback: [...sending].some((s) => s !== "breakout"),
      inSession: inTradingSession(last.time + 900),
      sessionHours: `${String(sessionStart).padStart(2, "0")}:00–${String(sessionEnd).padStart(2, "0")}:00 UTC`,
      longAllowed: !topDownOpposes(topDown, "long"),
      shortAllowed: !topDownOpposes(topDown, "short"),
    };

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

    const headshoulders = analysis.headShoulders.map((p) => ({
      direction: p.direction,
      ls: { time: p.ls.time, price: p.ls.price },
      n1: { time: p.n1.time, price: p.n1.price },
      h: { time: p.h.time, price: p.h.price },
      n2: { time: p.n2.time, price: p.n2.price },
      rs: { time: p.rs.time, price: p.rs.price },
      target: p.target,
      triggerTime: p.triggerTime,
    }));

    const levels = analysis.levels.map((l) => ({
      kind: l.kind,
      price: l.price,
      time: l.time,
    }));

    return NextResponse.json({
      candles,
      zones,
      fib,
      aoi: aoiOut,
      trendlines,
      headshoulders,
      levels,
      structure: structure.slice(-18),
      breakout,
      gate,
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
