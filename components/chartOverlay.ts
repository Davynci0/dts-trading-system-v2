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
  /** the 15-minute market structure: each swing with its label, and each close beyond a swing */
  structure?: {
    points: { time: number; price: number; kind: "high" | "low"; label: string }[];
    breaks: { time: number; level: number; levelTime: number; dir: 1 | -1; kind: "BOS" | "CHoCH" }[];
  } | null;
  /** yesterday's high and low */
  dayLevels?: { high: number; low: number } | null;
  /** stretches of candles in which no new trade is taken (first and last candle open time) */
  quiet?: { from: number; to: number; bars: number; label: string }[];
  /** fresh 1-hour supply (sell) and demand (buy) zones */
  sdZones?: { kind: "demand" | "supply"; low: number; high: number; known: number; /** open time of the chart candle the band starts at */ from?: number }[];
  /** the 1-hour trendlines the trendline strategy trades: the line's price at points along the chart */
  trendlines?: { kind: "down" | "up"; touches: number; now: number; points: { time: number; price: number }[]; touchPoints?: { time: number; price: number }[]; broken?: "long" | "short" | null }[];
  /** the trendline strategy's setups inside the chart: bounces, breaks and retests, and whether each was a trade */
  lineMarks?: { time: number; price: number; type: "bounce" | "break" | "retest"; direction: "long" | "short"; traded: boolean }[];
  /** Set and Forget's areas of interest (weekly and daily levels price has turned at), and the pullback's extreme its stop would go beyond */
  areas?: { low: number; high: number; touches: number; tf: "weekly" | "daily"; active?: boolean }[];
  pullback?: { price: number; side: "long" | "short" } | null;
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
  tori: "192,132,252", // violet — the trendline strategy's lines
  area: "129,140,248", // indigo — Set and Forget's areas of interest
  demand: "45,212,191", // teal — fresh demand
  supply: "251,113,133", // rose — fresh supply
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

          // ── the hours with no new trades: a faint band behind everything ──
          for (const q of data.quiet ?? []) {
            const [xa, xb] = [X(q.from), X(q.to)];
            if (xa == null || xb == null) continue;
            const half = q.bars > 1 ? (xb - xa) / (q.bars - 1) / 2 : 3;
            ctx.fillStyle = rgba(C.muted, 0.09);
            ctx.fillRect(xa - half, 0, xb - xa + 2 * half, mediaSize.height);
            // only where the band starts inside the view — a label pushed in from off-screen would pile up at the edge
            if (xb - xa > 60 && xa - half >= 0 && xa < W) tag(q.label, xa - half + 4, 12, C.muted, "left", 8, { small: true, dim: true });
          }

          // ── yesterday's high and low ─────────────────────────────────────
          if (data.dayLevels) {
            for (const [name, price] of [["yesterday's high", data.dayLevels.high], ["yesterday's low", data.dayLevels.low]] as const) {
              const y = Y(price);
              if (y == null) continue;
              line(0, W, y, C.ink, 0.3, 1, [1, 5]);
              tag(`${name} ${fmt(price)}`, 8, y - 3, C.ink, "left", 7, { small: true, dim: true });
            }
          }

          // ── market structure: breaks first (lines), then the swing labels ──
          if (data.structure) {
            ctx.font = FONT_SMALL;
            ctx.textBaseline = "alphabetic";
            for (const b of data.structure.breaks) {
              const xb = X(b.time);
              const y = Y(b.level);
              if (xb == null || y == null) continue;
              const xa = Math.max(X(b.levelTime) ?? 0, 0);
              const rgb = b.dir === 1 ? C.win : C.loss;
              const turn = b.kind === "CHoCH";
              segment(xa, y, xb, y, rgb, turn ? 0.95 : 0.6, turn ? 1.5 : 1, turn ? [] : [3, 3]);
              if (xb - xa >= (turn ? 34 : 22)) {
                ctx.textAlign = "center";
                ctx.fillStyle = rgba(rgb, turn ? 1 : 0.75);
                ctx.fillText(b.kind, (xa + xb) / 2, y + (b.dir === 1 ? -3 : 10));
              }
            }
            let lastTop = -Infinity;
            let lastBottom = -Infinity;
            for (const p of data.structure.points) {
              const x = X(p.time);
              const y = Y(p.price);
              if (x == null || y == null) continue;
              const top = p.kind === "high";
              // labels that would sit on top of each other are left out; the swing itself is still marked
              const room = x - (top ? lastTop : lastBottom) >= 18;
              const bullish = p.label === "HH" || p.label === "HL";
              const rgb = p.label.length === 1 ? C.muted : bullish ? C.win : C.loss;
              dot(x, y + (top ? -3 : 3), rgb, 1.5);
              if (!room) continue;
              ctx.textAlign = "center";
              ctx.fillStyle = rgba(rgb, 0.9);
              ctx.fillText(p.label, x, y + (top ? -8 : 15));
              if (top) lastTop = x;
              else lastBottom = x;
            }
            ctx.textAlign = "left";
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

          // ── fresh supply and demand: a band from where the zone formed to the right edge ──
          for (const z of data.sdZones ?? []) {
            const [yHi, yLo] = [Y(z.high), Y(z.low)];
            if (yHi == null || yLo == null) continue;
            const x0 = Math.max(X(z.from ?? Math.floor(z.known / 900) * 900 - 900) ?? 0, 0);
            const rgb = z.kind === "demand" ? C.demand : C.supply;
            const top = Math.min(yHi, yLo);
            const h = Math.max(Math.abs(yLo - yHi), 2);
            ctx.fillStyle = rgba(rgb, 0.12);
            ctx.fillRect(x0, top, W - x0, h);
            ctx.strokeStyle = rgba(rgb, 0.5);
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(x0, top, W - x0, h);
            ctx.setLineDash([]);
            tag(`${z.kind === "demand" ? "DEMAND" : "SUPPLY"} 1H ${fmt(z.low)}–${fmt(z.high)} · fresh`, x0 + 4, top + (z.kind === "demand" ? h + 10 : -3), rgb, "left", 2, { small: true, dim: true });
          }

          // ── the 1-hour trendlines: a straight line per trendline, with its touches ──
          for (const tl of data.trendlines ?? []) {
            const pts = tl.points.map((p) => [X(p.time), Y(p.price)] as const).filter((p): p is readonly [number, number] => p[0] != null && p[1] != null);
            if (pts.length < 2) continue;
            const strong = tl.touches >= 3 && !tl.broken;
            ctx.save();
            ctx.strokeStyle = rgba(C.tori, strong ? 0.9 : 0.55);
            ctx.lineWidth = strong ? 1.5 : 1;
            ctx.setLineDash(strong ? [] : tl.broken ? [2, 4] : [6, 4]);
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
            ctx.stroke();
            ctx.restore();
            const [xe, ye] = pts[pts.length - 1];
            // where price turned on the line
            for (const p of tl.touchPoints ?? []) {
              const [x, y] = [X(p.time), Y(p.price)];
              if (x != null && y != null) dot(x, y, C.tori, 2.5);
            }
            tag(
              tl.broken ? `1H line broken ${tl.broken === "long" ? "upwards" : "downwards"} · its retest at ${fmt(tl.now)} is a ${tl.broken === "long" ? "buy" : "sell"}` : `1H ${tl.kind === "down" ? "falling" : "rising"} line · ${tl.touches} touches · ${fmt(tl.now)}`,
              Math.min(xe, W - 4),
              ye + (tl.kind === "down" ? -4 : 12),
              C.tori,
              "right",
              1,
              { small: true, dim: !strong }
            );
          }

          // ── the trendline strategy's setups: an arrow where a candle bounced off, broke or retested a line ──
          for (const m of data.lineMarks ?? []) {
            const [x, y] = [X(m.time), Y(m.price)];
            if (x == null || y == null) continue;
            const up = m.direction === "long";
            const rgb = m.traded ? (up ? C.win : C.loss) : C.muted;
            const tip = y + (up ? 6 : -6);
            ctx.save();
            ctx.fillStyle = rgba(rgb, m.traded ? 0.95 : 0.7);
            ctx.beginPath();
            ctx.moveTo(x, tip);
            ctx.lineTo(x - 4, tip + (up ? 7 : -7));
            ctx.lineTo(x + 4, tip + (up ? 7 : -7));
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            const name = m.type === "bounce" ? "bounce" : m.type === "retest" ? "retest" : "break";
            if (m.traded || m.type === "break") tag(m.traded ? `${name} · ${up ? "buy" : "sell"}` : name, x + 6, tip + (up ? 12 : -6), rgb, "left", 3, { small: true, dim: !m.traded });
          }

          // ── Set and Forget: the areas of interest, and the level its stop would go beyond ──
          for (const z of data.areas ?? []) {
            const [yHi, yLo] = [Y(z.high), Y(z.low)];
            if (yHi == null || yLo == null) continue;
            const top = Math.min(yHi, yLo) - 1;
            const h = Math.max(Math.abs(yLo - yHi), 2) + 2;
            ctx.fillStyle = rgba(C.area, z.active ? 0.16 : 0.07);
            ctx.fillRect(0, top, W, h);
            line(0, W, top, C.area, z.active ? 0.7 : 0.35, 1, [8, 4]);
            line(0, W, top + h, C.area, z.active ? 0.7 : 0.35, 1, [8, 4]);
            tag(`AREA OF INTEREST (${z.tf}) ${fmt(z.low)}–${fmt(z.high)} · ${z.touches} touches${z.active ? " · price is here" : ""}`, 6, top - 3, C.area, "left", 2, { small: true, dim: !z.active });
          }
          if (data.pullback) {
            const y = Y(data.pullback.price);
            if (y != null) {
              line(0, W, y, C.area, 0.8, 1, [3, 3]);
              tag(`Set and Forget: pullback ${data.pullback.side === "long" ? "low" : "high"} ${fmt(data.pullback.price)} — its stop goes beyond`, 6, y + (data.pullback.side === "long" ? 12 : -4), C.area, "left", 3, { small: true });
            }
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
