import type { Candle, SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";
import { wilderAtr } from "./trendline";

/**
 * Supply and demand, traded the way the method is taught: a zone is the small
 * base price left in a hurry; the first time price comes back to it, the
 * orders left there are expected to turn it again.
 *
 *  - ZONE (30-minute chart): a base of one to three small-bodied candles,
 *    left by a candle whose body is at least 60% of its range and 1.2 ATR
 *    long. A rally out of the base makes a DEMAND zone, a drop a SUPPLY zone.
 *    The PROXIMAL line is the edge of the base bodies nearest to price, the
 *    DISTAL line the far wick. A zone is FRESH until price has come back to
 *    it; it is gone once a candle closes beyond the distal line, and after
 *    ten days.
 *  - ENTRY (15-minute chart), with the daily trend only — demand zones are
 *    bought in an uptrend, supply zones sold in a downtrend: a candle trades
 *    into a fresh zone and CLOSES BACK OUT of it, rising from demand or
 *    falling from supply — the zone has been rejected. That close is the
 *    entry (the "confirmation" entry; a resting limit order at the proximal
 *    line lost money on five years of gold).
 *  - STOP just beyond the distal line. TARGET three times the risk.
 *
 * What the losing trades had in common, and what is left out for it:
 *  - a rejection that came more than two candles after price first reached
 *    the zone (83 trades, −11.5R) — the zone was being worn down, not rejected;
 *  - a candle that went deeper than half-way into the zone (107 trades,
 *    −13.6R) — the orders there were being filled through;
 *  - the 1-hour ADX at 40 or more (49 trades, −7R) — the move was exhausted.
 * Against the daily trend the same entry lost 60R: it is never taken.
 *
 * Everything is read from CLOSED candles; a zone is used only by candles that
 * open after the candle that made it has closed.
 */

export const ZN_SECONDS = 1800;
/** 15-minute candles a scan reads: the ten days a zone lives, and as much again for the ATR and the bases */
export const ZN_HISTORY = 1500;
/** a base of up to this many candles … */
export const ZN_BASE_MAX = 3;
/** … each with a body no bigger than this share of its range … */
export const ZN_BASE_BODY = 0.5;
/** … left by a candle whose body is at least this share of its range and this many ATRs long */
export const ZN_LEG_BODY = 0.6;
export const ZN_LEG_ATR = 1.2;
/** a zone counts for this many days */
export const ZN_LIFE_DAYS = 10;
/** the rejection has to come within this many 15-minute candles of the first touch */
export const ZN_WAIT_BARS = 2;
/** the candle may not have gone deeper into the zone than this share of its height */
export const ZN_MAX_DEPTH = 0.5;
/** no trade with the 1-hour ADX at or above this */
export const ZN_ADX_MAX = 40;
/** the stop sits this far beyond the distal line, in 15-minute ATRs */
export const ZN_STOP_BUFFER_ATR = 0.2;
export const ZN_TARGET_R = 3;
/** no trade when the spread and slippage are more than this share of the risk */
export const ZN_MAX_COST_SHARE = 0.1;
/** 15-minute candles after which an undecided trade is closed at market: five trading days */
export const ZN_MAX_HOLD_BARS = 480;
/** the daily trend: the last closed day's close against its 50-day average */
export const ZN_TREND_DAYS = 50;
export const ZN_KEY_PREFIX = "sd:" as const;

/** A supply (sell) or demand (buy) zone of the 30-minute chart. */
export interface Zone {
  kind: "demand" | "supply";
  /** the edge price returns to first, and the far edge */
  proximal: number;
  distal: number;
  /** when it was known — the close of the candle that left the base — and when it lapses (epoch seconds) */
  known: number;
  expires: number;
  /** candles in its base */
  base: number;
}

/** Candles of `seconds` length built from 15-minute ones (the data feed aligns 30-minute candles to the clock, so these match its own). */
function aggregate(candles: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / seconds) * seconds;
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

/** Every zone of a 30-minute series, oldest first. */
export function findZones(c: Candle[]): Zone[] {
  const atr = wilderAtr(c);
  const out: Zone[] = [];
  for (let j = 15; j < c.length; j++) {
    const leg = c[j];
    const body = Math.abs(leg.close - leg.open);
    const range = leg.high - leg.low;
    if (!(range > 0) || body < ZN_LEG_BODY * range || !(body >= ZN_LEG_ATR * atr[j - 1])) continue;
    const up = leg.close > leg.open;
    const base: Candle[] = [];
    for (let k = j - 1; k >= 0 && base.length < ZN_BASE_MAX; k--) {
      const b = c[k];
      const rb = b.high - b.low;
      if (rb > 0 && Math.abs(b.close - b.open) <= ZN_BASE_BODY * rb) base.push(b);
      else break;
    }
    if (!base.length) continue;
    const baseHigh = Math.max(...base.map((b) => b.high));
    const baseLow = Math.min(...base.map((b) => b.low));
    // the candle has to leave the base
    if (up ? leg.close <= baseHigh : leg.close >= baseLow) continue;
    const proximal = up ? Math.max(...base.map((b) => Math.max(b.open, b.close))) : Math.min(...base.map((b) => Math.min(b.open, b.close)));
    const distal = up ? Math.min(baseLow, leg.low) : Math.max(baseHigh, leg.high);
    const known = leg.time + ZN_SECONDS;
    out.push({ kind: up ? "demand" : "supply", proximal, distal, known, expires: known + ZN_LIFE_DAYS * 86_400, base: base.length });
  }
  return out;
}

/** A 15-minute candle that rejected a zone. */
export interface ZoneEvent {
  zone: Zone;
  direction: SignalDirection;
  /** index of the 15-minute candle, and when it closed (epoch seconds) */
  index: number;
  time: number;
  close: number;
  /** 15-minute candles since price first reached the zone (0 = this candle) */
  bars: number;
  /** how far into the zone the candle went, as a share of its height (over 1 = beyond the distal line) */
  depth: number;
  /** the stop: beyond the distal line */
  stop: number;
  atr: number;
  key: string;
}

/** A zone as it stands at the last candle. */
export interface LiveZone extends Zone {
  /** price has reached it in the last candles and it has not been rejected yet */
  touched: boolean;
}

export interface ZoneRead {
  /** the rejections from candle `from` on, oldest first */
  events: ZoneEvent[];
  /** the zones still fresh at the last candle */
  zones: LiveZone[];
  m15: Candle[];
}

/**
 * Read closed 15-minute candles (oldest first): the zones of the 30-minute
 * chart built from them, what price has done to each since, and every
 * rejection from index `from` on (by default only the last candle's).
 */
export function readZones(m15: Candle[], from: number = m15.length - 1): ZoneRead {
  const all = findZones(aggregate(m15, ZN_SECONDS));
  const atr = wilderAtr(m15);
  const events: ZoneEvent[] = [];
  let live: { z: Zone; touchedAt: number }[] = [];
  let zi = 0;
  for (let i = 0; i < m15.length; i++) {
    const c = m15[i];
    const t = c.time + 900;
    // a zone is used only by candles that open once it is known
    while (zi < all.length && all[zi].known <= c.time) live.push({ z: all[zi++], touchedAt: -1 });
    const keep: typeof live = [];
    for (const w of live) {
      const z = w.z;
      if (z.expires <= t) continue;
      const d = z.kind === "demand" ? 1 : -1;
      // a close beyond the far edge: the zone has failed
      if (d === 1 ? c.close < z.distal : c.close > z.distal) continue;
      const inZone = d === 1 ? c.low <= z.proximal : c.high >= z.proximal;
      if (inZone && w.touchedAt < 0) w.touchedAt = i;
      // not rejected within the candles allowed: used up
      if (w.touchedAt >= 0 && i - w.touchedAt > ZN_WAIT_BARS) continue;
      const rejected = inZone && (d === 1 ? c.close >= z.proximal && c.close > c.open : c.close <= z.proximal && c.close < c.open);
      if (!rejected) {
        keep.push(w);
        continue;
      }
      // one entry a zone
      if (i >= from) {
        events.push({
          zone: z,
          direction: d === 1 ? "long" : "short",
          index: i,
          time: t,
          close: c.close,
          bars: i - w.touchedAt,
          depth: (d * (z.proximal - (d === 1 ? c.low : c.high))) / Math.max(1e-9, Math.abs(z.proximal - z.distal)),
          stop: z.distal - d * ZN_STOP_BUFFER_ATR * atr[i],
          atr: atr[i],
          key: `${ZN_KEY_PREFIX}${z.kind}:${z.known}:${c.time}`,
        });
      }
    }
    live = keep;
  }
  return { events, zones: live.map((w) => ({ ...w.z, touched: w.touchedAt >= 0 })), m15 };
}

const isWeekend = (c: Candle) => [5, 6].includes(new Date(c.time * 1000).getUTCDay());

/** The daily trend as it stood at `time` (epoch seconds): 1 up, −1 down, 0 unknown. Only days that had closed by then count. */
export function znDailyTrend(daily: Candle[], time: number): 1 | -1 | 0 {
  const days = daily.filter((d) => !isWeekend(d) && d.time + 86_400 <= time);
  if (days.length < ZN_TREND_DAYS) return 0;
  let sum = 0;
  for (let k = days.length - ZN_TREND_DAYS; k < days.length; k++) sum += days[k].close;
  const avg = sum / ZN_TREND_DAYS;
  const close = days[days.length - 1].close;
  return close > avg ? 1 : close < avg ? -1 : 0;
}

export interface ZnSetup {
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  zone: Zone;
  /** when the signal candle closed (epoch seconds) */
  time: number;
  atr: number;
  key: string;
}

/**
 * The trade a rejection gives, or why it gives none. `dailyTrend` and `adx`
 * (the 1-hour ADX) are as they stood when the candle closed; `entry` is the
 * price the trade is entered at (the close, or the next open in the backtest).
 */
export function znSetup(ev: ZoneEvent, dailyTrend: number, adx: number, entry: number = ev.close, pair = "XAU_USD"): { setup: ZnSetup | null; reason: string | null } {
  const dir = ev.direction === "long" ? 1 : -1;
  const side = ev.zone.kind === "demand" ? "buy at demand" : "sell at supply";
  if (dailyTrend !== dir) return { setup: null, reason: `a ${side} against the daily trend` };
  if (ev.bars > ZN_WAIT_BARS) return { setup: null, reason: "the rejection came too long after price reached the zone" };
  if (ev.depth >= ZN_MAX_DEPTH) return { setup: null, reason: `the candle went ${(ev.depth * 100).toFixed(0)}% into the zone — more than half-way, the zone is being filled through` };
  if (adx >= ZN_ADX_MAX) return { setup: null, reason: `the 1-hour ADX is ${adx.toFixed(0)} — the move is exhausted (limit ${ZN_ADX_MAX})` };
  const risk = dir * (entry - ev.stop);
  if (!Number.isFinite(risk) || !(risk > 0)) return { setup: null, reason: "price is already beyond the stop" };
  if (tradeCost(pair) > ZN_MAX_COST_SHARE * risk) return { setup: null, reason: "the costs are too large a share of the risk" };
  return { setup: { direction: ev.direction, entry, stopLoss: ev.stop, takeProfit: entry + dir * ZN_TARGET_R * risk, risk, zone: ev.zone, time: ev.time, atr: ev.atr, key: ev.key }, reason: null };
}
