import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME, SCAN_HISTORY } from "@/lib/analysis/execution";
import { buildTrendSeries, structureMarks, trendStateAt, TREND_QUIET_HOURS_UTC, TREND_LOCK_AT_R, TREND_LOCK_TO_R, TREND_MAX_HOLD_BARS, TREND_MAX_OPEN, TREND_MAX_RISK_ATR, TREND_MIN_CANDLES, TREND_MIN_H1_CANDLES, TREND_MIN_RISK_ATR, TREND_REENTRY_MINUTES, TREND_REENTRY_R, TREND_SR_DAYS, TREND_SR_TOUCHES, TREND_TARGET_R, TREND_MAX_CANDLE_ATR, TREND_SD_AHEAD_R } from "@/lib/analysis/trend";
import { fetchScanCandles } from "@/lib/engine/scanner";
import { fetchCandles } from "@/lib/oanda";
import type { Candle } from "@/lib/types";

export const maxDuration = 60;

/**
 * GET /api/analysis?instrument=XAU_USD&count=500[&view=M15|H1|H4][&to=<ISO time>]
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
  // the candles shown: the 15-minute chart the entries are read on, or the 1-hour / 4-hour chart above it.
  // The read of the system is the same whichever is shown.
  const viewParam = sp.get("view") ?? EXECUTION_TIMEFRAME;
  if (!["M15", "H1", "H4"].includes(viewParam)) {
    return NextResponse.json({ error: "`view` must be M15, H1 or H4" }, { status: 400 });
  }
  const view = viewParam as "M15" | "H1" | "H4";
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
      // the 4-hour chart is only shown, never read
      view === "H4" ? fetchCandles({ instrument, granularity: "H4", count: 500, to }).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
    ]);
    const shown = view === "H1" ? data.h1 : view === "H4" ? h4 : data.m15;
    const candles = shown.slice(-count);
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
        /** fresh 1-hour supply and demand zones, and the one ahead that stops a trade */
        sdZones: t.sdZones.map((z) => ({ kind: z.kind, low: Math.min(z.proximal, z.distal), high: Math.max(z.proximal, z.distal), known: z.known })),
        sdAhead: t.sdAhead ? { kind: t.sdAhead.kind, low: Math.min(t.sdAhead.proximal, t.sdAhead.distal), high: Math.max(t.sdAhead.proximal, t.sdAhead.distal) } : null,
        candleAtr: t.candleAtr,
        maxCandleAtr: TREND_MAX_CANDLE_ATR,
        sdAheadR: TREND_SD_AHEAD_R,
        srDays: TREND_SR_DAYS,
        srTouches: TREND_SR_TOUCHES,
        holdHours: (TREND_MAX_HOLD_BARS * 900) / 3600,
        /** when the 15-minute candle this was read on closed (epoch seconds) */
        readAt: ts.candles[ts.n - 1].time + 900,
        setup: t.setup ? { direction: t.setup.direction, entry: t.setup.entry, stopLoss: t.setup.stopLoss, takeProfit: t.setup.takeProfit, trigger: t.setup.trigger, lockTrigger: t.setup.lockTrigger, lockStop: t.setup.lockStop } : null,
      };
    }
    // what a chartist would mark by hand: the swings and breaks of structure of the chart shown (on the 15-minute
    // chart the ones the entries are read from, on the 1-hour chart the ones the trend is), yesterday's high and
    // low, and the hours in which no new trade is taken
    const from = candles[0]?.time ?? 0;
    const marks = structureMarks(shown);
    const structure = { points: marks.points.filter((p) => p.time >= from), breaks: marks.breaks.filter((b) => b.time >= from) };
    const days = data.daily.filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
    const yesterday = days[days.length - 1];
    const context = { prevDayHigh: yesterday?.high ?? null, prevDayLow: yesterday?.low ?? null, quietHoursUtc: [...TREND_QUIET_HOURS_UTC] };
    return NextResponse.json({ candles, view, trend, structure, context, build: process.env.APP_BUILD ?? null, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
