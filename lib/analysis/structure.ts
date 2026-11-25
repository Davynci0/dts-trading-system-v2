import type { Candle } from "@/lib/types";

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
 * Swing points ("structure points") and the structure they make. A swing high
 * is a high with `k` lower highs on each side, so it is only known `k` candles
 * later. Structure changes only when a candle CLOSES beyond the last swing
 * that has not been broken yet — a wick through it changes nothing. Until
 * then the market keeps the direction it had.
 */
export function readStructure(candles: Candle[], k: number): Structure {
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

/** A confirmed swing point of a timeframe. */
export interface SwingPoint {
  /** open time of the candle that made it (epoch seconds) */
  time: number;
  /** when it became known: the close of the `k`-th candle after it */
  knownAt: number;
  price: number;
  kind: "high" | "low";
}

/** Every swing high and swing low of a series, with the moment each became known. `seconds` is the candle length. */
export function swingPoints(candles: Candle[], k: number, seconds: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let p = k; p + k < candles.length; p++) {
    let isHigh = true;
    let isLow = true;
    for (let q = p - k; q <= p + k; q++) {
      if (q === p) continue;
      if (candles[q].high >= candles[p].high) isHigh = false;
      if (candles[q].low <= candles[p].low) isLow = false;
    }
    const knownAt = candles[p + k].time + seconds;
    if (isHigh) out.push({ time: candles[p].time, knownAt, price: candles[p].high, kind: "high" });
    if (isLow) out.push({ time: candles[p].time, knownAt, price: candles[p].low, kind: "low" });
  }
  return out;
}

/** Wilder's ATR, 14 periods. */
export function wilderAtr(candles: Candle[]): Float64Array {
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
