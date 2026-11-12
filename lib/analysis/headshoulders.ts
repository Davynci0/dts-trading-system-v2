import type { Candle } from "@/lib/types";
import type { Pivot } from "./pivots";
import { atr } from "./indicators";

/**
 * Head-and-Shoulders / Inverse Head-and-Shoulders reversal pattern.
 * Structure requires 5 consecutive alternating structural pivots.
 * Fires on a CLOSED break of the neckline, not a touch.
 */

export interface HeadShouldersPattern {
  direction: "short" | "long"; // bearish or bullish
  ls: Pivot;      // left shoulder
  n1: Pivot;      // first neckline point
  h: Pivot;       // head (most extreme)
  n2: Pivot;      // second neckline point
  rs: Pivot;      // right shoulder
  necklineSlope: number; // (price at n2 - price at n1) / (n2.time - n1.time)
  necklineStartPrice: number;
  necklineEndPrice: number;
  /** distance from neckline to head, projected to give the target */
  target: number;
  triggerTime: number;    // time of neckline break close
}

/**
 * Find the most recent H&S / inverse H&S formation in the last N pivots and
 * check if the latest candle CLOSED through the neckline.
 *
 * Core trigger for the `headshoulders` strategy: close beyond neckline
 * after the 5-pivot formation is complete (LS → N1 → H → N2 → RS).
 */
export function detectHeadShoulders(
  candles: Candle[],
  pivots: Pivot[],
  atrValue: number
): HeadShouldersPattern | null {
  if (!candles.length || pivots.length < 5 || atrValue <= 0) return null;
  if (candles.length < 40) return null;

  // Need at least 5 pivots to form LS,N1,H,N2,RS. Look backwards over the most
  // recent pivots, checking each 5-pivot run for a valid pattern.
  const last = candles[candles.length - 1];
  const atr1x = atrValue;
  const last5 = pivots.slice(-20); // look at recent structural pivots

  for (let start = Math.max(0, last5.length - 7); start < last5.length - 4; start++) {
    const ls = last5[start];
    const n1 = last5[start + 1];
    const h = last5[start + 2];
    const n2 = last5[start + 3];
    const rs = last5[start + 4];

    // Bearish H&S shape: LS(high) N1(low) H(high) N2(low) RS(high)
    if (ls.kind === "high" && n1.kind === "low" && h.kind === "high" && n2.kind === "low" && rs.kind === "high") {
      // Head is the most extreme
      if (h.price > ls.price && h.price > rs.price) {
        // LS ≈ RS within 50% of each other's distance from H
        const lsDist = h.price - ls.price;
        const rsDist = h.price - rs.price;
        const similar = Math.abs(lsDist - rsDist) <= Math.max(lsDist, rsDist) * 0.5 + 1e-10;
        // Neckline points are roughly horizontal (slope < 0.5×ATR over span)
        const span = n2.time - n1.time;
        const slope = span > 0 ? Math.abs(n2.price - n1.price) / Math.max(span, 1) : 0;
        const flat = slope <= atr1x / Math.max(span, 1) * 0.75 + 1e-10;

        if (similar && flat) {
          // Neckline: from n1.price to n2.price projected forward linearly
          const nTime = n2.time - n1.time;
          const slopePerSec = nTime > 0 ? (n2.price - n1.price) / nTime : 0;
          const necklinePrice = n2.price + slopePerSec * (last.time - n2.time);
          const headToNeckline = Math.abs(n1.price - h.price);
          const triggered = last.close < necklinePrice;
          const recent = last.time - rs.time <= 120 * 60 * 1000; // within ~120 bars of right shoulder

          if (triggered && recent) {
            return {
              direction: "short",
              ls, n1, h, n2, rs,
              necklineSlope: slopePerSec,
              necklineStartPrice: n1.price,
              necklineEndPrice: n2.price,
              target: necklinePrice - headToNeckline,
              triggerTime: last.time,
            };
          }
        }
      }
    }

    // Bullish H&S shape: LS(low) N1(high) H(low) N2(high) RS(low)
    if (ls.kind === "low" && n1.kind === "high" && h.kind === "low" && n2.kind === "high" && rs.kind === "low") {
      // Head is the most extreme
      if (h.price < ls.price && h.price < rs.price) {
        // LS ≈ RS
        const lsDist = ls.price - h.price;
        const rsDist = rs.price - h.price;
        const similar = Math.abs(lsDist - rsDist) <= Math.max(lsDist, rsDist) * 0.5 + 1e-10;
        // Neckline flat
        const span = n2.time - n1.time;
        const slope = span > 0 ? Math.abs(n2.price - n1.price) / Math.max(span, 1) : 0;
        const flat = slope <= atr1x / Math.max(span, 1) * 0.75 + 1e-10;

        if (similar && flat) {
          const nTime = n2.time - n1.time;
          const slopePerSec = nTime > 0 ? (n2.price - n1.price) / nTime : 0;
          const necklinePrice = n2.price + slopePerSec * (last.time - n2.time);
          const headToNeckline = Math.abs(h.price - n1.price);
          const triggered = last.close > necklinePrice;
          const recent = last.time - rs.time <= 120 * 60 * 1000;

          if (triggered && recent) {
            return {
              direction: "long",
              ls, n1, h, n2, rs,
              necklineSlope: slopePerSec,
              necklineStartPrice: n1.price,
              necklineEndPrice: n2.price,
              target: necklinePrice + headToNeckline,
              triggerTime: last.time,
            };
          }
        }
      }
    }
  }

  return null;
}
