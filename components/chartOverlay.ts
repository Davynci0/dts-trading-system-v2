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
  zones: {
    kind: "demand" | "supply";
    top: number;
    bottom: number;
    startTime: number;
    /** times price has returned to the zone (0 = untouched) */
    touches?: number;
    /** false when the trend rule does not allow a trade from this zone */
    tradeable?: boolean;
  }[];
  /** Alex G Set & Forget: the 50–61.8% AOI of the most recent structure-breaking leg */
  aoi: {
    direction: "long" | "short";
    top: number;
    bottom: number;
    startTime: number;
    legEndTime: number;
    tested: boolean;
    /** the impulse leg the AOI is measured on */
    leg?: { lowTime: number; lowPrice: number; highTime: number; highPrice: number };
    tradeable?: boolean;
  } | null;
  fib: {
    direction: "long" | "short";
    goldenTop: number;
    goldenBottom: number;
    /** swing anchors + golden-ratio levels for precise rendering */
    swingLow: { time: number; price: number };
    swingHigh: { time: number; price: number };
    level50: number;
    level618: number;
    level786: number;
    range: number;
    /** true when this is the swing the scanner would trade; false = reference only */
    isSetup?: boolean;
    /** true while the latest closed candle is inside the golden zone */
    inZone?: boolean;
    tradeable?: boolean;
  } | null;
  /** pending signal's trade plan (entry/SL/TP), drawn as a position tool */
  position?: {
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit: number;
    startTime: number;
    riskPips: number;
    rewardPips: number;
    rMultiple: number;
    skipped: boolean;
  } | null;
  /** settled signals: entry → the bar/price where TP or SL was hit */
  history?: {
    direction: "long" | "short";
    entry: number;
    startTime: number;
    endTime: number;
    exitPrice: number;
    outcome: "win" | "loss";
    r: number;
    skipped: boolean;
  }[];
  /** price display precision on labels (XAU 2, JPY quotes 3, 4-dec majors 5) */
  digits?: number;
  /** trendlines from structural pivots, drawn as rays from origin through definitionAnchor */
  trendlines?: {
    kind: "resistance" | "support";
    origin: { time: number; price: number };
    definitionAnchor: { time: number; price: number };
    anchors: { time: number; price: number }[];
    touches: number;
    broken: boolean;
  }[];
  /** head-and-shoulders reversal patterns on the chart */
  headshoulders?: {
    direction: "short" | "long";
    ls: { time: number; price: number };
    n1: { time: number; price: number };
    h: { time: number; price: number };
    n2: { time: number; price: number };
    rs: { time: number; price: number };
    target: number;
    triggerTime: number;
  }[];
  /** support/resistance: H1 levels price has turned at more than once */
  levels?: {
    kind: "support" | "resistance";
    price: number;
    /** the band the level's swing points span */
    top: number;
    bottom: number;
    touches: number;
    /** has acted as both support and resistance */
    flipped: boolean;
    time: number;
  }[];
  /** trend breakout: the one-week channel and the daily trend */
  breakout?: {
    trend: 1 | -1 | 0;
    channel: { high: number; low: number; startTime?: number } | null;
  } | null;
  /** market structure: the engine's swing points, labelled HH / HL / LH / LL */
  structure?: {
    time: number;
    price: number;
    kind: "high" | "low";
    label: string;
  }[];
}

export const EMPTY_OVERLAY: OverlayData = { zones: [], aoi: null, fib: null, trendlines: [] };

/**
 * One colour per idea, used the same way everywhere (chart, legend, tracker):
 * the four strategies each own a hue, and green/red are kept for direction
 * and results.
 */
export const CHART_COLORS = {
  breakout: "245,158,11", // amber
  demand: "38,166,154", // teal — buy zones
  supply: "239,83,80", // red — sell zones
  fib: "167,139,250", // violet
  aoi: "56,189,248", // sky
  level: "203,213,225", // slate — support / resistance
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
 * Draws the engine's analysis on the candle pane. The visual rules:
 *
 *  - a strategy's AREA (zone, golden zone, AOI) is a soft box with a solid
 *    accent bar on its left edge and one label inside its top-left corner;
 *  - a LEVEL (breakout trigger, support/resistance) is a line with a short
 *    tag at the right edge;
 *  - anything the trend rule does not allow is drawn muted — outline only —
 *    so what can actually be traded is what stands out;
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
            return { x: left + 8, y: height >= 16 ? top + 13 : top - 4 };
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
          const emphasisOf = (tradeable: boolean | undefined, live = false): Emphasis =>
            tradeable === false ? "muted" : live ? "live" : "ready";
          const againstTrend = (tradeable: boolean | undefined) => (tradeable === false ? " · against the trend" : "");

          // ── context: support / resistance ────────────────────────────────
          // A line at each level with a short tag on the right. Levels that have
          // been both ceiling and floor ("flipped") count as a confirmation, so
          // they are solid; the rest are dotted.
          for (const lvl of data.levels ?? []) {
            const y = Y(lvl.price);
            if (y == null) continue;
            const from = Math.max(X(lvl.time) ?? 0, 0);
            if (lvl.flipped) {
              const yTop = Y(lvl.top);
              const yBottom = Y(lvl.bottom);
              if (yTop != null && yBottom != null) {
                ctx.fillStyle = rgba(C.level, 0.05);
                ctx.fillRect(from, Math.min(yTop, yBottom), W - from, Math.max(Math.abs(yBottom - yTop), 1));
              }
            }
            line(from, W, y, C.level, lvl.flipped ? 0.6 : 0.35, 1, lvl.flipped ? [] : [2, 4]);
            const name = lvl.flipped ? "S/R" : lvl.kind === "support" ? "S" : "R";
            tag(`${name} ${fmt(lvl.price)}${lvl.touches > 1 ? ` ×${lvl.touches}` : ""}`, W - 4, y - 3, C.level, "right", 6, { small: true, dim: !lvl.flipped });
          }

          // ── context: market structure ────────────────────────────────────
          if (data.structure && data.structure.length > 1) {
            const pts = data.structure
              .map((sp) => ({ ...sp, px: X(sp.time), py: Y(sp.price) }))
              .filter((sp): sp is typeof sp & { px: number; py: number } => sp.px != null && sp.py != null);
            ctx.strokeStyle = rgba(C.muted, 0.45);
            ctx.lineWidth = 1;
            ctx.beginPath();
            pts.forEach((sp, i) => (i === 0 ? ctx.moveTo(sp.px, sp.py) : ctx.lineTo(sp.px, sp.py)));
            ctx.stroke();
            for (const sp of pts) {
              if (sp.px < 0 || sp.px > W) continue; // off-screen swings keep their place in the zigzag, no label
              const bullish = sp.label === "HH" || sp.label === "HL";
              const bearish = sp.label === "LH" || sp.label === "LL";
              tag(sp.label, sp.px - 7, sp.py + (sp.kind === "high" ? -7 : 15), bullish ? C.demand : bearish ? C.supply : C.muted, "left", 8, { small: true });
            }
          }

          // ── context: trendlines ──────────────────────────────────────────
          for (const l of data.trendlines ?? []) {
            const x0 = X(l.origin.time);
            const y0 = Y(l.origin.price);
            const x1 = X(l.definitionAnchor.time);
            const y1 = Y(l.definitionAnchor.price);
            if (x0 == null || y0 == null || x1 == null || y1 == null || x1 === x0) continue;
            const rgb = l.broken ? C.muted : l.kind === "support" ? C.demand : C.supply;
            const yEdge = y0 + ((y1 - y0) / (x1 - x0)) * (W - x0);
            segment(x0, y0, W, yEdge, rgb, l.broken ? 0.5 : 0.8, 1, l.broken ? [5, 4] : []);
            for (const a of l.anchors) {
              const ax = X(a.time);
              const ay = Y(a.price);
              if (ax != null && ay != null) dot(ax, ay, rgb, 2.5);
            }
            tag(`Trendline · ${l.kind} ×${l.touches}${l.broken ? " · broken" : ""}`, Math.min(x1 + 8, W - 10), y1 - 5, rgb, "left", 7, { small: true, dim: l.broken });
          }

          // ── context: head and shoulders ──────────────────────────────────
          for (const p of data.headshoulders ?? []) {
            const pts = [p.ls, p.n1, p.h, p.n2, p.rs].map((pt) => ({ px: X(pt.time), py: Y(pt.price) }));
            if (!pts.every((g) => g.px != null && g.py != null)) continue;
            const rgb = p.direction === "short" ? C.supply : C.demand;
            for (let i = 1; i < pts.length; i++) segment(pts[i - 1].px!, pts[i - 1].py!, pts[i].px!, pts[i].py!, rgb, 0.8, 1, [4, 3]);
            ["LS", "", "H", "", "RS"].forEach((name, i) => {
              if (!name) return;
              dot(pts[i].px!, pts[i].py!, rgb, 2.5);
              tag(name, pts[i].px! - 6, pts[i].py! + (p.direction === "short" ? -7 : 15), rgb, "left", 7, { small: true });
            });
            const [n1, n2] = [pts[1], pts[3]];
            if (n2.px !== n1.px) {
              const yEdge = n1.py! + ((n2.py! - n1.py!) / (n2.px! - n1.px!)) * (W - n1.px!);
              segment(n1.px!, n1.py!, W, yEdge, C.level, 0.6);
              tag(`${p.direction === "short" ? "H&S" : "Inverse H&S"} neckline`, W - 4, yEdge - 3, C.level, "right", 7, { small: true });
            }
            const ty = Y(p.target);
            if (ty != null) {
              line(Math.max(pts[4].px!, 0), W, ty, rgb, 0.5, 1, [6, 4]);
              tag(`H&S target ${fmt(p.target)}`, W - 4, ty - 3, rgb, "right", 7, { small: true });
            }
          }

          // ── strategy: supply / demand zones ──────────────────────────────
          for (const z of data.zones) {
            const rgb = z.kind === "demand" ? C.demand : C.supply;
            const at = area(X(z.startTime) ?? 0, z.top, z.bottom, rgb, emphasisOf(z.tradeable));
            if (!at) continue;
            const visits = z.touches == null ? "" : z.touches === 0 ? " · untouched" : z.touches === 1 ? " · 1 touch" : ` · ${z.touches} touches`;
            tag(`ZONE · ${z.kind === "demand" ? "BUY" : "SELL"} ${fmt(z.bottom)}–${fmt(z.top)}${visits}${againstTrend(z.tradeable)}`, at.x, at.y, rgb, "left", 3, { dim: z.tradeable === false });
          }

          // ── strategy: set & forget AOI ───────────────────────────────────
          if (data.aoi) {
            const a = data.aoi;
            if (a.leg) {
              const [lx, ly, hx, hy] = [X(a.leg.lowTime), Y(a.leg.lowPrice), X(a.leg.highTime), Y(a.leg.highPrice)];
              if (lx != null && ly != null && hx != null && hy != null) segment(lx, ly, hx, hy, C.aoi, 0.6, 1, [5, 3]);
            }
            const at = area(X(a.legEndTime) ?? 0, a.top, a.bottom, C.aoi, a.tested ? "muted" : emphasisOf(a.tradeable));
            if (at) {
              tag(`SET & FORGET · ${side(a.direction)} AOI ${fmt(a.bottom)}–${fmt(a.top)}${a.tested ? " · already tested" : ""}${againstTrend(a.tradeable)}`, at.x, at.y, C.aoi, "left", 2, { dim: a.tested || a.tradeable === false });
            }
          }

          // ── strategy: fibonacci golden zone ──────────────────────────────
          if (data.fib) {
            const f = data.fib;
            const up = f.direction === "long";
            const end = up ? f.swingHigh : f.swingLow; // 0% — where the swing finished
            const origin = up ? f.swingLow : f.swingHigh; // 100% — where it began
            const [ox, oy, ex, ey] = [X(origin.time), Y(origin.price), X(end.time), Y(end.price)];
            const reference = f.isSetup === false;
            if (ox != null && oy != null && ex != null && ey != null) {
              // the swing being measured: present, but never louder than the candles
              segment(ox, oy, ex, ey, C.fib, reference ? 0.3 : 0.5, 1, [5, 3]);
              dot(ox, oy, C.fib, 2.5);
              dot(ex, ey, C.fib, 2.5);
              // an anchor scrolled out of view gets no label (it would be pinned to the edge)
              if (ox >= 0 && ox <= W) tag("100%", ox - 12, oy + (up ? 14 : -6), C.fib, "left", 6, { small: true, dim: true });
              if (ex >= 0 && ex <= W) tag("0%", ex - 6, ey + (up ? -6 : 14), C.fib, "left", 6, { small: true, dim: true });
            }
            const from = ex ?? 0;
            const at = area(from, f.goldenTop, f.goldenBottom, C.fib, reference ? "muted" : emphasisOf(f.tradeable, f.inZone === true));
            const y50 = Y(f.level50);
            if (y50 != null) {
              line(Math.max(from, 0), W, y50, C.fib, 0.35, 1, [2, 4]);
              tag("50%", W - 4, y50 - 3, C.fib, "right", 7, { small: true, dim: true });
            }
            if (at) {
              const text = reference
                ? `FIB reference · 61.8–78.6% ${fmt(f.goldenBottom)}–${fmt(f.goldenTop)} · no setup`
                : `FIBONACCI · ${side(f.direction)} 61.8–78.6% ${fmt(f.goldenBottom)}–${fmt(f.goldenTop)}${f.inZone ? " · price inside" : ""}${againstTrend(f.tradeable)}`;
              tag(text, at.x, at.y, C.fib, "left", 2, { dim: reference || f.tradeable === false });
            }
          }

          // ── strategy: trend breakout ─────────────────────────────────────
          // The one-week channel is a faint bracket over its own bars; only
          // the edge on the trend's side is a trigger, drawn as one amber line.
          if (data.breakout?.channel) {
            const b = data.breakout;
            const ch = b.channel!;
            const yTop = Y(ch.high);
            const yBottom = Y(ch.low);
            const x0 = Math.max((ch.startTime != null ? X(ch.startTime) : null) ?? 0, 0);
            if (yTop != null && yBottom != null) {
              ctx.fillStyle = rgba(C.breakout, 0.035);
              ctx.fillRect(x0, yTop, Math.max(W - x0, 2), yBottom - yTop);
              // the edge against the trend is context only
              const idle = b.trend === 1 ? yBottom : b.trend === -1 ? yTop : null;
              for (const y of idle == null ? [yTop, yBottom] : [idle]) line(x0, W, y, C.breakout, 0.35, 1, [2, 4]);
              tag("1-week range", x0 + 6, yTop + 12, C.breakout, "left", 7, { small: true, dim: true });
            }
            if (b.trend !== 0) {
              const up = b.trend === 1;
              const level = up ? ch.high : ch.low;
              const y = Y(level);
              if (y != null) {
                line(x0, W, y, C.breakout, 0.95, 1.5, []);
                tag(`BREAKOUT · ${up ? "BUY above" : "SELL below"} ${fmt(level)} · 1-week ${up ? "high" : "low"}`, W - 4, y - 3, C.breakout, "right", 1);
              }
            }
          }

          // ── results: settled trades ──────────────────────────────────────
          for (const h of data.history ?? []) {
            const [xA, xB, yA, yB] = [X(h.startTime), X(h.endTime), Y(h.entry), Y(h.exitPrice)];
            if (xA == null || xB == null || yA == null || yB == null || xB < 0) continue;
            const rgb = h.outcome === "win" ? C.win : C.loss;
            segment(xA, yA, xB, yB, rgb, 0.9, 1.5, h.skipped ? [4, 3] : []);
            dot(xA, yA, rgb, 2.5);
            dot(xB, yB, rgb, 4);
            const result = h.outcome === "win" ? `+${h.r.toFixed(1)}R` : "−1R";
            tag(`${h.skipped ? "skipped " : ""}${h.direction === "long" ? "BUY" : "SELL"} ${result}`, xB + 7, yB - 3, rgb, "left", 4, { small: true });
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
              const dash = p.skipped ? [6, 4] : [];
              line(x0, W, yT, C.win, 0.95, 1.5, dash);
              line(x0, W, yE, C.ink, 0.95, 1.5, dash);
              line(x0, W, yS, C.loss, 0.95, 1.5, dash);
              tag(`TARGET ${fmt(p.takeProfit)} · +${p.rMultiple.toFixed(p.rMultiple % 1 ? 2 : 0)}R`, W - 4, yT - 3, C.win, "right", 0);
              tag(`${p.skipped ? "SKIPPED " : ""}${side(p.direction)} ${fmt(p.entry)}`, W - 4, yE - 3, C.ink, "right", 0);
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
