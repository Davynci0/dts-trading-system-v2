import { TREND_KEY_PREFIX, type Candle, type SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * The system: trend breakouts on the 15-minute chart with a fixed 1:3 target.
 *
 *  - THE TREND is read on the daily and the 1-hour chart and every reading has
 *    to agree. Daily: the last closed day against its 50-day average, and
 *    time-series momentum — at least two of the 20-, 60- and 250-day returns
 *    pointing the same way. 1-hour: the 50 EMA above the 200 EMA for buys,
 *    below it for sells, and +DI above −DI for buys, below for sells.
 *  - NOT AN EXHAUSTED TREND: no new trade once the 1-hour ADX is 40 or more.
 *  - COSTS UNDER 6% OF THE RISK: the stop is 2.5 × the 15-minute ATR, so when
 *    the candles are small the spread is a large share of it — and that share
 *    is what turned this system's edge into a loss for a decade. No trade then.
 *  - TWO ENTRIES, each on the close of a 15-minute candle, with the trend:
 *      breakout          the first close beyond the high/low of the previous
 *                        12, 24, 48 or 96 candles (3, 6, 12 and 24 hours)
 *      momentum candle   a candle at least 1.2 ATR long that closes in the
 *                        outer quarter of its range, in the trend's direction
 *  - ONE EXIT: a stop 2.5 ATR from the entry (that distance is 1R), a
 *    take-profit at 3R, and a time limit — a trade that has reached neither
 *    after 96 candles (24 hours of trading) is closed at market.
 *  - UP TO EIGHT TRADES open together, one per signal candle, never a buy and
 *    a sell at once.
 *
 * The filters come from the losing trades of the first version (see the
 * README): the trades that lost in every period were the ones against the
 * 1-hour directional movement, in an exhausted trend, against the longer
 * daily momentum, or with costs above about 6% of the risk.
 */

export const TREND_FAST_EMA = 50;
export const TREND_SLOW_EMA = 200;
/** Days in the daily trend average. */
export const TREND_DAYS = 50;
/** Time-series momentum: the daily close against the close this many trading days earlier (a month, a quarter, a year). */
export const TREND_MOMENTUM_DAYS = [20, 60, 250] as const;
/** How many of those returns have to point the trade's way. */
export const TREND_MOMENTUM_MIN = 2;
/** No new trade once the 1-hour ADX is at or above this — the move is exhausted. */
export const TREND_ADX_MAX = 40;
/** The breakout entry: a close beyond the high/low of this many earlier 15-minute candles, for each length. */
export const TREND_BREAKOUT_BARS = [12, 24, 48, 96] as const;
/** The momentum entry: the candle's range in ATR, and how close to its end it has to close (share of the range). */
export const TREND_MOMENTUM_ATR = 1.2;
export const TREND_MOMENTUM_CLOSE = 0.25;
/** Stop in 15-minute ATR, take-profit in R. */
export const TREND_STOP_ATR = 2.5;
export const TREND_TARGET_R = 3;
/** A trade that has reached neither level after this many 15-minute candles is closed at market. */
export const TREND_MAX_HOLD_BARS = 96;
/** Trades that may be open together. */
export const TREND_MAX_OPEN = 8;
/** No trade when the spread and slippage are more than this share of the risk. */
export const TREND_MAX_COST_SHARE = 0.06;
/** 1-hour candles needed before the slow EMA has settled, and 15-minute candles before the ATR and the longest channel have. */
export const TREND_MIN_H1_CANDLES = 2 * TREND_SLOW_EMA;
export const TREND_MIN_CANDLES = 120;

const M15 = 900;
const H1 = 3600;
const DAY = 86400;
const PERIOD = 14;

export interface TrendSeries {
  n: number;
  /** closed 15-minute candles, oldest first */
  candles: Candle[];
  /** 15-minute ATR (Wilder, 14) */
  atr: Float64Array;
  /** per breakout length: highest high / lowest low of that many candles BEFORE each candle */
  channelHigh: Float64Array[];
  channelLow: Float64Array[];
  /** the 1-hour readings as they stood when each 15-minute candle closed (last CLOSED 1-hour candle) */
  emaFast: Float64Array;
  emaSlow: Float64Array;
  plusDi: Float64Array;
  minusDi: Float64Array;
  adx: Float64Array;
  /** +1 / −1 / 0 from the last CLOSED daily candle, and the average it was read against */
  dailyTrend: Int8Array;
  dailyAverage: Float64Array;
  /** per momentum horizon: +1 / −1 / 0, the last closed day against the close that many days earlier */
  momentum: Int8Array[];
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

/** Wilder's ATR, ±DI and ADX, 14 periods. */
function wilder(candles: Candle[]): { atr: Float64Array; plusDi: Float64Array; minusDi: Float64Array; adx: Float64Array } {
  const n = candles.length;
  const atrOut = new Float64Array(n).fill(NaN);
  const plusDi = new Float64Array(n).fill(NaN);
  const minusDi = new Float64Array(n).fill(NaN);
  const adxOut = new Float64Array(n).fill(NaN);
  const P = PERIOD;
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  let atr = 0;
  let adx = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= P) {
      trSum += tr;
      plusSum += plus;
      minusSum += minus;
      atr += tr / P;
    } else {
      trSum = trSum - trSum / P + tr;
      plusSum = plusSum - plusSum / P + plus;
      minusSum = minusSum - minusSum / P + minus;
      atr = (atr * (P - 1) + tr) / P;
    }
    if (i >= P) {
      atrOut[i] = atr;
      const pdi = (100 * plusSum) / trSum;
      const mdi = (100 * minusSum) / trSum;
      plusDi[i] = pdi;
      minusDi[i] = mdi;
      const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
      adx = i < 2 * P ? adx + dx / P : (adx * (P - 1) + dx) / P;
      if (i >= 2 * P - 1) adxOut[i] = adx;
    }
  }
  return { atr: atrOut, plusDi, minusDi, adx: adxOut };
}

/**
 * Everything the system reads, aligned to the 15-minute candles. All three
 * series are CLOSED candles, oldest first; a 1-hour or daily candle is used
 * only once it has closed.
 */
export function buildTrendSeries(input: { m15: Candle[]; h1: Candle[]; daily: Candle[] }): TrendSeries {
  const candles = input.m15;
  const n = candles.length;
  const s: TrendSeries = {
    n,
    candles,
    atr: wilder(candles).atr,
    channelHigh: [],
    channelLow: [],
    emaFast: new Float64Array(n).fill(NaN),
    emaSlow: new Float64Array(n).fill(NaN),
    plusDi: new Float64Array(n).fill(NaN),
    minusDi: new Float64Array(n).fill(NaN),
    adx: new Float64Array(n).fill(NaN),
    dailyTrend: new Int8Array(n),
    dailyAverage: new Float64Array(n).fill(NaN),
    momentum: TREND_MOMENTUM_DAYS.map(() => new Int8Array(n)),
  };

  for (const bars of TREND_BREAKOUT_BARS) {
    const hi = new Float64Array(n).fill(NaN);
    const lo = new Float64Array(n).fill(NaN);
    for (let i = bars; i < n; i++) {
      let h = -Infinity;
      let l = Infinity;
      for (let k = i - bars; k < i; k++) {
        if (candles[k].high > h) h = candles[k].high;
        if (candles[k].low < l) l = candles[k].low;
      }
      hi[i] = h;
      lo[i] = l;
    }
    s.channelHigh.push(hi);
    s.channelLow.push(lo);
  }

  // the 1-hour readings, carried to each 15-minute candle from the last 1-hour candle closed by then
  const h1 = input.h1;
  const close = Float64Array.from(h1, (c) => c.close);
  const fast = ema(close, TREND_FAST_EMA);
  const slow = ema(close, TREND_SLOW_EMA);
  const di = wilder(h1);
  let j = -1;
  for (let i = 0; i < n; i++) {
    const now = candles[i].time + M15;
    while (j + 1 < h1.length && h1[j + 1].time + H1 <= now) j++;
    if (j < 0) continue;
    s.emaFast[i] = fast[j];
    s.emaSlow[i] = slow[j];
    s.plusDi[i] = di.plusDi[j];
    s.minusDi[i] = di.minusDi[j];
    s.adx[i] = di.adx[j];
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
    const now = candles[i].time + M15;
    while (d + 1 < daily.length && daily[d + 1].time + DAY <= now) d++;
    if (d >= TREND_DAYS - 1) {
      s.dailyTrend[i] = daily[d].close > avg[d] ? 1 : daily[d].close < avg[d] ? -1 : 0;
      s.dailyAverage[i] = avg[d];
    }
    TREND_MOMENTUM_DAYS.forEach((days, m) => {
      if (d >= days) s.momentum[m][i] = Math.sign(daily[d].close - daily[d - days].close);
    });
  }
  return s;
}

export type TrendTrigger = "breakout" | "momentum candle" | "breakout and momentum candle";

export interface TrendSetup {
  direction: SignalDirection;
  trigger: TrendTrigger;
  /** the longest channel the candle closed beyond, in 15-minute candles; null for a momentum candle alone */
  breakoutBars: number | null;
  /** entry at market: the close of the signal candle (the next candle's open) */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** the stop distance (1R), in price */
  risk: number;
  atr: number;
  /** when the signal candle closed (epoch seconds) */
  time: number;
  /** identity of the signal: one trade per signal candle */
  key: string;
}

export interface TrendState {
  dailyTrend: 1 | -1 | 0;
  dailyAverage: number | null;
  /** +1 when the 1-hour fast EMA is above the slow one, −1 below */
  maTrend: 1 | -1 | 0;
  emaFast: number | null;
  emaSlow: number | null;
  plusDi: number | null;
  minusDi: number | null;
  adx: number | null;
  atr: number | null;
  /** how many of the daily momentum horizons point the daily trend's way */
  momentumAgree: number;
  /** spread + slippage as a share of a new trade's risk */
  costShare: number | null;
  /** the side every trend reading agrees on, or null */
  side: SignalDirection | null;
  /** the levels the NEXT candle has to close beyond for a breakout, on the daily trend's side.
   *  `armed` is false while price is already beyond the level (only the FIRST close beyond counts). */
  levels: { bars: number; price: number; armed: boolean }[];
  /** the conditions, in the order they have to be met; the last one is the entry */
  checks: { label: string; met: boolean }[];
  /** why there is nothing to wait for right now, or null when only the entry is missing */
  blocked: string | null;
  setup: TrendSetup | null;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);
const sign = (x: number): 1 | -1 | 0 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const hours = (bars: number) => `${(bars * M15) / H1}`;

/**
 * The system's read of 15-minute candle `i`: the trend readings, the two
 * things that rule a trade out (an exhausted trend, costs too large for the
 * stop) and — when the candle is a breakout or a momentum candle with the
 * trend — the trade. `entry` overrides the entry price (the backtest fills at
 * the next candle's open).
 */
export function trendStateAt(s: TrendSeries, i: number, pair = "XAU_USD", entry?: number): TrendState {
  const c = s.candles[i];
  const daily = s.dailyTrend[i] as 1 | -1 | 0;
  const ma = Number.isFinite(s.emaSlow[i]) ? sign(s.emaFast[i] - s.emaSlow[i]) : 0;
  const di = Number.isFinite(s.plusDi[i]) ? sign(s.plusDi[i] - s.minusDi[i]) : 0;
  const dir = daily === -1 ? -1 : 1;
  // time-series momentum: the 20-, 60- and 250-day returns, counted on the daily trend's side
  const momSum = s.momentum.reduce((sum, m) => sum + m[i], 0);
  const momentumAgree = daily === 0 ? 0 : s.momentum.filter((m) => m[i] === daily).length;
  const momentumOk = daily !== 0 && momSum * daily >= 2 * TREND_MOMENTUM_MIN - TREND_MOMENTUM_DAYS.length;
  const agreed = momentumOk && daily === ma && daily === di;
  const adx = s.adx[i];
  const fresh = adx < TREND_ADX_MAX;
  const side: SignalDirection | null = agreed ? (daily === 1 ? "long" : "short") : null;
  const word = (t: number) => (t === 1 ? "up" : t === -1 ? "down" : "unclear");
  const atr = s.atr[i];
  const costShare = atr > 0 ? tradeCost(pair) / (TREND_STOP_ATR * atr) : NaN;
  const affordable = costShare <= TREND_MAX_COST_SHARE;

  let breakoutBars: number | null = null;
  let momentum = false;
  if (i >= 1 && side && fresh) {
    const prev = s.candles[i - 1];
    TREND_BREAKOUT_BARS.forEach((bars, b) => {
      const broke =
        dir === 1
          ? c.close > s.channelHigh[b][i] && prev.close <= s.channelHigh[b][i - 1]
          : c.close < s.channelLow[b][i] && prev.close >= s.channelLow[b][i - 1];
      if (broke) breakoutBars = bars;
    });
    const range = c.high - c.low;
    momentum =
      range >= TREND_MOMENTUM_ATR * atr &&
      (dir === 1 ? c.close >= c.high - TREND_MOMENTUM_CLOSE * range && c.close > c.open : c.close <= c.low + TREND_MOMENTUM_CLOSE * range && c.close < c.open);
  }
  const trigger: TrendTrigger | null = breakoutBars != null && momentum ? "breakout and momentum candle" : breakoutBars != null ? "breakout" : momentum ? "momentum candle" : null;

  // the levels the next candle has to close beyond: this candle now counts towards each channel
  const levels: TrendState["levels"] = [];
  if (daily !== 0) {
    TREND_BREAKOUT_BARS.forEach((bars, b) => {
      if (i + 1 < bars) return;
      let m = dir === 1 ? -Infinity : Infinity;
      for (let k = i + 1 - bars; k <= i; k++) m = dir === 1 ? Math.max(m, s.candles[k].high) : Math.min(m, s.candles[k].low);
      const now = dir === 1 ? s.channelHigh[b][i] : s.channelLow[b][i];
      levels.push({ bars, price: m, armed: Number.isFinite(now) && (dir === 1 ? c.close <= now : c.close >= now) });
    });
  }

  const lengths = TREND_BREAKOUT_BARS.map(hours).join(", ");
  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "?");
  const checks = [
    { label: `Daily trend ${word(daily)} (close vs ${TREND_DAYS}-day average)`, met: daily !== 0 },
    {
      label: `Daily momentum: ${momentumAgree} of the ${TREND_MOMENTUM_DAYS.join("-, ").replace(/, (\d+)$/, " and $1")}-day returns point ${word(daily)} (needs ${TREND_MOMENTUM_MIN})`,
      met: momentumOk,
    },
    {
      label: `1-hour ${TREND_FAST_EMA} EMA ${ma === 1 ? "above" : ma === -1 ? "below" : "vs"} the ${TREND_SLOW_EMA} EMA${daily !== 0 && ma !== 0 && ma !== daily ? " — against the daily trend" : ""}`,
      met: daily !== 0 && ma === daily,
    },
    {
      label: `1-hour +DI ${Number.isFinite(s.plusDi[i]) ? s.plusDi[i].toFixed(0) : "?"} / −DI ${Number.isFinite(s.minusDi[i]) ? s.minusDi[i].toFixed(0) : "?"}${daily !== 0 && di !== 0 && di !== daily ? " — against the daily trend" : ""}`,
      met: daily !== 0 && di === daily,
    },
    { label: `Trend not exhausted: 1-hour ADX ${Number.isFinite(adx) ? adx.toFixed(0) : "?"} (must be under ${TREND_ADX_MAX})`, met: fresh },
    { label: `Costs ${pct(costShare)} of the risk (limit ${TREND_MAX_COST_SHARE * 100}%)`, met: affordable },
    {
      label: `Entry: a 15-minute close ${dir === 1 ? "above" : "below"} the ${dir === 1 ? "high" : "low"} of the last ${lengths} hours, or a ${dir === 1 ? "rising" : "falling"} candle of ${TREND_MOMENTUM_ATR} ATR or more`,
      met: trigger != null,
    },
  ];

  let blocked: string | null = null;
  if (i < TREND_MIN_CANDLES || !(atr > 0)) blocked = "not enough 15-minute history yet";
  else if (!Number.isFinite(s.emaSlow[i]) || !Number.isFinite(adx)) blocked = "not enough 1-hour history yet";
  else if (daily === 0) blocked = "the daily trend is not known yet";
  else if (!momentumOk) blocked = `daily momentum does not back the trend — only ${momentumAgree} of ${TREND_MOMENTUM_DAYS.length} returns point ${word(daily)}`;
  else if (ma !== daily) blocked = `the 1-hour moving averages point ${word(ma)}, against the daily trend (${word(daily)})`;
  else if (di !== daily) blocked = `1-hour directional movement (+DI/−DI) points ${word(di)}, against the trend (${word(daily)})`;
  else if (!fresh) blocked = `the trend is exhausted — 1-hour ADX ${adx.toFixed(0)}, no new trade at ${TREND_ADX_MAX} or more`;
  else if (!affordable) blocked = `the candles are too small — costs would be ${pct(costShare)} of the risk (limit ${TREND_MAX_COST_SHARE * 100}%)`;

  let setup: TrendSetup | null = null;
  if (!blocked && side && trigger) {
    const risk = TREND_STOP_ATR * atr;
    const price = entry ?? c.close;
    setup = {
      direction: side,
      trigger,
      breakoutBars,
      entry: price,
      stopLoss: price - dir * risk,
      takeProfit: price + dir * TREND_TARGET_R * risk,
      risk,
      atr,
      time: c.time + M15,
      key: `${TREND_KEY_PREFIX}${c.time}`,
    };
  }

  return {
    dailyTrend: daily,
    dailyAverage: finite(s.dailyAverage[i]),
    maTrend: ma,
    emaFast: finite(s.emaFast[i]),
    emaSlow: finite(s.emaSlow[i]),
    plusDi: finite(s.plusDi[i]),
    minusDi: finite(s.minusDi[i]),
    adx: finite(adx),
    atr: finite(atr),
    momentumAgree,
    costShare: finite(costShare),
    side,
    levels,
    checks,
    blocked,
    setup,
  };
}
