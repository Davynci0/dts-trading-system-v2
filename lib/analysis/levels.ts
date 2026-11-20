import type { Candle } from "@/lib/types";
import { atr } from "./indicators";
import { detectPivots } from "./pivots";

/**
 * Support and resistance: prices the market has turned at more than once.
 *
 * A single swing high is just a swing high. It becomes a level when price
 * comes back and turns there again, and a strong one when it has been both a
 * ceiling and a floor (a "flip"). So the detector:
 *
 *  1. takes the swing highs and lows of a higher timeframe (H1 by default —
 *     a few weeks of structure, where M15 would only see a few days),
 *  2. groups swings that sit within LEVEL_WIDTH_ATR × ATR of each other,
 *  3. counts the group's separate visits (swings at least MIN_TOUCH_GAP bars
 *     apart — one turn often prints two neighbouring pivots),
 *  4. keeps groups with at least `minTouches` visits.
 *
 * Whether a level is support or resistance is not a property of the level:
 * it is support while price is above it and resistance while price is below.
 */

/** Swings within this many ATR of each other belong to one level. */
export const LEVEL_WIDTH_ATR = 0.5;
/** Swings closer together in time than this are the same visit. */
export const MIN_TOUCH_GAP = 6;
/** Fractal half-width for the swing points (3 → a 7-bar swing). */
export const LEVEL_PIVOT_K = 3;

export interface KeyLevel {
  /** the level: the average of the swing prices that make it up */
  price: number;
  /** the band the swings span */
  top: number;
  bottom: number;
  /** support while the reference price is above the level, resistance below */
  kind: "support" | "resistance";
  /** separate visits where price turned at the level */
  touches: number;
  /** how many of those turns were swing highs / swing lows */
  highs: number;
  lows: number;
  /** it has acted as both a ceiling and a floor */
  flipped: boolean;
  /** open time of the first and the most recent swing at the level */
  firstTime: number;
  lastTime: number;
}

/**
 * Key levels in `candles` (a higher-timeframe series, closed bars only),
 * classified against `price`. Strongest first.
 */
export function detectKeyLevels(candles: Candle[], price: number, minTouches = 2): KeyLevel[] {
  if (candles.length < 30) return [];
  const atrValue = atr(candles);
  if (atrValue == null || atrValue <= 0) return [];
  const width = LEVEL_WIDTH_ATR * atrValue;

  const swings = detectPivots(candles, LEVEL_PIVOT_K).sort((a, b) => a.price - b.price);
  const levels: KeyLevel[] = [];
  let group: typeof swings = [];
  const flush = () => {
    if (group.length === 0) return;
    // separate visits: walk the group in time order, a new visit starts after a gap
    const byTime = [...group].sort((a, b) => a.index - b.index);
    let touches = 0;
    let highs = 0;
    let lows = 0;
    let lastIndex = -Infinity;
    for (const s of byTime) {
      if (s.index - lastIndex >= MIN_TOUCH_GAP) {
        touches++;
        if (s.kind === "high") highs++;
        else lows++;
      }
      lastIndex = s.index;
    }
    if (touches >= minTouches) {
      const mean = group.reduce((sum, s) => sum + s.price, 0) / group.length;
      levels.push({
        price: mean,
        top: group[group.length - 1].price,
        bottom: group[0].price,
        kind: price >= mean ? "support" : "resistance",
        touches,
        highs,
        lows,
        flipped: highs > 0 && lows > 0,
        firstTime: byTime[0].time,
        lastTime: byTime[byTime.length - 1].time,
      });
    }
    group = [];
  };
  for (const s of swings) {
    if (group.length > 0 && s.price - group[0].price > width) flush();
    group.push(s);
  }
  flush();

  const strength = (l: KeyLevel) => l.touches + (l.flipped ? 1 : 0);
  return levels.sort((a, b) => strength(b) - strength(a) || b.lastTime - a.lastTime);
}

/** The `count` nearest levels on each side of `price` — what a chart can show without clutter. */
export function nearestLevels(levels: KeyLevel[], price: number, count = 3): KeyLevel[] {
  const by = (kind: KeyLevel["kind"]) =>
    levels
      .filter((l) => l.kind === kind)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, count);
  return [...by("resistance"), ...by("support")].sort((a, b) => b.price - a.price);
}

/** Levels that were known before `candle` opened: built from higher-timeframe
 *  bars that had already closed, so the trader could have drawn them in advance.
 *  Cached per higher-timeframe series — every strategy asks on every candle. */
const knownCache = new WeakMap<Candle[], { time: number; price: number; atr: number; levels: KeyLevel[] }>();
function knownLevels(htf: Candle[], candle: Candle, price: number, htfSeconds: number): { atr: number; levels: KeyLevel[] } {
  const hit = knownCache.get(htf);
  if (hit && hit.time === candle.time && hit.price === price) return hit;
  const known = htf.filter((c) => c.time + htfSeconds <= candle.time);
  const atrValue = atr(known) ?? 0;
  const entry = { time: candle.time, price, atr: atrValue, levels: atrValue > 0 ? detectKeyLevels(known, price) : [] };
  knownCache.set(htf, entry);
  return entry;
}

/**
 * The flipped key level sitting just behind an entry, if there is one: a
 * level that has been both ceiling and floor, on the protective side of the
 * latest close (below a long, above a short) and within one higher-timeframe
 * ATR of it. Trades taken with such a level behind them did about twice as
 * well as the rest in testing — it grades a signal, it does not gate one.
 */
export function backingLevel(candles: Candle[], htf: Candle[], direction: "long" | "short", htfSeconds = 3600): KeyLevel | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const { atr: atrValue, levels } = knownLevels(htf, last, last.close, htfSeconds);
  if (!(atrValue > 0)) return null;
  const sign = direction === "long" ? 1 : -1;
  let best: KeyLevel | null = null;
  for (const l of levels) {
    const behind = (last.close - l.price) * sign;
    if (!l.flipped || behind < 0 || behind > atrValue) continue;
    if (!best || l.touches > best.touches) best = l;
  }
  return best;
}

export interface LevelRetest {
  direction: "long" | "short";
  level: KeyLevel;
  /** open time of the retest candle */
  time: number;
  /** stable identity of the level for the day: one retest trade per level per day */
  key: string;
}

/**
 * Break-and-retest of a key level, on the LATEST candle of `candles`:
 *
 *  - long: a level that used to cap price (made mostly of swing highs) is now
 *    below it; the candle opens above the level's band, dips into it and
 *    closes back above the level — old resistance holding as support.
 *  - short: the mirror image, old support holding as resistance.
 *
 * Repeat bounces off a level that was always support (or always resistance)
 * are deliberately not signals: on gold they showed no edge, the retests did.
 * Levels are built only from `htf` bars that had closed before the candle
 * opened, so the level is one the trader could have drawn in advance.
 */
export function detectLevelRetest(candles: Candle[], htf: Candle[], htfSeconds = 3600): LevelRetest | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const { atr: atrValue, levels } = knownLevels(htf, last, last.open, htfSeconds);
  if (!(atrValue > 0)) return null;
  const day = Math.floor((last.time + 2 * 3600) / 86400); // FX trading day, rolls at 22:00 UTC
  for (const level of levels) {
    const key = `${Math.round(level.price / (LEVEL_WIDTH_ATR * atrValue))}:${day}`;
    if (last.open > level.top && last.low <= level.top && last.close > level.price && level.highs >= level.lows) {
      return { direction: "long", level, time: last.time, key };
    }
    if (last.open < level.bottom && last.high >= level.bottom && last.close < level.price && level.lows >= level.highs) {
      return { direction: "short", level, time: last.time, key };
    }
  }
  return null;
}
