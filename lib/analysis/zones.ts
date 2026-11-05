import type { Candle } from "@/lib/types";
import { atrSeries } from "./indicators";

export interface Zone {
  id: string;
  /** demand = buy zone at base of bullish impulse, supply = sell zone at base of bearish impulse */
  kind: "demand" | "supply";
  top: number;
  bottom: number;
  /** index of the first base candle */
  startIndex: number;
  startTime: number;
  /** index where the impulse candle left the zone */
  impulseIndex: number;
  /** candle index where price closed through the zone (invalidation), if any */
  invalidatedIndex: number | null;
  active: boolean;
  /** number of times price re-entered the zone after the impulse (freshness) */
  touches: number;
}

const IMPULSE_RANGE_MULT = 1.8; // impulse candle range must exceed this × ATR
const IMPULSE_BODY_RATIO = 0.6; // and be mostly body, not wick
const MAX_BASE_CANDLES = 5;
const MAX_BASE_WIDTH_ATR = 1.5; // base wider than this isn't a tight accumulation zone

/**
 * Supply/demand zone detection + invalidation (Section 5).
 * A zone box spans the origin base candle(s) of a strong impulsive move and
 * stays active until a candle CLOSES through it, at which point it is
 * invalidated (greyed out on the chart).
 */
export function detectZones(candles: Candle[]): Zone[] {
  const atrs = atrSeries(candles, 14);
  const zones: Zone[] = [];

  for (let i = 15; i < candles.length; i++) {
    const a = atrs[i];
    const c = candles[i];
    if (!a) continue;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const impulsive = range > IMPULSE_RANGE_MULT * a && body / range > IMPULSE_BODY_RATIO;
    if (!impulsive) continue;

    // Walk back over the small-bodied base candle(s) preceding the impulse.
    // The walk stops at the first LARGE-bodied candle (or the candle-count
    // limit); the terminating large candle must NOT be part of the base —
    // including it would stretch the zone box into the opposite swing.
    let j = i - 1;
    let hitLargeCandle = false;
    while (j >= 1 && i - j < MAX_BASE_CANDLES) {
      if (Math.abs(candles[j].close - candles[j].open) < 0.5 * (atrs[j] ?? a)) {
        j--;
      } else {
        hitLargeCandle = true;
        break;
      }
    }
    const baseStart = hitLargeCandle ? j + 1 : j;
    const base = candles.slice(baseStart, i); // small-bodied candles only
    if (base.length === 0) continue; // no base candle found

    const top = Math.max(...base.map((b) => b.high));
    const bottom = Math.min(...base.map((b) => b.low));
    if (top - bottom > MAX_BASE_WIDTH_ATR * a) continue;

    const kind: Zone["kind"] = c.close > c.open ? "demand" : "supply";

    // skip if an existing active same-kind zone already covers this price band
    const dupe = zones.some(
      (z) => z.active && z.kind === kind && !(top < z.bottom || bottom > z.top)
    );
    if (dupe) continue;

    zones.push({
      id: `${kind}-${candles[j].time}`,
      kind,
      top,
      bottom,
      startIndex: j,
      startTime: candles[j].time,
      impulseIndex: i,
      invalidatedIndex: null,
      active: true,
      touches: 0,
    });
  }

  // forward pass per zone: touches + invalidation (uses only candles after the impulse)
  for (const z of zones) {
    let inside = false;
    for (let i = z.impulseIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (z.kind === "demand") {
        if (c.close < z.bottom) {
          z.active = false;
          z.invalidatedIndex = i;
          break;
        }
        const enters = c.low <= z.top;
        if (enters && !inside) z.touches++;
        inside = enters && c.close >= z.bottom;
      } else {
        if (c.close > z.top) {
          z.active = false;
          z.invalidatedIndex = i;
          break;
        }
        const enters = c.high >= z.bottom;
        if (enters && !inside) z.touches++;
        inside = enters && c.close <= z.top;
      }
    }
  }

  return zones;
}

export interface ZoneEntry {
  zone: Zone;
  direction: "long" | "short";
  /** candles price has been continuously inside the zone on this visit */
  candlesInside: number;
}

/** How long price may sit inside a zone before the entry window lapses. */
export const ZONE_ENTRY_WINDOW = 3;

/**
 * Supply/demand zone strategy core trigger: the latest candle has entered an
 * active zone (overlap) and the current visit began within the last
 * ZONE_ENTRY_WINDOW candles — price parked inside a zone for longer than that
 * has already shown its hand and is not a fresh entry. Freshest zone (fewest
 * prior touches) wins when zones overlap. Demand → long, supply → short.
 */
export function detectZoneEntry(candles: Candle[], zones: Zone[]): ZoneEntry | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];

  const candidates = zones
    .filter((z) => z.active && last.low <= z.top && last.high >= z.bottom)
    .sort((a, b) => a.touches - b.touches || b.startIndex - a.startIndex);

  for (const zone of candidates) {
    let inside = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      if (c.low <= zone.top && c.high >= zone.bottom) inside++;
      else break;
    }
    if (inside >= 1 && inside <= ZONE_ENTRY_WINDOW) {
      return {
        zone,
        direction: zone.kind === "demand" ? "long" : "short",
        candlesInside: inside,
      };
    }
  }
  return null;
}
