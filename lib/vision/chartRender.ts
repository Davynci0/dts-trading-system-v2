import type { Candle } from "@/lib/types";
import type { Zone } from "@/lib/analysis/zones";
import type { Trendline } from "@/lib/analysis/trendlines";
import { lineValueAtTime } from "@/lib/analysis/trendlines";
import type { FibSetup } from "@/lib/analysis/fibonacci";

export interface SetupOverlay {
  trendlines?: Trendline[];
  zones?: Zone[];
  fib?: FibSetup;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
}

const W = 960;
const H = 540;
const PAD_R = 64; // price labels
const PAD_B = 24; // time labels
const UP = "#26a69a";
const DOWN = "#ef5350";
const BG = "#0b0e11";
const GRID = "#1c212b";
const TEXT = "#d1d4dc";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * Server-side chart renderer: draws candles + overlays to an SVG, converted
 * to PNG by the caller (sharp). Used by the vision confirmation (#5) and the
 * rendering validation check (Section 6, use #3) — both need a real image of
 * exactly what the engine detected, rendered from the same coordinates.
 */
export function renderSetupSvg(candles: Candle[], overlay: SetupOverlay): string {
  const view = candles.slice(-140);
  if (view.length === 0) throw new Error("no candles to render");
  const offset = candles.length - view.length; // candle[0] in view = index `offset` in full series

  let min = Infinity;
  let max = -Infinity;
  for (const c of view) {
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
  }
  // expand bounds to fit overlays (zones/fib/levels may sit off-price)
  for (const z of overlay.zones ?? []) {
    min = Math.min(min, z.bottom);
    max = Math.max(max, z.top);
  }
  for (const v of [overlay.entry, overlay.stopLoss, overlay.takeProfit]) {
    if (v != null) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const firstTime = view[0].time;
  const lastTime = view[view.length - 1].time;
  for (const line of overlay.trendlines ?? []) {
    const startTime = Math.max(line.origin.time, firstTime);
    const start = lineValueAtTime(line, startTime);
    const end = lineValueAtTime(line, lastTime);
    min = Math.min(min, start, end);
    max = Math.max(max, start, end);
  }
  const span = max - min || 1;
  min -= span * 0.06;
  max += span * 0.06;

  const plotW = W - PAD_R;
  const plotH = H - PAD_B;
  const cw = plotW / view.length;
  const x = (i: number) => (i - offset + 0.5) * cw;
  const xTime = (time: number) => ((time - firstTime) / (lastTime - firstTime || 1)) * plotW;
  const y = (p: number) => plotH * (1 - (p - min) / (max - min));

  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  for (let g = 0; g <= 4; g++) {
    const gy = (plotH / 4) * g;
    el.push(`<line x1="0" y1="${gy}" x2="${plotW}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`);
  }

  // zone + fib boxes (extend forward to the right edge, Section 5 box convention)
  for (const z of overlay.zones ?? []) {
    const x0 = Math.max(0, x(z.startIndex) - cw / 2);
    const y0 = y(z.top);
    const h = Math.abs(y(z.bottom) - y0);
    const fill = z.kind === "demand" ? "rgba(38,166,154," : "rgba(239,83,80,";
    const alpha = z.active ? "0.22)" : "0.08)"; // invalidated = greyed/faded
    el.push(`<rect x="${x0}" y="${y0}" width="${plotW - x0}" height="${h}" fill="${fill}${alpha}" stroke="${z.kind === "demand" ? UP : DOWN}" stroke-opacity="${z.active ? 0.7 : 0.25}"/>`);
  }
  if (overlay.fib) {
    const f = overlay.fib;
    const yTop = y(f.goldenTop);
    const h = Math.abs(y(f.goldenBottom) - yTop);
    const color = f.direction === "long" ? UP : DOWN; // green buy zone / red sell zone
    el.push(`<rect x="0" y="${yTop}" width="${plotW}" height="${h}" fill="${color}22" stroke="${color}" stroke-dasharray="4 3" stroke-opacity="0.8"/>`);
  }

  // H4 action lines projected by time onto the selected execution chart.
  for (const tl of overlay.trendlines ?? []) {
    const startTime = Math.max(tl.origin.time, firstTime);
    if (startTime >= lastTime) continue;
    const stroke = tl.kind === "resistance" ? "#f0b90b" : "#58a6ff";
    const dash = tl.broken ? ' stroke-dasharray="7 5"' : "";
    el.push(
      `<line x1="${xTime(startTime)}" y1="${y(lineValueAtTime(tl, startTime))}" x2="${xTime(lastTime)}" y2="${y(lineValueAtTime(tl, lastTime))}" stroke="${stroke}" stroke-width="1.5"${dash}/>` +
        tl.anchors
          .filter((p) => p.time >= firstTime && p.time <= lastTime)
          .map((p) => `<circle cx="${xTime(p.time)}" cy="${y(p.price)}" r="3" fill="${stroke}"/>`)
          .join("")
    );
  }

  // candles
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const up = c.close >= c.open;
    const color = up ? UP : DOWN;
    const cx = x(i + offset);
    el.push(`<line x1="${cx}" y1="${y(c.high)}" x2="${cx}" y2="${y(c.low)}" stroke="${color}" stroke-width="1"/>`);
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    el.push(`<rect x="${cx - Math.max(1, cw * 0.3)}" y="${bodyTop}" width="${Math.max(2, cw * 0.6)}" height="${bodyH}" fill="${color}"/>`);
  }

  // entry / SL / TP dashed levels with labels
  const level = (p: number, color: string, label: string) => {
    el.push(`<line x1="0" y1="${y(p)}" x2="${plotW}" y2="${y(p)}" stroke="${color}" stroke-dasharray="6 4" stroke-width="1.2"/>`);
    el.push(`<text x="${plotW + 4}" y="${y(p) + 4}" fill="${color}" font-size="11" font-family="monospace">${esc(label)} ${p.toFixed(5)}</text>`);
  };
  if (overlay.entry != null) level(overlay.entry, "#d1d4dc", "E");
  if (overlay.stopLoss != null) level(overlay.stopLoss, DOWN, "SL");
  if (overlay.takeProfit != null) level(overlay.takeProfit, UP, "TP");

  // price scale labels
  for (let g = 0; g <= 4; g++) {
    const p = max - ((max - min) / 4) * g;
    el.push(`<text x="${plotW + 4}" y="${(plotH / 4) * g + 4}" fill="${TEXT}" font-size="10" font-family="monospace">${p.toFixed(5)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${el.join("")}</svg>`;
}

/** SVG → PNG buffer via sharp. */
export async function renderSetupPng(candles: Candle[], overlay: SetupOverlay): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const svg = Buffer.from(renderSetupSvg(candles, overlay));
  return sharp(svg, { density: 144 }).png().toBuffer();
}
