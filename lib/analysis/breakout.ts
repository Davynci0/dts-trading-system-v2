import type { Candle, SignalDirection } from "@/lib/types";

/**
 * Trend breakout. Gold tends to keep going when it breaks a level in the
 * direction of its daily trend, so the strategy enters on the M15 candle that
 * first CLOSES beyond one of two levels:
 *
 *  - the Asian range (22:00–07:00 UTC), broken during the London morning
 *    (07:00–11:00 UTC). Only the first close beyond the range each day counts;
 *    if that first break is against the trend there is no Asian trade that day.
 *  - the one-week channel (highest high / lowest low of the previous 480 M15
 *    bars), broken between 07:00 and 20:00 UTC.
 *
 * The daily trend is the last closed daily close against the average of the
 * last 50. Both rules use a wide stop — the middle of the Asian range, or
 * 3 ATR below a channel break — and a target of BREAKOUT_TARGET_R × the risk.
 * The target is 2R: on fifteen years of gold a small target won often but
 * made nothing (0.5R: 70% wins, flat), and every step wider did better. A
 * 2R target wins about 4 trades in 10.
 *
 * Every number here is a rule of the strategy, not a tuning knob: the same
 * definitions are used by the scanner, the backtest and the chart.
 */

/** Asian session, as UTC hours of the M15 bar's open. */
export const ASIAN_START_HOUR = 22;
export const ASIAN_END_HOUR = 7;
/** The Asian range may be broken until this hour (exclusive). */
export const ASIAN_ENTRY_END_HOUR = 11;
/** Channel breaks are taken from the London open to the New York afternoon. */
export const CHANNEL_ENTRY_START_HOUR = 7;
export const CHANNEL_ENTRY_END_HOUR = 20;
/** One trading week of M15 bars. */
export const CHANNEL_BARS = 480;
/** Stop distance for a channel break, in ATR. */
export const CHANNEL_STOP_ATR = 3;
/** Days in the daily-trend average. Research override: BREAKOUT_TREND_DAYS. */
export const TREND_DAYS = (() => {
  const raw = Number(process.env.BREAKOUT_TREND_DAYS);
  return Number.isInteger(raw) && raw >= 10 && raw <= 300 ? raw : 50;
})();
/** Which breakouts are taken. Research override: BREAKOUT_KINDS=asian or =channel. */
const KINDS = new Set((process.env.BREAKOUT_KINDS ?? "asian,channel").split(",").map((x) => x.trim()));
/** Target as a multiple of the risk. Override with BREAKOUT_TARGET_R: a smaller
 *  target wins more often and earns less. */
export const BREAKOUT_TARGET_R = (() => {
  const raw = Number(process.env.BREAKOUT_TARGET_R);
  return Number.isFinite(raw) && raw >= 0.25 && raw <= 5 ? raw : 2;
})();

export interface BreakoutSetup {
  kind: "asian" | "channel";
  direction: SignalDirection;
  /** the level the candle closed beyond */
  level: number;
  /** the range (Asian) or channel (one-week) that was broken */
  high: number;
  low: number;
  /** where the trade is wrong: the middle of the Asian range, or 3 ATR back */
  stop: number;
  /** open time of the breakout candle */
  time: number;
  /** FX trading day of the breakout (rolls at 22:00 UTC) */
  day: number;
}

const hourOf = (time: number) => new Date(time * 1000).getUTCHours();
/** The FX trading day rolls at 22:00 UTC, so Sunday's open belongs to Monday. */
export const tradingDay = (time: number) => Math.floor((time + 2 * 3600) / 86400);
const inAsianSession = (time: number) => hourOf(time) >= ASIAN_START_HOUR || hourOf(time) < ASIAN_END_HOUR;

/**
 * +1 when the last closed daily candle closed above the average of the last
 * TREND_DAYS daily closes, −1 below, 0 when there is not enough history.
 * `daily` must hold closed candles only.
 */
export function dailyTrend(daily: Candle[], period = TREND_DAYS): 1 | -1 | 0 {
  if (daily.length < period) return 0;
  const recent = daily.slice(-period);
  const mean = recent.reduce((s, c) => s + c.close, 0) / period;
  const last = recent[period - 1].close;
  return last > mean ? 1 : last < mean ? -1 : 0;
}

export interface AsianRange {
  high: number;
  low: number;
  /** open time of the first and last bar of the range */
  startTime: number;
  endTime: number;
}

/** The Asian range of the trading day the latest candle belongs to. */
export function asianRange(candles: Candle[]): AsianRange | null {
  if (candles.length === 0) return null;
  const day = tradingDay(candles[candles.length - 1].time);
  let high = -Infinity;
  let low = Infinity;
  let startTime = 0;
  let endTime = 0;
  for (let i = candles.length - 1; i >= 0 && tradingDay(candles[i].time) === day; i--) {
    const c = candles[i];
    if (!inAsianSession(c.time)) continue;
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    startTime = c.time;
    if (!endTime) endTime = c.time;
  }
  return Number.isFinite(high) ? { high, low, startTime, endTime } : null;
}

export interface Channel {
  high: number;
  low: number;
}

/** Highest high / lowest low of the CHANNEL_BARS bars before index `end` (exclusive). */
export function channelBefore(candles: Candle[], end: number): Channel | null {
  const start = end - CHANNEL_BARS;
  if (start < 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i < end; i++) {
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }
  return { high, low };
}

/**
 * The breakout, if the LATEST candle is one. An Asian-range break takes
 * precedence over a channel break on the same candle.
 */
export function detectBreakout(candles: Candle[], daily: Candle[], atrValue: number): BreakoutSetup | null {
  const n = candles.length;
  if (n < 2) return null;
  const trend = dailyTrend(daily);
  if (trend === 0) return null;
  const last = candles[n - 1];
  const hour = hourOf(last.time);
  const day = tradingDay(last.time);
  const direction: SignalDirection = trend === 1 ? "long" : "short";

  // --- Asian range: the first close beyond it during the London morning ---
  if (KINDS.has("asian") && hour >= ASIAN_END_HOUR && hour < ASIAN_ENTRY_END_HOUR) {
    const range = asianRange(candles);
    if (range) {
      const side = (c: Candle) => (c.close > range.high ? 1 : c.close < range.low ? -1 : 0);
      // an earlier candle of today's entry window already broke the range → today's break is spent
      let spent = false;
      for (let i = n - 2; i >= 0 && tradingDay(candles[i].time) === day; i--) {
        const h = hourOf(candles[i].time);
        if (h >= ASIAN_END_HOUR && h < ASIAN_ENTRY_END_HOUR && side(candles[i]) !== 0) {
          spent = true;
          break;
        }
      }
      if (!spent && side(last) === trend) {
        return {
          kind: "asian",
          direction,
          level: trend === 1 ? range.high : range.low,
          high: range.high,
          low: range.low,
          stop: (range.high + range.low) / 2,
          time: last.time,
          day,
        };
      }
    }
  }

  // --- one-week channel: a close through it that the previous candle had not made ---
  if (KINDS.has("channel") && hour >= CHANNEL_ENTRY_START_HOUR && hour < CHANNEL_ENTRY_END_HOUR && atrValue > 0) {
    const now = channelBefore(candles, n - 1);
    const before = channelBefore(candles, n - 2);
    if (now && before) {
      const prev = candles[n - 2];
      const broke =
        trend === 1
          ? last.close > now.high && prev.close <= before.high
          : last.close < now.low && prev.close >= before.low;
      if (broke) {
        return {
          kind: "channel",
          direction,
          level: trend === 1 ? now.high : now.low,
          high: now.high,
          low: now.low,
          stop: last.close - trend * CHANNEL_STOP_ATR * atrValue,
          time: last.time,
          day,
        };
      }
    }
  }

  return null;
}

/** What the chart draws: today's Asian range, the one-week channel and the trend. */
export function breakoutLevels(candles: Candle[], daily: Candle[]) {
  return {
    trend: dailyTrend(daily),
    asian: asianRange(candles),
    channel: channelBefore(candles, candles.length),
  };
}
