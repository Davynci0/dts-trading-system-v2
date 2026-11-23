import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { buildFibSeries, fibPrice, fibStateAt, FIB_LEVELS, FIB_TARGET_EXTENSION, FIB_ZONE_DEEP, FIB_ZONE_SHALLOW } from "@/lib/analysis/fibonacci";
import { buildTrendSeries, trendStateAt, TREND_BREAKOUT_BARS, TREND_MIN_CANDLES, TREND_STOP_ATR, TREND_TARGET_R, TREND_TRAIL_ATR } from "@/lib/analysis/trend";
import { fetchFibCandles } from "@/lib/engine/scanner";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&to=<ISO time>]
 * Everything the chart draws, from the same code the scanner runs: the
 * 15-minute candles; the Fibonacci system's read of the last closed one — the
 * two trends, the 1-hour swing, its retracement levels, the entry zone and the
 * stop and target a trade from it would have; and the trend entries' read of
 * the last closed 1-hour candle. `to` returns the read as it stood at that
 * moment, for reviewing a past setup.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrument = sp.get("instrument") ?? "XAU_USD";
  const granularity = sp.get("granularity") ?? EXECUTION_TIMEFRAME;
  const count = Math.min(Math.max(Number(sp.get("count") ?? EXECUTION_CANDLES), 100), 5000);
  const toParam = sp.get("to");
  const toMs = toParam ? Date.parse(toParam) : NaN;
  if (toParam && !Number.isFinite(toMs)) {
    return NextResponse.json({ error: "`to` must be an ISO date-time, e.g. 2026-11-19T07:15:00Z" }, { status: 400 });
  }
  const to = Number.isFinite(toMs) ? new Date(toMs).toISOString() : undefined;
  if (granularity !== EXECUTION_TIMEFRAME) {
    return NextResponse.json({ error: `The chart is locked to ${EXECUTION_TIMEFRAME}` }, { status: 400 });
  }

  try {
    const data = await fetchFibCandles(instrument, to, count);
    const candles = data.m15;
    if (candles.length < 60) return NextResponse.json({ candles, fib: null, trend: null, asOf: to ?? null });

    const series = buildFibSeries(data);
    const state = fibStateAt(series, series.n - 1, instrument);
    const leg = state.leg;
    const tradeable = !state.blocked;
    const fib = {
      dailyTrend: state.dailyTrend,
      h4Trend: state.h4Trend,
      dailyAverage: state.dailyAverage,
      h4Ema: state.h4Ema,
      side: state.side,
      checks: state.checks,
      blocked: state.blocked,
      legAtr: state.legAtr,
      /** true when the leg is one the system would trade a pullback of */
      tradeable,
      leg: leg ? { direction: leg.direction, origin: leg.origin, end: leg.end, range: leg.range } : null,
      levels: leg ? FIB_LEVELS.map((level) => ({ level, price: fibPrice(leg, level) })) : [],
      zone: state.zone ? { ...state.zone, shallowLevel: FIB_ZONE_SHALLOW, deepLevel: FIB_ZONE_DEEP } : null,
      stopLoss: state.stopLoss,
      takeProfit: state.takeProfit,
      targetLevel: 1 + FIB_TARGET_EXTENSION,
      setup: state.setup ? { direction: state.setup.direction, entry: state.setup.entry, stopLoss: state.setup.stopLoss, takeProfit: state.setup.takeProfit, rr: state.setup.rr, trigger: state.setup.trigger } : null,
    };

    let trend = null;
    if (data.h1.length > TREND_MIN_CANDLES) {
      const ts = buildTrendSeries(data);
      const t = trendStateAt(ts, ts.n - 1, instrument);
      trend = {
        dailyTrend: t.dailyTrend,
        maTrend: t.maTrend,
        emaFast: t.emaFast,
        emaSlow: t.emaSlow,
        adx: t.adx,
        plusDi: t.plusDi,
        minusDi: t.minusDi,
        rsi: t.rsi,
        atr: t.atr,
        side: t.side,
        checks: t.checks,
        blocked: t.blocked,
        breakoutLevel: t.breakoutLevel,
        breakoutBars: TREND_BREAKOUT_BARS,
        stopAtr: TREND_STOP_ATR,
        trailAtr: TREND_TRAIL_ATR,
        targetR: TREND_TARGET_R,
        /** when the 1-hour candle this was read on closed (epoch seconds) */
        readAt: ts.candles[ts.n - 1].time + 3600,
        setup: t.setup ? { direction: t.setup.direction, entry: t.setup.entry, stopLoss: t.setup.stopLoss, takeProfit: t.setup.takeProfit, trailDistance: t.setup.trailDistance, trigger: t.setup.trigger } : null,
      };
    }
    return NextResponse.json({ candles, fib, trend, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
