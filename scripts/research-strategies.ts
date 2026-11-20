/**
 * Strategy lab: an event study of textbook intraday strategies on three years
 * of M15 data, so an idea can be accepted or rejected in seconds before any
 * of it is built into the scanner.
 *
 * Every rule is tested the same way: signal on a CLOSED bar, fill at the next
 * bar's open plus the full spread and slippage, stop-before-target when one
 * bar touches both, one open trade per pair, and no trade whose costs exceed
 * 10% of its risk. The first two years are the DESIGN sample; the last year
 * is the HOLDOUT. A rule is only worth building when it is positive in both,
 * with t above ~2 in the design sample — and, when more than one instrument
 * is tested, across most of them.
 *
 * Usage: npx tsx --env-file=.env.local scripts/research-strategies.ts [PAIR ...]
 *        (no pairs = XAU_USD; e.g. add EUR_USD GBP_USD USD_JPY for breadth)
 *        ONLY=C npx tsx ...   (run one family)
 */
import { SPREAD_PIPS, DEFAULT_SPREAD_PIPS, SLIPPAGE_PIPS, pipSize } from "@/lib/analysis/instruments";
import { PAIRS, type Candle } from "@/lib/types";
import { DAY_MS, loadPairData, windowEnd } from "./research-data";

const SPAN_DAYS = 3 * 365;
const HOLDOUT_START = (windowEnd() - 365 * DAY_MS) / 1000;
const MAX_COST_SHARE = 0.1;
const MAX_HOLD_BARS = 480;

// ───────────────────────── market data with indicators ─────────────────────────

interface TradingDay {
  first: number;
  last: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Market {
  pair: string;
  n: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  atr: number[];
  hour: number[];
  minute: number[];
  /** FX trading days (rolling at 22:00 UTC) and each bar's index into them */
  days: TradingDay[];
  dayOf: number[];
  /** spread + slippage in price units */
  cost: number;
  ema(period: number): number[];
  sma(period: number): number[];
  rsi(period: number): number[];
  /** highest high / lowest low of the PRIOR `period` bars (current bar excluded) */
  highest(period: number): number[];
  lowest(period: number): number[];
}

function buildMarket(pair: string, m15: Candle[]): Market {
  const n = m15.length;
  const t = m15.map((x) => x.time);
  const o = m15.map((x) => x.open);
  const h = m15.map((x) => x.high);
  const l = m15.map((x) => x.low);
  const c = m15.map((x) => x.close);

  const atr = new Array<number>(n).fill(NaN);
  let a = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= 14) {
      a += tr / 14;
      if (i === 14) atr[i] = a;
    } else {
      a = (a * 13 + tr) / 14;
      atr[i] = a;
    }
  }

  const days: TradingDay[] = [];
  const dayOf = new Array<number>(n).fill(0);
  let key = NaN;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((t[i] + 2 * 3600) / 86400);
    if (k !== key) {
      key = k;
      days.push({ first: i, last: i, open: o[i], high: h[i], low: l[i], close: c[i] });
    }
    const d = days[days.length - 1];
    d.last = i;
    d.high = Math.max(d.high, h[i]);
    d.low = Math.min(d.low, l[i]);
    d.close = c[i];
    dayOf[i] = days.length - 1;
  }

  const cache = new Map<string, number[]>();
  const memo = (k: string, make: () => number[]) => cache.get(k) ?? (cache.set(k, make()), cache.get(k)!);
  const rolling = (src: number[], period: number, max: boolean) => {
    const out = new Array<number>(n).fill(NaN);
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= period) out[i] = src[queue[0]];
      while (queue.length && (max ? src[queue[queue.length - 1]] <= src[i] : src[queue[queue.length - 1]] >= src[i])) queue.pop();
      queue.push(i);
      if (queue[0] <= i - period) queue.shift();
    }
    return out;
  };

  const pip = pipSize(pair);
  return {
    pair,
    n,
    t,
    o,
    h,
    l,
    c,
    atr,
    hour: t.map((x) => new Date(x * 1000).getUTCHours()),
    minute: t.map((x) => new Date(x * 1000).getUTCMinutes()),
    days,
    dayOf,
    cost: ((SPREAD_PIPS[pair] ?? DEFAULT_SPREAD_PIPS) + SLIPPAGE_PIPS) * pip,
    ema: (period) =>
      memo(`ema${period}`, () => {
        const out = new Array<number>(n).fill(NaN);
        const k = 2 / (period + 1);
        let e = 0;
        for (let i = 0; i < n; i++) {
          if (i < period) {
            e += c[i] / period;
            if (i === period - 1) out[i] = e;
          } else {
            e = c[i] * k + e * (1 - k);
            out[i] = e;
          }
        }
        return out;
      }),
    sma: (period) =>
      memo(`sma${period}`, () => {
        const out = new Array<number>(n).fill(NaN);
        let s = 0;
        for (let i = 0; i < n; i++) {
          s += c[i];
          if (i >= period) s -= c[i - period];
          if (i >= period - 1) out[i] = s / period;
        }
        return out;
      }),
    rsi: (period) =>
      memo(`rsi${period}`, () => {
        const out = new Array<number>(n).fill(NaN);
        let gain = 0;
        let loss = 0;
        for (let i = 1; i < n; i++) {
          const d = c[i] - c[i - 1];
          if (i <= period) {
            gain += Math.max(d, 0) / period;
            loss += Math.max(-d, 0) / period;
          } else {
            gain = (gain * (period - 1) + Math.max(d, 0)) / period;
            loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
          }
          if (i >= period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
        }
        return out;
      }),
    highest: (period) => memo(`hh${period}`, () => rolling(h, period, true)),
    lowest: (period) => memo(`ll${period}`, () => rolling(l, period, false)),
  };
}

// ───────────────────────────────── simulation ─────────────────────────────────

interface Signal {
  /** bar whose close produced the signal; the fill is the next bar's open */
  i: number;
  dir: 1 | -1;
  stop: number;
  target?: number;
  /** close the trade at this bar's close if still open */
  exitIdx?: number;
  /** close the trade at bar j's close when this turns true */
  exitWhen?: (j: number) => boolean;
}

interface Trade {
  pair: string;
  time: number;
  r: number;
  costR: number;
}

function simulate(m: Market, signals: Signal[]): Trade[] {
  const out: Trade[] = [];
  let busyUntil = -1;
  for (const s of [...signals].sort((x, y) => x.i - y.i)) {
    if (s.i <= busyUntil || s.i + 1 >= m.n) continue;
    const entry = m.o[s.i + 1] + s.dir * m.cost;
    const risk = (entry - s.stop) * s.dir;
    if (!(risk > 0) || m.cost / risk > MAX_COST_SHARE) continue;
    if (s.target != null && (s.target - entry) * s.dir <= 0) continue;

    let r = NaN;
    let j = s.i + 1;
    for (; j < m.n; j++) {
      const stopped = s.dir === 1 ? m.l[j] <= s.stop : m.h[j] >= s.stop;
      if (stopped) {
        r = -1;
        break;
      }
      if (s.target != null && (s.dir === 1 ? m.h[j] >= s.target : m.l[j] <= s.target)) {
        r = ((s.target - entry) * s.dir) / risk;
        break;
      }
      const timed = (s.exitIdx != null && j >= s.exitIdx) || j - s.i >= MAX_HOLD_BARS;
      if (timed || (s.exitWhen && j > s.i + 1 && s.exitWhen(j))) {
        r = ((m.c[j] - entry) * s.dir) / risk;
        break;
      }
    }
    if (Number.isNaN(r)) continue;
    busyUntil = j;
    out.push({ pair: m.pair, time: m.t[s.i + 1], r, costR: m.cost / risk });
  }
  return out;
}

function summary(trades: Trade[]): string {
  const n = trades.length;
  if (n === 0) return "    0".padEnd(41);
  const total = trades.reduce((s, x) => s + x.r, 0);
  const mean = total / n;
  const sd = Math.sqrt(trades.reduce((s, x) => s + (x.r - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = trades.filter((x) => x.r > 0);
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const pf = grossWin / Math.max(1e-9, grossWin - total);
  return `${String(n).padStart(5)} win ${((100 * wins.length) / n).toFixed(0).padStart(2)}% avgR ${mean.toFixed(3).padStart(6)} t ${t.toFixed(1).padStart(4)} pf ${pf.toFixed(2)}`;
}

// ──────────────────────────────── shared helpers ───────────────────────────────

const inHours = (m: Market, i: number, from: number, to: number) => m.hour[i] >= from && m.hour[i] < to;

/** Last bar of bar i's trading day that closes by 21:00 UTC (before rollover). */
function endOfSession(m: Market, i: number): number {
  let j = m.days[m.dayOf[i]].last;
  while (j > i && m.hour[j] >= 21) j--;
  return j;
}

/** Per trading day: the Asian range (22:00–07:00 UTC) and the pre-New-York range (12:00–13:30). */
function sessionRanges(m: Market) {
  return m.days.map((d) => {
    let asiaHigh = -Infinity;
    let asiaLow = Infinity;
    let nyHigh = -Infinity;
    let nyLow = Infinity;
    for (let i = d.first; i <= d.last; i++) {
      if (m.hour[i] >= 22 || m.hour[i] < 7) {
        asiaHigh = Math.max(asiaHigh, m.h[i]);
        asiaLow = Math.min(asiaLow, m.l[i]);
      }
      if (m.hour[i] === 12 || (m.hour[i] === 13 && m.minute[i] < 30)) {
        nyHigh = Math.max(nyHigh, m.h[i]);
        nyLow = Math.min(nyLow, m.l[i]);
      }
    }
    return { asiaHigh, asiaLow, nyHigh, nyLow };
  });
}

/** Daily trend proxy: the prior day's close against the 50-day average close. */
function dailyTrend(m: Market, period = 50): number[] {
  const out = new Array<number>(m.days.length).fill(0);
  let sum = 0;
  for (let k = 0; k < m.days.length; k++) {
    if (k >= period) out[k] = Math.sign(m.days[k - 1].close - sum / period);
    sum += m.days[k].close;
    if (k >= period) sum -= m.days[k - period].close;
  }
  return out;
}

/** Average daily range of the previous `period` days. */
function averageDailyRange(m: Market, period = 20): number[] {
  const out = new Array<number>(m.days.length).fill(NaN);
  for (let k = period; k < m.days.length; k++) {
    let s = 0;
    for (let q = k - period; q < k; q++) s += m.days[q].high - m.days[q].low;
    out[k] = s / period;
  }
  return out;
}

// ───────────────────────────────── the strategies ──────────────────────────────

type Strategy = (m: Market) => Signal[];
const STRATEGIES: Record<string, Strategy> = {};

// A. London breakout of the Asian range: first 07:00–11:00 close beyond it.
for (const [name, stopAt, rr] of [
  ["A1 Asian-range breakout, stop mid, 1R", "mid", 1],
  ["A2 Asian-range breakout, stop mid, 2R", "mid", 2],
  ["A3 Asian-range breakout, stop far side, 1R", "far", 1],
] as const) {
  STRATEGIES[name] = (m) => {
    const ranges = sessionRanges(m);
    const out: Signal[] = [];
    for (let k = 1; k < m.days.length; k++) {
      const { asiaHigh, asiaLow } = ranges[k];
      if (!Number.isFinite(asiaHigh)) continue;
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (!inHours(m, i, 7, 11)) continue;
        const dir = m.c[i] > asiaHigh ? 1 : m.c[i] < asiaLow ? -1 : 0;
        if (!dir) continue;
        const stop = stopAt === "mid" ? (asiaHigh + asiaLow) / 2 : dir === 1 ? asiaLow : asiaHigh;
        out.push({ i, dir, stop, target: m.c[i] + dir * rr * Math.abs(m.c[i] - stop), exitIdx: endOfSession(m, i) });
        break;
      }
    }
    return out;
  };
}

// B. London fade of an Asian-range sweep: wick through the range, close back inside.
for (const [name, targetAt] of [
  ["B1 Asian-range sweep fade, 2R", "2R"],
  ["B2 Asian-range sweep fade, target far side", "far"],
] as const) {
  STRATEGIES[name] = (m) => {
    const ranges = sessionRanges(m);
    const out: Signal[] = [];
    for (let k = 1; k < m.days.length; k++) {
      const { asiaHigh, asiaLow } = ranges[k];
      if (!Number.isFinite(asiaHigh)) continue;
      let sweptHigh = false;
      let sweptLow = false;
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (!inHours(m, i, 7, 12)) continue;
        if (!sweptHigh && m.h[i] > asiaHigh && m.c[i] < asiaHigh) {
          sweptHigh = true;
          const stop = m.h[i] + 0.1 * m.atr[i];
          out.push({ i, dir: -1, stop, target: targetAt === "2R" ? m.c[i] - 2 * (stop - m.c[i]) : asiaLow, exitIdx: endOfSession(m, i) });
        }
        if (!sweptLow && m.l[i] < asiaLow && m.c[i] > asiaLow) {
          sweptLow = true;
          const stop = m.l[i] - 0.1 * m.atr[i];
          out.push({ i, dir: 1, stop, target: targetAt === "2R" ? m.c[i] + 2 * (m.c[i] - stop) : asiaHigh, exitIdx: endOfSession(m, i) });
        }
      }
    }
    return out;
  };
}

// C. Previous-day high/low sweep reversal ("turtle soup").
for (const [name, rr, from, to] of [
  ["C1 Prev-day high/low sweep reversal, 2R", 2, 7, 20],
  ["C2 Prev-day high/low sweep reversal, 1R", 1, 7, 20],
  ["C3 Prev-day high/low sweep reversal, 2R, NY", 2, 12, 20],
] as const) {
  STRATEGIES[name] = (m) => {
    const out: Signal[] = [];
    for (let k = 1; k < m.days.length; k++) {
      const prev = m.days[k - 1];
      let sweptHigh = false;
      let sweptLow = false;
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (!inHours(m, i, from, to)) continue;
        if (!sweptHigh && m.h[i] > prev.high && m.c[i] < prev.high) {
          sweptHigh = true;
          const stop = m.h[i] + 0.1 * m.atr[i];
          out.push({ i, dir: -1, stop, target: m.c[i] - rr * (stop - m.c[i]) });
        }
        if (!sweptLow && m.l[i] < prev.low && m.c[i] > prev.low) {
          sweptLow = true;
          const stop = m.l[i] - 0.1 * m.atr[i];
          out.push({ i, dir: 1, stop, target: m.c[i] + rr * (m.c[i] - stop) });
        }
      }
    }
    return out;
  };
}

// D. Previous-day high/low breakout continuation on a conviction close.
for (const [name, withTrend] of [
  ["D1 Prev-day high/low breakout, 2R", false],
  ["D2 Prev-day high/low breakout, 2R, daily trend", true],
] as const) {
  STRATEGIES[name] = (m) => {
    const trend = dailyTrend(m);
    const out: Signal[] = [];
    for (let k = 1; k < m.days.length; k++) {
      const prev = m.days[k - 1];
      for (let i = Math.max(1, m.days[k].first); i <= m.days[k].last; i++) {
        if (!inHours(m, i, 7, 20)) continue;
        const body = Math.abs(m.c[i] - m.o[i]) / Math.max(1e-12, m.h[i] - m.l[i]);
        const dir =
          m.c[i] > prev.high && m.c[i - 1] <= prev.high ? 1 : m.c[i] < prev.low && m.c[i - 1] >= prev.low ? -1 : 0;
        if (!dir || body < 0.5 || (withTrend && trend[k] !== dir)) continue;
        out.push({ i, dir, stop: m.c[i] - dir * 1.5 * m.atr[i], target: m.c[i] + dir * 3 * m.atr[i] });
        break;
      }
    }
    return out;
  };
}

// E. New York opening-range breakout: 12:00–13:30 range, break by 16:00.
for (const [name, rr] of [
  ["E1 NY opening-range breakout, 1R", 1],
  ["E2 NY opening-range breakout, 2R", 2],
] as const) {
  STRATEGIES[name] = (m) => {
    const ranges = sessionRanges(m);
    const out: Signal[] = [];
    for (let k = 1; k < m.days.length; k++) {
      const { nyHigh, nyLow } = ranges[k];
      if (!Number.isFinite(nyHigh)) continue;
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (!((m.hour[i] === 13 && m.minute[i] >= 30) || inHours(m, i, 14, 16))) continue;
        const dir = m.c[i] > nyHigh ? 1 : m.c[i] < nyLow ? -1 : 0;
        if (!dir) continue;
        const stop = (nyHigh + nyLow) / 2;
        out.push({ i, dir, stop, target: m.c[i] + dir * rr * Math.abs(m.c[i] - stop), exitIdx: endOfSession(m, i) });
        break;
      }
    }
    return out;
  };
}

// F. Pullback to the EMA50 inside an EMA200 trend, entered on a rejection close.
for (const [name, from, to] of [
  ["F1 EMA50 pullback in trend, 2R", 7, 20],
  ["F2 EMA50 pullback in trend, 2R, NY", 12, 20],
] as const) {
  STRATEGIES[name] = (m) => {
    const fast = m.ema(50);
    const slow = m.ema(200);
    const out: Signal[] = [];
    for (let i = 300; i < m.n; i++) {
      if (!inHours(m, i, from, to)) continue;
      const up = fast[i] > slow[i] && slow[i] > slow[i - 96];
      const down = fast[i] < slow[i] && slow[i] < slow[i - 96];
      if (up && m.l[i - 1] > fast[i - 1] && m.l[i] <= fast[i] && m.c[i] > fast[i] && m.c[i] > m.o[i]) {
        const stop = Math.min(m.l[i], m.l[i - 1]) - 0.25 * m.atr[i];
        out.push({ i, dir: 1, stop, target: m.c[i] + 2 * (m.c[i] - stop) });
      }
      if (down && m.h[i - 1] < fast[i - 1] && m.h[i] >= fast[i] && m.c[i] < fast[i] && m.c[i] < m.o[i]) {
        const stop = Math.max(m.h[i], m.h[i - 1]) + 0.25 * m.atr[i];
        out.push({ i, dir: -1, stop, target: m.c[i] - 2 * (stop - m.c[i]) });
      }
    }
    return out;
  };
}

// G. RSI(2) pullback with the trend, exit on a close back over the 5-bar average.
for (const [name, threshold, from, to] of [
  ["G1 RSI(2)<5 with trend, exit SMA5", 5, 0, 24],
  ["G2 RSI(2)<5 with trend, London/NY", 5, 7, 20],
  ["G3 RSI(2)<10 with trend, NY", 10, 12, 20],
] as const) {
  STRATEGIES[name] = (m) => {
    const slow = m.ema(200);
    const rsi = m.rsi(2);
    const mean = m.sma(5);
    const out: Signal[] = [];
    for (let i = 300; i < m.n; i++) {
      if (!inHours(m, i, from, to)) continue;
      if (m.c[i] > slow[i] && slow[i] > slow[i - 96] && rsi[i] < threshold) {
        out.push({ i, dir: 1, stop: m.c[i] - 2 * m.atr[i], exitWhen: (j) => m.c[j] > mean[j] });
      }
      if (m.c[i] < slow[i] && slow[i] < slow[i - 96] && rsi[i] > 100 - threshold) {
        out.push({ i, dir: -1, stop: m.c[i] + 2 * m.atr[i], exitWhen: (j) => m.c[j] < mean[j] });
      }
    }
    return out;
  };
}

// H. Bollinger-band fade back to the 20-bar mean.
for (const [name, from, to] of [
  ["H1 Bollinger fade, Asian session", 22, 6],
  ["H2 Bollinger fade, London/NY", 7, 20],
] as const) {
  STRATEGIES[name] = (m) => {
    const mean = m.sma(20);
    const band = new Array<number>(m.n).fill(NaN);
    for (let i = 19; i < m.n; i++) {
      let v = 0;
      for (let q = i - 19; q <= i; q++) v += (m.c[q] - mean[i]) ** 2;
      band[i] = 2 * Math.sqrt(v / 20);
    }
    const out: Signal[] = [];
    for (let i = 40; i < m.n; i++) {
      const inSession = from > to ? m.hour[i] >= from || m.hour[i] < to : inHours(m, i, from, to);
      if (!inSession) continue;
      if (m.c[i] < mean[i] - band[i] && m.c[i - 1] >= mean[i - 1] - band[i - 1]) {
        out.push({ i, dir: 1, stop: m.c[i] - 1.5 * m.atr[i], target: mean[i] });
      }
      if (m.c[i] > mean[i] + band[i] && m.c[i - 1] <= mean[i - 1] + band[i - 1]) {
        out.push({ i, dir: -1, stop: m.c[i] + 1.5 * m.atr[i], target: mean[i] });
      }
    }
    return out;
  };
}

// I. Donchian channel breakout (one-day and one-week extremes), 3 ATR stop, 6 ATR target.
for (const [name, period, withTrend] of [
  ["I1 Donchian breakout, 1 day", 96, false],
  ["I2 Donchian breakout, 1 week", 480, false],
  ["I3 Donchian breakout, 1 week, daily trend", 480, true],
] as const) {
  STRATEGIES[name] = (m) => {
    const top = m.highest(period);
    const bottom = m.lowest(period);
    const trend = dailyTrend(m);
    const out: Signal[] = [];
    for (let i = period + 20; i < m.n; i++) {
      if (!inHours(m, i, 7, 20)) continue;
      const dir = m.c[i] > top[i] && m.c[i - 1] <= top[i - 1] ? 1 : m.c[i] < bottom[i] && m.c[i - 1] >= bottom[i - 1] ? -1 : 0;
      if (!dir || (withTrend && trend[m.dayOf[i]] !== dir)) continue;
      out.push({ i, dir, stop: m.c[i] - dir * 3 * m.atr[i], target: m.c[i] + dir * 6 * m.atr[i] });
    }
    return out;
  };
}

// J. Impulse candle (range > 2.5 ATR, mostly body): ride it or fade it.
for (const [name, fade] of [
  ["J1 Impulse candle continuation, 2R", false],
  ["J2 Impulse candle fade, 1R", true],
] as const) {
  STRATEGIES[name] = (m) => {
    const out: Signal[] = [];
    for (let i = 20; i < m.n; i++) {
      if (!inHours(m, i, 7, 20)) continue;
      const range = m.h[i] - m.l[i];
      if (range < 2.5 * m.atr[i - 1] || Math.abs(m.c[i] - m.o[i]) / range < 0.7) continue;
      const impulse = m.c[i] > m.o[i] ? 1 : -1;
      if (fade) {
        const dir = (impulse === 1 ? -1 : 1) as 1 | -1;
        const stop = dir === -1 ? m.h[i] + 0.25 * m.atr[i] : m.l[i] - 0.25 * m.atr[i];
        out.push({ i, dir, stop, target: m.c[i] + dir * Math.abs(m.c[i] - stop) });
      } else {
        const stop = (m.h[i] + m.l[i]) / 2;
        out.push({ i, dir: impulse, stop, target: m.c[i] + impulse * 2 * Math.abs(m.c[i] - stop) });
      }
    }
    return out;
  };
}

// K. Narrow-range day (NR4): break of the tightest day in four.
for (const [name, rr] of [
  ["K1 NR4 day breakout, 1R", 1],
  ["K2 NR4 day breakout, 2R", 2],
] as const) {
  STRATEGIES[name] = (m) => {
    const range = (k: number) => m.days[k].high - m.days[k].low;
    const out: Signal[] = [];
    for (let k = 5; k < m.days.length; k++) {
      if (!(range(k - 1) < range(k - 2) && range(k - 1) < range(k - 3) && range(k - 1) < range(k - 4))) continue;
      const prev = m.days[k - 1];
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (!inHours(m, i, 7, 20)) continue;
        const dir = m.c[i] > prev.high ? 1 : m.c[i] < prev.low ? -1 : 0;
        if (!dir) continue;
        const stop = (prev.high + prev.low) / 2;
        out.push({ i, dir, stop, target: m.c[i] + dir * rr * Math.abs(m.c[i] - stop) });
        break;
      }
    }
    return out;
  };
}

// L. Yesterday's direction carried (or reversed) through today's London–NY session.
for (const [name, sign] of [
  ["L1 Prev-day momentum, hold to 21:00", 1],
  ["L2 Prev-day reversal, hold to 21:00", -1],
] as const) {
  STRATEGIES[name] = (m) => {
    const adr = averageDailyRange(m);
    const out: Signal[] = [];
    for (let k = 21; k < m.days.length; k++) {
      const move = m.days[k - 1].close - m.days[k - 1].open;
      if (Math.abs(move) < 0.5 * adr[k]) continue;
      for (let i = m.days[k].first; i <= m.days[k].last; i++) {
        if (m.hour[i] !== 7) continue;
        const dir = (Math.sign(move) * sign) as 1 | -1;
        out.push({ i, dir, stop: m.c[i] - dir * 0.5 * adr[k], exitIdx: endOfSession(m, i) });
        break;
      }
    }
    return out;
  };
}

// N. London open drive: a strong first hour continues.
STRATEGIES["N1 London first-hour drive, 2R"] = (m) => {
  const ranges = sessionRanges(m);
  const out: Signal[] = [];
  for (let k = 1; k < m.days.length; k++) {
    const { asiaHigh, asiaLow } = ranges[k];
    if (!Number.isFinite(asiaHigh)) continue;
    for (let i = Math.max(3, m.days[k].first); i <= m.days[k].last; i++) {
      if (!(m.hour[i] === 7 && m.minute[i] === 45)) continue;
      const move = m.c[i] - m.o[i - 3];
      if (Math.abs(move) < 0.5 * (asiaHigh - asiaLow)) break;
      const dir = move > 0 ? 1 : -1;
      const stop =
        dir === 1
          ? Math.min(m.l[i], m.l[i - 1], m.l[i - 2], m.l[i - 3])
          : Math.max(m.h[i], m.h[i - 1], m.h[i - 2], m.h[i - 3]);
      out.push({ i, dir, stop, target: m.c[i] + dir * 2 * Math.abs(m.c[i] - stop), exitIdx: endOfSession(m, i) });
      break;
    }
  }
  return out;
};

// ─────────────────────────────────── runner ────────────────────────────────────

async function main() {
  // Name more instruments on the command line to check that a rule is not
  // just a quirk of one market.
  const pairs = process.argv.slice(2).length ? process.argv.slice(2) : [...PAIRS];
  const markets: Market[] = [];
  for (const pair of pairs) markets.push(buildMarket(pair, (await loadPairData(pair, SPAN_DAYS)).m15));

  console.log(
    `${pairs.length} instruments, ~${markets[0].n} M15 bars each. Costs: full spread + ${SLIPPAGE_PIPS} pip, capped at ${MAX_COST_SHARE * 100}% of risk.`
  );
  console.log("DESIGN = first two years, HOLDOUT = last year. Build nothing that is not positive in both.\n");

  const only = process.env.ONLY;
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    if (only && !name.startsWith(only)) continue;
    const trades = markets.flatMap((m) => simulate(m, strategy(m)));
    const positivePairs = pairs.filter((p) => {
      const own = trades.filter((x) => x.pair === p);
      return own.length > 0 && own.reduce((s, x) => s + x.r, 0) > 0;
    }).length;
    const perDay = trades.length / (3 * 260);
    console.log(
      `${name.padEnd(46)} DESIGN ${summary(trades.filter((x) => x.time < HOLDOUT_START))} | HOLDOUT ${summary(trades.filter((x) => x.time >= HOLDOUT_START))} | ${perDay.toFixed(1)}/day, ${positivePairs}/${pairs.length} pairs positive`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
