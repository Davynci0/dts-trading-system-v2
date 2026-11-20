"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "@/components/Chart";
import SignalFeed from "@/components/SignalFeed";
import ConfirmationTracker from "@/components/ConfirmationTracker";
import AskAIButton from "@/components/AskAIButton";
import { PAIRS, type Candle, type Pair, type Signal, type Timeframe } from "@/lib/types";
import { pipSize } from "@/lib/analysis/confirmations";
import { EMPTY_OVERLAY, type OverlayData } from "@/components/chartOverlay";

const LAYERS = [
  { id: "breakout", label: "Breakout" },
  { id: "zones", label: "Zones" },
  { id: "fib", label: "Fib" },
  { id: "aoi", label: "AOI" },
  { id: "trendlines", label: "Trendlines" },
  { id: "levels", label: "S/R" },
  { id: "headshoulders", label: "H&S" },
  { id: "structure", label: "Structure" },
  { id: "position", label: "Trade plan" },
  { id: "history", label: "Results" },
] as const;
type LayerId = (typeof LAYERS)[number]["id"];

interface TopDownSummary {
  weekly: string;
  daily: string;
  h4: string;
  h1?: string;
  m15?: string;
  bias: "bullish" | "bearish" | "neutral";
  actionLine: { kind: string; touches: number } | null;
  safetyLine: { kind: string; touches: number } | null;
}

/** What the send gate currently allows on this pair (from /api/analysis). */
interface GateSummary {
  /** true when a pullback strategy (zones / set & forget / fib) may send */
  pullback: boolean;
  inSession: boolean;
  sessionHours: string;
  longAllowed: boolean;
  shortAllowed: boolean;
}

export default function Dashboard() {
  const [pair, setPair] = useState<Pair>("XAU_USD");
  const timeframe: Timeframe = "M15";
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [overlay, setOverlay] = useState<OverlayData>(EMPTY_OVERLAY);
  const [topDown, setTopDown] = useState<TopDownSummary | null>(null);
  const [gate, setGate] = useState<GateSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [pairSignals, setPairSignals] = useState<Signal[]>([]);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>({
    breakout: true,
    zones: true,
    fib: true,
    aoi: true,
    position: true,
    history: true,
    trendlines: true,
    levels: true,
    headshoulders: true,
    structure: true,
  });
  const analysisSigRef = useRef<string>("");

  // this pair's signals: the unsettled one is drawn as a trade plan, settled ones as results
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
    const pending =
      pairSignals.find((s) => !s.outcome && !s.superseded_by && s.status === "active") ??
      pairSignals.find((s) => !s.outcome && !s.superseded_by) ??
      null;
    let position: OverlayData["position"] = null;
    if (pending && candles.length > 0) {
      const pip = pipSize(pending.pair);
      position = {
        direction: pending.direction,
        entry: pending.entry,
        stopLoss: pending.stop_loss,
        takeProfit: pending.take_profit,
        startTime: barAt(Math.floor(new Date(pending.created_at).getTime() / 1000)).time,
        riskPips: Math.abs(pending.entry - pending.stop_loss) / pip,
        rewardPips: Math.abs(pending.take_profit - pending.entry) / pip,
        rMultiple: pending.r_multiple ?? Math.abs(pending.take_profit - pending.entry) / Math.abs(pending.entry - pending.stop_loss),
        skipped: pending.status === "skipped",
      };
    }

    const history: NonNullable<OverlayData["history"]> = [];
    if (candles.length > 0) {
      const first = candles[0].time;
      const sorted = pairSignals
        .filter((s) => (s.outcome === "win" || s.outcome === "loss") && s.outcome_at && s.outcome_price != null)
        .sort((a, b) => new Date(b.outcome_at!).getTime() - new Date(a.outcome_at!).getTime())
        .slice(0, 20); // only show the 20 most recent settled trades
      for (const s of sorted) {
        if (!s.outcome_at || s.outcome_price == null) continue;
        const start = Math.floor(new Date(s.created_at).getTime() / 1000);
        const end = Math.floor(new Date(s.outcome_at).getTime() / 1000);
        if (end < first) continue;
        history.push({
          direction: s.direction,
          entry: s.entry,
          startTime: barAt(start).time,
          endTime: barAt(end).time,
          exitPrice: s.outcome_price,
          outcome: s.outcome as "win" | "loss",
          r: s.outcome_r ?? 0,
          skipped: s.status === "skipped",
        });
      }
    }
    return {
      zones: layers.zones ? overlay.zones : [],
      fib: layers.fib ? overlay.fib : null,
      aoi: layers.aoi ? overlay.aoi : null,
      trendlines: layers.trendlines ? overlay.trendlines : undefined,
      levels: layers.levels ? overlay.levels : undefined,
      headshoulders: layers.headshoulders ? overlay.headshoulders : undefined,
      structure: layers.structure ? overlay.structure : undefined,
      breakout: layers.breakout ? overlay.breakout : undefined,
      position: layers.position ? position : null,
      history: layers.history ? history : [],
      digits: (() => {
        const pip = pipSize(pair);
        return pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
      })(),
    };
  }, [overlay, layers, pairSignals, candles, pair]);

  async function scanNow() {
    setScanStatus("scanning…");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: [pair], timeframes: ["M15"] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const ev = json.events?.length ?? 0;
      setScanStatus(
        `scan done — ${json.units} unit(s), ${ev} event(s)${ev ? ": " + json.events.map((e: { kind: string; strategy: string }) => `${e.strategy}:${e.kind}`).join(", ") : ""}`
      );
    } catch (e) {
      setScanStatus(`scan failed: ${(e as Error).message}`);
    }
  }

  // setState only inside async .then/.catch callbacks (react-hooks/set-state-in-effect)
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    const loadAnalysis = (initial: boolean) =>
      fetch(`/api/analysis?instrument=${pair}&granularity=M15&count=500`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          // signature of the drawn analysis — skip re-render when nothing
          // changed. The candle series is part of it: during quiet markets the
          // overlays freeze but price still prints new bars, and the chart must
          // never go stale.
          const jsonCandles = (json.candles ?? []) as Candle[];
          if (jsonCandles.length === 0) {
            throw new Error(`No candles returned for ${pair}`);
          }
          const sig = JSON.stringify({
            n: jsonCandles.length,
            t: jsonCandles[jsonCandles.length - 1]?.time ?? null,
            z: json.zones ?? [],
            f: json.fib ?? null,
            a: json.aoi ?? null,
            l: json.trendlines ?? [],
            hs: json.headshoulders ?? [],
            lv: json.levels ?? [],
            st: json.structure ?? [],
            b: json.breakout ?? null,
            g: json.gate ?? null,
            d: json.topDown ?? null,
          });
          if (!initial && sig === analysisSigRef.current) return; // analysis unchanged
          analysisSigRef.current = sig;
          setCandles(jsonCandles);
          setOverlay({
            zones: json.zones ?? [],
            aoi: json.aoi ?? null,
            fib: json.fib ?? null,
            trendlines: json.trendlines ?? [],
            levels: json.levels ?? [],
            headshoulders: json.headshoulders ?? [],
            structure: json.structure ?? [],
            breakout: json.breakout ?? null,
          });
          setTopDown(json.topDown ?? null);
          setGate(json.gate ?? null);
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name === "AbortError" || stopped) return;
          if (initial) {
            setError(e.message);
            setCandles([]);
            setOverlay(EMPTY_OVERLAY);
            setTopDown(null);
            setGate(null);
          }
        })
        .finally(() => {
          if (!stopped) setLoading(false);
        });

    // 1) initial load
    loadAnalysis(true);
    // 2) TA refresh every 15 min (new M15 bar) — the signature
    // check inside loadAnalysis skips the re-render when analysis is unchanged
    const taTimer = setInterval(() => loadAnalysis(false), 15 * 60 * 1000);
    // 3) fast live tick — updates only the forming bar via a cheap 1-candle call
    const liveTimer = setInterval(() => {
      fetch(`/api/live?instrument=${pair}&granularity=M15`, {
        signal: controller.signal,
      })
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

  function changePair(p: Pair) {
    setPair(p);
    setLoading(true);
    setOverlay(EMPTY_OVERLAY);
    setTopDown(null);
    setGate(null);
    setLiveCandle(null);
    analysisSigRef.current = "";
  }

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

  return (
    <div className="relative flex h-full flex-col gap-4 p-4 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {PAIRS.length > 1 ? (
            <select
              value={pair}
              onChange={(e) => changePair(e.target.value as Pair)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
            >
              {PAIRS.map((p) => (
                <option key={p} value={p}>
                  {p.replace("_", "/")}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm font-medium text-neutral-100">
              {pair.replace("_", "/")}
            </span>
          )}
          <span className="rounded border border-neutral-700 bg-neutral-700 px-2.5 py-1.5 text-sm text-white">
            M15
          </span>
          <div className="flex overflow-hidden rounded border border-neutral-700">
            {LAYERS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLayers((prev) => ({ ...prev, [l.id]: !prev[l.id] }))}
                className={`px-2 py-1.5 text-xs ${
                  layers[l.id] ? "bg-neutral-800 text-neutral-100" : "bg-neutral-900 text-neutral-600 line-through"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={scanNow}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
            >
              Scan now
            </button>
            <button
              onClick={testTelegram}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
            >
              Test Telegram
            </button>
            <AskAIButton />
          </div>
        </div>

        {topDown && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-neutral-800 py-1.5 font-mono text-[11px] text-neutral-500">
            <span className="text-neutral-300">Top-down</span>
            <span>W {topDown.weekly}</span>
            <span>D {topDown.daily}</span>
            <span>H4 {topDown.h4}</span>
            {topDown.h1 ? <span>H1 {topDown.h1}</span> : null}
            <span
              className={
                topDown.bias === "bullish"
                  ? "text-emerald-400"
                  : topDown.bias === "bearish"
                    ? "text-rose-400"
                    : "text-zinc-400"
              }
            >
              Bias {topDown.bias}
            </span>
            {topDown.m15 ? <span>M15 {topDown.m15}</span> : null}
            {overlay.breakout && (
              <>
                <span className="text-neutral-300">Breakout</span>
                <span className={overlay.breakout.trend === 1 ? "text-emerald-400" : overlay.breakout.trend === -1 ? "text-rose-400" : "text-zinc-400"}>
                  daily trend {overlay.breakout.trend === 1 ? "up — buys only" : overlay.breakout.trend === -1 ? "down — sells only" : "unknown"}
                </span>
                <span className={overlay.breakout.asianWindowOpen ? "text-emerald-400" : "text-neutral-500"}>
                  Asian-range window {overlay.breakout.asianWindowOpen ? "open" : "closed"} (07–11 UTC)
                </span>
                <span className={overlay.breakout.channelWindowOpen ? "text-emerald-400" : "text-neutral-500"}>
                  1-week window {overlay.breakout.channelWindowOpen ? "open" : "closed"} (07–20 UTC)
                </span>
              </>
            )}
            {gate?.pullback && (
              <>
                <span className="text-neutral-300">Send gate</span>
                <span className={gate.inSession ? "text-emerald-400" : "text-amber-400"}>
                  {gate.inSession ? "in session" : `outside session (${gate.sessionHours})`}
                </span>
                <span className={gate.longAllowed ? "text-emerald-400" : "text-rose-400"}>
                  longs {gate.longAllowed ? "allowed" : "blocked by weekly"}
                </span>
                <span className={gate.shortAllowed ? "text-emerald-400" : "text-rose-400"}>
                  shorts {gate.shortAllowed ? "allowed" : "blocked by weekly"}
                </span>
              </>
            )}
          </div>
        )}

        {(telegramStatus || scanStatus) && (
          <p className="font-mono text-xs text-neutral-400">
            {[telegramStatus, scanStatus].filter(Boolean).join("  ·  ")}
          </p>
        )}
        {error && (
          <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        {/* chart — takes ~2/3 of the viewport height, with engine overlays */}
        <div className="h-[50vh] min-h-[320px] shrink-0 rounded-lg border border-neutral-800 bg-[#0b0e11] lg:h-[67vh]">
          {loading && candles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Loading candles…
            </div>
          ) : (
            <Chart
              candles={candles}
              overlay={shownOverlay}
              timeframe={timeframe}
              liveCandle={liveCandle}
              viewKey={pair}
              digits={(() => {
                const pip = pipSize(pair);
                return pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
              })()}
            />
          )}
        </div>
      </div>

      {/* side panels */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-80">
        <ConfirmationTracker pair={pair} timeframe={timeframe} />
        <SignalFeed />
      </aside>
    </div>
  );
}
