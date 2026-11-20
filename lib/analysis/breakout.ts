import type { Candle, SignalDirection } from "@/lib/types";
import { inTradingSession } from "./session";
import { EXECUTION_BAR_SECONDS } from "./execution";

/**
 * Range breakout (a pattern strategy, context only). Gold tends to keep going
 * when it breaks a level in the direction of its daily trend, so the strategy
 * enters on the candle that first CLOSES beyond the 30-candle channel — the
 * highest high / lowest low of the previous 30 candles.
 *
 * The daily trend is the last closed daily close against the average of the
 * last 50: above it only upside breaks are taken, below it only downside ones.
 * The stop sits 3 ATR behind the close and the target at BREAKOUT_TARGET_R ×
 * that risk.
 *
 * On fifteen years of gold the rule was positive for every channel length
 * tried (30 to 480 bars), which is why the plain one-week channel is used
 * rather than the best-scoring length.
 *
 * The same definitions are used by the scanner, the backtest and the chart.
 */

/** Channel length in candles. Research override: BREAKOUT_CHANNEL_BARS. */
export const CHANNEL_BARS = (() => {
  const raw = Number(process.env.BREAKOUT_CHANNEL_BARS);
  return Number.isInteger(raw) && raw >= 5 && raw <= 2000 ? raw : 30;
})();
/** Stop distance for a channel break, in ATR. */
export const CHANNEL_STOP_ATR = 3;
/** Days in the daily-trend average. Research override: BREAKOUT_TREND_DAYS. */
export const TREND_DAYS = (() => {
  const raw = Number(process.env.BREAKOUT_TREND_DAYS);
  return Number.isInteger(raw) && raw >= 10 && raw <= 300 ? raw : 50;
})();
/** Target as a multiple of the risk. Override with BREAKOUT_TARGET_R: a smaller
 *  target wins more often and earns less. */
export const BREAKOUT_TARGET_R = (() => {
  const raw = Number(process.env.BREAKOUT_TARGET_R);
  return Number.isFinite(raw) && raw >= 0.25 && raw <= 5 ? raw : 2;
})();

export interface BreakoutSetup {
  kind: "channel";
  direction: SignalDirection;
  /** the level the candle closed beyond */
  level: number;
  /** the one-week channel that was broken */
  high: number;
  low: number;
  /** where the trade is wrong: 3 ATR behind the close */
  stop: number;
  /** open time of the breakout candle */
  time: number;
}

/** When the latest candle closed — the moment a signal from it is entered. */
export function closeTimeOf(candles: Candle[]): number {
  const n = candles.length;
  const last = candles[n - 1];
  const step = n > 1 ? last.time - candles[n - 2].time : 0;
  // a weekend/holiday gap before the last bar is not the bar length
  return last.time + (step > 0 && step <= EXECUTION_BAR_SECONDS ? step : EXECUTION_BAR_SECONDS);
}

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
 * The breakout, if the LATEST candle is one: a close through the one-week
 * channel that the previous candle had not made, with the daily trend, inside
 * the trading session.
 */
export function detectBreakout(candles: Candle[], daily: Candle[], atrValue: number): BreakoutSetup | null {
  const n = candles.length;
  if (n < 2 || !(atrValue > 0)) return null;
  const trend = dailyTrend(daily);
  if (trend === 0) return null;
  if (!inTradingSession(closeTimeOf(candles))) return null;

  const last = candles[n - 1];
  const prev = candles[n - 2];
  const now = channelBefore(candles, n - 1);
  const before = channelBefore(candles, n - 2);
  if (!now || !before) return null;

  const broke =
    trend === 1
      ? last.close > now.high && prev.close <= before.high
      : last.close < now.low && prev.close >= before.low;
  if (!broke) return null;

  return {
    kind: "channel",
    direction: trend === 1 ? "long" : "short",
    level: trend === 1 ? now.high : now.low,
    high: now.high,
    low: now.low,
    stop: last.close - trend * CHANNEL_STOP_ATR * atrValue,
    time: last.time,
  };
}

/** What the chart draws: the one-week channel and the daily trend. */
export function breakoutLevels(candles: Candle[], daily: Candle[]) {
  return {
    trend: dailyTrend(daily),
    channel: channelBefore(candles, candles.length),
  };
}
