"use client";

import type { ISeriesPrimitive, IPrimitivePaneView, SeriesAttachedParameter, Time } from "lightweight-charts";

// CanvasRenderingTarget2D is from the bundled 'fancy-canvas' dep (not re-exported)
// — use a structural type for the slice of its API we rely on.
interface RenderTarget {
  useMediaCoordinateSpace<T>(f: (scope: {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
  }) => T): T;
}

export interface OverlayData {
  /** the system's read: the levels a 15-minute close has to break for an entry, and the swing a stop would go beyond */
  trend?: {
    direction: "long" | "short";
    /** the last swing and each channel; `armed` is false while price is already beyond the level */
    levels: { label: string; price: number; armed: boolean }[];
    /** false while the trend readings do not agree */
    ready: boolean;
    /** the high (sell) / low (buy) of the last two candles: a new trade's stop goes just beyond it */
    stopSwing?: number | null;
  } | null;
  /** support/resistance zones: bands where several 1-hour swing highs/lows sit */
  zones?: { low: number; high: number; touches: number }[];
  /** the open trade's plan (entry/SL/TP), drawn as a position tool — the system holds one at a time */
  positions?: {
    /** the trade's name as shown on the chart */
    label: string;
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit: number;
    /** where the stop stands now, once the profit lock has moved it */
    stopNow?: number | null;
    startTime: number;
    rMultiple: number;
  }[];
  /** settled signals: entry → the bar/price where the trade closed */
  history?: {
    direction: "long" | "short";
    entry: number;
    startTime: number;
    endTime: number;
    exitPrice: number;
    outcome: "win" | "loss";
    r: number;
  }[];
  /** price display precision on labels */
  digits?: number;
}

export const EMPTY_OVERLAY: OverlayData = {};

/** One colour per idea, used the same way on the chart and in the panels: blue for the trend entries, green/red for direction and results. */
export const CHART_COLORS = {
  trend: "56,189,248", // sky blue — the breakout levels
  zone: "245,158,11", // amber — support and resistance
  muted: "100,116,139",
  ink: "229,231,235",
  win: "38,166,154",
  loss: "239,83,80",
} as const;

const rgba = (rgb: string, alpha: number) => `rgba(${rgb},${alpha})`;
const FONT = '600 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_SMALL = '600 9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

interface PaneSource {
  timeToX(time: number): number | null;
  priceToY(price: number): number | null;
}

/**
 * Draws the entry levels, the level a stop would sit beyond, the open trade
 * and the closed trades on the candle pane. The visual rules:
 *
 *  - a LEVEL is a line with a tag; the entry levels are muted while the trend
 *    is not confirmed, and levels that share a price are drawn once;
 *  - an open trade is its entry, stop and target lines over a soft
 *    profit/loss shading;
 *  - labels never overprint each other: one that finds no room is dropped.
 *
 * All coordinates come straight from the detection engine.
 */
class OverlayPaneView implements IPrimitivePaneView {
  constructor(
    private readonly source: PaneSource,
    private readonly data: OverlayData
  ) {}

  renderer() {
    const { source, data } = this;
    return {
      draw(target: RenderTarget) {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          const W = mediaSize.width;
          const C = CHART_COLORS;
          const fmt = (n: number) => n.toFixed(data.digits ?? 2);
          const X = (t: number) => source.timeToX(t);
          const Y = (p: number) => source.priceToY(p);

          // ── labels: collected while drawing, laid out at the end ─────────
          interface Label { text: string; x: number; y: number; rgb: string; align: "left" | "right"; prio: number; small?: boolean; dim?: boolean }
          const labels: Label[] = [];
          const tag = (text: string, x: number, y: number, rgb: string, align: "left" | "right", prio: number, opts: { small?: boolean; dim?: boolean } = {}) =>
            labels.push({ text, x, y, rgb, align, prio, ...opts });

          // ── primitives ───────────────────────────────────────────────────
          const line = (x0: number, x1: number, y: number, rgb: string, alpha: number, width = 1, dash: number[] = []) => {
            ctx.strokeStyle = rgba(rgb, alpha);
            ctx.lineWidth = width;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
          };
          const segment = (ax: number, ay: number, bx: number, by: number, rgb: string, alpha: number, width = 1, dash: number[] = []) => {
            ctx.strokeStyle = rgba(rgb, alpha);
            ctx.lineWidth = width;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
          };
          const dot = (x: number, y: number, rgb: string, radius = 3) => {
            ctx.fillStyle = rgba(rgb, 1);
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
          };
          const side = (direction: "long" | "short") => (direction === "long" ? "BUY" : "SELL");

          // ── results: settled trades ──────────────────────────────────────
          for (const h of data.history ?? []) {
            const [xA, xB, yA, yB] = [X(h.startTime), X(h.endTime), Y(h.entry), Y(h.exitPrice)];
            if (xA == null || xB == null || yA == null || yB == null || xB < 0) continue;
            const rgb = h.outcome === "win" ? C.win : C.loss;
            segment(xA, yA, xB, yB, rgb, 0.9, 1.5, []);
            dot(xA, yA, rgb, 2.5);
            dot(xB, yB, rgb, 4);
            const result = `${h.r >= 0 ? "+" : "−"}${Math.abs(h.r).toFixed(1)}R`;
            tag(`${h.direction === "long" ? "BUY" : "SELL"} ${result}`, xB + 7, yB - 3, rgb, "left", 4, { small: true });
          }

          // ── support and resistance: a band per zone, behind everything else ──
          for (const z of data.zones ?? []) {
            const [yHi, yLo] = [Y(z.high), Y(z.low)];
            if (yHi == null || yLo == null) continue;
            const top = Math.min(yHi, yLo) - 1;
            const h = Math.max(Math.abs(yLo - yHi), 2) + 2;
            ctx.fillStyle = rgba(C.zone, 0.1);
            ctx.fillRect(0, top, W, h);
            line(0, W, top, C.zone, 0.35, 1, []);
            line(0, W, top + h, C.zone, 0.35, 1, []);
            tag(`S/R ${fmt(z.low)}–${fmt(z.high)} · ${z.touches} touches`, W - 4, top + h + 10, C.zone, "right", 2, { small: true, dim: true });
          }

          // ── the entry levels: what a 15-minute close has to break ─────────
          if (data.trend) {
            const t = data.trend;
            const up = t.direction === "long";
            // the last swing and the channels often share a high/low: one line, the names listed together
            const byPrice = new Map<number, { names: string[]; armed: boolean }>();
            for (const l of t.levels) {
              const g = byPrice.get(l.price) ?? { names: [], armed: false };
              g.names.push(l.label);
              g.armed = g.armed || l.armed;
              byPrice.set(l.price, g);
            }
            for (const [price, g] of byPrice) {
              const y = Y(price);
              if (y == null) continue;
              const live = t.ready && g.armed;
              line(0, W, y, C.trend, live ? 0.7 : 0.3, 1, [8, 4]);
              tag(`${side(t.direction)} on a 15-min close ${up ? "above" : "below"} ${fmt(price)} (${g.names.join(", ")})${t.ready ? (g.armed ? "" : " · already beyond") : " · trend not confirmed"}`, 8, y + (up ? -3 : 13), C.trend, "left", 3, { small: true, dim: !live });
            }
            // the last two candles' extreme on the other side: where a new trade's stop would go
            const yS = t.stopSwing != null ? Y(t.stopSwing) : null;
            if (yS != null && !data.positions?.length) {
              line(0, W, yS, C.loss, t.ready ? 0.45 : 0.25, 1, [2, 4]);
              tag(`${up ? "low" : "high"} of the last two candles ${fmt(t.stopSwing!)} · a new trade's stop goes beyond it`, 8, yS + (up ? 13 : -3), C.loss, "left", 6, { small: true, dim: true });
            }
          }

          // ── the open trade plans ─────────────────────────────────────────
          for (const p of data.positions ?? []) {
            const x0 = Math.max(X(p.startTime) ?? 0, 0);
            const [yE, yS, yT] = [Y(p.entry), Y(p.stopLoss), Y(p.takeProfit)];
            if (yE == null || yS == null || yT == null) continue;
            ctx.fillStyle = rgba(C.win, 0.09);
            ctx.fillRect(x0, Math.min(yE, yT), W - x0, Math.abs(yT - yE));
            ctx.fillStyle = rgba(C.loss, 0.09);
            ctx.fillRect(x0, Math.min(yE, yS), W - x0, Math.abs(yS - yE));
            const dash: number[] = [];
            line(x0, W, yT, C.win, 0.95, 1.5, dash);
            line(x0, W, yE, C.ink, 0.95, 1.5, dash);
            // once the stop has been moved, it is the one that counts; the first one fades
            const trailed = p.stopNow != null && p.stopNow !== p.stopLoss;
            line(x0, W, yS, C.loss, trailed ? 0.4 : 0.95, trailed ? 1 : 1.5, trailed ? [4, 4] : dash);
            tag(`TARGET ${fmt(p.takeProfit)} · +${p.rMultiple.toFixed(p.rMultiple % 1 ? 2 : 0)}R`, W - 4, yT - 3, C.win, "right", 0);
            tag(`${p.label} ${side(p.direction)} ${fmt(p.entry)}`, W - 4, yE - 3, C.ink, "right", 0);
            tag(`${trailed ? "FIRST STOP" : "STOP"} ${fmt(p.stopLoss)}`, W - 4, yS - 3, C.loss, "right", trailed ? 6 : 0, { small: trailed, dim: trailed });
            const yN = trailed ? Y(p.stopNow!) : null;
            if (yN != null) {
              line(x0, W, yN, C.loss, 0.95, 1.5, dash);
              tag(`STOP NOW ${fmt(p.stopNow!)} (moved — profit locked)`, W - 4, yN - 3, C.loss, "right", 0);
            }
          }

          // ── label layout: by priority; no room means no label ────────────
          const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
          labels.sort((a, b) => a.prio - b.prio);
          for (const l of labels) {
            ctx.font = l.small ? FONT_SMALL : FONT;
            const H = l.small ? 12 : 14;
            const w = ctx.measureText(l.text).width + (l.small ? 8 : 12);
            const left = Math.max(2, Math.min(l.align === "right" ? l.x - w : l.x, W - w - 2));
            for (const dy of [0, H + 1, -(H + 1), 2 * (H + 1), -2 * (H + 1), 3 * (H + 1), -3 * (H + 1)]) {
              const top = l.y - H + 3 + dy;
              if (top < 0 || top + H > mediaSize.height) continue;
              if (placed.some((p) => left < p.x1 + 2 && left + w > p.x0 - 2 && top < p.y1 + 1 && top + H > p.y0 - 1)) continue;
              placed.push({ x0: left, y0: top, x1: left + w, y1: top + H });
              ctx.fillStyle = "rgba(11,14,17,0.88)";
              ctx.fillRect(left, top, w, H);
              if (!l.small) {
                // strategy tags carry their colour as a bar; context tags stay plain
                ctx.fillStyle = rgba(l.rgb, l.dim ? 0.5 : 1);
                ctx.fillRect(left, top, 2, H);
              }
              ctx.fillStyle = rgba(l.rgb, l.dim ? 0.7 : 1);
              ctx.textAlign = "left";
              ctx.textBaseline = "middle";
              ctx.fillText(l.text, left + (l.small ? 4 : 7), top + H / 2 + 0.5);
              ctx.textBaseline = "alphabetic";
              break;
            }
          }
        });
      },
    };
  }
}

/** ISeriesPrimitive wrapper so the overlay renders in the candle pane. */
export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private _view: OverlayPaneView | null = null;
  private _param: SeriesAttachedParameter<Time> | null = null;

  constructor(private readonly data: OverlayData) {}

  attached(param: SeriesAttachedParameter<Time>) {
    this._param = param;
  }

  updateAllViews() {
    if (!this._param) return;
    const { chart, series } = this._param;
    const source: PaneSource = {
      timeToX: (t) => {
        const x = chart.timeScale().timeToCoordinate(t as Time);
        return x == null ? null : (x as number);
      },
      priceToY: (p) => series.priceToCoordinate(p) as number | null,
    };
    this._view = new OverlayPaneView(source, this.data);
  }

  paneViews() {
    return this._view ? [this._view] : [];
  }
}
