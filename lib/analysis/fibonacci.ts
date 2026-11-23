import type { Candle, SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";

/**
 * The Fibonacci retracement system — the only strategy that sends signals.
 *
 * Four timeframes, each with one job:
 *
 *  - DAILY: the trend. The last closed day above its 50-day average means
 *    buys only, below it sells only.
 *  - 4-HOUR: the trend must agree — price above a rising 50 EMA for buys,
 *    below a falling one for sells.
 *  - 1-HOUR: the swing the retracement is measured on. A swing point counts
 *    once price has turned 5 ATR away from it, so the leg is a real impulse
 *    and not noise; it must be at least 8 ATR long and point with the trend.
 *  - 15-MINUTE: the entry. Price pulls back into the 38.2%–61.8% zone of the
 *    leg and a 15-minute candle rejects it — an engulfing candle or a pin bar,
 *    closing inside or above the zone.
 *
 * The stop goes beyond the start of the leg (the 100% level) and the target is
 * the 161.8% extension of the leg, so the levels follow the market's own
 * structure rather than a fixed distance. A trade that reaches neither within
 * five trading days is closed at market. One trade per leg, one trade at a time.
 *
 * Every number below was chosen on 2011–2021 gold data and then left alone for
 * 2021–2026 (scripts/backtest.ts prints both). Faster versions — smaller
 * swings, tighter stops, no trend filter — lost money over those years.
 */

/** Days in the daily trend average. */
export const FIB_TREND_DAYS = 50;
/** Period of the 4-hour EMA, and how many candles back its slope is read. */
export const FIB_H4_EMA = 50;
export const FIB_H4_SLOPE_BARS = 5;
/** A 1-hour swing point is confirmed once price has turned this many ATR away from it. */
export const FIB_SWING_ATR = 5;
/** Shortest and longest leg worth trading, in 1-hour ATR. */
export const FIB_MIN_LEG_ATR = 8;
export const FIB_MAX_LEG_ATR = 80;
/** The entry zone: retracement between these two levels. */
export const FIB_ZONE_SHALLOW = 0.382;
export const FIB_ZONE_DEEP = 0.618;
/** The stop sits this many 1-hour ATR beyond the start of the leg. */
export const FIB_STOP_BUFFER_ATR = 0.25;
/** The target: this far beyond the end of the leg, as a share of it (0.618 = the 161.8% extension). */
export const FIB_TARGET_EXTENSION = 0.618;
/** A trade still open after this many 15-minute candles (five trading days) is closed at market. */
export const FIB_MAX_HOLD_BARS = 480;
/** A stop closer than this many 15-minute ATR is inside the noise — no trade. */
export const FIB_MIN_RISK_ATR = 1.5;
/** No trade when the spread and slippage are more than this share of the risk. */
export const FIB_MAX_COST_SHARE = 0.1;
/** No trade when the target is closer than the stop. */
export const FIB_MIN_RR = 1;
/** The retracement levels drawn on the chart. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

const M15 = 900;
const H1 = 3600;
const H4 = 14400;
const DAY = 86400;

export interface FibLeg {
  /** long = an up-leg being retraced (buy the pullback), short = a down-leg */
  direction: SignalDirection;
  /** where the leg started (the 100% level) and ended (the 0% level) */
  origin: { time: number; price: number };
  end: { time: number; price: number };
  range: number;
  /** when the 1-hour candle that confirmed the leg's end closed (epoch seconds) */
  confirmedAt: number;
  /** stable identity of the leg: one trade per leg */
  key: string;
}

export interface FibSeries {
  n: number;
  candles: Candle[];
  atr15: Float64Array;
  /** +1 / −1 / 0 for every 15-minute candle, read from the last CLOSED higher-timeframe candle */
  dailyTrend: Int8Array;
  h4Trend: Int8Array;
  /** the 1-hour ATR in force at each 15-minute candle */
  atrH1: Float64Array;
  /** index into `legs` of the leg in force at each 15-minute candle, or −1 */
  legAt: Int32Array;
  legs: FibLeg[];
  /** true once price has traded through the leg's start or beyond its end — the leg is finished */
  dead: Uint8Array;
  /** the values the checklist shows */
  dailyAverage: Float64Array;
  h4Ema: Float64Array;
}

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

function wilderAtr(c: Candle[], n = 14): Float64Array {
  const out = new Float64Array(c.length);
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

function ema(values: number[], n: number): Float64Array {
  const out = new Float64Array(values.length);
  const k = 2 / (n + 1);
  for (let i = 0; i < values.length; i++) out[i] = i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function sma(values: number[], n: number): Float64Array {
  const out = new Float64Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out[i] = i >= n - 1 ? sum / n : NaN;
  }
  return out;
}

/** OANDA prints an empty daily candle on some weekends (it opens on a Friday or Saturday, UTC); it is not a trading day. */
const isWeekendCandle = (c: Candle) => {
  const day = new Date(c.time * 1000).getUTCDay();
  return day === 5 || day === 6;
};

/**
 * The 1-hour swings as a zigzag: a swing high is confirmed once price has
 * fallen FIB_SWING_ATR × ATR from it, a swing low once price has risen that far.
 * Returns, for every 1-hour candle, the leg that was in force when it closed.
 */
function swingLegs(h1: Candle[], atr: Float64Array): { legs: FibLeg[]; at: Int32Array } {
  const legs: FibLeg[] = [];
  const at = new Int32Array(h1.length).fill(-1);
  if (h1.length === 0) return { legs, at };
  let up = true;
  let ext = { time: h1[0].time, price: h1[0].high };
  let lastLow = { time: h1[0].time, price: h1[0].low };
  let lastHigh = { time: h1[0].time, price: h1[0].high };
  let current = -1;
  for (let j = 0; j < h1.length; j++) {
    const c = h1[j];
    const turn = FIB_SWING_ATR * atr[j];
    if (up) {
      if (c.high > ext.price) ext = { time: c.time, price: c.high };
      else if (c.low < ext.price - turn) {
        // swing high confirmed: the up-leg lastLow → ext is now being retraced
        lastHigh = ext;
        legs.push({ direction: "long", origin: lastLow, end: lastHigh, range: lastHigh.price - lastLow.price, confirmedAt: c.time + H1, key: `long:${lastLow.time}:${lastHigh.time}` });
        current = legs.length - 1;
        up = false;
        ext = { time: c.time, price: c.low };
      }
    } else {
      if (c.low < ext.price) ext = { time: c.time, price: c.low };
      else if (c.high > ext.price + turn) {
        // swing low confirmed: the down-leg lastHigh → ext is now being retraced
        lastLow = ext;
        legs.push({ direction: "short", origin: lastHigh, end: lastLow, range: lastHigh.price - lastLow.price, confirmedAt: c.time + H1, key: `short:${lastHigh.time}:${lastLow.time}` });
        current = legs.length - 1;
        up = true;
        ext = { time: c.time, price: c.high };
      }
    }
    at[j] = current;
  }
  return { legs, at };
}

/**
 * Everything the system reads, aligned to the 15-minute candles. All four
 * series are CLOSED candles, oldest first; a higher-timeframe candle is used
 * only once it has closed, so nothing looks ahead.
 */
export function buildFibSeries(input: { m15: Candle[]; h1: Candle[]; h4: Candle[]; daily: Candle[] }): FibSeries {
  const candles = input.m15;
  const n = candles.length;
  const daily = input.daily.filter((c) => !isWeekendCandle(c));
  const dClose = daily.map((c) => c.close);
  const dAvg = sma(dClose, FIB_TREND_DAYS);
  const h4Close = input.h4.map((c) => c.close);
  const h4E = ema(h4Close, FIB_H4_EMA);
  const h1Atr = wilderAtr(input.h1);
  const { legs, at } = swingLegs(input.h1, h1Atr);

  const s: FibSeries = {
    n,
    candles,
    atr15: wilderAtr(candles),
    dailyTrend: new Int8Array(n),
    h4Trend: new Int8Array(n),
    atrH1: new Float64Array(n),
    legAt: new Int32Array(n).fill(-1),
    legs,
    dead: new Uint8Array(n),
    dailyAverage: new Float64Array(n).fill(NaN),
    h4Ema: new Float64Array(n).fill(NaN),
  };

  let d = -1;
  let h = -1;
  let j = -1;
  let leg = -1;
  let dead = false;
  for (let i = 0; i < n; i++) {
    const now = candles[i].time + M15;
    while (d + 1 < daily.length && daily[d + 1].time + DAY <= now) d++;
    while (h + 1 < input.h4.length && input.h4[h + 1].time + H4 <= now) h++;
    while (j + 1 < input.h1.length && input.h1[j + 1].time + H1 <= now) j++;

    if (d >= FIB_TREND_DAYS - 1) {
      s.dailyTrend[i] = sign(dClose[d] - dAvg[d]);
      s.dailyAverage[i] = dAvg[d];
    }
    // enough 4-hour history for the EMA to have settled
    if (h >= 2 * FIB_H4_EMA) {
      const side = sign(h4Close[h] - h4E[h]);
      const slope = sign(h4E[h] - h4E[h - FIB_H4_SLOPE_BARS]);
      s.h4Trend[i] = side !== 0 && side === slope ? side : 0;
      s.h4Ema[i] = h4E[h];
    }
    if (j >= 50) {
      s.atrH1[i] = h1Atr[j];
      const now15 = at[j];
      if (now15 !== leg) {
        leg = now15;
        dead = false;
      }
      s.legAt[i] = leg;
      if (leg >= 0 && !dead) {
        const L = legs[leg];
        const c = candles[i];
        // only candles after the leg was confirmed can finish it
        if (c.time + M15 > L.confirmedAt) {
          dead = L.direction === "long" ? c.low <= L.origin.price || c.high > L.end.price : c.high >= L.origin.price || c.low < L.end.price;
        }
      }
      s.dead[i] = dead ? 1 : 0;
    }
  }
  return s;
}

/** Price at a retracement level of a leg: 0 is the end of the leg, 1 its start; negative values are extensions. */
export function fibPrice(leg: FibLeg, level: number): number {
  const dir = leg.direction === "long" ? 1 : -1;
  return leg.end.price - dir * level * leg.range;
}

export interface FibSetup {
  direction: SignalDirection;
  leg: FibLeg;
  /** which candle pattern rejected the zone */
  trigger: "engulfing candle" | "pin bar";
  /** entry at market: the close of the signal candle (the next candle's open) */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  /** reward ÷ risk */
  rr: number;
  /** how deep price pulled back at the signal candle's extreme, as a share of the leg */
  retracement: number;
  /** when the signal candle closed (epoch seconds) */
  time: number;
}

export interface FibState {
  dailyTrend: 1 | -1 | 0;
  h4Trend: 1 | -1 | 0;
  dailyAverage: number | null;
  h4Ema: number | null;
  /** the side both trends allow, or null */
  side: SignalDirection | null;
  /** the 1-hour leg in force (whatever its direction), or null */
  leg: FibLeg | null;
  /** leg length in 1-hour ATR */
  legAtr: number | null;
  /** the entry zone and the trade's levels on that leg */
  zone: { shallow: number; deep: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** the five conditions, in the order they have to be met */
  checks: { label: string; met: boolean }[];
  /** why there is no trade to wait for right now, or null when everything but the entry candle is in place */
  blocked: string | null;
  /** the trade, when the last candle completed every condition */
  setup: FibSetup | null;
}

/**
 * The system's read of candle `i`: the two trends, the leg, the zone, and —
 * when the candle completes every condition — the trade. `entry` overrides the
 * entry price (the backtest fills at the next candle's open).
 */
export function fibStateAt(s: FibSeries, i: number, pair = "XAU_USD", entry?: number): FibState {
  const c = s.candles[i];
  const prev = i > 0 ? s.candles[i - 1] : null;
  const daily = s.dailyTrend[i] as 1 | -1 | 0;
  const h4 = s.h4Trend[i] as 1 | -1 | 0;
  const side: SignalDirection | null = daily !== 0 && daily === h4 ? (daily === 1 ? "long" : "short") : null;
  const leg = s.legAt[i] >= 0 ? s.legs[s.legAt[i]] : null;
  const atrH1 = s.atrH1[i];
  const legAtr = leg && atrH1 > 0 ? leg.range / atrH1 : null;
  const arrow = (t: number) => (t === 1 ? "up" : t === -1 ? "down" : "unclear");

  const withTrend = !!leg && side === leg.direction;
  const sized = legAtr != null && legAtr >= FIB_MIN_LEG_ATR && legAtr <= FIB_MAX_LEG_ATR;
  const alive = !!leg && s.dead[i] === 0;
  const legOk = withTrend && sized && alive;

  const zone = leg ? { shallow: fibPrice(leg, FIB_ZONE_SHALLOW), deep: fibPrice(leg, FIB_ZONE_DEEP) } : null;
  const dir = leg?.direction === "short" ? -1 : 1;
  const stopLoss = leg ? leg.origin.price - dir * FIB_STOP_BUFFER_ATR * atrH1 : null;
  const takeProfit = leg ? fibPrice(leg, -FIB_TARGET_EXTENSION) : null;

  // the candle traded into the zone and did not close through its deep edge
  const inZone = !!leg && !!zone && (dir === 1 ? c.low <= zone.shallow && c.close >= zone.deep : c.high >= zone.shallow && c.close <= zone.deep);
  let trigger: FibSetup["trigger"] | null = null;
  if (prev) {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-9;
    const closesWith = dir === 1 ? c.close > c.open : c.close < c.open;
    const engulfing = closesWith && (dir === 1 ? c.close > prev.high : c.close < prev.low);
    const wick = dir === 1 ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    const pin = wick >= 2 * body && wick >= 0.5 * range && (dir === 1 ? c.close >= c.low + 0.6 * range : c.close <= c.high - 0.6 * range);
    trigger = engulfing ? "engulfing candle" : pin ? "pin bar" : null;
  }

  const checks = [
    { label: `Daily trend ${arrow(daily)} (close vs ${FIB_TREND_DAYS}-day average)`, met: daily !== 0 },
    { label: `4-hour trend ${arrow(h4)}${daily !== 0 && h4 !== 0 && h4 !== daily ? " — disagrees" : ""} (price and slope of the ${FIB_H4_EMA} EMA)`, met: side != null },
    {
      label: leg
        ? `1-hour ${leg.direction === "long" ? "up" : "down"}-leg of ${legAtr != null ? legAtr.toFixed(1) : "?"} ATR${!withTrend && side ? " — against the trend" : !sized ? ` — needs ${FIB_MIN_LEG_ATR}–${FIB_MAX_LEG_ATR}` : !alive ? " — finished" : ""}`
        : "1-hour swing leg with the trend",
      met: legOk,
    },
    { label: `Pullback into the ${(FIB_ZONE_SHALLOW * 100).toFixed(1)}%–${(FIB_ZONE_DEEP * 100).toFixed(1)}% zone`, met: legOk && inZone },
    { label: "15-minute rejection candle (engulfing or pin bar)", met: legOk && inZone && trigger != null },
  ];

  let blocked: string | null = null;
  if (daily === 0) blocked = "the daily trend is not known yet";
  else if (!side) blocked = `the 4-hour trend does not agree with the daily trend (${arrow(daily)})`;
  else if (!leg) blocked = "no 1-hour swing yet";
  else if (!withTrend) blocked = `the last 1-hour leg points ${leg.direction === "long" ? "up" : "down"}, against the trend — waiting for a leg ${side === "long" ? "up" : "down"}`;
  else if (!sized) blocked = `the 1-hour leg is ${legAtr?.toFixed(1)} ATR long — it needs ${FIB_MIN_LEG_ATR} to ${FIB_MAX_LEG_ATR}`;
  else if (!alive) blocked = "price has left the leg (through its start or past its end) — waiting for the next one";

  let setup: FibSetup | null = null;
  if (legOk && inZone && trigger && leg && stopLoss != null && takeProfit != null) {
    const price = entry ?? c.close;
    const risk = dir * (price - stopLoss);
    const rr = risk > 0 ? (dir * (takeProfit - price)) / risk : 0;
    if (risk >= FIB_MIN_RISK_ATR * s.atr15[i] && tradeCost(pair) / risk <= FIB_MAX_COST_SHARE && rr >= FIB_MIN_RR) {
      const extreme = dir === 1 ? c.low : c.high;
      setup = { direction: leg.direction, leg, trigger, entry: price, stopLoss, takeProfit, risk, rr, retracement: Math.abs(leg.end.price - extreme) / leg.range, time: c.time + M15 };
    }
  }

  return {
    dailyTrend: daily,
    h4Trend: h4,
    dailyAverage: Number.isFinite(s.dailyAverage[i]) ? s.dailyAverage[i] : null,
    h4Ema: Number.isFinite(s.h4Ema[i]) ? s.h4Ema[i] : null,
    side,
    leg,
    legAtr,
    zone,
    stopLoss,
    takeProfit,
    checks,
    blocked,
    setup,
  };
}
