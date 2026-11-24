import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME, SCAN_HISTORY } from "@/lib/analysis/execution";
import { buildTrendSeries, trendStateAt, TREND_LOCK_AT_R, TREND_LOCK_TO_R, TREND_MAX_HOLD_BARS, TREND_MAX_OPEN, TREND_MAX_RISK_ATR, TREND_MIN_CANDLES, TREND_MIN_H1_CANDLES, TREND_MIN_RISK_ATR, TREND_REENTRY_MINUTES, TREND_REENTRY_R, TREND_SR_DAYS, TREND_SR_TOUCHES, TREND_TARGET_R } from "@/lib/analysis/trend";
import { fetchScanCandles } from "@/lib/engine/scanner";
import { fetchCandles } from "@/lib/oanda";
import { toriChartLines, toriRead, TORI_HISTORY, TORI_SECONDS, TORI_TIMEFRAME } from "@/lib/analysis/tori";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&to=<ISO time>]
 * Everything the chart draws, from the same code the scanner runs: the
 * 15-minute candles and the system's read of the last closed one — the daily
 * trend, the 1-hour and 15-minute structure, the last swings, the levels an
 * entry has to close beyond, and the trade when one has just fired. `to`
 * returns the read as it stood at that moment, for reviewing a past setup.
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
    const [data, h4] = await Promise.all([
      fetchScanCandles(instrument, to, Math.max(count, SCAN_HISTORY.m15)),
      // Tori Trades' trendlines are read on the 4-hour chart — shown and alerted, never traded by the system
      fetchCandles({ instrument, granularity: TORI_TIMEFRAME, count: TORI_HISTORY, to }).catch(() => []),
    ]);
    const candles = data.m15.slice(-count);
    let tori = null;
    if (h4.length > 50 && candles.length > 0) {
      const read = toriRead(h4);
      const ev = read.event;
      tori = {
        lines: toriChartLines(read, candles[0].time, candles[candles.length - 1].time),
        safetyLong: read.safetyLong,
        safetyShort: read.safetyShort,
        /** what the last closed 4-hour candle did, if it made one of her setups */
        event: ev ? { type: ev.type, direction: ev.direction, kind: ev.line.kind, touches: ev.line.touches, close: ev.close, time: ev.time, stop: ev.stop, safety: ev.safety } : null,
        readAt: h4[h4.length - 1].time + TORI_SECONDS,
      };
    }

    let trend = null;
    if (data.m15.length > TREND_MIN_CANDLES && data.h1.length > TREND_MIN_H1_CANDLES) {
      const ts = buildTrendSeries(data);
      const t = trendStateAt(ts, ts.n - 1, instrument);
      trend = {
        dailyTrend: t.dailyTrend,
        h1Trend: t.h1Trend,
        structure: t.structure,
        swingHigh: t.swingHigh,
        swingLow: t.swingLow,
        stopLevel: t.stopLevel,
        adx: t.adx,
        rangePosition: t.rangePosition,
        distancePct: t.distancePct,
        atr: t.atr,
        costShare: t.costShare,
        side: t.side,
        checks: t.checks,
        blocked: t.blocked,
        levels: t.levels,
        minRiskAtr: TREND_MIN_RISK_ATR,
        maxRiskAtr: TREND_MAX_RISK_ATR,
        targetR: TREND_TARGET_R,
        lockAtR: TREND_LOCK_AT_R,
        lockToR: TREND_LOCK_TO_R,
        maxOpen: TREND_MAX_OPEN,
        reentryMinutes: TREND_REENTRY_MINUTES,
        reentryR: TREND_REENTRY_R,
        /** support/resistance zones near the price, and the one the last candle closed through */
        zones: t.zones,
        brokeZone: t.brokeZone,
        srDays: TREND_SR_DAYS,
        srTouches: TREND_SR_TOUCHES,
        holdHours: (TREND_MAX_HOLD_BARS * 900) / 3600,
        /** when the 15-minute candle this was read on closed (epoch seconds) */
        readAt: ts.candles[ts.n - 1].time + 900,
        setup: t.setup ? { direction: t.setup.direction, entry: t.setup.entry, stopLoss: t.setup.stopLoss, takeProfit: t.setup.takeProfit, trigger: t.setup.trigger, lockTrigger: t.setup.lockTrigger, lockStop: t.setup.lockStop } : null,
      };
    }
    return NextResponse.json({ candles, trend, tori, build: process.env.APP_BUILD ?? null, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
