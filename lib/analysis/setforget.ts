import type { Candle, SignalDirection } from "@/lib/types";
import { tradeCost } from "./instruments";
import { readStructure, swingPoints, wilderAtr, type Structure, type SwingPoint } from "./structure";

/**
 * Set and Forget, the swing method Alex Gonzalez (fxalexg, Swing Trading Lab)
 * teaches, as he describes it on his own channel:
 *
 *  1. TOP-DOWN TREND. The weekly, daily and 4-hour charts give the trend, each
 *     read from its structure points: higher highs and higher lows, or lower
 *     highs and lower lows. A timeframe only changes direction when a candle
 *     BODY closes beyond the last structure point — a wick does not count. The
 *     trade is taken with these three timeframes.
 *  2. AREA OF INTEREST. No trade without one. It is a level on the weekly or
 *     daily chart that price has turned at, from above or from below, at least
 *     three times in the last one to three years.
 *  3. WAIT. Price has to pull back into the area. Nothing is done before that.
 *  4. ENTRY SIGNAL on a lower timeframe (4-hour down to 30-minute): while it
 *     pulls back, that timeframe points against the trend; the entry is when
 *     it SHIFTS STRUCTURE back with the trend (a body close through its last
 *     structure point) and an ENGULFING candle confirms it.
 *  5. STOP beyond the high (for a sell) or low (for a buy) the pullback made —
 *     the place where the idea is simply wrong.
 *  6. TARGET a little before the next daily structure point, and never less
 *     than 1:2.
 *  7. SET AND FORGET. The trade ends at its stop or at its target. The stop is
 *     never moved, not to break-even and not to lock profit.
 *
 * Everything is read from CLOSED candles; a weekly, daily or 4-hour candle is
 * used only once it has closed.
 */

const H4 = 14_400;
const DAY = 86_400;
const WEEK = 604_800;
const YEAR = 365 * DAY;

export type SfEntryTf = "M30" | "H1" | "H2" | "H4";
export const SF_ENTRY_SECONDS: Record<SfEntryTf, number> = { M30: 1800, H1: 3600, H2: 7200, H4: 14_400 };

export interface SfOptions {
  /** candles on each side of a structure point on the weekly, daily and 4-hour charts */
  swingTrend: number;
  /** the same on the entry timeframe */
  swingEntry: number;
  /** candles on each side of a daily / weekly turning point that counts as a touch of an area */
  swingZoneDaily: number;
  swingZoneWeekly: number;
  /** how far back the touches of an area are looked for, in years */
  zoneYears: number;
  /** touches an area needs */
  zoneTouches: number;
  /** the tallest an area may be, in daily ATRs (daily areas / weekly areas) */
  zoneWidthAtr: number;
  zoneWidthWeeklyAtr: number;
  /** how close to an area the pullback has to turn, in daily ATRs */
  zonePadAtr: number;
  /** "all": weekly, daily and 4-hour agree · "daily4h": daily and 4-hour agree */
  sync: "all" | "daily4h";
  /** entry-timeframe candles after the shift of structure within which the engulfing candle has to come */
  engulfBars: number;
  /** the stop sits this far beyond the pullback's high or low, in entry-timeframe ATRs */
  stopBufferAtr: number;
  /**
   * The structure the stop goes beyond: "pullback" — the high/low the pullback made on the entry chart ·
   * "zone" — that and the far edge of the area of interest · "h4" / "daily" — that and the 4-hour / daily
   * structure point that keeps the trend (the lower high of a downtrend, the higher low of an uptrend)
   */
  stopMode: "pullback" | "zone" | "h4" | "daily";
  /** "structure": the next daily structure point at least `targetR` away, at most `targetMaxR` · "zone": the next area of interest, likewise · "fixed": `targetR` */
  targetMode: "fixed" | "structure" | "zone";
  targetR: number;
  targetMaxR: number;
  /** no trade when the spread and slippage are more than this share of the risk */
  maxCostShare: number;
}

export const SF_DEFAULTS: SfOptions = {
  swingTrend: 2,
  swingEntry: 2,
  swingZoneDaily: 3,
  swingZoneWeekly: 2,
  zoneYears: 3,
  zoneTouches: 3,
  zoneWidthAtr: 0.5,
  zoneWidthWeeklyAtr: 1,
  zonePadAtr: 0.15,
  sync: "all",
  engulfBars: 6,
  stopBufferAtr: 0.1,
  stopMode: "pullback",
  targetMode: "fixed",
  targetR: 2,
  targetMaxR: 4,
  maxCostShare: 0.1,
};

/** An area of interest: a band price has turned at several times. */
export interface Zone {
  low: number;
  high: number;
  touches: number;
  /** the chart its touches were read on */
  tf: "weekly" | "daily";
  /** open time of the candle that made its most recent touch (epoch seconds) */
  lastTouch: number;
}

/** Everything the method reads, aligned to the entry timeframe's candles. */
export interface SfSeries {
  n: number;
  /** closed candles of the entry timeframe, oldest first */
  candles: Candle[];
  seconds: number;
  atr: Float64Array;
  structure: Structure;
  /** index of the candle that began the current leg of the entry timeframe's structure */
  legStart: Int32Array;
  /** the weekly, daily and 4-hour structure as they stood when each entry candle closed */
  weeklyDir: Int8Array;
  dailyDir: Int8Array;
  h4Dir: Int8Array;
  /** the structure point that keeps the 4-hour / daily trend: the high behind its last bearish break, or the low behind its last bullish one */
  h4Origin: Float64Array;
  dailyOrigin: Float64Array;
  /** index of the last CLOSED daily candle at each entry candle's close (−1 before the first) */
  dailyIdx: Int32Array;
  daily: Candle[];
  dailyAtr: Float64Array;
  dailySwings: SwingPoint[];
  weeklySwings: SwingPoint[];
  /** the daily structure points the targets are read from */
  targetSwings: SwingPoint[];
  zoneCache: Map<number, Zone[]>;
}

export function buildSfSeries(
  input: { entry: Candle[]; h4: Candle[]; daily: Candle[]; weekly: Candle[]; entrySeconds: number },
  opts: SfOptions = SF_DEFAULTS
): SfSeries {
  const { entry, h4, daily, weekly, entrySeconds } = input;
  const n = entry.length;
  const structure = readStructure(entry, opts.swingEntry);
  const st4 = readStructure(h4, opts.swingTrend);
  const stD = readStructure(daily, opts.swingTrend);
  const stW = readStructure(weekly, opts.swingTrend);
  const legStart = new Int32Array(n);
  const weeklyDir = new Int8Array(n);
  const dailyDir = new Int8Array(n);
  const h4Dir = new Int8Array(n);
  const dailyIdx = new Int32Array(n).fill(-1);
  const h4Origin = new Float64Array(n).fill(NaN);
  const dailyOrigin = new Float64Array(n).fill(NaN);
  let a = -1;
  let b = -1;
  let c = -1;
  for (let i = 0; i < n; i++) {
    legStart[i] = i > 0 && structure.leg[i] === structure.leg[i - 1] ? legStart[i - 1] : i;
    const closed = entry[i].time + entrySeconds;
    while (a + 1 < h4.length && h4[a + 1].time + H4 <= closed) a++;
    while (b + 1 < daily.length && daily[b + 1].time + DAY <= closed) b++;
    while (c + 1 < weekly.length && weekly[c + 1].time + WEEK <= closed) c++;
    h4Dir[i] = a >= 0 ? st4.dir[a] : 0;
    dailyDir[i] = b >= 0 ? stD.dir[b] : 0;
    weeklyDir[i] = c >= 0 ? stW.dir[c] : 0;
    dailyIdx[i] = b;
    if (a >= 0) h4Origin[i] = st4.origin[a];
    if (b >= 0) dailyOrigin[i] = stD.origin[b];
  }
  return {
    n,
    candles: entry,
    seconds: entrySeconds,
    atr: wilderAtr(entry),
    structure,
    legStart,
    weeklyDir,
    dailyDir,
    h4Dir,
    h4Origin,
    dailyOrigin,
    dailyIdx,
    daily,
    dailyAtr: wilderAtr(daily),
    dailySwings: swingPoints(daily, opts.swingZoneDaily, DAY),
    weeklySwings: swingPoints(weekly, opts.swingZoneWeekly, WEEK),
    targetSwings: swingPoints(daily, opts.swingTrend, DAY),
    zoneCache: new Map(),
  };
}

/** Groups of at least `touches` turning points no further apart than `width`, the fullest first, never overlapping. */
function cluster(points: SwingPoint[], width: number, touches: number, tf: Zone["tf"]): Zone[] {
  const p = [...points].sort((x, y) => x.price - y.price);
  const found: { a: number; b: number }[] = [];
  let b = 0;
  for (let a = 0; a < p.length; a++) {
    if (b < a) b = a;
    while (b + 1 < p.length && p[b + 1].price - p[a].price <= width) b++;
    if (b - a + 1 >= touches) found.push({ a, b });
  }
  found.sort((x, y) => y.b - y.a - (x.b - x.a) || p[x.b].price - p[x.a].price - (p[y.b].price - p[y.a].price));
  const taken = new Uint8Array(p.length);
  const zones: Zone[] = [];
  for (const f of found) {
    let free = true;
    for (let q = f.a; q <= f.b; q++) if (taken[q]) free = false;
    if (!free) continue;
    let lastTouch = 0;
    for (let q = f.a; q <= f.b; q++) {
      taken[q] = 1;
      if (p[q].time > lastTouch) lastTouch = p[q].time;
    }
    zones.push({ low: p[f.a].price, high: p[f.b].price, touches: f.b - f.a + 1, tf, lastTouch });
  }
  return zones;
}

/** The areas of interest as they stood once daily candle `d` had closed: weekly ones first, then daily ones that do not overlap them. */
export function zonesAt(s: SfSeries, d: number, opts: SfOptions = SF_DEFAULTS): Zone[] {
  if (d < 0) return [];
  const cached = s.zoneCache.get(d);
  if (cached) return cached;
  const now = s.daily[d].time + DAY;
  const from = now - opts.zoneYears * YEAR;
  const atr = s.dailyAtr[d];
  let zones: Zone[] = [];
  if (Number.isFinite(atr) && atr > 0) {
    const known = (x: SwingPoint) => x.knownAt <= now && x.time >= from;
    const weekly = cluster(s.weeklySwings.filter(known), opts.zoneWidthWeeklyAtr * atr, opts.zoneTouches, "weekly");
    const daily = cluster(s.dailySwings.filter(known), opts.zoneWidthAtr * atr, opts.zoneTouches, "daily").filter(
      (z) => !weekly.some((w) => z.low <= w.high && z.high >= w.low)
    );
    zones = [...weekly, ...daily].sort((x, y) => x.low - y.low);
  }
  s.zoneCache.set(d, zones);
  return zones;
}

/** The area a turning point at `price` belongs to, if any: inside it, or within `pad` of it. */
function zoneAt(zones: Zone[], price: number, pad: number): Zone | null {
  let best: Zone | null = null;
  for (const z of zones) {
    if (price < z.low - pad || price > z.high + pad) continue;
    if (!best || (z.tf === "weekly" && best.tf !== "weekly") || (z.tf === best.tf && z.touches > best.touches)) best = z;
  }
  return best;
}

/** True when candle `c` engulfs the body of the candle before it, in direction `dir`. */
export function engulfs(c: Candle, prev: Candle, dir: 1 | -1): boolean {
  return dir === 1
    ? prev.close < prev.open && c.close > c.open && c.close > prev.open
    : prev.close > prev.open && c.close < c.open && c.close < prev.open;
}

export interface SfSetup {
  direction: SignalDirection;
  /** the close of the engulfing candle */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  risk: number;
  /** planned reward ÷ risk */
  targetR: number;
  /** what the target is: the daily structure point it sits just in front of, or null for the minimum 1:2 */
  targetLevel: number | null;
  /** the high (sell) or low (buy) the pullback made — the stop sits beyond it */
  pullback: number;
  zone: Zone;
  /** open time of the candle that shifted structure, and of the engulfing candle (epoch seconds) */
  shiftTime: number;
  time: number;
  atr: number;
  /** one signal per market and entry candle */
  key: string;
}

/** The side the higher timeframes agree on when entry candle `i` closed, or 0. */
function sideAt(s: SfSeries, i: number, opts: SfOptions): 1 | -1 | 0 {
  const d = s.dailyDir[i];
  if (d === 0) return 0;
  // on the 4-hour entry chart the 4-hour structure IS the entry signal, so only the two above it give the trend
  if (s.seconds < H4 && s.h4Dir[i] !== d) return 0;
  if (opts.sync === "all" && s.weeklyDir[i] !== d) return 0;
  return d as 1 | -1;
}

interface Reading {
  side: 1 | -1 | 0;
  /** the entry timeframe has shifted back with the trend and the shift is still fresh */
  shifted: boolean;
  shiftIndex: number;
  /** the candle is the first engulfing candle since the shift */
  engulfing: boolean;
  /** the pullback's high (sell) or low (buy) so far */
  pullback: number;
  zone: Zone | null;
  zones: Zone[];
}

function read(s: SfSeries, i: number, opts: SfOptions, needZones: boolean): Reading {
  const st = s.structure;
  const c = s.candles;
  const side = sideAt(s, i, opts);
  const out: Reading = { side, shifted: false, shiftIndex: -1, engulfing: false, pullback: NaN, zone: null, zones: [] };
  if (needZones) out.zones = zonesAt(s, s.dailyIdx[i], opts);
  if (side === 0 || i < 2) return out;
  const start = s.legStart[i];
  if (st.dir[i] === side && start >= 1 && st.dir[start - 1] === -side) {
    // shifted back with the trend: the pullback ended at the high/low behind the break
    let extreme = st.origin[start];
    for (let q = start + 1; q <= i; q++) extreme = side === 1 ? Math.min(extreme, c[q].low) : Math.max(extreme, c[q].high);
    out.pullback = extreme;
    if (i - start <= opts.engulfBars) {
      out.shifted = true;
      out.shiftIndex = start;
      if (engulfs(c[i], c[i - 1], side)) {
        out.engulfing = true;
        for (let q = start; q < i; q++) if (q >= 1 && engulfs(c[q], c[q - 1], side)) out.engulfing = false;
      }
    }
  } else if (st.dir[i] === -side) {
    // still pulling back: its high/low so far
    let extreme = side === 1 ? Infinity : -Infinity;
    for (let q = Math.max(0, start - opts.swingEntry); q <= i; q++) extreme = side === 1 ? Math.min(extreme, c[q].low) : Math.max(extreme, c[q].high);
    out.pullback = extreme;
  }
  if (Number.isFinite(out.pullback) && (needZones || out.engulfing)) {
    const d = s.dailyIdx[i];
    if (!needZones) out.zones = zonesAt(s, d, opts);
    const atr = d >= 0 ? s.dailyAtr[d] : NaN;
    if (Number.isFinite(atr)) out.zone = zoneAt(out.zones, out.pullback, opts.zonePadAtr * atr);
  }
  return out;
}

/** The stop, the target and the risk of a trade entered at `price` — or why there is none. */
function plan(s: SfSeries, i: number, pair: string, opts: SfOptions, side: 1 | -1, pullback: number, price: number, zone: Zone, zones: Zone[]) {
  const atr = s.atr[i];
  if (!Number.isFinite(atr) || atr <= 0) return { error: "not enough candles yet" as const };
  // the structure the stop goes beyond: always the pullback's own high/low, and whatever else the mode names when that is further
  let level = pullback;
  const further = (x: number) => {
    if (Number.isFinite(x)) level = side === 1 ? Math.min(level, x) : Math.max(level, x);
  };
  if (opts.stopMode === "zone") further(side === 1 ? zone.low : zone.high);
  if (opts.stopMode === "h4") further(s.h4Origin[i]);
  if (opts.stopMode === "daily") further(s.dailyOrigin[i]);
  const stopLoss = level - side * opts.stopBufferAtr * atr;
  const risk = side * (price - stopLoss);
  if (!(risk > 0)) return { error: "price is already beyond the stop" as const };
  const costShare = tradeCost(pair) / risk;
  if (costShare > opts.maxCostShare) return { error: "the stop is too close for the spread" as const, costShare };
  let targetR = opts.targetR;
  let targetLevel: number | null = null;
  if (opts.targetMode === "structure") {
    const now = s.candles[i].time + s.seconds;
    let best = NaN;
    for (const p of s.targetSwings) {
      if (p.knownAt > now || p.time < now - YEAR) continue;
      if (p.kind !== (side === 1 ? "high" : "low")) continue;
      const reward = side * (p.price - price);
      // "a little before" the structure point: 95% of the way there
      if (reward * 0.95 < opts.targetR * risk) continue;
      if (!(reward >= best)) best = reward;
    }
    if (Number.isFinite(best)) {
      targetLevel = price + side * best;
      targetR = Math.min(opts.targetMaxR, (best * 0.95) / risk);
    }
  } else if (opts.targetMode === "zone") {
    // the near edge of the next area of interest in the trade's direction that leaves at least the minimum
    let best = NaN;
    for (const z of zones) {
      const reward = side * ((side === 1 ? z.low : z.high) - price);
      if (reward < opts.targetR * risk) continue;
      if (!(reward >= best)) best = reward;
    }
    if (Number.isFinite(best)) {
      targetLevel = price + side * best;
      targetR = Math.min(opts.targetMaxR, best / risk);
    }
  }
  return { stopLoss, stopLevel: level, risk, costShare, targetR, targetLevel, takeProfit: price + side * targetR * risk, atr };
}

/**
 * The trade entry candle `i` gives at its close, or null. `entry` replaces the
 * candle's close as the entry price (the backtest fills at the next open).
 */
export function sfSetupAt(s: SfSeries, i: number, pair: string, opts: SfOptions = SF_DEFAULTS, entry?: number): SfSetup | null {
  const r = read(s, i, opts, false);
  if (r.side === 0 || !r.engulfing || !r.zone) return null;
  const price = entry ?? s.candles[i].close;
  const p = plan(s, i, pair, opts, r.side, r.pullback, price, r.zone, r.zones);
  if ("error" in p) return null;
  return {
    direction: r.side === 1 ? "long" : "short",
    entry: price,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    risk: p.risk,
    targetR: p.targetR,
    targetLevel: p.targetLevel,
    pullback: r.pullback,
    zone: r.zone,
    shiftTime: s.candles[r.shiftIndex].time,
    time: s.candles[i].time,
    atr: p.atr,
    key: `${SF_KEY_PREFIX}${pair}:${s.candles[i].time}`,
  };
}

/** How a signal of these rules is keyed in the database (`variant`). */
export const SF_KEY_PREFIX = "sf:" as const;

/**
 * The version that sends signals: exactly as taught (weekly, daily and 4-hour
 * agree; an area of interest; a shift of structure and an engulfing candle;
 * the stop beyond the pullback; 1:2), with the 4-hour chart as the entry
 * chart. On five years of gold the 30-minute and 1-hour entries lost money;
 * the 4-hour entry did not.
 */
export const SF_LIVE_ENTRY: SfEntryTf = "H4";
export const SF_LIVE: SfOptions = SF_DEFAULTS;
/** Closed candles a scan reads: three years of daily and weekly candles for the areas, and enough of each for its structure to be the real one. */
export const SF_HISTORY = { h4: 2500, daily: 1500, weekly: 400 } as const;

export interface SfState {
  weekly: 1 | -1 | 0;
  daily: 1 | -1 | 0;
  h4: 1 | -1 | 0;
  /** the entry timeframe's own structure */
  entryDir: 1 | -1 | 0;
  /** the side the higher timeframes agree on, or null */
  side: SignalDirection | null;
  /** the areas of interest nearest to price: up to three above and three below */
  zones: Zone[];
  /** the area the current pullback has turned at (or is turning at), or null */
  zone: Zone | null;
  /** the pullback's high (sell) or low (buy) so far — the stop would go beyond it */
  pullback: number | null;
  atr: number | null;
  dailyAtr: number | null;
  /** the conditions, in the order they have to be met; the last one is the entry */
  checks: { label: string; met: boolean }[];
  /** what the system is waiting for right now, in a sentence */
  waiting: string;
  setup: SfSetup | null;
}

const word = (d: number) => (d === 1 ? "up" : d === -1 ? "down" : "unclear");

/** The full reading at entry candle `i`'s close — what the dashboard shows and the scanner acts on. */
export function sfStateAt(s: SfSeries, i: number, pair: string, opts: SfOptions = SF_DEFAULTS, tfLabel = "entry"): SfState {
  const r = read(s, i, opts, true);
  const c = s.candles[i];
  const weekly = s.weeklyDir[i] as 1 | -1 | 0;
  const daily = s.dailyDir[i] as 1 | -1 | 0;
  const h4 = s.h4Dir[i] as 1 | -1 | 0;
  const entryDir = s.structure.dir[i] as 1 | -1 | 0;
  const atr = Number.isFinite(s.atr[i]) ? s.atr[i] : null;
  const d = s.dailyIdx[i];
  const dailyAtr = d >= 0 && Number.isFinite(s.dailyAtr[d]) ? s.dailyAtr[d] : null;
  const setup = sfSetupAt(s, i, pair, opts);
  const above = r.zones.filter((z) => z.low > c.close).slice(0, 3);
  const below = r.zones.filter((z) => z.high < c.close).slice(-3);
  const around = r.zones.filter((z) => z.low <= c.close && z.high >= c.close);
  const zones = [...below, ...around, ...above];
  const sideWord = r.side === 1 ? "buy" : "sell";
  const pulling = r.side !== 0 && entryDir === -r.side;
  const atZone = r.zone !== null;
  const planned = r.side !== 0 && r.engulfing && r.zone ? plan(s, i, pair, opts, r.side, r.pullback, c.close, r.zone, r.zones) : null;
  const checks = [
    {
      label:
        opts.sync === "all"
          ? `Weekly ${word(weekly)}, daily ${word(daily)}, 4-hour ${word(h4)} — all three have to agree`
          : `Daily ${word(daily)}, 4-hour ${word(h4)} have to agree (weekly ${word(weekly)})`,
      met: r.side !== 0,
    },
    { label: "Price has pulled back into an area of interest (3 or more touches)", met: r.side !== 0 && atZone },
    { label: `The ${tfLabel} chart has shifted structure back with the trend`, met: r.side !== 0 && atZone && r.shifted },
    { label: "An engulfing candle confirms it", met: r.side !== 0 && atZone && r.shifted && r.engulfing },
    { label: `The stop is not too close for the spread, and the target is at least 1:${opts.targetR}`, met: setup !== null },
  ];
  let waiting: string;
  if (r.side === 0) waiting = "The weekly, daily and 4-hour charts do not agree on a direction, so there is no trade to wait for.";
  else if (setup) waiting = `Entry: ${sideWord} now.`;
  else if (planned && "error" in planned) waiting = `The signal came, but ${planned.error}.`;
  else if (r.shifted && atZone) waiting = `The ${tfLabel} chart has shifted ${word(r.side)} at the area — waiting for an engulfing candle to ${sideWord}.`;
  else if (pulling && atZone) waiting = `Price is at an area of interest — waiting for the ${tfLabel} chart to shift structure ${word(r.side)}.`;
  else if (pulling) waiting = `Price is pulling back — waiting for it to reach an area of interest.`;
  else waiting = `The trend is ${word(r.side)} — waiting for a pullback into an area of interest to ${sideWord}.`;
  return {
    weekly,
    daily,
    h4,
    entryDir,
    side: r.side === 0 ? null : r.side === 1 ? "long" : "short",
    zones,
    zone: r.zone,
    pullback: Number.isFinite(r.pullback) ? r.pullback : null,
    atr,
    dailyAtr,
    checks,
    waiting,
    setup,
  };
}
