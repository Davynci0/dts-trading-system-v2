import type { Candle } from "@/lib/types";
import { emaOf } from "@/lib/analysis/trend";

/**
 * The Bitcoin system (BTC/USD only): A BREAK OF YESTERDAY'S HIGH OR LOW, WITH
 * THE TREND, on the 4-hour chart. It is a different system from the gold
 * scalp, with its own rules — the gold rules lose on Bitcoin, and so did every
 * 15-minute and 1-hour method that was tested on it (README, "Bitcoin").
 *
 * These rules were chosen on the years 2016 to 2021 and then run once on the
 * five years after, which they had never seen; they replaced the first rules
 * (a break of the last 20 candles' range) on 26 November 2026.
 *
 *  - THE TREND: the 4-hour close against the 200-EMA of the 4-hour chart.
 *    Above it only buys, below it only sells.
 *  - THE ENTRY: the first 4-hour candle of the day that CLOSES above
 *    yesterday's high (buy) or below yesterday's low (sell). "Yesterday" is the
 *    last daily candle that has closed (17:00 New York). Only the first close
 *    beyond of the day counts, on each side — and if that first close is
 *    against the trend, that side is not traded that day. The trade is entered
 *    at market at that close.
 *  - THE STOP: just beyond the low (buy) / high (sell) of the last two 4-hour
 *    candles, by 0.2 ATR; never closer than 1.5 ATR (4-hour ATR) and never
 *    further than 2 ATR — a stop that would be further is pulled in to 2 ATR.
 *  - THE EXIT: a take-profit at 3 times the risk, the stop, or the clock — a
 *    trade that has reached neither after 72 hours of trading is closed at
 *    market.
 *  - THE PROFIT LOCK: once price has gone 0.6R the trade's way, the stop is
 *    moved to 0.2R in profit.
 *  - ONE TRADE AT A TIME. No trade when the spread and slippage would be more
 *    than 6% of the risk, and none when the market is closed at the 4-hour
 *    close (the weekend).
 */
export const BTC_PAIR = "BTC_USD";
/** The chart the entries are read on: 4-hour candles, built from 1-hour candles on the UTC clock (00:00, 04:00, …). */
export const BTC_CHART_SECONDS = 14400;
/** The trend: the 4-hour close against the EMA of this many 4-hour closes. */
export const BTC_TREND_EMA = 200;
/** The stop goes beyond the low/high of this many last 4-hour candles… */
export const BTC_STOP_CANDLES = 2;
/** …by this many ATR, and the risk is kept between these many ATR. */
export const BTC_STOP_BUFFER_ATR = 0.2;
export const BTC_MIN_RISK_ATR = 1.5;
export const BTC_MAX_RISK_ATR = 2;
/** Take-profit in R. */
export const BTC_TARGET_R = 3;
/** Profit lock: once price has gone this many R the trade's way, the stop is moved to this many R in profit. */
export const BTC_LOCK_AT_R = 0.6;
export const BTC_LOCK_TO_R = 0.2;
/** A trade that has reached neither level by the close of this many 15-minute candles (72 hours of trading) is closed at market. */
export const BTC_MAX_HOLD_BARS = 288;
/** What one trade costs, in dollars a coin: the spread (about $43 at the data provider in November 2026) plus slippage. */
export const BTC_COST = 45;
/** No trade when the cost is more than this share of the risk. */
export const BTC_MAX_COST_SHARE = 0.06;
/** No trade when the market opens again more than this many seconds after the 4-hour close (it was closed at the close). */
export const BTC_MAX_ENTRY_DELAY = 3600;
/** 4-hour candles needed before the reads have settled (the 200-EMA and the ATR). */
export const BTC_MIN_CANDLES = 260;

const PERIOD = 14;
const DAY = 86400;

/** 4-hour candles built from shorter ones on the UTC clock. A candle cut short by the weekend keeps the candles it has. */
export function fourHour(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / BTC_CHART_SECONDS) * BTC_CHART_SECONDS;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  return out;
}

export interface BtcSeries {
  /** closed 4-hour candles, oldest first */
  h4: Candle[];
  n: number;
  /** 4-hour ATR (Wilder, 14) */
  atr: Float64Array;
  /** the 200-EMA of the 4-hour closes */
  ema: Float64Array;
  /** the last daily candle CLOSED when each 4-hour candle closed: its number, its high and its low */
  day: Int32Array;
  prevHigh: Float64Array;
  prevLow: Float64Array;
  /** this candle is the first of its day to close above yesterday's high / below yesterday's low */
  firstAbove: Uint8Array;
  firstBelow: Uint8Array;
  /** a candle of this day has already closed above yesterday's high / below yesterday's low, this one included */
  usedAbove: Uint8Array;
  usedBelow: Uint8Array;
  /** the daily candles the days are counted in (weekday candles only) */
  days: Candle[];
}

/**
 * The series the rules are read from. `h1` are closed 1-hour candles (the
 * 4-hour chart is built from them), `daily` closed daily candles. `now`
 * (epoch seconds) drops a last 4-hour candle that has not closed yet.
 */
export function buildBtcSeries(input: { h1: Candle[]; daily: Candle[]; now?: number }): BtcSeries {
  // each 4-hour candle with the moment its last 1-hour candle ended (earlier than the clock's end before a weekend)
  const ends = new Map<number, number>();
  for (const c of input.h1) ends.set(Math.floor(c.time / BTC_CHART_SECONDS) * BTC_CHART_SECONDS, c.time + 3600);
  let h4 = fourHour(input.h1);
  if (input.now != null) h4 = h4.filter((c) => c.time + BTC_CHART_SECONDS <= input.now!);
  const n = h4.length;
  // the data provider prints an empty daily candle on some weekends (it opens on a Friday or Saturday, UTC)
  const days = input.daily.filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
  const s: BtcSeries = {
    h4,
    n,
    atr: new Float64Array(n).fill(NaN),
    ema: emaOf(h4, BTC_TREND_EMA),
    day: new Int32Array(n).fill(-1),
    prevHigh: new Float64Array(n).fill(NaN),
    prevLow: new Float64Array(n).fill(NaN),
    firstAbove: new Uint8Array(n),
    firstBelow: new Uint8Array(n),
    usedAbove: new Uint8Array(n),
    usedBelow: new Uint8Array(n),
    days,
  };
  let atr = 0;
  for (let j = 1; j < n; j++) {
    const c = h4[j];
    const p = h4[j - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr = j <= PERIOD ? atr + tr / PERIOD : (atr * (PERIOD - 1) + tr) / PERIOD;
    if (j >= PERIOD) s.atr[j] = atr;
  }
  let p = -1;
  let above = false;
  let below = false;
  for (let j = 0; j < n; j++) {
    // "yesterday" is the last daily candle closed by the start of this candle's last quarter of an hour
    const known = (ends.get(h4[j].time) ?? h4[j].time + BTC_CHART_SECONDS) - 900;
    const before = p;
    while (p + 1 < days.length && days[p + 1].time + DAY <= known) p++;
    if (p !== before) {
      above = false;
      below = false;
    }
    s.day[j] = p;
    if (p < 0) continue;
    s.prevHigh[j] = days[p].high;
    s.prevLow[j] = days[p].low;
    if (h4[j].close > days[p].high && !above) {
      s.firstAbove[j] = 1;
      above = true;
    }
    if (h4[j].close < days[p].low && !below) {
      s.firstBelow[j] = 1;
      below = true;
    }
    s.usedAbove[j] = above ? 1 : 0;
    s.usedBelow[j] = below ? 1 : 0;
  }
  return s;
}

export interface BtcSetup {
  direction: "long" | "short";
  /** the close of the 4-hour signal candle (epoch seconds) */
  time: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** the distance from the entry to the stop: 1R */
  risk: number;
  /** yesterday's high (buy) / low (sell), which the candle closed beyond */
  level: number;
  /** where the profit lock moves the stop, and the price that triggers it */
  lockTrigger: number;
  lockStop: number;
  /** the stop sits beyond the last candles' extreme, or was pulled in to the limit / pushed out to the minimum */
  stopBasis: "candles" | "limit" | "minimum";
}

export interface BtcState {
  /** the last closed 4-hour candle this was read on: its open time and its close time */
  candleTime: number;
  readAt: number;
  close: number;
  /** +1 the close is above the 200-EMA (buys only), −1 below it (sells only) */
  trend: 1 | -1 | 0;
  ema: number | null;
  atr: number | null;
  /** yesterday's high and low, as this candle was read against them */
  prevHigh: number | null;
  prevLow: number | null;
  /** the level the NEXT 4-hour candle has to close beyond, on the trend's side, and whether that side can still be traded today */
  nextLevel: number | null;
  nextArmed: boolean;
  /** false when the daily candle closes before the next 4-hour candle does: the level shown will then be replaced by today's high or low */
  nextLevelFinal: boolean;
  /** what a trade would risk at least and at most, per coin */
  minRisk: number | null;
  maxRisk: number | null;
  checks: { label: string; met: boolean }[];
  /** why there is no trade on this candle, in plain words — null when there is one */
  waiting: string | null;
  setup: BtcSetup | null;
}

const money = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * The read of the 4-hour candle `j` at its close. `entry` is the price the
 * trade would be filled at (the open of the next 15-minute candle); without
 * it the candle's close is used. `now` (epoch seconds, default the candle's
 * close) is the moment the page is read at: a daily candle that has closed
 * since the 4-hour candle did already gives the next candle its level.
 */
export function btcStateAt(s: BtcSeries, j: number, entry?: number, now?: number): BtcState {
  const c = s.h4[j];
  const atr = s.atr[j];
  const ema = s.ema[j];
  const enough = j >= BTC_MIN_CANDLES && atr > 0 && Number.isFinite(ema) && s.day[j] >= 0;
  const trend = (enough ? (c.close > ema ? 1 : c.close < ema ? -1 : 0) : 0) as 1 | -1 | 0;
  // which side closed beyond yesterday's range on this candle, for the first time today
  const dir = (s.firstAbove[j] ? 1 : s.firstBelow[j] ? -1 : 0) as 1 | -1 | 0;
  const beyondUp = c.close > s.prevHigh[j];
  const beyondDown = c.close < s.prevLow[j];
  const beyond = trend === 1 ? beyondUp : trend === -1 ? beyondDown : false;
  const first = dir !== 0 && dir === trend;
  const against = dir !== 0 && dir !== trend;

  let setup: BtcSetup | null = null;
  let affordable = true;
  if (enough && first) {
    const price = entry ?? c.close;
    let extreme = dir === 1 ? Infinity : -Infinity;
    for (let q = j - BTC_STOP_CANDLES + 1; q <= j; q++) extreme = dir === 1 ? Math.min(extreme, s.h4[q].low) : Math.max(extreme, s.h4[q].high);
    const raw = dir * (price - (extreme - dir * BTC_STOP_BUFFER_ATR * atr));
    if (raw > 0) {
      const risk = Math.min(Math.max(raw, BTC_MIN_RISK_ATR * atr), BTC_MAX_RISK_ATR * atr);
      affordable = BTC_COST / risk <= BTC_MAX_COST_SHARE;
      if (affordable) {
        setup = {
          direction: dir === 1 ? "long" : "short",
          time: c.time + BTC_CHART_SECONDS,
          entry: price,
          stopLoss: price - dir * risk,
          takeProfit: price + dir * BTC_TARGET_R * risk,
          risk,
          level: dir === 1 ? s.prevHigh[j] : s.prevLow[j],
          lockTrigger: price + dir * BTC_LOCK_AT_R * risk,
          lockStop: price + dir * BTC_LOCK_TO_R * risk,
          stopBasis: raw > BTC_MAX_RISK_ATR * atr ? "limit" : raw < BTC_MIN_RISK_ATR * atr ? "minimum" : "candles",
        };
      }
    }
  }

  // the next candle: which day it belongs to, the level on the trend's side, and whether that side has been used today
  let nextLevel: number | null = null;
  let nextArmed = false;
  let nextLevelFinal = true;
  if (enough && trend !== 0) {
    // the next candle is read against the last daily candle closed a quarter of an hour before it closes
    const known = c.time + 2 * BTC_CHART_SECONDS - 900;
    const at = Math.min(now ?? c.time + BTC_CHART_SECONDS, known);
    let p = s.day[j];
    while (p + 1 < s.days.length && s.days[p + 1].time + DAY <= at) p++;
    nextLevel = trend === 1 ? s.days[p].high : s.days[p].low;
    nextArmed = p !== s.day[j] || !(trend === 1 ? s.usedAbove[j] : s.usedBelow[j]);
    // when the daily candle now running closes: it opened when the last closed one ended, the weekend's empty candles skipped
    let open = s.days[p].time + DAY;
    while ([5, 6].includes(new Date(open * 1000).getUTCDay())) open += DAY;
    nextLevelFinal = open + DAY > known;
  }
  const side = trend === 1 ? "buy" : "sell";
  const word = trend === 1 ? "above" : "below";
  const edge = trend === 1 ? "high" : "low";
  const level = trend === 1 ? s.prevHigh[j] : s.prevLow[j];
  const checks = [
    {
      label: !enough || trend === 0 ? `Trend not known yet (4-hour close vs its ${BTC_TREND_EMA}-EMA)` : `Trend ${trend === 1 ? "up" : "down"}: the 4-hour close (${money(c.close)}) is ${word} its ${BTC_TREND_EMA}-EMA (${money(ema)})`,
      met: trend !== 0,
    },
    {
      label: trend === 0 || !Number.isFinite(level) ? "A 4-hour candle closing beyond yesterday's high or low" : `A 4-hour close ${word} yesterday's ${edge} (${money(level)}) — this one closed at ${money(c.close)}`,
      met: beyond,
    },
    { label: "The first such close of the day, not a later one", met: first },
    { label: `Costs no more than ${BTC_MAX_COST_SHARE * 100}% of the risk ($${BTC_COST} a coin)`, met: affordable },
  ];
  let waiting: string | null = null;
  if (!enough) waiting = "not enough 4-hour history yet";
  else if (trend === 0) waiting = "the trend is not clear";
  else if (against) waiting = `this candle closed ${dir === 1 ? "above yesterday's high" : "below yesterday's low"}, against the trend — no ${dir === 1 ? "buy" : "sell"} ${dir === 1 ? "below" : "above"} the ${BTC_TREND_EMA}-EMA`;
  else if (beyond && !first) waiting = `price has already closed ${word} yesterday's ${edge} today — only the first 4-hour close beyond it is traded`;
  else if (!beyond)
    waiting = !nextLevelFinal
      ? `the day closes (17:00 New York) before the next 4-hour candle does — the next ${side} level will be today's ${edge}, known at that close`
      : nextArmed && nextLevel != null
        ? `waiting for a 4-hour candle to close ${word} ${money(nextLevel)} — yesterday's ${edge}`
        : `today's ${side} has been used — waiting for tomorrow's level`;
  else if (!affordable) waiting = `the stop would be too close for the costs ($${BTC_COST} a coin is more than ${BTC_MAX_COST_SHARE * 100}% of the risk)`;
  else if (!setup) waiting = "the stop level is on the wrong side of the price";

  return {
    candleTime: c.time,
    readAt: c.time + BTC_CHART_SECONDS,
    close: c.close,
    trend,
    ema: Number.isFinite(ema) ? ema : null,
    atr: atr > 0 ? atr : null,
    prevHigh: Number.isFinite(s.prevHigh[j]) ? s.prevHigh[j] : null,
    prevLow: Number.isFinite(s.prevLow[j]) ? s.prevLow[j] : null,
    nextLevel,
    nextArmed,
    nextLevelFinal,
    minRisk: atr > 0 ? BTC_MIN_RISK_ATR * atr : null,
    maxRisk: atr > 0 ? BTC_MAX_RISK_ATR * atr : null,
    checks,
    waiting,
    setup,
  };
}
