import { TREND_KEY_PREFIX, type Candle, type SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * The system: a market-structure scalp on the 15-minute chart. One trade at a
 * time, a 1:3 target, closed within five hours.
 *
 *  - MARKET STRUCTURE is read from swing highs and swing lows — a high with
 *    three lower highs on each side, a low with three higher lows — the way it
 *    is usually taught: a candle that CLOSES below the last swing low makes
 *    the structure bearish, a close above the last swing high makes it
 *    bullish, and it stays that way until the other side is broken.
 *  - THE TREND is the 1-hour structure, and the daily chart has to agree: the
 *    last closed day on the same side of its 50-day average.
 *  - THREE ENTRIES, each on the close of a 15-minute candle, with the trend:
 *      break of structure   in a downtrend price comes back up, makes a lower
 *                           high, and then closes below the last swing low —
 *                           the pullback is over and the trend continues
 *      breakout             the first close beyond the high/low of the
 *                           previous 12, 24, 48 or 96 candles (3 to 24 hours)
 *      momentum candle      a candle at least 1.2 ATR long that closes in the
 *                           outer quarter of its range
 *  - THE STOP IS SET BY THE PRICE ACTION, not by a fixed distance: just beyond
 *    the high of the last two candles for a sell — the small pullback the
 *    trade is leaving behind — and the low of the last two for a buy. It is
 *    never closer than 0.75 ATR or further than 2 ATR, so a trade's risk
 *    follows the structure without one trade dwarfing the next.
 *  - THE EXIT: the stop, a take-profit at 3 times the risk, or the clock — a
 *    trade that has reached neither after 20 candles (five hours) is closed
 *    at market.
 *  - THE PROFIT LOCK: once price has gone 0.4R the trade's way, the stop is
 *    moved to 0.2R in profit. Half of all trades end there with a small gain
 *    instead of coming back to the stop; the ones that keep going still have
 *    the 1:3 target.
 *  - NO TRADE when the spread and slippage would be more than 6% of the risk.
 *  - FOUR CONDITIONS THAT COME FROM THE LOSING TRADES — each lost in both
 *    halves of the test: an exhausted trend (1-hour ADX 40 or more), the
 *    London morning (07:00–12:00 UTC), an entry in the wrong half of the last
 *    24 hours' range, and a price within 1% of the 50-day average (no real
 *    daily trend).
 *
 * Tested on five years of gold (scripts/backtest.ts); see the README for what
 * was tried and what the numbers are.
 */

/** Candles on each side of a swing high / swing low, on both the 15-minute and the 1-hour chart. */
export const TREND_SWING = 3;
/** Days in the daily trend average. */
export const TREND_DAYS = 50;
/** The breakout entry: a close beyond the high/low of this many earlier 15-minute candles, for each length. */
export const TREND_BREAKOUT_BARS = [12, 24, 48, 96] as const;
/** The momentum entry: the candle's range in ATR, and how close to its end it has to close (share of the range). */
export const TREND_MOMENTUM_ATR = 1.2;
export const TREND_MOMENTUM_CLOSE = 0.25;
/** The stop goes beyond the high/low of this many last candles (the signal candle included)… */
export const TREND_STOP_BARS = 2;
/** …by this many ATR, and the risk is kept between these many ATR. */
export const TREND_STOP_BUFFER_ATR = 0.2;
export const TREND_MIN_RISK_ATR = 0.75;
export const TREND_MAX_RISK_ATR = 2;
/** Take-profit in R. */
export const TREND_TARGET_R = 3;
/** A trade that has reached neither level by the close of this many 15-minute candles (five hours) is closed at market. */
export const TREND_MAX_HOLD_BARS = 20;
/** Profit lock: once price has gone this many R the trade's way, the stop is moved to this many R in profit. */
export const TREND_LOCK_AT_R = 0.4;
export const TREND_LOCK_TO_R = 0.2;
/** No new trade once the 1-hour ADX is at or above this — the move is exhausted. */
export const TREND_ADX_MAX = 40;
/** No new trade on a candle that closes in these UTC hours, from the first up to the second: the London morning. */
export const TREND_QUIET_HOURS_UTC = [7, 12] as const;
/** The entry has to be in the trend's half of the range of this many last candles (24 hours). */
export const TREND_RANGE_BARS = 96;
export const TREND_RANGE_MIN = 0.5;
/** Price has to be at least this far beyond the 50-day average on the trend's side, in percent. */
export const TREND_MIN_DISTANCE_PCT = 1;
/** Trades that may be open together. */
export const TREND_MAX_OPEN = 1;
/** No trade when the spread and slippage are more than this share of the risk. */
export const TREND_MAX_COST_SHARE = 0.06;
/** History needed before the reads have settled: 15-minute candles for the ATR, the longest channel and the swings; 1-hour candles for the structure. */
export const TREND_MIN_CANDLES = 300;
export const TREND_MIN_H1_CANDLES = 200;

const M15 = 900;
const H1 = 3600;
const DAY = 86400;
const PERIOD = 14;

/** The structure after each candle's close. */
export interface Structure {
  /** +1 bullish, −1 bearish, 0 not known yet */
  dir: Int8Array;
  /** the level that started the current leg: the lower high behind a bearish break, the higher low behind a bullish one */
  origin: Float64Array;
  /** counts the breaks: it changes on the candle that breaks structure */
  leg: Int32Array;
  /** the last confirmed swing high / swing low known at each candle's close */
  swingHigh: Float64Array;
  swingLow: Float64Array;
  /** the same, but only while no candle has closed beyond it yet (NaN once broken) — the level the next break needs */
  openHigh: Float64Array;
  openLow: Float64Array;
}

/**
 * Swing points and the structure they make. A swing high is a high with `k`
 * lower highs on each side, so it is only known `k` candles later. A candle
 * closing beyond the last swing that has not been broken yet breaks structure:
 * with the old direction that is a break of structure, against it a change of
 * character — either way the structure now points that way.
 */
export function readStructure(candles: Candle[], k: number = TREND_SWING): Structure {
  const n = candles.length;
  const s: Structure = {
    dir: new Int8Array(n),
    origin: new Float64Array(n).fill(NaN),
    leg: new Int32Array(n),
    swingHigh: new Float64Array(n).fill(NaN),
    swingLow: new Float64Array(n).fill(NaN),
    openHigh: new Float64Array(n).fill(NaN),
    openLow: new Float64Array(n).fill(NaN),
  };
  let high = { index: -1, price: NaN, broken: true };
  let low = { index: -1, price: NaN, broken: true };
  let dir = 0;
  let origin = NaN;
  let leg = 0;
  for (let i = 0; i < n; i++) {
    const p = i - k;
    if (p >= k) {
      let isHigh = true;
      let isLow = true;
      for (let q = p - k; q <= p + k; q++) {
        if (q === p) continue;
        if (candles[q].high >= candles[p].high) isHigh = false;
        if (candles[q].low <= candles[p].low) isLow = false;
      }
      if (isHigh) high = { index: p, price: candles[p].high, broken: false };
      if (isLow) low = { index: p, price: candles[p].low, broken: false };
    }
    const close = candles[i].close;
    if (!high.broken && close > high.price) {
      high.broken = true;
      dir = 1;
      leg++;
      // the low the rise started from: the lowest low since the last swing low
      let m = Infinity;
      for (let q = low.index >= 0 ? low.index : i; q <= i; q++) if (candles[q].low < m) m = candles[q].low;
      origin = m;
    } else if (!low.broken && close < low.price) {
      low.broken = true;
      dir = -1;
      leg++;
      let m = -Infinity;
      for (let q = high.index >= 0 ? high.index : i; q <= i; q++) if (candles[q].high > m) m = candles[q].high;
      origin = m;
    }
    s.dir[i] = dir;
    s.origin[i] = origin;
    s.leg[i] = leg;
    s.swingHigh[i] = high.price;
    s.swingLow[i] = low.price;
    if (!high.broken) s.openHigh[i] = high.price;
    if (!low.broken) s.openLow[i] = low.price;
  }
  return s;
}

export interface TrendSeries {
  n: number;
  /** closed 15-minute candles, oldest first */
  candles: Candle[];
  /** 15-minute ATR (Wilder, 14) */
  atr: Float64Array;
  /** the 15-minute structure */
  structure: Structure;
  /** per breakout length: highest high / lowest low of that many candles BEFORE each candle */
  channelHigh: Float64Array[];
  channelLow: Float64Array[];
  /** highest high / lowest low of the TREND_RANGE_BARS candles BEFORE each candle */
  rangeHigh: Float64Array;
  rangeLow: Float64Array;
  /** the 1-hour structure and ADX as they stood when each 15-minute candle closed (last CLOSED 1-hour candle) */
  h1Trend: Int8Array;
  h1Adx: Float64Array;
  /** +1 / −1 / 0 from the last CLOSED daily candle, and the average it was read against */
  dailyTrend: Int8Array;
  dailyAverage: Float64Array;
}

/** OANDA prints an empty daily candle on some weekends (it opens on a Friday or Saturday, UTC); it is not a trading day. */
const isWeekendCandle = (c: Candle) => {
  const day = new Date(c.time * 1000).getUTCDay();
  return day === 5 || day === 6;
};

/** Wilder's ATR, 14 periods. */
function wilderAtr(candles: Candle[]): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  let atr = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr = i <= PERIOD ? atr + tr / PERIOD : (atr * (PERIOD - 1) + tr) / PERIOD;
    if (i >= PERIOD) out[i] = atr;
  }
  return out;
}

/** Wilder's ADX, 14 periods. */
function wilderAdx(candles: Candle[]): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  const P = PERIOD;
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
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
    } else {
      trSum = trSum - trSum / P + tr;
      plusSum = plusSum - plusSum / P + plus;
      minusSum = minusSum - minusSum / P + minus;
    }
    if (i >= P) {
      const pdi = (100 * plusSum) / trSum;
      const mdi = (100 * minusSum) / trSum;
      const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
      adx = i < 2 * P ? adx + dx / P : (adx * (P - 1) + dx) / P;
      if (i >= 2 * P - 1) out[i] = adx;
    }
  }
  return out;
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
    atr: wilderAtr(candles),
    structure: readStructure(candles),
    channelHigh: [],
    channelLow: [],
    rangeHigh: new Float64Array(n).fill(NaN),
    rangeLow: new Float64Array(n).fill(NaN),
    h1Trend: new Int8Array(n),
    h1Adx: new Float64Array(n).fill(NaN),
    dailyTrend: new Int8Array(n),
    dailyAverage: new Float64Array(n).fill(NaN),
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

  for (let i = TREND_RANGE_BARS; i < n; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let k = i - TREND_RANGE_BARS; k < i; k++) {
      if (candles[k].high > h) h = candles[k].high;
      if (candles[k].low < l) l = candles[k].low;
    }
    s.rangeHigh[i] = h;
    s.rangeLow[i] = l;
  }

  // the 1-hour structure and ADX, carried to each 15-minute candle from the last 1-hour candle closed by then
  const h1 = input.h1;
  const hourly = readStructure(h1);
  const adx = wilderAdx(h1);
  let j = -1;
  for (let i = 0; i < n; i++) {
    const now = candles[i].time + M15;
    while (j + 1 < h1.length && h1[j + 1].time + H1 <= now) j++;
    if (j < 0) continue;
    s.h1Adx[i] = adx[j];
    // not before there is enough 1-hour history for the structure to be the real one
    if (j >= TREND_MIN_H1_CANDLES) s.h1Trend[i] = hourly.dir[j];
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
  }
  return s;
}

export type TrendTrigger = "break of structure" | "breakout" | "momentum candle" | "breakout and momentum candle";

export interface TrendSetup {
  direction: SignalDirection;
  trigger: TrendTrigger;
  /** the longest channel the candle closed beyond, in 15-minute candles; null when it was not a breakout */
  breakoutBars: number | null;
  /** entry at market: the close of the signal candle (the next candle's open) */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** the stop distance (1R), in price */
  risk: number;
  /** the profit lock: once price reaches `lockTrigger`, the stop is moved to `lockStop` */
  lockTrigger: number;
  lockStop: number;
  /** the level the stop is set beyond: the high (sell) or low (buy) of the last two candles */
  swing: number;
  /** "swing" when the stop sits just beyond that level; "nearest" / "furthest" when the level was closer or further than the limits and the stop was set at the limit */
  stopBasis: "swing" | "nearest" | "furthest";
  atr: number;
  /** when the signal candle closed (epoch seconds) */
  time: number;
  /** identity of the signal: one trade per signal candle */
  key: string;
}

export interface TrendState {
  dailyTrend: 1 | -1 | 0;
  dailyAverage: number | null;
  /** the 1-hour structure: +1 bullish, −1 bearish */
  h1Trend: 1 | -1 | 0;
  /** the 15-minute structure */
  structure: 1 | -1 | 0;
  /** the last confirmed 15-minute swing high / swing low */
  swingHigh: number | null;
  swingLow: number | null;
  /** the level a new trade's stop would go beyond right now, on the daily trend's side */
  stopLevel: number | null;
  /** the 1-hour ADX */
  adx: number | null;
  /** where the close sits in the last 24 hours' range, 0–1, measured in the daily trend's direction (1 = at the extreme) */
  rangePosition: number | null;
  /** how far price is beyond the 50-day average on the daily trend's side, in percent (negative = on the wrong side) */
  distancePct: number | null;
  atr: number | null;
  /** spread + slippage as a share of the widest stop a new trade can have — above the limit, no trade is possible */
  costShare: number | null;
  /** the side both trend readings agree on, or null */
  side: SignalDirection | null;
  /** the levels the NEXT candle has to close beyond for an entry, on the daily trend's side.
   *  `armed` is false while price is already beyond the level (only the FIRST close beyond counts). */
  levels: { label: string; price: number; armed: boolean }[];
  /** the conditions, in the order they have to be met; the last one is the entry */
  checks: { label: string; met: boolean }[];
  /** why there is nothing to wait for right now, or null when only the entry is missing */
  blocked: string | null;
  setup: TrendSetup | null;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);
const hours = (bars: number) => `${(bars * M15) / H1}`;

/**
 * The system's read of 15-minute candle `i`: the two trend readings, the
 * swings, and — when the candle is an entry with the trend — the trade, with
 * its stop set beyond the last two candles. `entry` overrides the entry price (the
 * backtest fills at the next candle's open).
 */
export function trendStateAt(s: TrendSeries, i: number, pair = "XAU_USD", entry?: number): TrendState {
  const c = s.candles[i];
  const st = s.structure;
  const daily = s.dailyTrend[i] as 1 | -1 | 0;
  const hourly = s.h1Trend[i] as 1 | -1 | 0;
  const agreed = daily !== 0 && daily === hourly;
  const side: SignalDirection | null = agreed ? (daily === 1 ? "long" : "short") : null;
  const dir = daily === -1 ? -1 : 1;
  const word = (t: number) => (t === 1 ? "up" : t === -1 ? "down" : "unclear");
  const shape = (t: number) => (t === 1 ? "bullish" : t === -1 ? "bearish" : "not known");
  const atr = s.atr[i];
  // costs against the widest stop a trade may have: above the limit there, no trade is possible at all
  const costShare = atr > 0 ? tradeCost(pair) / (TREND_MAX_RISK_ATR * atr) : NaN;
  const affordable = costShare <= TREND_MAX_COST_SHARE;
  // the four conditions from the losing trades
  const adx = s.h1Adx[i];
  const fresh = adx < TREND_ADX_MAX;
  const hour = new Date((c.time + M15) * 1000).getUTCHours();
  const quiet = hour >= TREND_QUIET_HOURS_UTC[0] && hour < TREND_QUIET_HOURS_UTC[1];
  const top = Math.max(s.rangeHigh[i], c.high);
  const bottom = Math.min(s.rangeLow[i], c.low);
  const rangePosition = top > bottom ? (dir === 1 ? (c.close - bottom) / (top - bottom) : (top - c.close) / (top - bottom)) : NaN;
  const placed = rangePosition >= TREND_RANGE_MIN;
  const distancePct = (dir * (c.close - s.dailyAverage[i])) / c.close * 100;
  const clear = distancePct >= TREND_MIN_DISTANCE_PCT;

  // which entry, if any, this candle is
  const broke = i >= 1 && st.leg[i] !== st.leg[i - 1] ? st.dir[i] : 0;
  let breakoutBars: number | null = null;
  let momentum = false;
  if (i >= 1 && broke === 0) {
    const prev = s.candles[i - 1];
    TREND_BREAKOUT_BARS.forEach((bars, b) => {
      const through =
        dir === 1
          ? c.close > s.channelHigh[b][i] && prev.close <= s.channelHigh[b][i - 1]
          : c.close < s.channelLow[b][i] && prev.close >= s.channelLow[b][i - 1];
      if (through) breakoutBars = bars;
    });
    const range = c.high - c.low;
    momentum =
      range >= TREND_MOMENTUM_ATR * atr &&
      (dir === 1 ? c.close >= c.high - TREND_MOMENTUM_CLOSE * range && c.close > c.open : c.close <= c.low + TREND_MOMENTUM_CLOSE * range && c.close < c.open);
  }
  const trigger: TrendTrigger | null =
    broke !== 0
      ? broke === dir && daily !== 0
        ? "break of structure"
        : null
      : breakoutBars != null && momentum
        ? "breakout and momentum candle"
        : breakoutBars != null
          ? "breakout"
          : momentum
            ? "momentum candle"
            : null;

  // the levels the next candle has to close beyond: the swing a break of structure needs, and each channel with this candle counted in
  const levels: TrendState["levels"] = [];
  if (daily !== 0) {
    const swing = dir === 1 ? st.openHigh[i] : st.openLow[i];
    if (Number.isFinite(swing)) levels.push({ label: `last swing ${dir === 1 ? "high" : "low"}`, price: swing, armed: true });
    TREND_BREAKOUT_BARS.forEach((bars, b) => {
      if (i + 1 < bars) return;
      let m = dir === 1 ? -Infinity : Infinity;
      for (let k = i + 1 - bars; k <= i; k++) m = dir === 1 ? Math.max(m, s.candles[k].high) : Math.min(m, s.candles[k].low);
      const now = dir === 1 ? s.channelHigh[b][i] : s.channelLow[b][i];
      levels.push({ label: `${hours(bars)}-hour ${dir === 1 ? "high" : "low"}`, price: m, armed: Number.isFinite(now) && (dir === 1 ? c.close <= now : c.close >= now) });
    });
  }

  // the stop: just beyond the high (sell) / low (buy) of the last candles, kept between the two limits
  let stopLevel = NaN;
  if (i + 1 >= TREND_STOP_BARS) {
    stopLevel = dir === 1 ? Infinity : -Infinity;
    for (let k = i + 1 - TREND_STOP_BARS; k <= i; k++) stopLevel = dir === 1 ? Math.min(stopLevel, s.candles[k].low) : Math.max(stopLevel, s.candles[k].high);
  }
  let plan: { risk: number; swing: number; basis: TrendSetup["stopBasis"] } | null = null;
  if (trigger && atr > 0) {
    const price = entry ?? c.close;
    const swing = stopLevel;
    const raw = Number.isFinite(swing) ? dir * (price - (swing - dir * TREND_STOP_BUFFER_ATR * atr)) : NaN;
    // a level on the wrong side of the price (a gap) gives no stop, and so no trade
    if (raw > 0) {
      const risk = Math.min(Math.max(raw, TREND_MIN_RISK_ATR * atr), TREND_MAX_RISK_ATR * atr);
      const basis = raw < TREND_MIN_RISK_ATR * atr ? "nearest" : raw > TREND_MAX_RISK_ATR * atr ? "furthest" : "swing";
      if (tradeCost(pair) / risk <= TREND_MAX_COST_SHARE) plan = { risk, swing, basis };
    }
  }

  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "?");
  const two = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const quietHours = `${two(TREND_QUIET_HOURS_UTC[0])}–${two(TREND_QUIET_HOURS_UTC[1])}`;
  const checks = [
    { label: `Daily trend ${word(daily)} (close vs ${TREND_DAYS}-day average)`, met: daily !== 0 },
    {
      label: `1-hour structure ${shape(hourly)}${daily !== 0 && hourly !== 0 && hourly !== daily ? " — against the daily trend" : ""}`,
      met: agreed,
    },
    { label: `Trend not exhausted: 1-hour ADX ${Number.isFinite(adx) ? adx.toFixed(0) : "?"} (must be under ${TREND_ADX_MAX})`, met: fresh },
    { label: `A real daily trend: price ${Number.isFinite(distancePct) ? Math.max(distancePct, 0).toFixed(1) : "?"}% ${dir === 1 ? "above" : "below"} the ${TREND_DAYS}-day average (needs ${TREND_MIN_DISTANCE_PCT}%)`, met: clear },
    { label: `Not the London morning (${quietHours} UTC)`, met: !quiet },
    {
      label: `In the ${dir === 1 ? "upper" : "lower"} half of the last 24 hours' range (now ${Number.isFinite(rangePosition) ? (rangePosition * 100).toFixed(0) : "?"}% of the way ${dir === 1 ? "up" : "down"})`,
      met: placed,
    },
    { label: `Costs ${pct(costShare)} of the widest stop (limit ${TREND_MAX_COST_SHARE * 100}%)`, met: affordable },
    {
      label: `Entry: a 15-minute close ${dir === 1 ? "above" : "below"} the last swing ${dir === 1 ? "high" : "low"} or the ${dir === 1 ? "high" : "low"} of the last ${TREND_BREAKOUT_BARS.map(hours).join(", ")} hours, or a ${dir === 1 ? "rising" : "falling"} candle of ${TREND_MOMENTUM_ATR} ATR or more`,
      met: trigger != null && plan != null,
    },
  ];

  let blocked: string | null = null;
  if (i < TREND_MIN_CANDLES || !(atr > 0)) blocked = "not enough 15-minute history yet";
  else if (daily === 0) blocked = "the daily trend is not known yet";
  else if (hourly === 0) blocked = "not enough 1-hour history yet";
  else if (hourly !== daily) blocked = `the 1-hour structure is ${shape(hourly)}, against the daily trend (${word(daily)})`;
  else if (!Number.isFinite(adx)) blocked = "not enough 1-hour history yet";
  else if (!fresh) blocked = `the trend is exhausted — 1-hour ADX ${adx.toFixed(0)}, no new trade at ${TREND_ADX_MAX} or more`;
  else if (!clear) blocked = `no real daily trend — price is ${Math.max(distancePct, 0).toFixed(1)}% ${dir === 1 ? "above" : "below"} the ${TREND_DAYS}-day average, it needs ${TREND_MIN_DISTANCE_PCT}%`;
  else if (quiet) blocked = `the London morning (${quietHours} UTC) — no new trade`;
  else if (!placed) blocked = `price is in the ${dir === 1 ? "lower" : "upper"} half of the last 24 hours' range — ${dir === 1 ? "buys" : "sells"} wait for the ${dir === 1 ? "upper" : "lower"} half`;
  else if (!affordable) blocked = `the candles are too small — costs would be ${pct(costShare)} of even the widest stop (limit ${TREND_MAX_COST_SHARE * 100}%)`;

  let setup: TrendSetup | null = null;
  if (!blocked && side && trigger && plan) {
    const price = entry ?? c.close;
    setup = {
      direction: side,
      trigger,
      breakoutBars,
      entry: price,
      stopLoss: price - dir * plan.risk,
      takeProfit: price + dir * TREND_TARGET_R * plan.risk,
      risk: plan.risk,
      lockTrigger: price + dir * TREND_LOCK_AT_R * plan.risk,
      lockStop: price + dir * TREND_LOCK_TO_R * plan.risk,
      swing: plan.swing,
      stopBasis: plan.basis,
      atr,
      time: c.time + M15,
      key: `${TREND_KEY_PREFIX}${c.time}`,
    };
  }

  return {
    dailyTrend: daily,
    dailyAverage: finite(s.dailyAverage[i]),
    h1Trend: hourly,
    structure: st.dir[i] as 1 | -1 | 0,
    swingHigh: finite(st.swingHigh[i]),
    swingLow: finite(st.swingLow[i]),
    stopLevel: daily !== 0 ? finite(stopLevel) : null,
    adx: finite(adx),
    rangePosition: finite(rangePosition),
    distancePct: finite(distancePct),
    atr: finite(atr),
    costShare: finite(costShare),
    side,
    levels,
    checks,
    blocked,
    setup,
  };
}
