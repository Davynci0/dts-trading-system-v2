import type { Candle, SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * The trend system: eleven ways of joining a gold trend on the chart timeframe,
 * all managed the same way.
 *
 *  - A trade is only taken WITH the daily trend, and only when the 50-day and
 *    the 100-day trend agree (the last closed daily close is on the same side
 *    of both averages).
 *  - It is not taken when the move is already stretched: the chart's ADX must be
 *    below TREND_ADX_MAX.
 *  - There is no target. The stop starts TREND_STOP_ATR × ATR from the entry
 *    and then trails TREND_TRAIL_ATR × that same ATR behind the best price —
 *    a fixed distance, so the broker's own trailing stop can run it.
 *  - Each entry type holds at most one position; different types may be open
 *    side by side.
 *
 * Why these rules: on fifteen years of gold, fixed targets earned nothing in
 * the ten years the rules were chosen on, while every trend entry became
 * positive once the exit was a trailing stop. Trades against the 100-day trend
 * and trades that joined a stretched move were the two consistent losers, in
 * the design years and afterwards — hence the two filters.
 *
 * Everything here is pure and shared by the scanner, the backtest and the
 * chart. `candles` are closed bars of the chart timeframe, `daily` closed daily bars.
 */

export const TREND_STOP_ATR = 3;
export const TREND_TRAIL_ATR = 3;
export const TREND_ADX_MAX = 27;
export const TREND_FAST_DAYS = 50;
export const TREND_SLOW_DAYS = 100;
/** A position still open after this many candles is closed at market. */
export const TREND_MAX_HOLD_BARS = 360;
/** A trade is refused when spread + slippage exceed this share of its risk. */
const MAX_COST_SHARE = 0.1;

export type TrendFamily = "channel" | "pullback" | "cross" | "daybreak" | "momentum" | "inside";
export interface TrendEntryDef {
  id: string;
  family: TrendFamily;
  /** short name for signals and the tracker */
  label: string;
  /** what has to happen, in plain words */
  rule: string;
  /** channel length in candles, or EMA period */
  period?: number;
}

export const TREND_ENTRIES: TrendEntryDef[] = [
  { id: "don20", family: "channel", period: 20, label: "20-candle breakout", rule: "close beyond the high/low of the last 20 candles" },
  { id: "don30", family: "channel", period: 30, label: "30-candle breakout", rule: "close beyond the high/low of the last 30 candles" },
  { id: "don60", family: "channel", period: 60, label: "60-candle breakout", rule: "close beyond the high/low of the last 60 candles" },
  { id: "don120", family: "channel", period: 120, label: "120-candle breakout", rule: "close beyond the high/low of the last 120 candles" },
  { id: "don240", family: "channel", period: 240, label: "240-candle breakout", rule: "close beyond the high/low of the last 240 candles" },
  { id: "ema20pb", family: "pullback", period: 20, label: "Pullback to the 20 EMA", rule: "dip to the 20 EMA and close back beyond it, in the candle's own direction" },
  { id: "ema50pb", family: "pullback", period: 50, label: "Pullback to the 50 EMA", rule: "dip to the 50 EMA and close back beyond it, in the candle's own direction" },
  { id: "emax2050", family: "cross", label: "20/50 EMA cross", rule: "the 20 EMA crosses the 50 EMA" },
  { id: "prevday", family: "daybreak", label: "Previous-day break", rule: "close beyond yesterday's high/low" },
  { id: "impulse1", family: "momentum", label: "Momentum candle", rule: "a candle that closes more than 1 ATR beyond the previous close" },
  { id: "inside", family: "inside", label: "Inside-bar breakout", rule: "close beyond the candle that contained an inside bar" },
];
export const trendEntryDef = (id: string) => TREND_ENTRIES.find((e) => e.id === id);

// ───────────── indicators on plain number arrays ─────────────

function sma(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

function ema(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 0; i < v.length; i++) {
    e = i === 0 ? v[0] : v[i] * k + e * (1 - k);
    if (i >= p - 1) out[i] = e;
  }
  return out;
}

/** Wilder's ATR. */
function atrOf(h: number[], l: number[], c: number[], p = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= p) {
      a += tr / p;
      if (i === p) out[i] = a;
    } else {
      a = (a * (p - 1) + tr) / p;
      out[i] = a;
    }
  }
  return out;
}

/** Wilder's ADX. */
function adxOf(h: number[], l: number[], c: number[], p = 14): number[] {
  const n = c.length;
  const out = new Array<number>(n).fill(NaN);
  let tr = 0;
  let pdm = 0;
  let ndm = 0;
  let ax = 0;
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    const pd = up > dn && up > 0 ? up : 0;
    const nd = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= p) {
      tr += t;
      pdm += pd;
      ndm += nd;
    } else {
      tr = tr - tr / p + t;
      pdm = pdm - pdm / p + pd;
      ndm = ndm - ndm / p + nd;
    }
    if (i >= p) {
      const pdi = (100 * pdm) / tr;
      const ndi = (100 * ndm) / tr;
      const dx = pdi + ndi === 0 ? 0 : (100 * Math.abs(pdi - ndi)) / (pdi + ndi);
      ax = i < 2 * p ? ax + dx / p : (ax * (p - 1) + dx) / p;
      if (i >= 2 * p - 1) out[i] = ax;
    }
  }
  return out;
}

/** Highest value of the PRIOR `p` bars (bar i itself excluded). */
function priorHighest(v: number[], p: number): number[] {
  return v.map((_, i) => {
    if (i < p) return NaN;
    let m = -Infinity;
    for (let k = i - p; k < i; k++) m = Math.max(m, v[k]);
    return m;
  });
}
function priorLowest(v: number[], p: number): number[] {
  return v.map((_, i) => {
    if (i < p) return NaN;
    let m = Infinity;
    for (let k = i - p; k < i; k++) m = Math.min(m, v[k]);
    return m;
  });
}

// ───────────── the series every rule reads ─────────────

export interface TrendSeries {
  n: number;
  /** length of one candle in seconds (read from the candles) */
  bar: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  atr: number[];
  adx: number[];
  ema20: number[];
  ema50: number[];
  hi: Record<number, number[]>;
  lo: Record<number, number[]>;
  /** +1 / −1 when the last closed daily close is above / below the average, 0 when unknown */
  fast: number[];
  slow: number[];
  /** index of the last daily bar that had CLOSED when candle i closed (−1 if none) */
  day: number[];
  dayHigh: number[];
  dayLow: number[];
}

const DAY_SECONDS = 86400;

/** The candles' own bar length: the median spacing (ignores weekend gaps). 4 hours when it cannot be read. */
function barSeconds(candles: Candle[]): number {
  const diffs: number[] = [];
  for (let i = Math.max(1, candles.length - 120); i < candles.length; i++) diffs.push(candles[i].time - candles[i - 1].time);
  if (diffs.length === 0) return 4 * 3600;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

export function buildTrendSeries(candles: Candle[], daily: Candle[]): TrendSeries {
  const t = candles.map((x) => x.time);
  const o = candles.map((x) => x.open);
  const h = candles.map((x) => x.high);
  const l = candles.map((x) => x.low);
  const c = candles.map((x) => x.close);
  const dc = daily.map((x) => x.close);
  const s50 = sma(dc, TREND_FAST_DAYS);
  const s100 = sma(dc, TREND_SLOW_DAYS);
  const sign = (k: number, avg: number[], p: number) => (k < p || !Number.isFinite(avg[k]) ? 0 : dc[k] > avg[k] ? 1 : dc[k] < avg[k] ? -1 : 0);

  const bar = barSeconds(candles);
  const day = new Array<number>(candles.length).fill(-1);
  let k = 0;
  for (let i = 0; i < candles.length; i++) {
    const close = t[i] + bar;
    while (k < daily.length && daily[k].time + DAY_SECONDS <= close) k++;
    day[i] = k - 1;
  }

  const hi: Record<number, number[]> = {};
  const lo: Record<number, number[]> = {};
  for (const e of TREND_ENTRIES) {
    if (e.family !== "channel" || !e.period) continue;
    hi[e.period] = priorHighest(h, e.period);
    lo[e.period] = priorLowest(l, e.period);
  }

  return {
    n: candles.length,
    bar,
    t,
    o,
    h,
    l,
    c,
    atr: atrOf(h, l, c),
    adx: adxOf(h, l, c),
    ema20: ema(c, 20),
    ema50: ema(c, 50),
    hi,
    lo,
    fast: day.map((d) => (d < 0 ? 0 : sign(d, s50, TREND_FAST_DAYS))),
    slow: day.map((d) => (d < 0 ? 0 : sign(d, s100, TREND_SLOW_DAYS))),
    day,
    dayHigh: day.map((d) => (d < 0 ? NaN : daily[d].high)),
    dayLow: day.map((d) => (d < 0 ? NaN : daily[d].low)),
  };
}

// ───────────── the rules ─────────────

export interface TrendState {
  /** 50-day and 100-day trend: +1 up, −1 down, 0 unknown */
  fast: number;
  slow: number;
  adx: number;
  /** the side that may be traded on this candle, or null */
  side: SignalDirection | null;
  /** why nothing may be traded, when side is null */
  blocked: string | null;
}

/** What the filters allow when candle `i` closes. */
export function trendStateAt(s: TrendSeries, i: number): TrendState {
  const fast = s.fast[i];
  const slow = s.slow[i];
  const adx = s.adx[i];
  let blocked: string | null = null;
  if (fast === 0 || slow === 0) blocked = "not enough daily history for the trend";
  else if (fast !== slow) blocked = `the ${TREND_FAST_DAYS}-day and ${TREND_SLOW_DAYS}-day trends disagree`;
  else if (!(adx < TREND_ADX_MAX)) blocked = `the move is stretched (ADX ${Number.isFinite(adx) ? adx.toFixed(0) : "?"}, limit ${TREND_ADX_MAX})`;
  return { fast, slow, adx, side: blocked ? null : fast === 1 ? "long" : "short", blocked };
}

/** Does entry `id` trigger on bar `i` in direction `dir` (+1 / −1)? The filters are NOT applied here. */
export function entryTriggers(s: TrendSeries, id: string, i: number, dir: 1 | -1): boolean {
  const def = trendEntryDef(id);
  if (!def || i < 2) return false;
  const { c, o, h, l } = s;
  switch (def.family) {
    case "channel": {
      const p = def.period!;
      if (i < p + 1) return false;
      return dir === 1 ? c[i] > s.hi[p][i] && c[i - 1] <= s.hi[p][i - 1] : c[i] < s.lo[p][i] && c[i - 1] >= s.lo[p][i - 1];
    }
    case "pullback": {
      const e = def.period === 20 ? s.ema20 : s.ema50;
      if (!Number.isFinite(e[i - 1])) return false;
      return dir === 1
        ? l[i] <= e[i] && c[i] > e[i] && c[i] > o[i] && c[i - 1] > e[i - 1]
        : h[i] >= e[i] && c[i] < e[i] && c[i] < o[i] && c[i - 1] < e[i - 1];
    }
    case "cross": {
      const a = s.ema20;
      const b = s.ema50;
      if (!Number.isFinite(b[i - 1])) return false;
      return dir === 1 ? a[i] > b[i] && a[i - 1] <= b[i - 1] : a[i] < b[i] && a[i - 1] >= b[i - 1];
    }
    case "daybreak": {
      // yesterday's range must already have been known when the previous candle closed
      const d = s.day[i];
      if (d < 1 || s.day[i - 1] !== d) return false;
      return dir === 1 ? c[i] > s.dayHigh[i] && c[i - 1] <= s.dayHigh[i] : c[i] < s.dayLow[i] && c[i - 1] >= s.dayLow[i];
    }
    case "momentum": {
      const a = s.atr[i - 1];
      if (!Number.isFinite(a)) return false;
      return dir === 1 ? c[i] - c[i - 1] > a : c[i - 1] - c[i] > a;
    }
    case "inside": {
      const insideBar = h[i - 1] <= h[i - 2] && l[i - 1] >= l[i - 2];
      if (!insideBar) return false;
      return dir === 1 ? c[i] > h[i - 2] : c[i] < l[i - 2];
    }
  }
}

export interface TrendSetup {
  id: string;
  label: string;
  direction: SignalDirection;
  /** open time of the signal candle */
  time: number;
  /** the candle's close — the signal price */
  price: number;
  atr: number;
  /** initial stop distance and the trailing distance, in price */
  stopDistance: number;
  trailDistance: number;
}

/** Every entry that fires when candle `i` closes, after the filters and the cost cap. */
export function trendSetupsAt(s: TrendSeries, i: number, instrument = "XAU_USD"): TrendSetup[] {
  const state = trendStateAt(s, i);
  if (!state.side) return [];
  const a = s.atr[i];
  if (!(a > 0)) return [];
  const stopDistance = TREND_STOP_ATR * a;
  if (tradeCost(instrument) / stopDistance > MAX_COST_SHARE) return [];
  const dir = state.side === "long" ? 1 : -1;
  return TREND_ENTRIES.filter((e) => entryTriggers(s, e.id, i, dir)).map((e) => ({
    id: e.id,
    label: e.label,
    direction: state.side!,
    time: s.t[i],
    price: s.c[i],
    atr: a,
    stopDistance,
    trailDistance: TREND_TRAIL_ATR * a,
  }));
}

/** What each entry is waiting for on the trend's side, for the chart and the tracker. */
export function trendWatchAt(s: TrendSeries, i: number): { id: string; label: string; level: number | null; note: string }[] {
  const state = trendStateAt(s, i);
  const dir = state.fast === 1 ? 1 : state.fast === -1 ? -1 : 0;
  const above = dir === 1;
  return TREND_ENTRIES.map((e) => {
    let level: number | null = null;
    let note = e.rule;
    if (dir !== 0 && i + 1 <= s.n) {
      if (e.family === "channel") {
        // the level the NEXT candle has to close beyond
        const p = e.period!;
        if (i + 1 >= p) {
          let m = above ? -Infinity : Infinity;
          for (let k = i + 1 - p; k <= i; k++) m = above ? Math.max(m, s.h[k]) : Math.min(m, s.l[k]);
          level = m;
          note = `${above ? "close above" : "close below"} the ${p}-candle ${above ? "high" : "low"}`;
        }
      } else if (e.family === "pullback") {
        const v = (e.period === 20 ? s.ema20 : s.ema50)[i];
        level = Number.isFinite(v) ? v : null;
        note = `${above ? "dip to" : "rally to"} the ${e.period} EMA and close back ${above ? "above" : "below"} it`;
      } else if (e.family === "daybreak") {
        const v = above ? s.dayHigh[i] : s.dayLow[i];
        level = Number.isFinite(v) ? v : null;
        note = `${above ? "close above yesterday's high" : "close below yesterday's low"}`;
      } else if (e.family === "momentum") {
        level = Number.isFinite(s.atr[i]) ? s.c[i] + dir * s.atr[i] : null;
        note = `a candle closing ${above ? "above" : "below"} this (1 ATR from the last close)`;
      } else if (e.family === "cross") {
        note = `the 20 EMA crossing ${above ? "above" : "below"} the 50 EMA`;
      } else if (e.family === "inside") {
        note = `an inside bar, then a close ${above ? "above" : "below"} the candle that contained it`;
      }
    }
    return { id: e.id, label: e.label, level, note };
  });
}

// ───────────── the trailing stop ─────────────

/**
 * Follow one position bar by bar with a fixed-distance trailing stop, exactly
 * as a broker's trailing stop does: the stop sits `trailDistance` behind the
 * best price reached and never moves back. Within a bar the stop is tested
 * BEFORE the bar's own extreme is allowed to move it (the conservative order).
 *
 * `stop` is the stop as it stood before these bars. Returns the exit when the
 * stop was hit, otherwise the stop as it now stands.
 */
export function trailThrough(
  direction: SignalDirection,
  stop: number,
  trailDistance: number,
  bars: { time: number; open: number; high: number; low: number }[]
): { exit: { time: number; price: number } | null; stop: number } {
  const dir = direction === "long" ? 1 : -1;
  let s = stop;
  for (const b of bars) {
    const hit = dir === 1 ? b.low <= s : b.high >= s;
    if (hit) {
      // a gap through the stop fills at the open, not at the stop
      const price = dir === 1 ? Math.min(s, b.open) : Math.max(s, b.open);
      return { exit: { time: b.time, price }, stop: s };
    }
    const next = (dir === 1 ? b.high : b.low) - dir * trailDistance;
    s = dir === 1 ? Math.max(s, next) : Math.min(s, next);
  }
  return { exit: null, stop: s };
}
