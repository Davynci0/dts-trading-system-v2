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
  }[];
  /** Alex G Set & Forget: the 50–61.8% AOI of the most recent structure-breaking leg */
  aoi: {
    direction: "long" | "short";
    top: number;
    bottom: number;
    startTime: number;
    legEndTime: number;
    tested: boolean;
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
}

export const EMPTY_OVERLAY: OverlayData = { zones: [], aoi: null, fib: null };

const UP = "rgba(38,166,154,";
const DOWN = "rgba(239,83,80,";

interface PaneSource {
  timeToX(time: number): number | null;
  priceToY(price: number): number | null;
  width(): number;
}

/**
 * Custom pane primitive that draws the engine's detected overlays directly on
 * the chart canvas: trendlines extended through their real pivot anchors,
 * supply/demand zone boxes extending right from the base, and the fibonacci
 * golden-zone box. All coordinates come straight from the detection engine.
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

          // labels are collected, then laid out last so none overprint each other
          interface Label { text: string; x: number; y: number; color: string; font: string; align: "left" | "right"; prio: number }
          const labels: Label[] = [];
          const label = (text: string, x: number, y: number, color: string, font: string, align: "left" | "right", prio: number) =>
            labels.push({ text, x, y, color, font, align, prio });

          // fib: anchored to the actual swing, with ratio levels drawn
          if (data.fib) {
            const f = data.fib;
            const xSwing0 = source.timeToX(f.swingLow.time);
            const xSwing1 = source.timeToX(f.swingHigh.time);
            const x0 = xSwing0 != null ? Math.min(xSwing0, xSwing1 ?? xSwing0) : 0;
            const base = f.direction === "long" ? UP : DOWN;

            // golden zone box: from the swing end to the right edge
            const yTop = source.priceToY(f.goldenTop);
            const yBottom = source.priceToY(f.goldenBottom);
            const xZone = xSwing1 ?? x0;
            if (yTop != null && yBottom != null) {
              const y = Math.min(yTop, yBottom);
              const h = Math.max(Math.abs(yBottom - yTop), 4);
              ctx.fillStyle = `${base}0.22)`;
              ctx.fillRect(xZone, y, W - xZone, h);
              ctx.strokeStyle = `${base}0.85)`;
              ctx.lineWidth = 1.5;
              ctx.setLineDash([4, 3]);
              ctx.strokeRect(xZone, y, W - xZone, h);
              ctx.setLineDash([]);
              ctx.lineWidth = 1;
              const tradeAction = f.direction === "long" ? "BUY" : "SELL";
              label(`${tradeAction} ZONE — Golden (61.8–78.6%)`, xZone + 6, y - 4, `${base}1)`, "bold 11px monospace", "left", 3);
            }

            // ratio + swing level lines: 0%, 50%, 61.8%, 78.6%, 100%
            const levels: { price: number; label: string; strong: boolean }[] = [
              { price: f.swingHigh.price, label: "100%", strong: true },
              { price: f.level618, label: "61.8%", strong: true },
              { price: f.level50, label: "50%", strong: false },
              { price: f.level786, label: "78.6%", strong: true },
              { price: f.swingLow.price, label: "0%", strong: true },
            ];
            for (const lv of levels) {
              const y = source.priceToY(lv.price);
              if (y == null) continue;
              ctx.strokeStyle = lv.strong ? `${base}0.75)` : `${base}0.5)`;
              ctx.lineWidth = lv.strong ? 1.5 : 1;
              ctx.setLineDash(lv.strong ? [] : [3, 4]);
              ctx.beginPath();
              ctx.moveTo(x0, y);
              ctx.lineTo(W, y);
              ctx.stroke();
              ctx.setLineDash([]);
              label(`${lv.label} ${lv.price.toFixed(2)}`, x0 + 4, y - 2, `${base}${lv.strong ? "1)" : "0.8)"}`, lv.strong ? "bold 10px monospace" : "10px monospace", "left", 3);
            }

            // swing anchor markers
            for (const s of [f.swingLow, f.swingHigh]) {
              const x = source.timeToX(s.time);
              const y = source.priceToY(s.price);
              if (x == null || y == null) continue;
              ctx.fillStyle = `${base}1)`;
              ctx.beginPath();
              ctx.arc(x, y, 4, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // Alex G Set & Forget AOI: the 50–61.8% retrace of the impulse leg
          if (data.aoi) {
            const a = data.aoi;
            const x0 = source.timeToX(a.legEndTime);
            const yTop = source.priceToY(a.top);
            const yBottom = source.priceToY(a.bottom);
            if (x0 != null && yTop != null && yBottom != null) {
              const y = Math.min(yTop, yBottom);
              const h = Math.max(Math.abs(yBottom - yTop), 4);
              const base = a.direction === "long" ? UP : DOWN;
              ctx.fillStyle = `${base}${a.tested ? "0.08)" : "0.22)"}`;
              ctx.fillRect(x0, y, W - x0, h);
              ctx.strokeStyle = `${base}${a.tested ? "0.55)" : "0.85)"}`;
              ctx.lineWidth = 1.5;
              ctx.setLineDash([6, 4]);
              ctx.strokeRect(x0, y, W - x0, h);
              ctx.setLineDash([]);
              ctx.lineWidth = 1;
              const aoiAction = a.direction === "long" ? "BUY" : "SELL";
              label(
                `${aoiAction} ZONE — AOI 50–61.8% ${a.tested ? "(tested)" : "(untested)"}`,
                x0 + 6,
                y + (a.direction === "short" ? 14 : h - 6),
                `${base}1)`,
                "bold 11px monospace",
                "left",
                2
              );
            }
          }

          // supply/demand zone boxes (extend forward until invalidated)
          for (const z of data.zones) {
            const x0 = source.timeToX(z.startTime);
            const yTop = source.priceToY(z.top);
            const yBottom = source.priceToY(z.bottom);
            if (x0 == null || yTop == null || yBottom == null) continue;
            const y = Math.min(yTop, yBottom);
            const h = Math.max(Math.abs(yBottom - yTop), 4); // ensure visible even for tiny zones
            const base = z.kind === "demand" ? UP : DOWN;
            ctx.fillStyle = `${base}0.22)`;
            ctx.fillRect(x0, y, W - x0, h);
            ctx.strokeStyle = `${base}0.85)`;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x0, y, W - x0, h);
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
            const zoneAction = z.kind === "demand" ? "BUY" : "SELL";
            label(`${zoneAction} ZONE (${z.kind})`, x0 + 4, y + (z.kind === "supply" ? 14 : h - 6), `${base}1)`, "bold 11px monospace", "left", 4);
          }

          // settled trades: path from entry to where TP/SL was actually hit
          for (const h of data.history ?? []) {
            const xA = source.timeToX(h.startTime);
            const xB = source.timeToX(h.endTime);
            const yA = source.priceToY(h.entry);
            const yB = source.priceToY(h.exitPrice);
            if (xA == null || xB == null || yA == null || yB == null) continue;
            const color = h.outcome === "win" ? "#26a69a" : "#ef5350";
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash(h.skipped ? [4, 3] : []);
            ctx.beginPath();
            ctx.moveTo(xA, yA);
            ctx.lineTo(xB, yB);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(xA, yA, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(xB, yB, 5, 0, Math.PI * 2);
            ctx.fill();
            const verb = h.outcome === "win" ? `TP +${h.r.toFixed(1)}R` : "SL −1R";
            label(`${h.skipped ? "skip " : ""}${h.direction === "long" ? "L" : "S"} ${verb}`, xB + 6, yB - 4, color, "bold 10px monospace", "left", 1);
          }
          ctx.lineWidth = 1;

          // pending trade plan: shaded reward/risk boxes with entry, SL and TP lines
          if (data.position) {
            const p = data.position;
            const x0 = source.timeToX(p.startTime) ?? 0;
            const yE = source.priceToY(p.entry);
            const yS = source.priceToY(p.stopLoss);
            const yT = source.priceToY(p.takeProfit);
            if (yE != null && yS != null && yT != null) {
              ctx.fillStyle = "rgba(38,166,154,0.10)";
              ctx.fillRect(x0, Math.min(yE, yT), W - x0, Math.abs(yT - yE));
              ctx.fillStyle = "rgba(239,83,80,0.10)";
              ctx.fillRect(x0, Math.min(yE, yS), W - x0, Math.abs(yS - yE));

              const levels: [number, string, string][] = [
                [yT, "#26a69a", `TP ${p.takeProfit.toFixed(2)}  +${p.rewardPips.toFixed(0)} pips  ${p.rMultiple.toFixed(1)}R`],
                [yE, "#d1d4dc", `${p.skipped ? "SKIPPED " : ""}${p.direction.toUpperCase()} ${p.entry.toFixed(2)}`],
                [yS, "#ef5350", `SL ${p.stopLoss.toFixed(2)}  −${p.riskPips.toFixed(0)} pips`],
              ];
              for (const [y, color, text] of levels) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.setLineDash(p.skipped ? [6, 4] : []);
                ctx.beginPath();
                ctx.moveTo(x0, y);
                ctx.lineTo(W, y);
                ctx.stroke();
                label(text, W - 6, y - 4, color, "bold 10px monospace", "right", 0);
              }
              ctx.setLineDash([]);
              ctx.lineWidth = 1;
            }
          }

          // lay out labels by priority; one that cannot find a free slot is dropped, never overprinted
          const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
          const H = 13;
          labels.sort((a, b) => a.prio - b.prio);
          for (const l of labels) {
            ctx.font = l.font;
            const w = ctx.measureText(l.text).width + 8;
            const left = Math.max(2, Math.min(l.align === "right" ? l.x - w + 4 : l.x - 4, W - w - 2));
            for (const dy of [0, H, -H, 2 * H, -2 * H, 3 * H, -3 * H]) {
              const top = l.y - 10 + dy;
              if (top < 0 || top + H > mediaSize.height) continue;
              if (placed.some((p) => left < p.x1 && left + w > p.x0 && top < p.y1 && top + H > p.y0)) continue;
              placed.push({ x0: left, y0: top, x1: left + w, y1: top + H });
              ctx.fillStyle = "rgba(11,14,17,0.85)";
              ctx.fillRect(left, top, w, H);
              ctx.fillStyle = l.color;
              ctx.textAlign = "left";
              ctx.fillText(l.text, left + 4, top + 10);
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
      width: () => 0,
    };
    this._view = new OverlayPaneView(source, this.data);
  }

  paneViews() {
    return this._view ? [this._view] : [];
  }
}
