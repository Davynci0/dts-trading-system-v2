import { TREND_KEY_PREFIX, type Candle, type SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * The trend entries — trend trading as the textbooks describe it, on the
 * 1-hour chart with the daily chart above it:
 *
 *  - THE TREND is read three ways and all three have to agree. Daily: the last
 *    closed day against its 50-day average. Moving averages: the 1-hour 50 EMA
 *    above the 200 EMA for buys, below it for sells. Directional movement:
 *    +DI above −DI for buys, below for sells.
 *  - THE TREND MUST BE STRONG: the 1-hour ADX at 25 or more.
 *  - TWO ENTRIES, each on the close of a 1-hour candle, with the trend:
 *      breakout       the first close beyond the high/low of the last 240
 *                     candles (ten trading days)
 *      RSI pullback   the 14-period RSI coming back through 50 after a dip
 *                     against the trend — the retracement is over
 *  - ONE EXIT for both: a stop 2.5 ATR from the entry (that distance is 1R), a
 *    trailing stop 6 ATR behind the best price, and a take-profit at 8R. The
 *    trailing stop is what closes the winners; the take-profit only banks an
 *    exceptional run.
 *
 * One trend trade at a time. Every number was chosen on 2011–2021 gold data
 * and left alone for 2021–2026 (scripts/backtest.ts prints both). On that
 * data the same rules lost on 15- and 30-minute candles, fixed targets of 2R
 * and 3R lost on every chart, and range trading (RSI 30/70 while ADX is low)
 * earned nothing.
 */

export const TREND_FAST_EMA = 50;
export const TREND_SLOW_EMA = 200;
/** The 1-hour ADX must be at least this for a trend to count as one. */
export const TREND_ADX_MIN = 25;
/** Days in the daily trend average. */
export const TREND_DAYS = 50;
/** The breakout entry: a close beyond the high/low of this many earlier 1-hour candles. */
export const TREND_BREAKOUT_BARS = 240;
/** The pullback entry: RSI coming back through this level with the trend. */
export const TREND_RSI_LEVEL = 50;
/** Initial stop and trailing distance in 1-hour ATR, and the take-profit in R. */
export const TREND_STOP_ATR = 2.5;
export const TREND_TRAIL_ATR = 6;
export const TREND_TARGET_R = 8;
/** No trade when the spread and slippage are more than this share of the risk. */
export const TREND_MAX_COST_SHARE = 0.1;
/** 1-hour candles needed before the slow EMA has settled. */
export const TREND_MIN_CANDLES = 2 * TREND_SLOW_EMA;

const H1 = 3600;
const DAY = 86400;
const PERIOD = 14;

export interface TrendSeries {
  n: number;
  /** closed 1-hour candles, oldest first */
  candles: Candle[];
  atr: Float64Array;
  adx: Float64Array;
  plusDi: Float64Array;
  minusDi: Float64Array;
  rsi: Float64Array;
  emaFast: Float64Array;
  emaSlow: Float64Array;
  /** highest high / lowest low of the TREND_BREAKOUT_BARS candles BEFORE each candle */
  channelHigh: Float64Array;
  channelLow: Float64Array;
  /** +1 / −1 / 0 from the last CLOSED daily candle, and the average it was read against */
  dailyTrend: Int8Array;
  dailyAverage: Float64Array;
}

/** OANDA prints an empty daily candle on some weekends (it opens on a Friday or Saturday, UTC); it is not a trading day. */
const isWeekendCandle = (c: Candle) => {
  const day = new Date(c.time * 1000).getUTCDay();
  return day === 5 || day === 6;
};

function ema(close: Float64Array, period: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  const k = 2 / (period + 1);
  let v = close[0];
  for (let i = 0; i < close.length; i++) {
    v = i === 0 ? close[0] : close[i] * k + v * (1 - k);
    // the first 2 × period values still carry the starting price
    if (i >= 2 * period) out[i] = v;
  }
  return out;
}

/**
 * Everything the trend entries read, aligned to the 1-hour candles. Both
 * series are CLOSED candles, oldest first; a daily candle is used only once it
 * has closed. ATR, ADX, ±DI and RSI are Wilder's, 14 periods.
 */
export function buildTrendSeries(input: { h1: Candle[]; daily: Candle[] }): TrendSeries {
  const candles = input.h1;
  const n = candles.length;
  const h = Float64Array.from(candles, (c) => c.high);
  const l = Float64Array.from(candles, (c) => c.low);
  const c = Float64Array.from(candles, (x) => x.close);
  const s: TrendSeries = {
    n,
    candles,
    atr: new Float64Array(n).fill(NaN),
    adx: new Float64Array(n).fill(NaN),
    plusDi: new Float64Array(n).fill(NaN),
    minusDi: new Float64Array(n).fill(NaN),
    rsi: new Float64Array(n).fill(NaN),
    emaFast: ema(c, TREND_FAST_EMA),
    emaSlow: ema(c, TREND_SLOW_EMA),
    channelHigh: new Float64Array(n).fill(NaN),
    channelLow: new Float64Array(n).fill(NaN),
    dailyTrend: new Int8Array(n),
    dailyAverage: new Float64Array(n).fill(NaN),
  };

  const P = PERIOD;
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  let adx = 0;
  let atr = 0;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    const change = c[i] - c[i - 1];
    if (i <= P) {
      trSum += tr;
      plusSum += plus;
      minusSum += minus;
      atr += tr / P;
      gain += Math.max(change, 0) / P;
      loss += Math.max(-change, 0) / P;
    } else {
      trSum = trSum - trSum / P + tr;
      plusSum = plusSum - plusSum / P + plus;
      minusSum = minusSum - minusSum / P + minus;
      atr = (atr * (P - 1) + tr) / P;
      gain = (gain * (P - 1) + Math.max(change, 0)) / P;
      loss = (loss * (P - 1) + Math.max(-change, 0)) / P;
    }
    if (i >= P) {
      s.atr[i] = atr;
      s.rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      const pdi = (100 * plusSum) / trSum;
      const mdi = (100 * minusSum) / trSum;
      s.plusDi[i] = pdi;
      s.minusDi[i] = mdi;
      const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
      adx = i < 2 * P ? adx + dx / P : (adx * (P - 1) + dx) / P;
      if (i >= 2 * P - 1) s.adx[i] = adx;
    }
  }

  const B = TREND_BREAKOUT_BARS;
  for (let i = B; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - B; k < i; k++) {
      if (h[k] > hi) hi = h[k];
      if (l[k] < lo) lo = l[k];
    }
    s.channelHigh[i] = hi;
    s.channelLow[i] = lo;
  }

  const daily = input.daily.filter((d) => !isWeekendCandle(d));
  const avg = new Float64Array(daily.length).fill(NaN);
  let sum = 0;
  for (let k = 0; k < daily.length; k++) {
    sum += daily[k].close;
    if (k >= TREND_DAYS) sum -= daily[k - TREND_DAYS].close;
    if (k >= TREND_DAYS - 1) avg[k] = sum / TREND_DAYS;
  }
  let d = -1;
  for (let i = 0; i < n; i++) {
    const now = candles[i].time + H1;
    while (d + 1 < daily.length && daily[d + 1].time + DAY <= now) d++;
    if (d >= TREND_DAYS - 1) {
      s.dailyTrend[i] = daily[d].close > avg[d] ? 1 : daily[d].close < avg[d] ? -1 : 0;
      s.dailyAverage[i] = avg[d];
    }
  }
  return s;
}

export type TrendTrigger = "breakout" | "RSI pullback" | "breakout and RSI pullback";

export interface TrendSetup {
  direction: SignalDirection;
  trigger: TrendTrigger;
  /** entry at market: the close of the signal candle (the next candle's open) */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** the initial stop distance (1R) and the trailing distance, in price */
  risk: number;
  trailDistance: number;
  atr: number;
  /** when the signal candle closed (epoch seconds) */
  time: number;
  /** identity of the signal: one trade per signal candle */
  key: string;
}

export interface TrendState {
  dailyTrend: 1 | -1 | 0;
  dailyAverage: number | null;
  /** +1 when the fast EMA is above the slow one, −1 below */
  maTrend: 1 | -1 | 0;
  emaFast: number | null;
  emaSlow: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  rsi: number | null;
  atr: number | null;
  /** the side every trend reading agrees on (ADX aside), or null */
  side: SignalDirection | null;
  /** the level the NEXT 1-hour candle has to close beyond for the breakout entry, on the trend's side */
  breakoutLevel: number | null;
  /** the conditions, in the order they have to be met; the last one is the entry */
  checks: { label: string; met: boolean }[];
  /** why there is nothing to wait for right now, or null when only the entry is missing */
  blocked: string | null;
  setup: TrendSetup | null;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);
const sign = (x: number): 1 | -1 | 0 => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * The trend entries' read of 1-hour candle `i`: the three trend readings, the
 * trend's strength, and — when the candle is a breakout or an RSI pullback
 * with the trend — the trade. `entry` overrides the entry price (the backtest
 * fills at the next candle's open).
 */
export function trendStateAt(s: TrendSeries, i: number, pair = "XAU_USD", entry?: number): TrendState {
  const c = s.candles[i];
  const daily = s.dailyTrend[i] as 1 | -1 | 0;
  const ma = Number.isFinite(s.emaSlow[i]) ? sign(s.emaFast[i] - s.emaSlow[i]) : 0;
  const di = Number.isFinite(s.plusDi[i]) ? sign(s.plusDi[i] - s.minusDi[i]) : 0;
  const adx = s.adx[i];
  const strong = adx >= TREND_ADX_MIN;
  const agreed = daily !== 0 && daily === ma && daily === di;
  const side: SignalDirection | null = agreed ? (daily === 1 ? "long" : "short") : null;
  const dir = daily === -1 ? -1 : 1;
  const word = (t: number) => (t === 1 ? "up" : t === -1 ? "down" : "unclear");

  let breakout = false;
  let pullback = false;
  if (i >= 1 && side && strong) {
    const prev = s.candles[i - 1];
    breakout =
      dir === 1
        ? c.close > s.channelHigh[i] && prev.close <= s.channelHigh[i - 1]
        : c.close < s.channelLow[i] && prev.close >= s.channelLow[i - 1];
    pullback =
      dir === 1
        ? s.rsi[i - 1] < TREND_RSI_LEVEL && s.rsi[i] >= TREND_RSI_LEVEL
        : s.rsi[i - 1] > 100 - TREND_RSI_LEVEL && s.rsi[i] <= 100 - TREND_RSI_LEVEL;
  }
  const trigger: TrendTrigger | null = breakout && pullback ? "breakout and RSI pullback" : breakout ? "breakout" : pullback ? "RSI pullback" : null;

  // the level the next candle has to close beyond: this candle now counts towards the channel
  let breakoutLevel: number | null = null;
  if (daily !== 0 && i + 1 >= TREND_BREAKOUT_BARS) {
    let m = dir === 1 ? -Infinity : Infinity;
    for (let k = i + 1 - TREND_BREAKOUT_BARS; k <= i; k++) m = dir === 1 ? Math.max(m, s.candles[k].high) : Math.min(m, s.candles[k].low);
    breakoutLevel = m;
  }

  const checks = [
    { label: `Daily trend ${word(daily)} (close vs ${TREND_DAYS}-day average)`, met: daily !== 0 },
    {
      label: `1-hour ${TREND_FAST_EMA} EMA ${ma === 1 ? "above" : ma === -1 ? "below" : "vs"} the ${TREND_SLOW_EMA} EMA${daily !== 0 && ma !== 0 && ma !== daily ? " — against the daily trend" : ""}`,
      met: daily !== 0 && ma === daily,
    },
    {
      label: `+DI ${Number.isFinite(s.plusDi[i]) ? s.plusDi[i].toFixed(0) : "?"} / −DI ${Number.isFinite(s.minusDi[i]) ? s.minusDi[i].toFixed(0) : "?"}${daily !== 0 && di !== 0 && di !== daily ? " — against the daily trend" : ""}`,
      met: agreed,
    },
    { label: `Trend strength: ADX ${Number.isFinite(adx) ? adx.toFixed(0) : "?"} (needs ${TREND_ADX_MIN} or more)`, met: strong },
    {
      label: `Entry: a 1-hour close ${dir === 1 ? "above" : "below"} the ${TREND_BREAKOUT_BARS}-candle ${dir === 1 ? "high" : "low"}, or RSI back ${dir === 1 ? "above" : "below"} ${TREND_RSI_LEVEL} (now ${Number.isFinite(s.rsi[i]) ? s.rsi[i].toFixed(0) : "?"})`,
      met: trigger != null,
    },
  ];

  let blocked: string | null = null;
  if (i < TREND_MIN_CANDLES || !Number.isFinite(s.emaSlow[i])) blocked = "not enough 1-hour history yet";
  else if (daily === 0) blocked = "the daily trend is not known yet";
  else if (ma !== daily) blocked = `the 1-hour moving averages point ${word(ma)}, against the daily trend (${word(daily)})`;
  else if (di !== daily) blocked = `directional movement (+DI/−DI) points ${word(di)}, against the trend (${word(daily)})`;
  else if (!strong) blocked = `the trend is too weak — ADX ${Number.isFinite(adx) ? adx.toFixed(0) : "?"}, it needs ${TREND_ADX_MIN}`;

  let setup: TrendSetup | null = null;
  const atr = s.atr[i];
  if (!blocked && side && trigger && atr > 0) {
    const risk = TREND_STOP_ATR * atr;
    if (tradeCost(pair) / risk <= TREND_MAX_COST_SHARE) {
      const price = entry ?? c.close;
      setup = {
        direction: side,
        trigger,
        entry: price,
        stopLoss: price - dir * risk,
        takeProfit: price + dir * TREND_TARGET_R * risk,
        risk,
        trailDistance: TREND_TRAIL_ATR * atr,
        atr,
        time: c.time + H1,
        key: `${TREND_KEY_PREFIX}${c.time}`,
      };
    }
  }

  return {
    dailyTrend: daily,
    dailyAverage: finite(s.dailyAverage[i]),
    maTrend: ma,
    emaFast: finite(s.emaFast[i]),
    emaSlow: finite(s.emaSlow[i]),
    adx: finite(adx),
    plusDi: finite(s.plusDi[i]),
    minusDi: finite(s.minusDi[i]),
    rsi: finite(s.rsi[i]),
    atr: finite(atr),
    side,
    breakoutLevel,
    checks,
    blocked,
    setup,
  };
}
