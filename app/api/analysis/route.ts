import { NextRequest, NextResponse } from "next/server";
import { EXECUTION_CANDLES, EXECUTION_TIMEFRAME, SCAN_HISTORY } from "@/lib/analysis/execution";
import { buildTrendSeries, structureMarks, trendStateAt, TREND_QUIET_HOURS_UTC, TREND_LOCK_AT_R, TREND_LOCK_TO_R, TREND_MAX_HOLD_BARS, TREND_MAX_OPEN, TREND_MAX_RISK_ATR, TREND_MIN_CANDLES, TREND_MIN_H1_CANDLES, TREND_MIN_RISK_ATR, TREND_REENTRY_MINUTES, TREND_REENTRY_R, TREND_SR_DAYS, TREND_SR_TOUCHES, TREND_TARGET_R, TREND_MAX_CANDLE_ATR, TREND_SD_AHEAD_R } from "@/lib/analysis/trend";
import { fetchScanCandles } from "@/lib/engine/scanner";
import { fetchCandles } from "@/lib/oanda";
import { chartLines, readTrendlines, shownLines, tlDailyTrend, tlSetup, tlTrendFlips, TL_MAX_FLIPS, TL_HISTORY, TL_OPTIONS, TL_SECONDS, TL_TIMEFRAME } from "@/lib/analysis/trendline";
import { readZones, znContext, znSetup, ZN_ADX_MAX, ZN_HISTORY, ZN_MIN_DISTANCE_PCT } from "@/lib/analysis/zones";
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
    const [data, tlH1, znM15, h4] = await Promise.all([
      fetchScanCandles(instrument, to, Math.max(count, SCAN_HISTORY.m15)),
      // the trendline strategy reads the 1-hour chart, further back than the trend scalp does
      fetchCandles({ instrument, granularity: TL_TIMEFRAME, count: TL_HISTORY, to }).catch(() => [] as Candle[]),
      // supply and demand reads ten days of 15-minute candles and builds its 30-minute zones from them
      fetchCandles({ instrument, granularity: EXECUTION_TIMEFRAME, count: ZN_HISTORY, to }).catch(() => [] as Candle[]),
      // the 4-hour chart is only shown, never read
      view === "H4" ? fetchCandles({ instrument, granularity: "H4", count: 500, to }).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
    ]);
    const shown = view === "H1" ? data.h1 : view === "H4" ? h4 : data.m15;
    const candles = shown.slice(-count);
    // the trendline strategy: the lines it trades, and what the last closed 1-hour candle did
    let trendline = null;
    if (tlH1.length > 200 && candles.length > 0) {
      const n = tlH1.length;
      // the setups of the last three weeks are marked on the chart, the last candle's is the live read
      const read = readTrendlines(tlH1, TL_OPTIONS, Math.max(0, n - 500));
      const readAt = tlH1[n - 1].time + TL_SECONDS;
      const dailyTrend = tlDailyTrend(data.daily, readAt);
      const flips = tlTrendFlips(data.daily, readAt);
      // a candle can make more than one setup: the one that gives a trade, else the first
      const plans = read.events.filter((e) => e.index === n - 1).map((e) => ({ e, ...tlSetup(e, tlH1[n - 1], dailyTrend, e.close, instrument, flips) }));
      const plan = plans.find((x) => x.setup) ?? plans[0] ?? null;
      const ev = plan?.e ?? null;
      trendline = {
        lines: chartLines(read, shownLines(read, TL_OPTIONS), TL_OPTIONS, candles[0].time, candles[candles.length - 1].time),
        dailyTrend,
        /** why no trendline setup would be traded now, if anything stands in the way */
        blocks: flips > TL_MAX_FLIPS ? [`the daily trend has changed sides ${flips} times in the last ten days`] : [],
        /** every bounce, break and retest inside the chart, and whether it was a trade */
        marks: read.events
          .filter((e) => tlH1[e.index].time >= candles[0].time)
          .map((e) => ({ time: tlH1[e.index].time, price: read.valueAt(e.line, e.index), type: e.type, direction: e.direction, traded: tlSetup(e, tlH1[e.index], tlDailyTrend(data.daily, e.time), e.close, instrument, tlTrendFlips(data.daily, e.time)).setup != null })),
        event: ev
          ? {
              type: ev.type,
              direction: ev.direction,
              kind: ev.line.kind,
              touches: ev.touches,
              close: ev.close,
              time: ev.time,
              /** the trade it gives, or why it gives none */
              setup: plan?.setup ? { entry: plan.setup.entry, stopLoss: plan.setup.stopLoss, takeProfit: plan.setup.takeProfit } : null,
              reason: plan?.reason ?? null,
            }
          : null,
        readAt,
      };
    }
    // supply and demand: the fresh 30-minute zones, and what the 15-minute candles did at them
    let zones = null;
    if (znM15.length > 300 && candles.length > 0) {
      const n = znM15.length;
      const read = readZones(znM15, 0);
      const context = znContext(data.h1, data.daily);
      const readAt = znM15[n - 1].time + 900;
      const ctx = context(readAt);
      const dailyTrend = ctx.dailyTrend;
      const price = znM15[n - 1].close;
      const distance = (Math.abs(price - ctx.dailyAverage) / price) * 100;
      // what stands in the way of any zone trade right now, whatever price does at a zone
      const blocks = [
        ...(ctx.adx >= ZN_ADX_MAX ? [`the 1-hour ADX is ${ctx.adx.toFixed(0)} (limit ${ZN_ADX_MAX})`] : []),
        ...(dailyTrend !== 0 && ctx.h1Side !== dailyTrend ? ["the 1-hour averages do not agree with the daily trend"] : []),
        ...(dailyTrend !== 0 && ctx.yesterday !== -dailyTrend ? [`yesterday was not a ${dailyTrend === 1 ? "down" : "up"} day`] : []),
        ...(dailyTrend !== 0 && !(distance >= ZN_MIN_DISTANCE_PCT) ? [`price is only ${distance.toFixed(1)}% from the 50-day average`] : []),
      ];
      const plans = read.events.map((e) => ({ e, ...znSetup(e, context(e.time), e.close, instrument) }));
      const last = plans.filter((x) => x.e.index === n - 1);
      const now = last.find((x) => x.setup) ?? last[0] ?? null;
      zones = {
        dailyTrend,
        /** why no zone would be traded now, if anything stands in the way */
        blocks,
        /** the fresh zones: the ones on the trend's side can give a trade */
        zones: read.zones.map((z) => ({ kind: z.kind, low: Math.min(z.proximal, z.distal), high: Math.max(z.proximal, z.distal), proximal: z.proximal, known: z.known, touched: z.touched, tradable: (z.kind === "demand" ? 1 : -1) === dailyTrend })),
        /** every rejection inside the chart, and whether it was a trade */
        marks: plans.filter((x) => znM15[x.e.index].time >= candles[0].time).map((x) => ({ time: znM15[x.e.index].time, price: x.e.zone.proximal, kind: x.e.zone.kind, direction: x.e.direction, traded: x.setup != null })),
        event: now ? { kind: now.e.zone.kind, direction: now.e.direction, low: Math.min(now.e.zone.proximal, now.e.zone.distal), high: Math.max(now.e.zone.proximal, now.e.zone.distal), time: now.e.time, setup: now.setup ? { entry: now.setup.entry, stopLoss: now.setup.stopLoss, takeProfit: now.setup.takeProfit } : null, reason: now.reason } : null,
        readAt,
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
    return NextResponse.json({ candles, view, trend, trendline, zones, structure, context, build: process.env.APP_BUILD ?? null, asOf: to ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
