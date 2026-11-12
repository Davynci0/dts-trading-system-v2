"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";
import { OverlayPrimitive, EMPTY_OVERLAY, type OverlayData } from "@/components/chartOverlay";

interface LegendState {
  time: string;
  o: string;
  h: string;
  l: string;
  c: string;
}

function toLegend(candle: Candle | undefined, digits: number): LegendState | null {
  if (!candle) return null;
  const f = (n: number) => n.toFixed(digits);
  return {
    time: new Date(candle.time * 1000).toUTCString().slice(5, 22),
    o: f(candle.open),
    h: f(candle.high),
    l: f(candle.low),
    c: f(candle.close),
  };
}

/**
 * Interactive candle chart (zoom, pan, crosshair with OHLC legend) plus the
 * detection engine's overlays (trendlines, zone boxes, fib golden zone) drawn
 * from the same coordinates the engine used (Section 9).
 */
export default function Chart({
  candles,
  overlay = EMPTY_OVERLAY,
  timeframe,
  liveCandle,
  viewKey,
  digits = 5,
}: {
  candles: Candle[];
  overlay?: OverlayData;
  timeframe: string;
  liveCandle?: Candle | null;
  /** changes when the visible market dataset switches (pair) — the only
   *  moment the zoom/pan position is intentionally reset. */
  viewKey: string;
  /** price display precision (XAU 2, JPY 3, 4-dec majors 5) */
  digits?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayRef = useRef<OverlayPrimitive | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const rangeAppliedForRef = useRef<string | null>(null);
  const overlaySigRef = useRef<string>("");
  const digitsRef = useRef(5);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#d1d4dc",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#1c212b" },
        horzLines: { color: "#1c212b" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: {
        borderColor: "#2a2e39",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      const el = legendRef.current;
      if (!el) return;
      const byTime = param.time
        ? candlesRef.current.find((c) => c.time === (param.time as number))
        : undefined;
      const legend = toLegend(byTime ?? candlesRef.current[candlesRef.current.length - 1], digitsRef.current);
      el.textContent = legend
        ? `${legend.time}  O ${legend.o}  H ${legend.h}  L ${legend.l}  C ${legend.c}`
        : "";
    });

    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // expose a screenshot of exactly what's on screen for Ask AI (Section 6, use #2)
  useEffect(() => {
    window.__dtsChartCapture = () => {
      try {
        return chartRef.current?.takeScreenshot().toDataURL("image/png") ?? null;
      } catch {
        return null;
      }
    };
    return () => {
      delete window.__dtsChartCapture;
    };
  }, []);

  useEffect(() => {
    digitsRef.current = digits ?? 5;
  }, [digits]);

  useEffect(() => {
    candlesRef.current = candles;
    seriesRef.current?.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    // Apply the initial viewport only when the dataset (pair) changes —
    // refreshing with new bars must never destroy the user's zoom/pan.
    if (rangeAppliedForRef.current !== viewKey && candles.length > 0) {
      rangeAppliedForRef.current = viewKey;
      const visibleBars = timeframe === "M15" ? 180 : 150;
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - visibleBars),
        to: candles.length + 5,
      });
    }
  }, [candles, timeframe, viewKey]);

  // fast live tick: update ONLY the last (forming) bar — no setData, no re-render,
  // so overlays and the user's zoom/pan position are untouched between refreshes
  useEffect(() => {
    if (!liveCandle || candlesRef.current.length === 0) return;
    const lastClosed = candlesRef.current[candlesRef.current.length - 1];
    const series = seriesRef.current;
    if (!series) return;
    if (liveCandle.time === lastClosed.time) {
      // same bar still forming — merge high/low/close
      series.update({
        time: liveCandle.time as UTCTimestamp,
        open: lastClosed.open,
        high: Math.max(lastClosed.high, liveCandle.high),
        low: Math.min(lastClosed.low, liveCandle.low),
        close: liveCandle.close,
      } as never);
    } else if (liveCandle.time > lastClosed.time) {
      // new bar forming
      series.update({
        time: liveCandle.time as UTCTimestamp,
        open: liveCandle.open,
        high: liveCandle.high,
        low: liveCandle.low,
        close: liveCandle.close,
      } as never);
    }
  }, [liveCandle]);

  // attach/detach the overlay primitive when engine data CONTENT changes.
  // The primitive reads coordinates live at render time (timeToX/priceToY),
  // so candle updates re-render it without a detach/attach round-trip — this
  // also stops the 30-s poll from churning the primitive identity.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const sig = JSON.stringify(overlay);
    if (sig === overlaySigRef.current) return;
    overlaySigRef.current = sig;
    if (overlayRef.current) {
      series.detachPrimitive(overlayRef.current);
      overlayRef.current = null;
    }
    const has =
      overlay.zones.length > 0 ||
      overlay.fib != null ||
      overlay.aoi != null ||
      overlay.position != null ||
      (overlay.trendlines?.length ?? 0) > 0 ||
      (overlay.levels?.length ?? 0) > 0 ||
      (overlay.history?.length ?? 0) > 0;
    if (has) {
      const p = new OverlayPrimitive(overlay);
      series.attachPrimitive(p);
      overlayRef.current = p;
    }
    // coordinates may have changed — recompute views
    series.priceScale().applyOptions({});
    chartRef.current?.timeScale().applyOptions({});
  }, [overlay, candles]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-2 top-2 z-10 font-mono text-xs text-neutral-300"
      />
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
