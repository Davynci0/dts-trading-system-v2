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
 *  - SUPPORT AND RESISTANCE: zones where at least three 1-hour swing highs or
 *    lows of the last 30 days sit within 0.15 of a day's average range. They
 *    are used twice. A signal candle that has just CLOSED THROUGH a zone is not
 *    traded — price usually comes back to test the level it broke, and those
 *    trades lost. And when a zone sits behind the entry, the STOP goes just
 *    beyond that zone instead of beyond the last two candles, as long as that
 *    keeps it within the limits below.
 *  - SUPPLY AND DEMAND: a zone is a base of one to three small-bodied 1-hour
 *    candles that price left with a strong candle; it is FRESH until price
 *    first comes back to it. No trade into a fresh zone of the other side —
 *    no buy with fresh supply less than 1R ahead (no sell into fresh demand).
 *  - NO OVERSIZED SIGNAL CANDLE: a signal candle 2.5 ATR or longer is not
 *    traded; those trades lost in both halves of the test.
 *  - NO DUPLICATE ENTRY: within 60 minutes of the last trade's entry, a new
 *    trade on the same side is only taken once price is more than 1R (the
 *    last trade's risk) away from that entry. Re-entering the same move at
 *    the same price straight after a trade closed made nothing over five
 *    years.
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
/** No same-side re-entry within this many minutes of the last trade's entry … */
export const TREND_REENTRY_MINUTES = 60;
/** … unless price is more than this many times the last trade's risk away from that entry. */
export const TREND_REENTRY_R = 1;
/** Support and resistance: 1-hour swing points of the last this many days … */
export const TREND_SR_DAYS = 30;
/** … grouped into zones no taller than this share of a day's average range (daily ATR) … */
export const TREND_SR_WIDTH_ATR = 0.15;
/** … with at least this many swing points (touches) in a zone. */
export const TREND_SR_TOUCHES = 3;
/** No trade on a signal candle this many 15-minute ATRs long or longer. */
export const TREND_MAX_CANDLE_ATR = 2.5;
/** Supply and demand (1-hour): a base of up to this many candles … */
export const TREND_SD_BASE_MAX = 3;
/** … each with a body no bigger than this share of its range … */
export const TREND_SD_BASE_BODY = 0.5;
/** … left by a candle whose body is at least this share of its range and this many ATRs long … */
export const TREND_SD_LEG_BODY = 0.6;
export const TREND_SD_LEG_ATR = 1.2;
/** … and a zone counts for this many days. */
export const TREND_SD_LIFE_DAYS = 10;
/** No trade with a fresh zone of the other side within this many R ahead of the entry. */
export const TREND_SD_AHEAD_R = 1;

/** A supply (sell) or demand (buy) zone of the 1-hour chart. */
export interface SdZone {
  kind: "demand" | "supply";
  /** the edge price returns to first, and the far edge */
  proximal: number;
  distal: number;
  /** when it was known (the close of the candle that left the base), when price first came back to it, when a close went beyond its far edge, and when it lapses (epoch seconds; Infinity = not yet) */
  known: number;
  touched: number;
  broken: number;
  expires: number;
}

/** Every supply and demand zone of a 1-hour series, with what happened to it afterwards — all read from CLOSED candles. */
export function supplyDemandZones(h1: Candle[]): SdZone[] {
  const atr = wilderAtr(h1);
  const out: SdZone[] = [];
  for (let j = 15; j < h1.length; j++) {
    const leg = h1[j];
    const body = Math.abs(leg.close - leg.open);
    const range = leg.high - leg.low;
    if (!(range > 0) || body < TREND_SD_LEG_BODY * range || !(body >= TREND_SD_LEG_ATR * atr[j - 1])) continue;
    const up = leg.close > leg.open;
    const base: Candle[] = [];
    for (let k = j - 1; k >= 0 && base.length < TREND_SD_BASE_MAX; k--) {
      const b = h1[k];
      const rb = b.high - b.low;
      if (rb > 0 && Math.abs(b.close - b.open) <= TREND_SD_BASE_BODY * rb) base.push(b);
      else break;
    }
    if (!base.length) continue;
    const baseHigh = Math.max(...base.map((b) => b.high));
    const baseLow = Math.min(...base.map((b) => b.low));
    // the candle has to leave the base
    if (up ? leg.close <= baseHigh : leg.close >= baseLow) continue;
    const proximal = up ? Math.max(...base.map((b) => Math.max(b.open, b.close))) : Math.min(...base.map((b) => Math.min(b.open, b.close)));
    const distal = up ? Math.min(baseLow, leg.low) : Math.max(baseHigh, leg.high);
    const known = leg.time + H1;
    const expires = known + TREND_SD_LIFE_DAYS * DAY;
    let touched = Infinity;
    let broken = Infinity;
    for (let q = j + 1; q < h1.length && h1[q].time < expires; q++) {
      // known once the candle that did it has closed
      if (touched === Infinity && (up ? h1[q].low <= proximal : h1[q].high >= proximal)) touched = h1[q].time + H1;
      if (up ? h1[q].close < distal : h1[q].close > distal) {
        broken = h1[q].time + H1;
        break;
      }
    }
    out.push({ kind: up ? "demand" : "supply", proximal, distal, known, touched, broken, expires });
  }
  return out;
}

/** A support/resistance zone: the band its touches span. */
export interface SrZone {
  low: number;
  high: number;
  touches: number;
}

/** Zones of at least `touches` prices no more than `width` apart — the fullest first, never two sharing a touch. */
export function srZones(prices: number[], width: number, touches: number = TREND_SR_TOUCHES): SrZone[] {
  const p = [...prices].sort((a, b) => a - b);
  const found: { a: number; b: number }[] = [];
  let b = 0;
  for (let a = 0; a < p.length; a++) {
    if (b < a) b = a;
    while (b + 1 < p.length && p[b + 1] - p[a] <= width) b++;
    if (b - a + 1 >= touches) found.push({ a, b });
  }
  found.sort((x, y) => y.b - y.a - (x.b - x.a));
  const used = new Uint8Array(p.length);
  const zones: SrZone[] = [];
  for (const f of found) {
    let free = true;
    for (let q = f.a; q <= f.b; q++) if (used[q]) free = false;
    if (!free) continue;
    for (let q = f.a; q <= f.b; q++) used[q] = 1;
    zones.push({ low: p[f.a], high: p[f.b], touches: f.b - f.a + 1 });
  }
  return zones.sort((x, y) => x.low - y.low);
}

/** The last trade of the system, as the re-entry rule needs it. */
export interface LastEntry {
  direction: SignalDirection;
  /** when it was entered: the close of its signal candle (epoch seconds) */
  time: number;
  entry: number;
  /** its distance from the entry to the first stop */
  risk: number;
}

/**
 * Why a new trade would be a duplicate of the last one, or null when it is not:
 * the same side, within TREND_REENTRY_MINUTES of the last entry, and within
 * TREND_REENTRY_R of its price. `next.time` is the close of the new signal candle.
 */
export function reentryBlock(last: LastEntry | null, next: { direction: SignalDirection; time: number; entry: number }): string | null {
  if (!last || last.direction !== next.direction || !(last.risk > 0)) return null;
  const minutes = (next.time - last.time) / 60;
  if (minutes < 0 || minutes > TREND_REENTRY_MINUTES) return null;
  const apart = Math.abs(next.entry - last.entry);
  if (apart > TREND_REENTRY_R * last.risk) return null;
  const side = last.direction === "long" ? "buy" : "sell";
  return `a ${side} was entered at ${last.entry.toFixed(2)} ${Math.round(minutes)} min ago — no new ${side} within ${TREND_REENTRY_R}R of it (${(last.entry - TREND_REENTRY_R * last.risk).toFixed(2)}–${(last.entry + TREND_REENTRY_R * last.risk).toFixed(2)}) for ${TREND_REENTRY_MINUTES} minutes`;
}
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
  /** the daily ATR of the last closed day */
  dailyAtr: Float64Array;
  /** every 1-hour swing high and low, with the moment it became known (the close of the third candle after it), oldest first */
  h1Swings: { time: number; known: number; price: number }[];
  /** support/resistance zones already worked out, by the swings they were built from */
  zoneCache: Map<string, SrZone[]>;
  /** the 1-hour supply and demand zones */
  sdZones: SdZone[];
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
    dailyAtr: new Float64Array(n).fill(NaN),
    h1Swings: [],
    zoneCache: new Map(),
    sdZones: supplyDemandZones(input.h1),
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
  // the 1-hour swing points the support/resistance zones are built from
  for (let p = TREND_SWING; p + TREND_SWING < h1.length; p++) {
    let isHigh = true;
    let isLow = true;
    for (let q = p - TREND_SWING; q <= p + TREND_SWING; q++) {
      if (q === p) continue;
      if (h1[q].high >= h1[p].high) isHigh = false;
      if (h1[q].low <= h1[p].low) isLow = false;
    }
    const known = h1[p + TREND_SWING].time + H1;
    if (isHigh) s.h1Swings.push({ time: h1[p].time, known, price: h1[p].high });
    if (isLow) s.h1Swings.push({ time: h1[p].time, known, price: h1[p].low });
  }
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
  const dailyAtr = wilderAtr(daily);
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
    if (d >= 0) s.dailyAtr[i] = dailyAtr[d];
  }
  return s;
}

/** The support/resistance zones as they stood when 15-minute candle `i` closed. */
export function zonesAt(s: TrendSeries, i: number): SrZone[] {
  const t = s.candles[i].time + M15;
  const width = TREND_SR_WIDTH_ATR * s.dailyAtr[i];
  if (!(width > 0)) return [];
  // the swings are in order of time and of when they became known, so the ones that count are one slice
  const sw = s.h1Swings;
  const first = (ok: (k: number) => boolean) => {
    let lo = 0;
    let hi = sw.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ok(m)) hi = m;
      else lo = m + 1;
    }
    return lo;
  };
  const from = first((k) => sw[k].time >= t - TREND_SR_DAYS * DAY);
  const to = first((k) => sw[k].known > t);
  const key = `${from}:${to}:${width}`;
  let zones = s.zoneCache.get(key);
  if (!zones) {
    zones = srZones(sw.slice(from, Math.max(from, to)).map((x) => x.price), width);
    if (s.zoneCache.size > 5000) s.zoneCache.clear();
    s.zoneCache.set(key, zones);
  }
  return zones;
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
  /** the level the stop is set beyond: the far edge of the support/resistance zone behind the entry, or the high (sell) / low (buy) of the last two candles */
  swing: number;
  /** "zone" when the stop sits just beyond a support/resistance zone; "swing" when it sits just beyond the last two candles; "nearest" / "furthest" when that level was closer or further than the limits and the stop was set at the limit */
  stopBasis: "zone" | "swing" | "nearest" | "furthest";
  /** the zone the stop sits beyond, when it does */
  zone: SrZone | null;
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
  /** the support/resistance zones, nearest first: up to four above the price and four below */
  zones: SrZone[];
  /** the zone this candle closed through, if it did — no trade on such a candle */
  brokeZone: SrZone | null;
  /** the FRESH supply and demand zones at this candle's close, nearest to the price first (up to three of each) */
  sdZones: SdZone[];
  /** the fresh zone of the other side less than 1R ahead of the entry, which stops a trade */
  sdAhead: SdZone | null;
  /** the signal candle's length in ATR */
  candleAtr: number | null;
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
  // support and resistance: the zones, the one this candle closed through, and the nearest one behind the price
  const zones = zonesAt(s, i);
  const prevClose = i >= 1 ? s.candles[i - 1].close : NaN;
  const brokeZone =
    daily === 0
      ? null
      : (zones.find((z) => (dir === 1 ? prevClose <= z.high && c.close > z.high : prevClose >= z.low && c.close < z.low)) ?? null);

  let plan: { risk: number; swing: number; basis: TrendSetup["stopBasis"]; zone: SrZone | null } | null = null;
  if (trigger && atr > 0) {
    const price = entry ?? c.close;
    const swing = stopLevel;
    const raw = Number.isFinite(swing) ? dir * (price - (swing - dir * TREND_STOP_BUFFER_ATR * atr)) : NaN;
    // a level on the wrong side of the price (a gap) gives no stop, and so no trade
    if (raw > 0) {
      const risk = Math.min(Math.max(raw, TREND_MIN_RISK_ATR * atr), TREND_MAX_RISK_ATR * atr);
      const basis = raw < TREND_MIN_RISK_ATR * atr ? "nearest" : raw > TREND_MAX_RISK_ATR * atr ? "furthest" : "swing";
      if (tradeCost(pair) / risk <= TREND_MAX_COST_SHARE) plan = { risk, swing, basis, zone: null };
    }
    // a support (buy) / resistance (sell) zone behind the price: the stop goes just beyond its far edge, when that is within the limits
    if (plan) {
      let behind: SrZone | null = null;
      for (const z of zones) {
        const gap = dir * (price - (dir === 1 ? z.high : z.low));
        if (gap > 0 && (!behind || gap < dir * (price - (dir === 1 ? behind.high : behind.low)))) behind = z;
      }
      if (behind) {
        const edge = dir === 1 ? behind.high : behind.low;
        const risk = dir * (price - (edge - dir * TREND_STOP_BUFFER_ATR * atr));
        if (risk >= TREND_MIN_RISK_ATR * atr && risk <= TREND_MAX_RISK_ATR * atr && tradeCost(pair) / risk <= TREND_MAX_COST_SHARE) plan = { risk, swing: edge, basis: "zone", zone: behind };
      }
    }
  }

  // the signal candle's size, and the fresh supply/demand zones as they stood at its close
  const candleAtr = atr > 0 ? (c.high - c.low) / atr : NaN;
  const oversized = candleAtr >= TREND_MAX_CANDLE_ATR;
  const now = c.time + M15;
  const freshSd = s.sdZones.filter((z) => z.known <= now && now < z.expires && z.broken > now && z.touched > now);
  let sdAhead: SdZone | null = null;
  if (daily !== 0) {
    const price = entry ?? c.close;
    const risk = plan?.risk ?? NaN;
    for (const z of freshSd) {
      if (z.kind !== (dir === 1 ? "supply" : "demand")) continue;
      const inside = dir * (price - z.proximal) >= 0 && dir * (z.distal - price) >= 0;
      const ahead = dir * (z.proximal - price);
      if (inside || (ahead > 0 && risk > 0 && ahead <= TREND_SD_AHEAD_R * risk)) {
        if (!sdAhead || dir * (z.proximal - sdAhead.proximal) < 0) sdAhead = z;
      }
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
      label: brokeZone
        ? `This candle closed through the ${dir === 1 ? "resistance" : "support"} zone at ${brokeZone.low.toFixed(2)}–${brokeZone.high.toFixed(2)} — price usually comes back to test it`
        : `Not a candle that has just closed through a support/resistance zone`,
      met: brokeZone == null,
    },
    {
      label: oversized
        ? `This candle is ${candleAtr.toFixed(1)} ATR long — ${TREND_MAX_CANDLE_ATR} or more is not traded`
        : `Not an oversized candle (under ${TREND_MAX_CANDLE_ATR} ATR${Number.isFinite(candleAtr) ? `; this one ${candleAtr.toFixed(1)}` : ""})`,
      met: !oversized,
    },
    {
      label: sdAhead
        ? `A fresh 1-hour ${sdAhead.kind} zone at ${Math.min(sdAhead.proximal, sdAhead.distal).toFixed(2)}–${Math.max(sdAhead.proximal, sdAhead.distal).toFixed(2)} is less than ${TREND_SD_AHEAD_R}R ahead`
        : `No fresh 1-hour ${dir === 1 ? "supply" : "demand"} zone less than ${TREND_SD_AHEAD_R}R ahead`,
      met: sdAhead == null,
    },
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
  else if (trigger && brokeZone) blocked = `this candle closed through the ${dir === 1 ? "resistance" : "support"} zone at ${brokeZone.low.toFixed(2)}–${brokeZone.high.toFixed(2)} — no trade until price has tested it`;
  else if (trigger && oversized) blocked = `this candle is ${candleAtr.toFixed(1)} ATR long — no trade on a candle of ${TREND_MAX_CANDLE_ATR} ATR or more`;
  else if (trigger && plan && sdAhead) blocked = `a fresh 1-hour ${sdAhead.kind} zone (${Math.min(sdAhead.proximal, sdAhead.distal).toFixed(2)}–${Math.max(sdAhead.proximal, sdAhead.distal).toFixed(2)}) is less than ${TREND_SD_AHEAD_R}R ahead — no ${dir === 1 ? "buy into supply" : "sell into demand"}`;

  let setup: TrendSetup | null = null;
  if (!blocked && side && trigger && plan && !brokeZone && !oversized && !sdAhead) {
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
      zone: plan.zone,
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
    zones: [...zones.filter((z) => z.high < c.close).slice(-4), ...zones.filter((z) => z.low <= c.close && z.high >= c.close), ...zones.filter((z) => z.low > c.close).slice(0, 4)],
    brokeZone,
    sdZones: [...freshSd.filter((z) => z.kind === "demand").sort((x, y) => Math.abs(c.close - x.proximal) - Math.abs(c.close - y.proximal)).slice(0, 3), ...freshSd.filter((z) => z.kind === "supply").sort((x, y) => Math.abs(c.close - x.proximal) - Math.abs(c.close - y.proximal)).slice(0, 3)],
    sdAhead,
    candleAtr: finite(candleAtr),
    setup,
  };
}

/**
 * A signal found one or more candles late (the scan that should have sent it
 * did not run): the same trade entered at the latest close, with the original
 * stop and the target and the profit lock re-worked from the new price.
 * `since` are the candles closed after the signal candle. Null when there is
 * nothing left to take: the stop or the target has been reached, price is
 * beyond the stop, or the costs are more than the limit of what is left.
 * Over five years such entries made +0.11R a trade against +0.18R on time.
 */
export function lateEntry(setup: TrendSetup, since: Candle[], pair = "XAU_USD"): TrendSetup | null {
  const last = since[since.length - 1];
  if (!last) return null;
  const dir = setup.direction === "long" ? 1 : -1;
  const done = since.some((c) => (dir === 1 ? c.low <= setup.stopLoss || c.high >= setup.takeProfit : c.high >= setup.stopLoss || c.low <= setup.takeProfit));
  if (done) return null;
  const entry = last.close;
  const risk = dir * (entry - setup.stopLoss);
  if (!(risk > 0) || tradeCost(pair) / risk > TREND_MAX_COST_SHARE) return null;
  return {
    ...setup,
    entry,
    risk,
    takeProfit: entry + dir * TREND_TARGET_R * risk,
    lockTrigger: entry + dir * TREND_LOCK_AT_R * risk,
    lockStop: entry + dir * TREND_LOCK_TO_R * risk,
  };
}
