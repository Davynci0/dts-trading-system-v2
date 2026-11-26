import type { Candle } from "@/lib/types";

/**
 * The Bitcoin system (BTC/USD only): a RANGE BREAKOUT WITH THE DAILY TREND on
 * the 4-hour chart. It is a different system from the gold scalp, with its own
 * rules — the gold rules lose on Bitcoin, and so did every 15-minute and
 * 1-hour method that was tested on it (README, "Bitcoin").
 *
 *  - THE TREND: the last closed daily candle against the average of the last
 *    50 daily closes. Above it only buys, below it only sells.
 *  - THE ENTRY: a 4-hour candle that CLOSES beyond the high (buy) or the low
 *    (sell) of the 20 four-hour candles before it — the first close beyond,
 *    not the second. The trade is entered at market at that close. This is
 *    the Donchian channel breakout as trend followers use it on Bitcoin.
 *  - THE STOP: just beyond the low (buy) / high (sell) of the last two 4-hour
 *    candles, by 0.2 ATR; never closer than 0.75 ATR (4-hour ATR) and never
 *    further than 2 ATR — a stop that would be further is pulled in to 2 ATR.
 *  - THE EXIT: a take-profit at 3 times the risk, the stop, or the clock — a
 *    trade that has reached neither after 48 hours of trading is closed at
 *    market.
 *  - THE PROFIT LOCK: once price has gone 0.4R the trade's way, the stop is
 *    moved to 0.2R in profit. It is what makes two trades in three close in
 *    profit; without it the system makes more but wins only four in ten.
 *  - ONE TRADE AT A TIME. No trade when the spread and slippage would be more
 *    than 6% of the risk, and none when the market is closed at the 4-hour
 *    close (the weekend).
 */
export const BTC_PAIR = "BTC_USD";
/** The chart the entries are read on: 4-hour candles, built from 1-hour candles on the UTC clock (00:00, 04:00, …). */
export const BTC_CHART_SECONDS = 14400;
/** The breakout: a close beyond the high/low of this many earlier 4-hour candles. */
export const BTC_RANGE_CANDLES = 20;
/** The daily trend: the last closed daily candle against the average of this many daily closes. */
export const BTC_TREND_DAYS = 50;
/** The stop goes beyond the low/high of this many last 4-hour candles… */
export const BTC_STOP_CANDLES = 2;
/** …by this many ATR, and the risk is kept between these many ATR. */
export const BTC_STOP_BUFFER_ATR = 0.2;
export const BTC_MIN_RISK_ATR = 0.75;
export const BTC_MAX_RISK_ATR = 2;
/** Take-profit in R. */
export const BTC_TARGET_R = 3;
/** Profit lock: once price has gone this many R the trade's way, the stop is moved to this many R in profit. */
export const BTC_LOCK_AT_R = 0.4;
export const BTC_LOCK_TO_R = 0.2;
/** A trade that has reached neither level by the close of this many 15-minute candles (48 hours of trading) is closed at market. */
export const BTC_MAX_HOLD_BARS = 192;
/** What one trade costs, in dollars a coin: the spread (about $43 at the data provider in November 2026) plus slippage. */
export const BTC_COST = 45;
/** No trade when the cost is more than this share of the risk. */
export const BTC_MAX_COST_SHARE = 0.06;
/** No trade when the market opens again more than this many seconds after the 4-hour close (it was closed at the close). */
export const BTC_MAX_ENTRY_DELAY = 3600;
/** 4-hour candles needed before the reads have settled (the ATR and the range). */
export const BTC_MIN_CANDLES = 60;

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
  /** highest high / lowest low of the BTC_RANGE_CANDLES candles BEFORE each candle */
  rangeHigh: Float64Array;
  rangeLow: Float64Array;
  /** +1 / −1 / 0 from the last daily candle CLOSED when each 4-hour candle closed, and the average it was read against */
  dailyTrend: Int8Array;
  dailyAverage: Float64Array;
  dailyClose: Float64Array;
}

/**
 * The series the rules are read from. `h1` are closed 1-hour candles (the
 * 4-hour chart is built from them), `daily` closed daily candles. `now`
 * (epoch seconds) drops a last 4-hour candle that has not closed yet.
 */
export function buildBtcSeries(input: { h1: Candle[]; daily: Candle[]; now?: number }): BtcSeries {
  let h4 = fourHour(input.h1);
  if (input.now != null) h4 = h4.filter((c) => c.time + BTC_CHART_SECONDS <= input.now!);
  const n = h4.length;
  const s: BtcSeries = {
    h4,
    n,
    atr: new Float64Array(n).fill(NaN),
    rangeHigh: new Float64Array(n).fill(NaN),
    rangeLow: new Float64Array(n).fill(NaN),
    dailyTrend: new Int8Array(n),
    dailyAverage: new Float64Array(n).fill(NaN),
    dailyClose: new Float64Array(n).fill(NaN),
  };
  let atr = 0;
  for (let j = 1; j < n; j++) {
    const c = h4[j];
    const p = h4[j - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr = j <= PERIOD ? atr + tr / PERIOD : (atr * (PERIOD - 1) + tr) / PERIOD;
    if (j >= PERIOD) s.atr[j] = atr;
  }
  for (let j = BTC_RANGE_CANDLES; j < n; j++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let q = j - BTC_RANGE_CANDLES; q < j; q++) {
      hi = Math.max(hi, h4[q].high);
      lo = Math.min(lo, h4[q].low);
    }
    s.rangeHigh[j] = hi;
    s.rangeLow[j] = lo;
  }
  // the data provider prints an empty daily candle on some weekends (it opens on a Friday or Saturday, UTC)
  const days = input.daily.filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
  const avg = new Float64Array(days.length).fill(NaN);
  let sum = 0;
  for (let k = 0; k < days.length; k++) {
    sum += days[k].close;
    if (k >= BTC_TREND_DAYS) sum -= days[k - BTC_TREND_DAYS].close;
    if (k >= BTC_TREND_DAYS - 1) avg[k] = sum / BTC_TREND_DAYS;
  }
  let p = -1;
  for (let j = 0; j < n; j++) {
    const closed = h4[j].time + BTC_CHART_SECONDS;
    while (p + 1 < days.length && days[p + 1].time + DAY <= closed) p++;
    if (p >= 0 && Number.isFinite(avg[p])) {
      s.dailyTrend[j] = days[p].close > avg[p] ? 1 : days[p].close < avg[p] ? -1 : 0;
      s.dailyAverage[j] = avg[p];
      s.dailyClose[j] = days[p].close;
    }
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
  /** the range edge the candle closed beyond */
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
  dailyTrend: 1 | -1 | 0;
  dailyAverage: number | null;
  dailyClose: number | null;
  atr: number | null;
  /** the range the candle that has just closed had to break: the high and low of the 20 candles before it */
  rangeHigh: number | null;
  rangeLow: number | null;
  /** the level the NEXT 4-hour candle has to close beyond, on the trend's side, and whether it still can be a first close beyond */
  nextLevel: number | null;
  nextArmed: boolean;
  /** what a trade taken at the next level would risk at most and at least, per coin */
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
 * it the candle's close is used.
 */
export function btcStateAt(s: BtcSeries, j: number, entry?: number): BtcState {
  const c = s.h4[j];
  const atr = s.atr[j];
  const trend = (j >= 0 ? s.dailyTrend[j] : 0) as 1 | -1 | 0;
  const dir = trend;
  const enough = j >= BTC_MIN_CANDLES && atr > 0;
  const level = dir === 1 ? s.rangeHigh[j] : dir === -1 ? s.rangeLow[j] : NaN;
  const beyond = dir !== 0 && Number.isFinite(level) && dir * (c.close - level) > 0;
  const prevLevel = j >= 1 ? (dir === 1 ? s.rangeHigh[j - 1] : s.rangeLow[j - 1]) : NaN;
  const wasBeyond = dir !== 0 && j >= 1 && Number.isFinite(prevLevel) && dir * (s.h4[j - 1].close - prevLevel) > 0;
  const first = beyond && !wasBeyond;

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
          level,
          lockTrigger: price + dir * BTC_LOCK_AT_R * risk,
          lockStop: price + dir * BTC_LOCK_TO_R * risk,
          stopBasis: raw > BTC_MAX_RISK_ATR * atr ? "limit" : raw < BTC_MIN_RISK_ATR * atr ? "minimum" : "candles",
        };
      }
    }
  }

  // the level the next candle has to close beyond: the range of the last 20 closed candles
  let nextLevel: number | null = null;
  if (dir !== 0 && j + 1 >= BTC_RANGE_CANDLES) {
    let x = dir === 1 ? -Infinity : Infinity;
    for (let q = j + 1 - BTC_RANGE_CANDLES; q <= j; q++) x = dir === 1 ? Math.max(x, s.h4[q].high) : Math.min(x, s.h4[q].low);
    nextLevel = x;
  }
  const side = dir === 1 ? "buy" : "sell";
  const word = dir === 1 ? "above" : "below";
  const checks = [
    {
      label:
        trend === 0
          ? `Daily trend not known yet (close vs ${BTC_TREND_DAYS}-day average)`
          : `Daily trend ${trend === 1 ? "up" : "down"}: the last daily close (${money(s.dailyClose[j])}) is ${trend === 1 ? "above" : "below"} its ${BTC_TREND_DAYS}-day average (${money(s.dailyAverage[j])})`,
      met: trend !== 0,
    },
    {
      label:
        dir === 0 || !Number.isFinite(level)
          ? `A 4-hour candle closing beyond the range of the last ${BTC_RANGE_CANDLES}`
          : `A 4-hour close ${word} the ${dir === 1 ? "high" : "low"} of the ${BTC_RANGE_CANDLES} candles before it (${money(level)}) — this one closed at ${money(c.close)}`,
      met: beyond,
    },
    { label: "The first close beyond the range, not a later one", met: first },
    { label: `Costs no more than ${BTC_MAX_COST_SHARE * 100}% of the risk ($${BTC_COST} a coin)`, met: affordable },
  ];
  let waiting: string | null = null;
  if (!enough) waiting = "not enough 4-hour history yet";
  else if (trend === 0) waiting = "the daily trend is not known yet";
  else if (!beyond) waiting = `waiting for a 4-hour candle to close ${word} ${nextLevel != null ? money(nextLevel) : "the range"} — the ${dir === 1 ? "high" : "low"} of the last ${BTC_RANGE_CANDLES} four-hour candles`;
  else if (!first) waiting = `price has already broken out — the ${side} was at the first 4-hour close ${word} the range, and a later close is not traded`;
  else if (!affordable) waiting = `the stop would be too close for the costs ($${BTC_COST} a coin is more than ${BTC_MAX_COST_SHARE * 100}% of the risk)`;
  else if (!setup) waiting = "the stop level is on the wrong side of the price";

  return {
    candleTime: c.time,
    readAt: c.time + BTC_CHART_SECONDS,
    close: c.close,
    dailyTrend: trend,
    dailyAverage: Number.isFinite(s.dailyAverage[j]) ? s.dailyAverage[j] : null,
    dailyClose: Number.isFinite(s.dailyClose[j]) ? s.dailyClose[j] : null,
    atr: atr > 0 ? atr : null,
    rangeHigh: Number.isFinite(s.rangeHigh[j]) ? s.rangeHigh[j] : null,
    rangeLow: Number.isFinite(s.rangeLow[j]) ? s.rangeLow[j] : null,
    nextLevel,
    // the next candle's close can only be a FIRST close beyond if this one is not beyond the level the next one is read against
    nextArmed: nextLevel != null && !(dir * (c.close - nextLevel) > 0) && !beyond,
    minRisk: atr > 0 ? BTC_MIN_RISK_ATR * atr : null,
    maxRisk: atr > 0 ? BTC_MAX_RISK_ATR * atr : null,
    checks,
    waiting,
    setup,
  };
}
