import type { Candle, SignalDirection } from "@/lib/types";

/**
 * Tori Trades' trendlines, as she teaches them (her X threads and her
 * TradeZella playbook), read on the 4-hour chart. They are shown on the chart
 * and sent as ALERTS — they are not signals of the system and do not open,
 * block or settle any trade.
 *
 *  - A down line runs from a swing high (point A) to a lower swing high
 *    (point B), an up line from a swing low to a higher swing low, and no
 *    candle crosses it between the two. It stays valid until a candle CLOSES
 *    through it. Every later swing that comes back to it is a touch.
 *  - BREAK (her main setup): a full-bodied 4-hour candle closes through a line
 *    with three or more touches and at least a week of data. A broken down
 *    line is a buy idea, a broken up line a sell idea. Her stop goes beyond
 *    the opposing trendline — the SAFETY LINE: for a buy, the up line from the
 *    lowest low to the latest higher low.
 *  - BOUNCE: the third touch of a line with two touches and a week of data,
 *    the candle closing back on the line's side; the stop goes just beyond the
 *    line.
 *
 * Backtested on five years of gold (4-hour): the break made 22 trades and
 * about +1R; the bounce, with the daily trend, did better on the 1-hour chart
 * but won fewer than one trade in four. Hence alerts, not signals.
 */

export const TORI_TIMEFRAME = "H4" as const;
export const TORI_SECONDS = 4 * 3600;
/** 4-hour candles a scan reads — about four months */
export const TORI_HISTORY = 500;
/** candles on each side of a swing high / low */
export const TORI_SWING = 3;
/** touches a line needs before its break is a setup, and before its next touch is a bounce */
export const TORI_BREAK_TOUCHES = 3;
export const TORI_BOUNCE_TOUCHES = 2;
/** "at least a week of data" from the first point to the break: a week of 4-hour candles */
export const TORI_MIN_SPAN_BARS = 42;
/** how close a swing has to come to a line to count as a touch, in ATR */
export const TORI_TOUCH_ATR = 0.25;
/** a full-bodied candle: its body is at least this share of its range */
export const TORI_BODY_MIN = 0.5;
/** the stop sits this far beyond the safety line, in ATR */
export const TORI_STOP_BUFFER_ATR = 0.2;
/** how many earlier swings a new swing is paired with to draw lines */
const MAX_PAIRS = 12;
/** lines shown on the chart, per direction */
const SHOWN_PER_KIND = 3;

export interface ToriPoint {
  index: number;
  time: number;
  price: number;
}

export interface ToriLine {
  kind: "down" | "up";
  a: ToriPoint;
  b: ToriPoint;
  /** price change per 4-hour candle */
  slope: number;
  touches: number;
  /** index of the last touch */
  lastTouch: number;
}

export interface ToriEvent {
  type: "break" | "bounce";
  direction: SignalDirection;
  line: ToriLine;
  /** the close of the 4-hour candle that made it, and when that candle closed (epoch seconds) */
  close: number;
  time: number;
  /** where her stop would go: beyond the safety line (break) or beyond the line itself (bounce) */
  stop: number | null;
  /** the safety line's price at that candle (break) */
  safety: number | null;
  /** one alert per event */
  key: string;
}

export interface ToriRead {
  /** the lines still valid at the last closed candle, the strongest first */
  lines: ToriLine[];
  /** the value of each line at a 4-hour candle index */
  valueAt: (line: ToriLine, index: number) => number;
  /** the safety line for a buy (an up line under price) and for a sell, at the last candle */
  safetyLong: number | null;
  safetyShort: number | null;
  /** what the last closed candle did, if it made a setup */
  event: ToriEvent | null;
  candles: Candle[];
}

function wilderAtr(c: Candle[], n = 14): Float64Array {
  const o = new Float64Array(c.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
    if (i >= n) o[i] = a;
  }
  return o;
}

const value = (l: ToriLine, i: number) => l.a.price + l.slope * (i - l.a.index);

/** Read the 4-hour candles (closed, oldest first): the valid lines, the safety lines and the last candle's setup. */
export function toriRead(c: Candle[]): ToriRead {
  const n = c.length;
  const atr = wilderAtr(c);
  const highs: ToriPoint[] = [];
  const lows: ToriPoint[] = [];
  const lines: ToriLine[] = [];
  let event: ToriEvent | null = null;

  const safety = (d: 1 | -1, i: number, look: number): number | null => {
    const src = d === 1 ? lows : highs;
    let ext: ToriPoint | null = null;
    for (const q of src) if (q.index >= i - look && q.index <= i - TORI_SWING && (!ext || (d === 1 ? q.price < ext.price : q.price > ext.price))) ext = q;
    const last = src[src.length - 1];
    if (!ext || !last || last.index <= ext.index || (d === 1 ? last.price <= ext.price : last.price >= ext.price)) return null;
    const slope = (last.price - ext.price) / (last.index - ext.index);
    for (let q = ext.index + 1; q < last.index; q++) {
      const v = ext.price + slope * (q - ext.index);
      if (d === 1 ? c[q].low < v - 1e-9 : c[q].high > v + 1e-9) return null;
    }
    return ext.price + slope * (i - ext.index);
  };

  for (let i = TORI_SWING * 2; i < n; i++) {
    const tol = TORI_TOUCH_ATR * atr[i - 1];
    // a swing is known TORI_SWING candles after it
    const p = i - TORI_SWING;
    let isHigh = true;
    let isLow = true;
    for (let q = p - TORI_SWING; q <= p + TORI_SWING; q++) {
      if (q === p) continue;
      if (c[q].high >= c[p].high) isHigh = false;
      if (c[q].low <= c[p].low) isLow = false;
    }
    for (const [is, src, kind] of [
      [isHigh, highs, "down"],
      [isLow, lows, "up"],
    ] as const) {
      if (!is) continue;
      const B: ToriPoint = { index: p, time: c[p].time, price: kind === "down" ? c[p].high : c[p].low };
      for (const l of lines) {
        if (l.kind === kind && p > l.b.index && p - l.lastTouch >= TORI_SWING && Math.abs(B.price - value(l, p)) <= tol) {
          l.touches++;
          l.lastTouch = p;
        }
      }
      for (let j = src.length - 1, m = 0; j >= 0 && m < MAX_PAIRS; j--, m++) {
        const A = src[j];
        if (kind === "down" ? A.price <= B.price : A.price >= B.price) continue;
        const slope = (B.price - A.price) / (B.index - A.index);
        let ok = true;
        for (let q = A.index + 1; q < B.index && ok; q++) {
          const v = A.price + slope * (q - A.index);
          if (kind === "down" ? c[q].high > v + 1e-9 : c[q].low < v - 1e-9) ok = false;
        }
        for (let q = B.index + 1; q <= i && ok; q++) {
          const v = A.price + slope * (q - A.index);
          if (kind === "down" ? c[q].close > v : c[q].close < v) ok = false;
        }
        if (ok) lines.push({ kind, a: A, b: B, slope, touches: 2, lastTouch: B.index });
      }
      src.push(B);
    }

    // what candle i did to the lines
    const b = c[i];
    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);
    const last = i === n - 1;
    for (let k = lines.length - 1; k >= 0; k--) {
      const l = lines[k];
      const v = value(l, i);
      if (l.kind === "down" ? b.close > v : b.close < v) {
        lines.splice(k, 1);
        if (!last || l.touches < TORI_BREAK_TOUCHES || i - l.a.index < TORI_MIN_SPAN_BARS) continue;
        if (!(range > 0) || body < TORI_BODY_MIN * range || (l.kind === "down" ? b.close < b.open : b.close > b.open)) continue;
        const d: 1 | -1 = l.kind === "down" ? 1 : -1;
        const s = safety(d, i, Math.max(i - l.a.index, TORI_SWING * 4));
        const candidate: ToriEvent = {
          type: "break",
          direction: d === 1 ? "long" : "short",
          line: l,
          close: b.close,
          time: b.time + TORI_SECONDS,
          safety: s,
          stop: s == null ? null : s - d * TORI_STOP_BUFFER_ATR * atr[i],
          key: `tori:break:${l.kind}:${l.a.time}:${b.time}`,
        };
        if (!event || event.type !== "break" || l.touches > event.line.touches) event = candidate;
      } else if (last && !event && l.touches >= TORI_BOUNCE_TOUCHES && i - l.a.index >= TORI_MIN_SPAN_BARS && i - l.lastTouch > TORI_SWING) {
        // the next touch, closing back on the line's side in the trend's direction
        const d: 1 | -1 = l.kind === "up" ? 1 : -1;
        const touched = d === 1 ? b.low <= v + tol : b.high >= v - tol;
        if (!touched || (d === 1 ? b.close <= b.open : b.close >= b.open)) continue;
        event = {
          type: "bounce",
          direction: d === 1 ? "long" : "short",
          line: l,
          close: b.close,
          time: b.time + TORI_SECONDS,
          safety: v,
          stop: v - d * TORI_STOP_BUFFER_ATR * atr[i],
          key: `tori:bounce:${l.kind}:${l.a.time}:${b.time}`,
        };
      }
    }
    if (i % 100 === 0) for (let k = lines.length - 1; k >= 0; k--) if (i - lines[k].a.index > 1000) lines.splice(k, 1);
  }

  // the lines worth drawing: a week of data or more, the most touches first, then the most recent
  const strongest = (kind: "down" | "up") =>
    lines
      .filter((l) => l.kind === kind && n - 1 - l.a.index >= TORI_MIN_SPAN_BARS)
      .sort((x, y) => y.touches - x.touches || y.lastTouch - x.lastTouch)
      // one line per starting point
      .filter((l, k, all) => all.findIndex((o) => o.a.index === l.a.index) === k)
      .slice(0, SHOWN_PER_KIND);
  return {
    lines: [...strongest("down"), ...strongest("up")],
    valueAt: value,
    safetyLong: n > 0 ? safety(1, n - 1, 60) : null,
    safetyShort: n > 0 ? safety(-1, n - 1, 60) : null,
    event,
    candles: c,
  };
}

/** A line as the chart draws it: its price at each 4-hour candle from `fromTime` on, and at `endTime` (the last 15-minute candle). */
export interface ToriChartLine {
  kind: "down" | "up";
  touches: number;
  /** the price of the line now */
  now: number;
  points: { time: number; price: number }[];
}

export function toriChartLines(read: ToriRead, fromTime: number, endTime: number): ToriChartLine[] {
  const c = read.candles;
  const n = c.length;
  if (n === 0) return [];
  return read.lines.map((l) => {
    const points: { time: number; price: number }[] = [];
    for (let i = Math.max(l.a.index, 0); i < n; i++) if (c[i].time >= fromTime) points.push({ time: c[i].time, price: read.valueAt(l, i) });
    // carried on to the last 15-minute candle, in 4-hour candles
    const extra = (endTime - c[n - 1].time) / TORI_SECONDS;
    const now = read.valueAt(l, n - 1 + Math.max(0, extra));
    if (endTime > c[n - 1].time) points.push({ time: endTime, price: now });
    return { kind: l.kind, touches: l.touches, now, points };
  });
}
