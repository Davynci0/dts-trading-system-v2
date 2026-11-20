import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { analyzeExecution, EXECUTION_CANDLES, EXECUTION_HTF, EXECUTION_TIMEFRAME, HTF_CANDLES, TRENDLINE_LOOKBACK } from "@/lib/analysis/execution";
import { findRecentSwing, inGoldenZone } from "@/lib/analysis/fibonacci";
import { analyzeTopDown, topDownOpposes } from "@/lib/analysis/topDown";
import { inTradingSession, tradingHoursUtc } from "@/lib/analysis/session";
import { PULLBACK_TREND_DAYS } from "@/lib/analysis/pullback";
import { detectKeyLevels, nearestLevels } from "@/lib/analysis/levels";
import { breakoutLevels, closeTimeOf, dailyTrend, CHANNEL_BARS } from "@/lib/analysis/breakout";
import { signalStrategies } from "@/lib/engine/scanner";
import { buildTrendSeries, trendStateAt, trendWatchAt, TREND_ADX_MAX, TREND_CANDLES, TREND_EMA_BARS, TREND_FAST_DAYS, TREND_SLOW_DAYS, TREND_STOP_ATR, TREND_TARGET_R, TREND_TRAIL_ATR } from "@/lib/analysis/trend";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&to=<ISO time>]
 * Everything the chart draws, from the same engine the scanner uses, on the
 * system's one chart timeframe (EXECUTION_TIMEFRAME); weekly and daily are context. `to` returns the analysis as
 * it stood at that moment, for reviewing a past setup.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument") ?? "XAU_USD";
  const granularity = sp.get("granularity") ?? EXECUTION_TIMEFRAME;
  const count = Math.min(Number(sp.get("count") ?? EXECUTION_CANDLES), 5000);
  const toParam = sp.get("to");
  const toMs = toParam ? Date.parse(toParam) : NaN;
  if (toParam && !Number.isFinite(toMs)) {
    return NextResponse.json({ error: "`to` must be an ISO date-time, e.g. 2026-11-19T07:15:00Z" }, { status: 400 });
  }
  const to = Number.isFinite(toMs) ? new Date(toMs).toISOString() : undefined;

  if (granularity !== EXECUTION_TIMEFRAME) {
    return NextResponse.json({ error: `Chart technical analysis is locked to ${EXECUTION_TIMEFRAME}` }, { status: 400 });
  }

  try {
    const [trendCandles, weekly, daily, h1, h4] = await Promise.all([
      // the trend system's long average needs more candles than the chart shows
      fetchCandles({ instrument, granularity: EXECUTION_TIMEFRAME, count: Math.max(count, TREND_CANDLES), to }),
      fetchCandles({ instrument, granularity: "W", count: 52, to }),
      // closed days: the key levels read all of them, the 100-day trend the last 100, top-down the last 90
      fetchCandles({ instrument, granularity: EXECUTION_HTF, count: HTF_CANDLES, to }),
      fetchCandles({ instrument, granularity: "H1", count: 120, to }),
      fetchCandles({ instrument, granularity: "H4", count: 120, to }),
    ]);
    const candles = trendCandles.slice(-count);
    const analysis = analyzeExecution(candles, instrument);
    if (!analysis) {
      return NextResponse.json({ candles, zones: [], fib: null, aoi: null, topDown: null, structure: [], breakout: null, gate: null });
    }

    const topDown = analyzeTopDown({ weekly, daily: daily.slice(-90), h4, h1 });
    const last = candles[candles.length - 1];

    // The pullback strategies' trend rule (lib/analysis/pullback.ts): a setup
    // the rule does not allow is still drawn, but muted.
    const pullbackTrend = dailyTrend(daily, PULLBACK_TREND_DAYS);
    const allowed = (direction: "long" | "short") =>
      pullbackTrend === (direction === "long" ? 1 : -1) && !topDownOpposes(topDown, direction);

    // Supply/demand: the six active zones nearest to price — one far from the
    // market is not something the trader is waiting on.
    const distance = (z: { top: number; bottom: number }) =>
      last.close > z.top ? last.close - z.top : last.close < z.bottom ? z.bottom - last.close : 0;
    const zones = analysis.zones
      .filter((z) => z.active)
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, 6)
      .map((z) => ({
        kind: z.kind,
        top: z.top,
        bottom: z.bottom,
        startTime: z.startTime,
        touches: z.touches,
        tradeable: allowed(z.kind === "demand" ? "long" : "short"),
      }));

    // Fibonacci: draw the swing the SCANNER would trade (analysis.fib — an
    // intact leg, chosen with the chart's structure) so the chart and the engine
    // can never show different retracements. Only when the engine has no
    // setup does the chart fall back to the most recent intact swing, marked
    // as a reference rather than a trade zone.
    const engineFib = analysis.fib;
    const swingFib =
      engineFib ?? findRecentSwing(candles, analysis.structuralPivots, analysis.atrValue, TRENDLINE_LOOKBACK);
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
          tradeable: engineFib != null && allowed(engineFib.direction),
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

    // Trend breakout: the one-week channel it is waiting on. Only the
    // trend-side edge is a trigger.
    const waiting = breakoutLevels(candles, daily);
    const breakout = {
      trend: waiting.trend,
      channel: waiting.channel ? { ...waiting.channel, startTime: candles[Math.max(0, candles.length - CHANNEL_BARS)].time } : null,
    };

    // The trend system (lib/analysis/trend.ts): what its filters allow, what
    // each entry is waiting for, and the two EMAs it reads.
    const series = buildTrendSeries(trendCandles, daily);
    const ti = series.n - 1;
    const finite = (v: number) => (Number.isFinite(v) ? v : null);
    const shown = candles[0].time;
    const curve = (values: number[]) => series.t.map((time, k) => ({ time, value: values[k] })).filter((p) => p.time >= shown && Number.isFinite(p.value));
    const st = trendStateAt(series, ti);
    const trend = {
      state: { ...st, adx: finite(st.adx), ema: finite(st.ema) },
      adxMax: Number.isFinite(TREND_ADX_MAX) ? TREND_ADX_MAX : null,
      fastDays: TREND_FAST_DAYS,
      slowDays: TREND_SLOW_DAYS,
      emaBars: TREND_EMA_BARS,
      atr: finite(series.atr[ti]),
      stopAtr: TREND_STOP_ATR,
      trailAtr: TREND_TRAIL_ATR,
      targetR: TREND_TARGET_R,
      watch: trendWatchAt(series, ti),
      ema20: curve(series.ema20),
      ema50: curve(series.ema50),
      emaTrend: curve(series.emaTrend),
    };

    // The pullback strategies' rules (lib/analysis/pullback.ts) — only shown
    // when one of them is allowed to send.
    const [sessionStart, sessionEnd] = tradingHoursUtc();
    const sending = signalStrategies();
    const gate = {
      strategies: [...sending],
      pullback: [...sending].some((s) => s !== "breakout"),
      inSession: inTradingSession(closeTimeOf(candles)),
      sessionHours: `${String(sessionStart).padStart(2, "0")}:00–${String(sessionEnd).padStart(2, "0")}:00 UTC`,
      trend: pullbackTrend,
      trendDays: PULLBACK_TREND_DAYS,
      longAllowed: allowed("long"),
      shortAllowed: allowed("short"),
      // the daily trend allows this side but the weekly structure opposes it
      weeklyBlocks:
        (pullbackTrend === 1 && topDownOpposes(topDown, "long")) || (pullbackTrend === -1 && topDownOpposes(topDown, "short")),
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
            leg: { lowTime: sf.legLow.time, lowPrice: sf.legLow.price, highTime: sf.legHigh.time, highPrice: sf.legHigh.price },
            tradeable: allowed(sf.direction),
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

    // Support and resistance: the daily levels the engine grades signals with —
    // the three nearest on each side of price.
    const levels = nearestLevels(detectKeyLevels(daily, last.close), last.close, 3).map((l) => ({
      kind: l.kind,
      price: l.price,
      top: l.top,
      bottom: l.bottom,
      touches: l.touches,
      flipped: l.flipped,
      time: l.firstTime,
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
      trend,
      asOf: to ?? null,
      topDown: {
        weekly: topDown.weekly,
        daily: topDown.daily,
        h4: topDown.h4,
        h1: topDown.h1,
        bias: topDown.bias,
        chart: analysis.structureState,
        actionLine: null,
        safetyLine: null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
