import { NextRequest, NextResponse } from "next/server";
import {
  btcStateAt,
  buildBtcSeries,
  fourHour,
  BTC_CHART_SECONDS,
  BTC_COST,
  BTC_LOCK_AT_R,
  BTC_LOCK_TO_R,
  BTC_MAX_COST_SHARE,
  BTC_MAX_HOLD_BARS,
  BTC_MAX_RISK_ATR,
  BTC_MIN_CANDLES,
  BTC_MIN_RISK_ATR,
  BTC_PAIR,
  BTC_RANGE_CANDLES,
  BTC_TARGET_R,
  BTC_TREND_DAYS,
} from "@/lib/analysis/btc";
import { runBtcBacktest } from "@/lib/backtest/btc";
import results from "@/lib/backtest/btc-results.json";
import { fetchCandles } from "@/lib/oanda";

export const maxDuration = 60;

/** Candles the read needs: 1-hour candles for the 4-hour chart, 15-minute candles to follow the recent trades, daily candles for the trend. */
const HISTORY = { h1: 2000, m15: 5000, daily: 150 } as const;

/**
 * GET /api/btc[?to=<ISO time>]
 * Everything the Bitcoin page shows, from the code the backtest runs: the
 * 4-hour candles, the system's read of the last closed one, the trades the
 * rules would have taken over the last weeks, and the stored five-year
 * results. Nothing is sent or stored — this system does not send signals.
 */
export async function GET(req: NextRequest) {
  const toParam = req.nextUrl.searchParams.get("to");
  const toMs = toParam ? Date.parse(toParam) : NaN;
  if (toParam && !Number.isFinite(toMs)) {
    return NextResponse.json({ error: "`to` must be an ISO date-time, e.g. 2026-11-19T08:00:00Z" }, { status: 400 });
  }
  const to = Number.isFinite(toMs) ? new Date(toMs).toISOString() : undefined;
  try {
    const [h1, m15, daily] = await Promise.all([
      fetchCandles({ instrument: BTC_PAIR, granularity: "H1", count: HISTORY.h1, to }),
      fetchCandles({ instrument: BTC_PAIR, granularity: "M15", count: HISTORY.m15, to }),
      fetchCandles({ instrument: BTC_PAIR, granularity: "D", count: HISTORY.daily, to }),
    ]);
    const now = (Number.isFinite(toMs) ? toMs : Date.now()) / 1000;
    const s = buildBtcSeries({ h1, daily, now });
    if (s.n <= BTC_MIN_CANDLES) return NextResponse.json({ error: "Not enough BTC/USD history" }, { status: 502 });
    // the entry price of a signal on the last closed candle: the open of the 15-minute candle that follows it
    const closedAt = s.h4[s.n - 1].time + BTC_CHART_SECONDS;
    const next = m15.find((c) => c.time >= closedAt);
    const state = btcStateAt(s, s.n - 1, next?.open);
    // what the rules would have done over the 15-minute candles loaded: a simulation, not sent signals
    const trades = runBtcBacktest({ m15, h1, daily: daily.filter((d) => d.time + 86400 <= now), from: m15[0]?.time ?? 0 });
    // the chart: every 4-hour candle, the one still forming included
    const candles = fourHour(h1).slice(-300);
    const price = m15[m15.length - 1]?.close ?? null;
    return NextResponse.json({
      candles,
      state,
      price,
      trades: trades.slice(-30),
      simulatedFrom: m15[0]?.time ?? null,
      rules: {
        rangeCandles: BTC_RANGE_CANDLES,
        trendDays: BTC_TREND_DAYS,
        targetR: BTC_TARGET_R,
        lockAtR: BTC_LOCK_AT_R,
        lockToR: BTC_LOCK_TO_R,
        holdHours: (BTC_MAX_HOLD_BARS * 900) / 3600,
        minRiskAtr: BTC_MIN_RISK_ATR,
        maxRiskAtr: BTC_MAX_RISK_ATR,
        cost: BTC_COST,
        maxCostShare: BTC_MAX_COST_SHARE,
        chartSeconds: BTC_CHART_SECONDS,
      },
      results,
      build: process.env.APP_BUILD ?? null,
      asOf: to ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
