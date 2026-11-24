import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME } from "@/lib/analysis/execution";
import { buildTrendSeries, trendStateAt, TREND_BREAKOUT_BARS, TREND_MIN_CANDLES, TREND_STOP_ATR, TREND_TARGET_R, TREND_TRAIL_ATR } from "@/lib/analysis/trend";
import { fetchScanCandles } from "@/lib/engine/scanner";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&to=<ISO time>]
 * Everything the chart draws, from the same code the scanner runs: the
 * 15-minute candles and the trend entries' read of the last closed 1-hour
 * candle — the trend conditions, the breakout level, and the trade when one
 * has just fired. `to` returns the read as it stood at that moment, for
 * reviewing a past setup.
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
    const data = await fetchScanCandles(instrument, to, count);
    const candles = data.m15;

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
    return NextResponse.json({ candles, trend, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
