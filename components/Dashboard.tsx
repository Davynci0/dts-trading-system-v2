"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "@/components/Chart";
import SignalFeed from "@/components/SignalFeed";
import TrendTracker, { type TrendSummary } from "@/components/TrendTracker";
import AskAIButton from "@/components/AskAIButton";
import { isLiveSignal, PAIRS, TRADE_TIMEFRAMES, type Candle, type Pair, type Signal, type Timeframe } from "@/lib/types";
import { CHART_COLORS, type OverlayData } from "@/components/chartOverlay";

/** What the chart can show on top of the candles. */
const LAYERS = [
  { id: "trend", label: "Entry levels and swings", color: CHART_COLORS.trend, on: true },
  { id: "position", label: "Open trades", color: null, on: true },
  { id: "history", label: "Closed trades", color: null, on: true },
] as const;
type LayerId = (typeof LAYERS)[number]["id"];

/** The chart and the entries run on this timeframe. */
const timeframe: Timeframe = TRADE_TIMEFRAMES[0];
/** Length of one chart candle in milliseconds. */
const CANDLE_MS = ({ M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D: 1440 } as Record<string, number>)[timeframe] * 60_000;
const DIGITS = 2;
/** A local clock time, e.g. "13:30" or "13:30:05". */
const clock = (ms: number, seconds = false) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });

export default function Dashboard() {
  const pair: Pair = PAIRS[0];
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [trend, setTrend] = useState<TrendSummary | null>(null);
  /** when the analysis was last loaded */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [pairSignals, setPairSignals] = useState<Signal[]>([]);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(() => Object.fromEntries(LAYERS.map((l) => [l.id, l.on])) as Record<LayerId, boolean>);
  /** set when the chart shows a past moment (?asOf=…) instead of the live market */
  const [asOf, setAsOf] = useState<string | null>(null);
  const analysisSigRef = useRef<string>("");

  // this pair's signals: the open one is drawn as a trade plan, closed ones as results
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/signals")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          const rows = (j.signals ?? []) as Signal[];
          setPairSignals(rows.filter((s) => s.pair === pair && s.stop_loss > 0));
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pair]);

  const shownOverlay = useMemo<OverlayData>(() => {
    const barAt = (epochSec: number) => [...candles].reverse().find((c) => c.time <= epochSec) ?? candles[0];
    // one trade is open at a time
    const positions: NonNullable<OverlayData["positions"]> = [];
    if (candles.length > 0) {
      for (const open of pairSignals.filter((s) => isLiveSignal(s) && !s.outcome && s.status === "active")) {
        positions.push({
          label: "TREND",
          direction: open.direction,
          entry: open.entry,
          stopLoss: open.stop_loss,
          takeProfit: open.take_profit,
          // where the profit lock has moved the stop to, once it has
          stopNow: open.trail_stop ?? null,
          startTime: barAt(Math.floor(new Date(open.created_at).getTime() / 1000)).time,
          rMultiple: open.r_multiple ?? Math.abs(open.take_profit - open.entry) / Math.abs(open.entry - open.stop_loss),
        });
      }
    }

    const history: NonNullable<OverlayData["history"]> = [];
    if (candles.length > 0) {
      const first = candles[0].time;
      const closed = pairSignals
        .filter((s) => s.outcome != null && s.outcome_at && s.outcome_price != null)
        .sort((a, b) => new Date(b.outcome_at!).getTime() - new Date(a.outcome_at!).getTime())
        .slice(0, 20);
      for (const s of closed) {
        const start = Math.floor(new Date(s.created_at).getTime() / 1000);
        const end = Math.floor(new Date(s.outcome_at!).getTime() / 1000);
        if (end < first) continue;
        const r = s.outcome_r ?? 0;
        history.push({ direction: s.direction, entry: s.entry, startTime: barAt(start).time, endTime: barAt(end).time, exitPrice: s.outcome_price!, outcome: r > 0 ? "win" : "loss", r });
      }
    }

    return {
      trend:
        layers.trend && trend && trend.levels.length > 0 && trend.dailyTrend !== 0
          ? {
              direction: trend.dailyTrend === 1 ? "long" : "short",
              levels: trend.levels,
              ready: !trend.blocked,
              // the level a new trade's stop would go beyond
              stopSwing: trend.stopLevel,
            }
          : null,
      positions: layers.position ? positions : [],
      history: layers.history ? history : [],
      digits: DIGITS,
    };
  }, [trend, layers, pairSignals, candles]);

  /** One line on what the trend allows right now. */
  const trendLine = useMemo(() => {
    if (!trend) return null;
    const arrow = (t: number) => (t === 1 ? "▲ up" : t === -1 ? "▼ down" : "unclear");
    const daily = trend.dailyTrend;
    const tone = daily === 1 ? "text-emerald-400" : daily === -1 ? "text-rose-400" : "text-amber-400";
    const allows = daily === 0 ? "no trades until the daily trend is known" : `${daily === 1 ? "buys" : "sells"} only`;
    const shape = (t: number) => (t === 1 ? "bullish" : t === -1 ? "bearish" : "not known");
    return { text: `Daily trend ${arrow(daily)} · 1-hour structure ${shape(trend.h1Trend)} · 15-minute structure ${shape(trend.structure)} — ${allows}`, tone };
  }, [trend]);

  async function scanNow() {
    setScanStatus("scanning…");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: [pair] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const events = (json.events ?? []) as { kind: string; detail: string }[];
      setScanStatus(events.length ? `scan done — ${events.map((e) => `${e.kind}: ${e.detail}`).join(" · ")}` : "scan done — no setup on the last candle");
    } catch (e) {
      setScanStatus(`scan failed: ${(e as Error).message}`);
    }
  }

  // setState only inside async .then/.catch callbacks (react-hooks/set-state-in-effect)
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    // ?asOf=2026-11-19T07:15Z shows the analysis as it stood at that moment
    const review = new URLSearchParams(window.location.search).get("asOf");
    const loadAnalysis = (initial: boolean) =>
      fetch(`/api/analysis?instrument=${pair}&granularity=${timeframe}&count=500${review ? `&to=${encodeURIComponent(review)}` : ""}`, { signal: controller.signal })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          const jsonCandles = (json.candles ?? []) as Candle[];
          if (jsonCandles.length === 0) throw new Error(`No candles returned for ${pair}`);
          // skip the re-render when nothing changed — but the candle series is part
          // of the signature, so the chart never goes stale in a quiet market
          const sig = JSON.stringify({ n: jsonCandles.length, t: jsonCandles[jsonCandles.length - 1]?.time ?? null, tr: json.trend ?? null });
          if (!initial && sig === analysisSigRef.current) return;
          analysisSigRef.current = sig;
          setCandles(jsonCandles);
          setTrend(json.trend ?? null);
          setUpdatedAt(Date.now());
          setAsOf(json.asOf ?? null);
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name === "AbortError" || stopped) return;
          if (initial) {
            setError(e.message);
            setCandles([]);
            setTrend(null);
          }
        })
        .finally(() => {
          if (!stopped) setLoading(false);
        });

    loadAnalysis(true);
    // the analysis refreshes every minute, so a new 15-minute candle shows up soon after it closes
    const taTimer = review ? undefined : setInterval(() => loadAnalysis(false), 60 * 1000);
    // fast live tick — updates only the forming candle via a cheap 1-candle call
    const liveTimer = review
      ? undefined
      : setInterval(() => {
          fetch(`/api/live?instrument=${pair}&granularity=${timeframe}`, { signal: controller.signal })
            .then((r) => r.json())
            .then((j) => {
              if (!stopped && j.candle) setLiveCandle(j.candle);
            })
            .catch(() => undefined);
        }, Number(process.env.NEXT_PUBLIC_LIVE_TICK_MS ?? 2000));

    return () => {
      stopped = true;
      controller.abort();
      clearInterval(taTimer);
      clearInterval(liveTimer);
    };
  }, [pair]);

  async function testTelegram() {
    setTelegramStatus("sending…");
    try {
      const res = await fetch("/api/telegram/test", { method: "POST" });
      const json = await res.json();
      setTelegramStatus(json.ok ? "✅ test message sent" : `❌ ${json.error}`);
    } catch (e) {
      setTelegramStatus(`❌ ${(e as Error).message}`);
    }
  }

  const price = liveCandle?.close ?? candles[candles.length - 1]?.close ?? null;

  return (
    <div className="relative flex h-full flex-col gap-4 p-4 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm font-medium text-neutral-100">{pair.replace("_", "/")}</span>
          <span className="rounded border border-neutral-700 bg-neutral-700 px-2.5 py-1.5 text-sm text-white">{timeframe}</span>
          <div className="flex overflow-hidden rounded border border-neutral-700">
            {LAYERS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLayers((prev) => ({ ...prev, [l.id]: !prev[l.id] }))}
                aria-pressed={layers[l.id]}
                className={`flex items-center gap-1.5 px-2 py-1.5 text-xs ${layers[l.id] ? "bg-neutral-800 text-neutral-100" : "bg-neutral-900 text-neutral-600"}`}
              >
                {l.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: `rgb(${l.color})`, opacity: layers[l.id] ? 1 : 0.3 }} />}
                {l.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={scanNow} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800">
              Scan now
            </button>
            <button onClick={testTelegram} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800">
              Test Telegram
            </button>
            <AskAIButton />
          </div>
        </div>

        {asOf && (
          <p className="rounded border border-amber-900/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            Reviewing the chart as it stood at {new Date(asOf).toUTCString().slice(5, 22)} UTC — live updates are paused.{" "}
            <button onClick={() => window.location.assign(window.location.pathname)} className="underline">
              Back to live
            </button>
          </p>
        )}

        {(trendLine || updatedAt != null) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-neutral-800 py-2 text-[11px] text-neutral-500">
            {trendLine && <span className={trendLine.tone}>{trendLine.text}</span>}
            {updatedAt != null && candles.length > 0 && (
              <span title="Times are in your local time zone">
                Last closed candle {clock(candles[candles.length - 1].time * 1000 + CANDLE_MS)} · chart updated {clock(updatedAt, true)}
              </span>
            )}
          </div>
        )}

        {(telegramStatus || scanStatus) && <p className="font-mono text-xs text-neutral-400">{[telegramStatus, scanStatus].filter(Boolean).join("  ·  ")}</p>}
        {error && <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>}

        {/* chart — takes ~2/3 of the viewport height */}
        <div className="h-[50vh] min-h-[320px] shrink-0 rounded-lg border border-neutral-800 bg-[#0b0e11] lg:h-[67vh]">
          {loading && candles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">Loading candles…</div>
          ) : (
            <Chart candles={candles} overlay={shownOverlay} timeframe={timeframe} liveCandle={liveCandle} viewKey={pair} digits={DIGITS} />
          )}
        </div>
      </div>

      {/* side panels */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-80">
        <TrendTracker trend={trend} signals={pairSignals} price={price} digits={DIGITS} />
        <SignalFeed />
      </aside>
    </div>
  );
}
