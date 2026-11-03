import type { Candle } from "@/lib/types";
import { significantPivots, type Pivot } from "./pivots";

export interface Trendline {
  kind: "resistance" | "support";
  /** The true recent higher high (resistance) or lower low (support). */
  origin: Pivot;
  /** the actual detected pivot coordinates the line passes through (Section 9:
   * rendering must use these same anchors so drawing and detection never drift) */
  anchors: Pivot[];
  /** The second pivot that, with `origin`, defines this straight line. */
  definitionAnchor: Pivot;
  /** price = slope * candleIndex + intercept */
  slope: number;
  intercept: number;
  /** total pivot touches within tolerance */
  touches: number;
  /** candle index of the last anchor */
  lastAnchorIndex: number;
  /** true if price closed beyond the line after the last anchor — shown on the
   * chart but never used as a touch trigger */
  broken: boolean;
}

export const TOUCH_TOLERANCE_ATR = 0.15; // touch band half-width
export const MIN_TOUCHES = 3; // Section 2.1 — no two-point lines
export const CLOSE_BOUNCE_MARGIN_ATR = 0.05; // close must clear the line by this much to confirm a real bounce
// A line defined by two anchors that are only a few candles apart has a noisy
// slope — projected across the chart it looks crooked/wrong (worst on M15,
// where 120 candles ≈ 30h and every tiny swing becomes a pivot). Require the
// defining anchors to span a meaningful distance in both time and price.
const MIN_ANCHOR_SPAN_CANDLES = 12;
const MIN_ANCHOR_SPAN_ATR = 0.75; // |origin − p2| must be ≥ this × ATR
const STRUCTURAL_SWING_ATR = 0.5;
// how many of the most recent candles a pivot must fall within to anchor a
// trendline — without this, sparse-pivot pairs pick anchors from anywhere in
// the whole fetch window (days old), producing lines that don't track current
// price ("begin from the recent market structure", not ancient swings).
export const DEFAULT_TRENDLINE_LOOKBACK = 120;

export function lineValueAt(line: { slope: number; intercept: number }, index: number): number {
  return line.slope * index + line.intercept;
}

/** Project a line from its two defining pivots onto another timeframe. */
export function lineValueAtTime(line: Trendline, time: number): number {
  const duration = line.definitionAnchor.time - line.origin.time;
  if (duration === 0) return line.origin.price;
  return (
    line.origin.price +
    ((line.definitionAnchor.price - line.origin.price) * (time - line.origin.time)) / duration
  );
}

function buildBestLine(
  pivots: Pivot[],
  structuralPivots: Pivot[],
  candles: Candle[],
  tolerance: number,
  kind: Trendline["kind"],
  allowBroken: boolean,
  minimumTouches: number
): Trendline | null {
  const atrValue = tolerance / TOUCH_TOLERANCE_ATR;
  const rawPivots = pivots.filter((p) =>
    kind === "resistance" ? p.kind === "high" : p.kind === "low"
  );
  const structuralKindPivots = structuralPivots.filter((p) =>
    kind === "resistance" ? p.kind === "high" : p.kind === "low"
  );
  if (rawPivots.length < 2 || structuralKindPivots.length < 2) return null;
  const firstVisiblePivotIndex = rawPivots[0].index;

  let best: Trendline | null = null;
  let bestDeviation = Infinity;
  let bestBroken: Trendline | null = null;

  for (let originOffset = 0; originOffset < structuralKindPivots.length - 1; originOffset++) {
    const origin = structuralKindPivots[originOffset];
    const priorSameKind = structuralKindPivots[originOffset - 1];
    if (origin.index < firstVisiblePivotIndex) continue;

    // Draw from actual market structure: HH → later LH for resistance and
    // LL → later HL for support. A lower high cannot be a new resistance ray's
    // origin, nor can a higher low be a new support ray's origin.
    if (
      priorSameKind &&
      ((kind === "resistance" && origin.price < priorSameKind.price) ||
        (kind === "support" && origin.price > priorSameKind.price))
    ) {
      continue;
    }

    for (const p2 of structuralKindPivots.slice(originOffset + 1)) {
      if (kind === "resistance" && p2.price >= origin.price) continue;
      if (kind === "support" && p2.price <= origin.price) continue;
      if (p2.index - origin.index < MIN_ANCHOR_SPAN_CANDLES) continue;
      if (Math.abs(p2.price - origin.price) < MIN_ANCHOR_SPAN_ATR * atrValue) continue;

      const slope = (p2.price - origin.price) / (p2.index - origin.index);
      const intercept = origin.price - slope * origin.index;
      const duration = p2.time - origin.time;
      if (duration === 0) continue;
      const valueAtTime = (time: number) =>
        origin.price + ((p2.price - origin.price) * (time - origin.time)) / duration;

      const span = rawPivots.filter((p) => p.index >= origin.index);

      const touchedPivots = span.filter(
        (p) => Math.abs(p.price - valueAtTime(p.time)) <= tolerance
      );
      if (touchedPivots.length < minimumTouches) continue;

      const lastAnchorIndex = Math.max(...touchedPivots.map((p) => p.index));

      // A valid ray must contain price rather than cut through it. Checking
      // all candle extremes, not only pivots, prevents visually crooked rays.
      const violated = candles.some(
        (c, index) =>
          index >= origin.index &&
          index <= lastAnchorIndex &&
          (kind === "resistance"
            ? c.high > valueAtTime(c.time) + tolerance
            : c.low < valueAtTime(c.time) - tolerance)
      );
      if (violated) continue;

      const deviation =
        touchedPivots.reduce(
          (sum, p) => sum + Math.abs(p.price - valueAtTime(p.time)),
          0
        ) / touchedPivots.length;

      const broken = candles.some((c, index) => {
        if (index <= lastAnchorIndex) return false;
        const lv = valueAtTime(c.time);
        return kind === "resistance"
          ? c.close > lv + tolerance
          : c.close < lv - tolerance;
      });

      const candidate: Trendline = {
        kind,
        origin,
        anchors: touchedPivots,
        definitionAnchor: p2,
        slope,
        intercept,
        touches: touchedPivots.length,
        lastAnchorIndex,
        broken,
      };

      if (!broken) {
        // A current 3-touch structural ray is more useful than an older
        // 4-touch line. Freshness wins; quality decides ties.
        if (
          !best ||
          candidate.lastAnchorIndex > best.lastAnchorIndex ||
          (candidate.lastAnchorIndex === best.lastAnchorIndex &&
            (candidate.touches > best.touches ||
              (candidate.touches === best.touches && deviation < bestDeviation)))
        ) {
          best = candidate;
          bestDeviation = deviation;
        }
      } else if (allowBroken && (!bestBroken || candidate.lastAnchorIndex > bestBroken.lastAnchorIndex)) {
        bestBroken = candidate;
      }
    }
  }
  return best ?? bestBroken;
}

/**
 * Best trendlines from swing pivots (Section 2.1). Unbroken lines are
 * preferred; the most recent broken line is included as a fallback for chart
 * display (flagged `broken`) — only unbroken lines can be touch triggers.
 * Anchors are restricted to the last `lookbackCandles` so lines reflect
 * recent market structure rather than reaching back through the whole fetch.
 */
export function detectTrendlines(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number,
  includeBroken = true,
  lookbackCandles = DEFAULT_TRENDLINE_LOOKBACK,
  minimumTouches = MIN_TOUCHES
): Trendline[] {
  const tolerance = TOUCH_TOLERANCE_ATR * atrValue;
  const minIndex = Math.max(0, candles.length - lookbackCandles);
  const recent = pivots.filter((p) => p.index >= minIndex);
  // Build structural swings before slicing. Re-filtering only the recent raw
  // pivots changes zigzag context as a chart pans or refreshes, causing a ray
  // to jump between valid-but-different origins.
  const structuralPivots = significantPivots(pivots, atrValue, STRUCTURAL_SWING_ATR);
  const lines: Trendline[] = [];
  const resistance = buildBestLine(
    recent,
    structuralPivots,
    candles,
    tolerance,
    "resistance",
    includeBroken,
    minimumTouches
  );
  if (resistance) lines.push(resistance);
  const support = buildBestLine(
    recent,
    structuralPivots,
    candles,
    tolerance,
    "support",
    includeBroken,
    minimumTouches
  );
  if (support) lines.push(support);
  return lines;
}

/**
 * Core trigger (Section 2.1): the latest candle touched a valid trendline
 * within the tolerance band AND closed back on the correct side of it.
 * A wick through the line that closes beyond it is a break, not a bounce,
 * so broken lines and close-beyond touches are rejected here.
 */
export function trendlineTouch(
  candles: Candle[],
  lines: Trendline[],
  atrValue: number
): { line: Trendline; direction: "long" | "short" } | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const tolerance = TOUCH_TOLERANCE_ATR * atrValue;
  const margin = CLOSE_BOUNCE_MARGIN_ATR * atrValue;

  for (const line of lines) {
    if (line.broken) continue;
    const lv = lineValueAtTime(line, last.time);
    if (line.kind === "support") {
      const touched = Math.abs(last.low - lv) <= tolerance;
      const closedCorrectSide = last.close > lv + margin;
      if (touched && closedCorrectSide) return { line, direction: "long" };
    }
    if (line.kind === "resistance") {
      const touched = Math.abs(last.high - lv) <= tolerance;
      const closedCorrectSide = last.close < lv - margin;
      if (touched && closedCorrectSide) return { line, direction: "short" };
    }
  }
  return null;
}

/** Check a higher-timeframe line against the latest candle by timestamp. */
export function trendlineTouchAtTime(
  candles: Candle[],
  lines: Trendline[],
  atrValue: number
): { line: Trendline; direction: "long" | "short" } | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const tolerance = TOUCH_TOLERANCE_ATR * atrValue;
  const margin = CLOSE_BOUNCE_MARGIN_ATR * atrValue;

  for (const line of lines) {
    if (line.broken) continue;
    const value = lineValueAtTime(line, last.time);
    if (line.kind === "support") {
      const touched = Math.abs(last.low - value) <= tolerance;
      const closedCorrectSide = last.close > value + margin;
      if (touched && closedCorrectSide) return { line, direction: "long" };
    }
    if (line.kind === "resistance") {
      const touched = Math.abs(last.high - value) <= tolerance;
      const closedCorrectSide = last.close < value - margin;
      if (touched && closedCorrectSide) return { line, direction: "short" };
    }
  }
  return null;
}

/**
 * Bounce confirmation: it's not enough to touch the line — price must CLOSE
 * back on the correct side of it (a genuine rejection off the trendline, not
 * a ride-through). Checks the last candle against the projected line value.
 */
export function bounceConfirmed(
  candles: Candle[],
  line: Trendline,
  direction: "long" | "short",
  atrValue: number
): boolean {
  if (candles.length === 0) return false;
  const last = candles[candles.length - 1];
  const value = lineValueAtTime(line, last.time);
  const slack = TOUCH_TOLERANCE_ATR * atrValue * 0.5; // must clear the line by a margin
  if (direction === "long") return last.close > value + slack; // bounced up off support
  return last.close < value - slack; // bounced down off resistance
}
