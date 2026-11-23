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
  /** the Fibonacci system's read: the 1-hour swing, its retracement levels, the entry zone and the trade's levels */
  fib: {
    direction: "long" | "short";
    /** where the swing started (100%) and ended (0%) */
    origin: { time: number; price: number };
    end: { time: number; price: number };
    levels: { level: number; price: number }[];
    zone: { shallow: number; deep: number; shallowLevel: number; deepLevel: number } | null;
    stopLoss: number | null;
    takeProfit: number | null;
    /** the target as a multiple of the swing, e.g. 1.618 */
    targetLevel: number;
    /** false when the trend, the size of the swing or its state rules a trade out */
    tradeable: boolean;
    /** true while the last closed candle is inside the entry zone */
    inZone?: boolean;
  } | null;
  /** the open trade's plan (entry/SL/TP), drawn as a position tool */
  position?: {
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit: number;
    startTime: number;
    rMultiple: number;
  } | null;
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

export const EMPTY_OVERLAY: OverlayData = { fib: null };

/** One colour per idea, used the same way on the chart and in the panels: violet for the Fibonacci levels, green/red for direction and results. */
export const CHART_COLORS = {
  fib: "167,139,250", // violet
  zone: "250,204,21", // yellow — the entry zone
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
 * Draws the Fibonacci system's read on the candle pane. The visual rules:
 *
 *  - the entry ZONE is a soft box with a solid accent bar on its left edge
 *    and one label inside its top-left corner;
 *  - a retracement LEVEL is a line with a short tag at the right edge;
 *  - a swing the rules do not allow a trade on is drawn muted — outline only;
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
          type Emphasis = "live" | "ready" | "muted";
          /** A strategy area from x0 to the right edge. Returns the label anchor, or null when off-screen. */
          const area = (x0: number, priceA: number, priceB: number, rgb: string, emphasis: Emphasis) => {
            const yA = Y(priceA);
            const yB = Y(priceB);
            if (yA == null || yB == null) return null;
            const top = Math.min(yA, yB);
            const height = Math.max(Math.abs(yB - yA), 3);
            const left = Math.max(x0, 0);
            if (left >= W) return null;
            if (emphasis !== "muted") {
              ctx.fillStyle = rgba(rgb, emphasis === "live" ? 0.2 : 0.11);
              ctx.fillRect(left, top, W - left, height);
            }
            ctx.strokeStyle = rgba(rgb, emphasis === "muted" ? 0.35 : 0.55);
            ctx.lineWidth = 1;
            ctx.setLineDash(emphasis === "muted" ? [3, 3] : []);
            ctx.strokeRect(left + 0.5, top + 0.5, W - left, height - 1);
            ctx.setLineDash([]);
            if (x0 >= 0) {
              // accent bar where the area begins
              ctx.fillStyle = rgba(rgb, emphasis === "muted" ? 0.5 : 0.95);
              ctx.fillRect(left, top, 3, height);
            }
            // label sits inside the top-left corner, or above a box too thin to hold it
            // (a box that starts above the visible chart keeps its label at the top edge)
            return { x: left + 8, y: height >= 16 ? Math.max(top, 0) + 13 : top - 4 };
          };
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

          // ── the Fibonacci system: swing, levels, entry zone, stop and target ──
          if (data.fib) {
            const f = data.fib;
            const up = f.direction === "long";
            const [ox, oy, ex, ey] = [X(f.origin.time), Y(f.origin.price), X(f.end.time), Y(f.end.price)];
            const dim = !f.tradeable;
            if (ox != null && oy != null && ex != null && ey != null) {
              // the swing being measured: present, but never louder than the candles
              segment(ox, oy, ex, ey, C.fib, dim ? 0.35 : 0.6, 1, [5, 3]);
              dot(ox, oy, C.fib, 2.5);
              dot(ex, ey, C.fib, 2.5);
            }
            // levels run from the end of the swing (or the left edge when it has scrolled away) to the right edge
            const from = Math.max(ex ?? 0, 0);
            for (const lv of f.levels) {
              const y = Y(lv.price);
              if (y == null) continue;
              const edge = lv.level === 0 || lv.level === 1;
              line(from, W, y, C.fib, dim ? 0.25 : edge ? 0.6 : 0.4, 1, edge ? [] : [2, 4]);
              tag(`${(lv.level * 100).toFixed(1).replace(/\.0$/, "")}% ${fmt(lv.price)}`, W - 4, y - 3, C.fib, "right", 7, { small: true, dim: true });
            }
            if (f.zone) {
              const at = area(from, f.zone.shallow, f.zone.deep, C.zone, dim ? "muted" : f.inZone ? "live" : "ready");
              if (at) {
                const pct = (v: number) => (v * 100).toFixed(1);
                tag(`FIBONACCI · ${side(f.direction)} zone ${pct(f.zone.shallowLevel)}–${pct(f.zone.deepLevel)}% · ${fmt(Math.min(f.zone.shallow, f.zone.deep))}–${fmt(Math.max(f.zone.shallow, f.zone.deep))}${f.inZone ? " · price inside" : ""}${dim ? " · no trade" : ""}`, at.x, at.y, C.zone, "left", 2, { dim });
              }
            }
            // where a trade from this swing would have its stop and target (only while none is open)
            if (!data.position && !dim) {
              const yS = f.stopLoss != null ? Y(f.stopLoss) : null;
              const yT = f.takeProfit != null ? Y(f.takeProfit) : null;
              if (yS != null) {
                line(from, W, yS, C.loss, 0.55, 1, [6, 4]);
                tag(`stop would be ${fmt(f.stopLoss!)}`, W - 4, yS + (up ? 13 : -3), C.loss, "right", 5, { small: true });
              }
              if (yT != null) {
                line(from, W, yT, C.win, 0.55, 1, [6, 4]);
                tag(`target would be ${fmt(f.takeProfit!)} (${(f.targetLevel * 100).toFixed(1)}%)`, W - 4, yT - 3, C.win, "right", 5, { small: true });
              }
            }
          }

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

          // ── the open trade plan ──────────────────────────────────────────
          if (data.position) {
            const p = data.position;
            const x0 = Math.max(X(p.startTime) ?? 0, 0);
            const [yE, yS, yT] = [Y(p.entry), Y(p.stopLoss), Y(p.takeProfit)];
            if (yE != null && yS != null && yT != null) {
              ctx.fillStyle = rgba(C.win, 0.09);
              ctx.fillRect(x0, Math.min(yE, yT), W - x0, Math.abs(yT - yE));
              ctx.fillStyle = rgba(C.loss, 0.09);
              ctx.fillRect(x0, Math.min(yE, yS), W - x0, Math.abs(yS - yE));
              const dash: number[] = [];
              line(x0, W, yT, C.win, 0.95, 1.5, dash);
              line(x0, W, yE, C.ink, 0.95, 1.5, dash);
              line(x0, W, yS, C.loss, 0.95, 1.5, dash);
              tag(`TARGET ${fmt(p.takeProfit)} · +${p.rMultiple.toFixed(p.rMultiple % 1 ? 2 : 0)}R`, W - 4, yT - 3, C.win, "right", 0);
              tag(`${side(p.direction)} ${fmt(p.entry)}`, W - 4, yE - 3, C.ink, "right", 0);
              tag(`STOP ${fmt(p.stopLoss)}`, W - 4, yS - 3, C.loss, "right", 0);
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
