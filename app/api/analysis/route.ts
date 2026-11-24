import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME, SCAN_HISTORY } from "@/lib/analysis/execution";
import { buildTrendSeries, trendStateAt, TREND_MAX_HOLD_BARS, TREND_MAX_OPEN, TREND_MIN_CANDLES, TREND_MIN_H1_CANDLES, TREND_STOP_ATR, TREND_TARGET_R } from "@/lib/analysis/trend";
import { fetchScanCandles } from "@/lib/engine/scanner";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&to=<ISO time>]
 * Everything the chart draws, from the same code the scanner runs: the
 * 15-minute candles and the system's read of the last closed one — the three
 * trend readings, the levels a breakout has to close beyond, and the trade
 * when one has just fired. `to` returns the read as it stood at that moment,
 * for reviewing a past setup.
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
    // the read always uses the scanner's own window, however few candles the chart asked for
    const data = await fetchScanCandles(instrument, to, Math.max(count, SCAN_HISTORY.m15));
    const candles = data.m15.slice(-count);

    let trend = null;
    if (data.m15.length > TREND_MIN_CANDLES && data.h1.length > TREND_MIN_H1_CANDLES) {
      const ts = buildTrendSeries(data);
      const t = trendStateAt(ts, ts.n - 1, instrument);
      trend = {
        dailyTrend: t.dailyTrend,
        maTrend: t.maTrend,
        emaFast: t.emaFast,
        emaSlow: t.emaSlow,
        plusDi: t.plusDi,
        minusDi: t.minusDi,
        adx: t.adx,
        momentumAgree: t.momentumAgree,
        costShare: t.costShare,
        atr: t.atr,
        side: t.side,
        checks: t.checks,
        blocked: t.blocked,
        levels: t.levels,
        stopAtr: TREND_STOP_ATR,
        targetR: TREND_TARGET_R,
        maxOpen: TREND_MAX_OPEN,
        holdHours: (TREND_MAX_HOLD_BARS * 900) / 3600,
        /** when the 15-minute candle this was read on closed (epoch seconds) */
        readAt: ts.candles[ts.n - 1].time + 900,
        setup: t.setup ? { direction: t.setup.direction, entry: t.setup.entry, stopLoss: t.setup.stopLoss, takeProfit: t.setup.takeProfit, trigger: t.setup.trigger } : null,
      };
    }
    return NextResponse.json({ candles, trend, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
