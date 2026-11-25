import type { Candle, SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * Trendlines, read the way Tori Trades teaches them (her X threads and her
 * TradeZella playbook), on any chart.
 *
 *  - A down line runs from a swing high (point A) to a lower swing high
 *    (point B), an up line from a swing low to a higher swing low, and no
 *    candle crosses it between the two. It stays valid until a candle CLOSES
 *    through it. Every later swing that comes back to it is a touch.
 *  - BREAK: a full-bodied candle closes through a line with enough touches and
 *    enough history. A broken down line is a buy idea, a broken up line a sell
 *    idea. The stop goes beyond the opposing trendline — the SAFETY LINE: for
 *    a buy, the up line from the lowest low to the latest higher low.
 *  - BOUNCE: a later candle comes back to a line with enough touches and
 *    history and closes away from it, in the line's direction; the stop goes
 *    just beyond the line.
 *
 * Every candle is read with what was known when it closed: a swing counts
 * `swing` candles after it formed, never before.
 */

export interface TrendlineOptions {
  /** length of one candle, in seconds */
  seconds: number;
  /** candles on each side of a swing high / low */
  swing: number;
  /** touches a line needs before its break is a setup, and before its next touch is a bounce */
  breakTouches: number;
  bounceTouches: number;
  /** candles from point A to the setup: "at least a week of data" on her 4-hour chart */
  minSpanBars: number;
  /** how close a swing or a candle has to come to a line to count as a touch, in ATR */
  touchAtr: number;
  /** a full-bodied candle: its body is at least this share of its range */
  bodyMin: number;
  /** the stop sits this far beyond the safety line or the line, in ATR */
  stopBufferAtr: number;
  /** a line is dropped this many candles after its point A */
  maxAgeBars: number;
  /** the start of every event key */
  keyPrefix: string;
}

/** how many earlier swings a new swing is paired with to draw lines */
const MAX_PAIRS = 12;

export interface LinePoint {
  index: number;
  time: number;
  price: number;
}

export interface Trendline {
  kind: "down" | "up";
  a: LinePoint;
  b: LinePoint;
  /** price change per candle */
  slope: number;
  touches: number;
  /** index of the last touch */
  lastTouch: number;
  /** index of the last candle that bounced off it */
  lastBounce: number;
}

export interface TrendlineEvent {
  type: "break" | "bounce";
  direction: SignalDirection;
  line: Trendline;
  /** index of the candle that made it, its close, and when it closed (epoch seconds) */
  index: number;
  close: number;
  time: number;
  /** where the stop goes: beyond the safety line (break) or beyond the line itself (bounce) */
  stop: number | null;
  /** the safety line's price at that candle (break), the line's price (bounce) */
  safety: number | null;
  /** the average true range at that candle */
  atr: number;
  /** one alert, one trade per event */
  key: string;
}

export interface TrendlineRead {
  /** the lines still valid at the last closed candle */
  lines: Trendline[];
  /** the value of a line at a candle index */
  valueAt: (line: Trendline, index: number) => number;
  /** the safety line for a buy (an up line under price) and for a sell, at the last candle */
  safetyLong: number | null;
  safetyShort: number | null;
  /** the setups, at most one a candle, oldest first — from `from` on */
  events: TrendlineEvent[];
  candles: Candle[];
}

export function wilderAtr(c: Candle[], n = 14): Float64Array {
  const o = new Float64Array(c.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
    if (i >= n) o[i] = a;
  }
  return o;
}

const value = (l: Trendline, i: number) => l.a.price + l.slope * (i - l.a.index);

/**
 * Read closed candles (oldest first): the lines valid at the end, and the
 * setup each candle from index `from` on made (by default only the last one).
 */
export function readTrendlines(c: Candle[], o: TrendlineOptions, from: number = c.length - 1): TrendlineRead {
  const n = c.length;
  const atr = wilderAtr(c);
  const highs: LinePoint[] = [];
  const lows: LinePoint[] = [];
  const lines: Trendline[] = [];
  const events: TrendlineEvent[] = [];
  const k = o.swing;

  const safety = (d: 1 | -1, i: number, look: number): number | null => {
    const src = d === 1 ? lows : highs;
    let ext: LinePoint | null = null;
    for (let j = src.length - 1; j >= 0 && src[j].index >= i - look; j--) {
      const q = src[j];
      if (q.index <= i - k && (!ext || (d === 1 ? q.price <= ext.price : q.price >= ext.price))) ext = q;
    }
    const last = src[src.length - 1];
    if (!ext || !last || last.index <= ext.index || (d === 1 ? last.price <= ext.price : last.price >= ext.price)) return null;
    const slope = (last.price - ext.price) / (last.index - ext.index);
    for (let q = ext.index + 1; q < last.index; q++) {
      const v = ext.price + slope * (q - ext.index);
      if (d === 1 ? c[q].low < v - 1e-9 : c[q].high > v + 1e-9) return null;
    }
    return ext.price + slope * (i - ext.index);
  };

  for (let i = k * 2; i < n; i++) {
    const tol = o.touchAtr * atr[i - 1];
    // a swing is known `swing` candles after it
    const p = i - k;
    let isHigh = true;
    let isLow = true;
    for (let q = p - k; q <= p + k; q++) {
      if (q === p) continue;
      if (c[q].high >= c[p].high) isHigh = false;
      if (c[q].low <= c[p].low) isLow = false;
    }
    for (const [is, src, kind] of [
      [isHigh, highs, "down"],
      [isLow, lows, "up"],
    ] as const) {
      if (!is) continue;
      const B: LinePoint = { index: p, time: c[p].time, price: kind === "down" ? c[p].high : c[p].low };
      for (const l of lines) {
        if (l.kind === kind && p > l.b.index && p - l.lastTouch >= k && Math.abs(B.price - value(l, p)) <= tol) {
          l.touches++;
          l.lastTouch = p;
        }
      }
      for (let j = src.length - 1, m = 0; j >= 0 && m < MAX_PAIRS; j--, m++) {
        const A = src[j];
        if (i - A.index > o.maxAgeBars) break;
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
        if (ok) lines.push({ kind, a: A, b: B, slope, touches: 2, lastTouch: B.index, lastBounce: -1 });
      }
      src.push(B);
    }

    // what candle i did to the lines
    const b = c[i];
    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);
    const wanted = i >= from;
    let event: TrendlineEvent | null = null;
    for (let x = lines.length - 1; x >= 0; x--) {
      const l = lines[x];
      if (i - l.a.index > o.maxAgeBars) {
        lines.splice(x, 1);
        continue;
      }
      const v = value(l, i);
      if (l.kind === "down" ? b.close > v : b.close < v) {
        lines.splice(x, 1);
        if (!wanted || l.touches < o.breakTouches || i - l.a.index < o.minSpanBars) continue;
        if (!(range > 0) || body < o.bodyMin * range || (l.kind === "down" ? b.close < b.open : b.close > b.open)) continue;
        if (event && event.type === "break" && l.touches <= event.line.touches) continue;
        const d: 1 | -1 = l.kind === "down" ? 1 : -1;
        const s = safety(d, i, Math.max(i - l.a.index, k * 4));
        event = {
          type: "break",
          direction: d === 1 ? "long" : "short",
          line: l,
          index: i,
          close: b.close,
          time: b.time + o.seconds,
          safety: s,
          stop: s == null ? null : s - d * o.stopBufferAtr * atr[i],
          atr: atr[i],
          key: `${o.keyPrefix}:break:${l.kind}:${l.a.time}:${b.time}`,
        };
      } else if (l.touches >= o.bounceTouches && i - l.a.index >= o.minSpanBars && i - l.lastTouch > k && i - l.lastBounce > k) {
        // the next touch, closing back on the line's side in the trend's direction
        const d: 1 | -1 = l.kind === "up" ? 1 : -1;
        const touched = d === 1 ? b.low <= v + tol : b.high >= v - tol;
        if (!touched || (d === 1 ? b.close <= b.open : b.close >= b.open)) continue;
        l.lastBounce = i;
        if (!wanted || event) continue;
        event = {
          type: "bounce",
          direction: d === 1 ? "long" : "short",
          line: l,
          index: i,
          close: b.close,
          time: b.time + o.seconds,
          safety: v,
          stop: v - d * o.stopBufferAtr * atr[i],
          atr: atr[i],
          key: `${o.keyPrefix}:bounce:${l.kind}:${l.a.time}:${b.time}`,
        };
      }
    }
    if (event) events.push(event);
  }

  return {
    lines,
    valueAt: value,
    safetyLong: n > 0 ? safety(1, n - 1, 60) : null,
    safetyShort: n > 0 ? safety(-1, n - 1, 60) : null,
    events,
    candles: c,
  };
}

/* ───────────────────────── the trendline strategy ─────────────────────────
 *
 * Her lines, read on the 1-hour chart and traded WITH the daily trend:
 *  - BOUNCE: in an uptrend, a 1-hour candle comes back to a rising line and
 *    closes up, away from it — buy; the stop goes just beyond the line.
 *  - BREAK: in an uptrend, a full-bodied 1-hour candle closes up through a
 *    falling line with three or more touches (the pullback is over) — buy; the
 *    stop goes beyond the safety line, or beyond the break candle when no
 *    safety line can be drawn.
 * (Mirrored for sells.) The stop is never closer than half an ATR; a setup
 * whose stop would be more than three ATRs away is left alone. The target is
 * three times the risk. Nothing is moved: the trade ends at its stop, at its
 * target, or at market after five trading days.
 */
export const TL_TIMEFRAME = "H1" as const;
export const TL_SECONDS = 3600;
/** 1-hour candles a scan reads: the lines live for 1000 candles, plus the warm-up */
export const TL_HISTORY = 1300;
export const TL_OPTIONS: TrendlineOptions = {
  seconds: TL_SECONDS,
  swing: 3,
  breakTouches: 3,
  bounceTouches: 2,
  /** "at least a week of data": a week of 1-hour candles */
  minSpanBars: 120,
  touchAtr: 0.25,
  bodyMin: 0.5,
  stopBufferAtr: 0.2,
  maxAgeBars: 1000,
  keyPrefix: "tl",
};
/** the daily trend: the last closed day's close against its 50-day average */
export const TL_TREND_DAYS = 50;
export const TL_MIN_RISK_ATR = 0.5;
export const TL_MAX_RISK_ATR = 3;
export const TL_TARGET_R = 3;
/** no trade when the spread and slippage are more than this share of the risk */
export const TL_MAX_COST_SHARE = 0.1;
/** 15-minute candles after which an undecided trade is closed at market: five trading days */
export const TL_MAX_HOLD_BARS = 480;

const isWeekend = (c: Candle) => [5, 6].includes(new Date(c.time * 1000).getUTCDay());

/** The daily trend as it stood at `time` (epoch seconds): 1 up, −1 down, 0 unknown. Only days that had closed by then count. */
export function tlDailyTrend(daily: Candle[], time: number): 1 | -1 | 0 {
  const days = daily.filter((d) => !isWeekend(d) && d.time + 86_400 <= time);
  if (days.length < TL_TREND_DAYS) return 0;
  let sum = 0;
  for (let k = days.length - TL_TREND_DAYS; k < days.length; k++) sum += days[k].close;
  const avg = sum / TL_TREND_DAYS;
  const close = days[days.length - 1].close;
  return close > avg ? 1 : close < avg ? -1 : 0;
}

export interface TlSetup {
  type: "break" | "bounce";
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  /** where the stop comes from */
  stopBasis: "safety line" | "line" | "signal candle" | "minimum";
  /** the line: its direction, its touches and its price at the signal candle */
  line: { kind: "down" | "up"; touches: number; value: number };
  /** when the signal candle closed (epoch seconds) */
  time: number;
  atr: number;
  key: string;
}

/**
 * The trade a trendline setup gives, or why it gives none. `candle` is the
 * 1-hour candle that made the setup, `dailyTrend` the daily trend when it
 * closed, `entry` the price the trade is entered at (its close, or the next
 * open in the backtest).
 */
export function tlSetup(ev: TrendlineEvent, candle: Candle, dailyTrend: number, entry: number = ev.close, pair = "XAU_USD"): { setup: TlSetup | null; reason: string | null } {
  const dir = ev.direction === "long" ? 1 : -1;
  if (dailyTrend !== dir) return { setup: null, reason: `a ${ev.direction === "long" ? "buy" : "sell"} against the daily trend` };
  if (!Number.isFinite(ev.atr) || !(ev.atr > 0)) return { setup: null, reason: "not enough candles" };
  let stop = ev.stop;
  let basis: TlSetup["stopBasis"] = ev.type === "break" ? "safety line" : "line";
  if (stop == null) {
    stop = dir === 1 ? candle.low - TL_OPTIONS.stopBufferAtr * ev.atr : candle.high + TL_OPTIONS.stopBufferAtr * ev.atr;
    basis = "signal candle";
  }
  let risk = dir * (entry - stop);
  if (risk < TL_MIN_RISK_ATR * ev.atr) {
    risk = TL_MIN_RISK_ATR * ev.atr;
    stop = entry - dir * risk;
    basis = "minimum";
  }
  if (risk > TL_MAX_RISK_ATR * ev.atr) return { setup: null, reason: `the stop would be ${(risk / ev.atr).toFixed(1)} ATR away (limit ${TL_MAX_RISK_ATR})` };
  if (tradeCost(pair) > TL_MAX_COST_SHARE * risk) return { setup: null, reason: "the costs are too large a share of the risk" };
  const value = ev.line.a.price + ev.line.slope * (ev.index - ev.line.a.index);
  return {
    setup: {
      type: ev.type,
      direction: ev.direction,
      entry,
      stopLoss: stop,
      takeProfit: entry + dir * TL_TARGET_R * risk,
      risk,
      stopBasis: basis,
      line: { kind: ev.line.kind, touches: ev.line.touches, value },
      time: ev.time,
      atr: ev.atr,
      key: ev.key,
    },
    reason: null,
  };
}

/** A line as the chart draws it: its price at each candle it was read on from `fromTime` on, and at `endTime` (the last candle shown). */
export interface ChartLine {
  kind: "down" | "up";
  touches: number;
  /** the price of the line now */
  now: number;
  points: { time: number; price: number }[];
}

/** The lines worth drawing: old enough to be traded, the most touches first, then the most recent — one per starting point, `perKind` of each direction. */
export function shownLines(read: TrendlineRead, o: TrendlineOptions, perKind = 3): Trendline[] {
  const n = read.candles.length;
  const strongest = (kind: "down" | "up") =>
    read.lines
      .filter((l) => l.kind === kind && n - 1 - l.a.index >= o.minSpanBars)
      .sort((x, y) => y.touches - x.touches || y.lastTouch - x.lastTouch)
      .filter((l, k, all) => all.findIndex((q) => q.a.index === l.a.index) === k)
      .slice(0, perKind);
  return [...strongest("down"), ...strongest("up")];
}

export function chartLines(read: TrendlineRead, lines: Trendline[], o: TrendlineOptions, fromTime: number, endTime: number): ChartLine[] {
  const c = read.candles;
  const n = c.length;
  if (n === 0) return [];
  return lines.map((l) => {
    const points: { time: number; price: number }[] = [];
    for (let i = Math.max(l.a.index, 0); i < n; i++) if (c[i].time >= fromTime) points.push({ time: c[i].time, price: read.valueAt(l, i) });
    // carried on to the last candle shown
    const extra = (endTime - c[n - 1].time) / o.seconds;
    const now = read.valueAt(l, n - 1 + Math.max(0, extra));
    if (endTime > c[n - 1].time) points.push({ time: endTime, price: now });
    return { kind: l.kind, touches: l.touches, now, points };
  });
}
