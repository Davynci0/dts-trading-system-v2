"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "@/components/Chart";
import SignalFeed from "@/components/SignalFeed";
import ConfirmationTracker from "@/components/ConfirmationTracker";
import TrendTracker, { type TrendSummary } from "@/components/TrendTracker";
import AskAIButton from "@/components/AskAIButton";
import { PAIRS, TRADE_TIMEFRAMES, type Candle, type Pair, type Signal, type Timeframe } from "@/lib/types";
import { pipSize } from "@/lib/analysis/confirmations";
import { CHART_COLORS, EMPTY_OVERLAY, type OverlayData } from "@/components/chartOverlay";

/**
 * Chart layers in three groups: the strategies (each in its own colour,
 * all on), context a trader may want behind them (key levels on, the rest
 * off so the chart starts clean), and the system's own trades.
 */
const LAYERS = [
  { id: "trend", label: "Trend system", group: "Strategies", color: CHART_COLORS.trend, on: true },
  { id: "breakout", label: "30-candle range", group: "Patterns", color: CHART_COLORS.breakout, on: false },
  { id: "aoi", label: "Set & forget", group: "Patterns", color: CHART_COLORS.aoi, on: false },
  { id: "zones", label: "Zones", group: "Patterns", color: CHART_COLORS.demand, on: false },
  { id: "fib", label: "Fibonacci", group: "Patterns", color: CHART_COLORS.fib, on: false },
  { id: "levels", label: "Key levels", group: "Context", color: null, on: true },
  { id: "structure", label: "Structure", group: "Context", color: null, on: false },
  { id: "trendlines", label: "Trendlines", group: "Context", color: null, on: false },
  { id: "headshoulders", label: "H&S", group: "Context", color: null, on: false },
  { id: "position", label: "Trade plan", group: "Trades", color: null, on: true },
  { id: "history", label: "Results", group: "Trades", color: null, on: true },
] as const;
type LayerId = (typeof LAYERS)[number]["id"];
const LAYER_GROUPS = ["Strategies", "Patterns", "Context", "Trades"] as const;

interface TopDownSummary {
  weekly: string;
  daily: string;
  h4: string;
  h1?: string;
  /** swing structure of the chart timeframe */
  chart?: string;
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
  /** daily trend the pullback strategies trade with: +1 up, −1 down, 0 unknown */
  trend: 1 | -1 | 0;
  trendDays: number;
  longAllowed: boolean;
  shortAllowed: boolean;
  weeklyBlocks: boolean;
}

/** Length of one chart candle in milliseconds (M30 → 30 minutes). */
const CANDLE_MS = ({ M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D: 1440 } as Record<string, number>)[TRADE_TIMEFRAMES[0]] * 60_000;
/** A local clock time, e.g. "13:30" or "13:30:05". */
const clock = (ms: number, seconds = false) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });

/** The chart, the analysis and the scanner all run on this one timeframe. */
const timeframe: Timeframe = TRADE_TIMEFRAMES[0];

export default function Dashboard() {
  const [pair, setPair] = useState<Pair>("XAU_USD");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [overlay, setOverlay] = useState<OverlayData>(EMPTY_OVERLAY);
  const [topDown, setTopDown] = useState<TopDownSummary | null>(null);
  const [gate, setGate] = useState<GateSummary | null>(null);
  const [trend, setTrend] = useState<TrendSummary | null>(null);
  /** when the analysis was last loaded, and the close time of the newest candle it holds */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [pairSignals, setPairSignals] = useState<Signal[]>([]);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(
    () => Object.fromEntries(LAYERS.map((l) => [l.id, l.on])) as Record<LayerId, boolean>
  );
  /** set when the chart shows a past moment (?asOf=…) instead of the live market */
  const [asOf, setAsOf] = useState<string | null>(null);
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
      pairSignals.find((s) => s.strategy !== "trend" && !s.outcome && !s.superseded_by && s.status === "active") ??
      pairSignals.find((s) => s.strategy !== "trend" && !s.outcome && !s.superseded_by) ??
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
    // Trend system: the levels its breakout entries wait on, on the trend's
    // side only; levels within 0.05% of each other share one line.
    const digitsOf = (() => {
      const pip = pipSize(pair);
      return pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
    })();
    void digitsOf;
    const short: Record<string, string> = { don20: "20", don30: "30", don60: "60", don120: "120", don240: "240" };
    const trendLevels: { label: string; price: number }[] = [];
    if (trend) {
      const up = trend.state.fast === 1;
      for (const w of trend.watch) {
        if (w.level == null || !(w.id in short || w.id === "prevday")) continue;
        const name = w.id === "prevday" ? `yesterday's ${up ? "high" : "low"}` : `${short[w.id]}-candle ${up ? "high" : "low"}`;
        const same = trendLevels.find((l) => Math.abs(l.price - w.level!) / w.level! < 0.0005);
        if (same) same.label = same.label.includes("yesterday") || w.id === "prevday" ? `${same.label} + ${name}` : `${same.label.replace(/-candle.*/, "")}/${name}`;
        else trendLevels.push({ label: name, price: w.level });
      }
    }
    const trails = pairSignals
      .filter((s) => s.strategy === "trend" && !s.outcome && s.status === "active" && candles.length > 0)
      .map((s) => ({
        label: `${trend?.watch.find((w) => w.id === s.variant)?.label ?? "trend"}${(s.confluence_strategies?.length ?? 0) > 1 ? ` +${s.confluence_strategies!.length - 1} more` : ""}`,
        direction: s.direction,
        entry: s.entry,
        stop: s.trail_stop ?? s.stop_loss,
        target: s.take_profit > 0 ? s.take_profit : null,
        startTime: barAt(Math.floor(new Date(s.created_at).getTime() / 1000)).time,
      }));
    return {
      trend: layers.trend && trend ? { ema20: trend.ema20, ema50: trend.ema50, emaTrend: trend.emaTrend, emaBars: trend.emaBars, levels: trendLevels, side: trend.state.side } : null,
      trails: layers.position ? trails : [],
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
  }, [overlay, layers, pairSignals, candles, pair, trend]);

  /** One line on what the trend system allows right now. */
  const trendLine = useMemo(() => {
    if (!trend) return null;
    const st = trend.state;
    const arrow = (t: number) => (t === 1 ? "▲ up" : t === -1 ? "▼ down" : "unknown");
    const allows = st.side ? `${st.side === "long" ? "buys" : "sells"} only` : `no new entries: ${st.blocked}`;
    const tone = st.side === "long" ? "text-emerald-400" : st.side === "short" ? "text-rose-400" : "text-amber-400";
    return { text: `Trend system: ${trend.fastDays}-day ${arrow(st.fast)} · ${trend.slowDays}-day ${arrow(st.slow)} — ${allows}`, tone };
  }, [trend]);

  /** Colour key for the five strategies, with what each is waiting on right now. */
  const legend = useMemo(() => {
    const pip = pipSize(pair);
    const digits = pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
    const px = (n: number) => n.toFixed(digits);
    const against = (tradeable: boolean | undefined) => (tradeable === false ? " · against the trend" : "");

    const b = overlay.breakout;
    let breakout = "no daily trend yet";
    if (b && b.trend !== 0) {
      // only the edge of the one-week range on the trend's side is a trigger
      const level = b.channel ? (b.trend === 1 ? b.channel.high : b.channel.low) : null;
      breakout =
        level == null
          ? "no level yet"
          : `${b.trend === 1 ? "buy on a close above" : "sell on a close below"} ${px(level)}`;
    }

    const a = overlay.aoi;
    const aoi = a ? `${a.direction === "long" ? "buy" : "sell"} AOI ${px(a.bottom)}–${px(a.top)}${against(a.tradeable)}` : "no untested AOI";

    const ready = overlay.zones.filter((z) => z.tradeable !== false);
    const zones =
      overlay.zones.length === 0
        ? "no active zone nearby"
        : ready.length === 0
          ? `${overlay.zones.length} nearby, none with the trend`
          : `${ready.length} ${ready[0].kind === "demand" ? "buy" : "sell"} zone${ready.length > 1 ? "s" : ""} with the trend, nearest ${px(ready[0].bottom)}–${px(ready[0].top)}`;

    const f = overlay.fib;
    const fib = !f || f.isSetup === false
      ? "no setup"
      : `${f.direction === "long" ? "buy" : "sell"} zone ${px(f.goldenBottom)}–${px(f.goldenTop)}${f.inZone ? " · price inside" : ""}${against(f.tradeable)}`;

    // S/R retest: a level that has been both ceiling and floor, on the trend's side of price
    const want = gate?.longAllowed ? "support" : gate?.shortAllowed ? "resistance" : null;
    const price = candles[candles.length - 1]?.close;
    const flipped = (overlay.levels ?? [])
      .filter((l) => l.flipped && l.kind === want)
      .sort((x, y) => Math.abs(x.price - (price ?? x.price)) - Math.abs(y.price - (price ?? y.price)));
    const retest = !want
      ? "no trend to trade with"
      : flipped.length === 0
        ? `no flipped ${want} nearby`
        : `${want === "support" ? "buy" : "sell"} on a retest of ${px(flipped[0].price)}`;

    return [
      { name: "Breakout", color: CHART_COLORS.breakout, state: breakout, active: !!b && b.trend !== 0 },
      { name: "S/R retest", color: CHART_COLORS.level, state: retest, active: flipped.length > 0 },
      { name: "Set & forget", color: CHART_COLORS.aoi, state: aoi, active: !!a && a.tradeable !== false },
      { name: "Zones", color: CHART_COLORS.demand, state: zones, active: ready.length > 0 },
      { name: "Fibonacci", color: CHART_COLORS.fib, state: fib, active: !!f && f.isSetup !== false && f.tradeable !== false },
    ];
  }, [overlay, pair, gate, candles]);

  async function scanNow() {
    setScanStatus("scanning…");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: [pair], timeframes: [timeframe] }),
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

    // ?asOf=2026-11-19T07:15Z shows the analysis as it stood at that moment
    const review = new URLSearchParams(window.location.search).get("asOf");
    const loadAnalysis = (initial: boolean) =>
      fetch(`/api/analysis?instrument=${pair}&granularity=${timeframe}&count=500${review ? `&to=${encodeURIComponent(review)}` : ""}`, {
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
            tr: json.trend ? { s: json.trend.state, w: json.trend.watch, a: json.trend.atr } : null,
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
    // 2) TA refresh every 5 min (picks up a new candle soon after it closes) — the signature
    // check inside loadAnalysis skips the re-render when analysis is unchanged
    //    (a past moment does not change, so a review loads once)
    const taTimer = review ? undefined : setInterval(() => loadAnalysis(false), 5 * 60 * 1000);
    // 3) fast live tick — updates only the forming bar via a cheap 1-candle call
    const liveTimer = review ? undefined : setInterval(() => {
      fetch(`/api/live?instrument=${pair}&granularity=${timeframe}`, {
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
            {timeframe}
          </span>
          {LAYER_GROUPS.map((group) => (
            <div key={group} className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-neutral-600">{group}</span>
              <div className="flex overflow-hidden rounded border border-neutral-700">
                {LAYERS.filter((l) => l.group === group).map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setLayers((prev) => ({ ...prev, [l.id]: !prev[l.id] }))}
                    aria-pressed={layers[l.id]}
                    className={`flex items-center gap-1.5 px-2 py-1.5 text-xs ${
                      layers[l.id] ? "bg-neutral-800 text-neutral-100" : "bg-neutral-900 text-neutral-600"
                    }`}
                  >
                    {l.color && (
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ backgroundColor: `rgb(${l.color})`, opacity: layers[l.id] ? 1 : 0.3 }}
                      />
                    )}
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
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

        {asOf && (
          <p className="rounded border border-amber-900/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            Reviewing the chart as it stood at {new Date(asOf).toUTCString().slice(5, 22)} UTC — live updates are paused.{" "}
            <button onClick={() => window.location.assign(window.location.pathname)} className="underline">
              Back to live
            </button>
          </p>
        )}

        {topDown && (
          <div className="space-y-1.5 border-y border-neutral-800 py-2 text-[11px]">
            {/* what the market is doing, and what that allows */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-neutral-500">
              {trendLine && <span className={trendLine.tone}>{trendLine.text}</span>}
              {gate && !gate.sessionHours.startsWith("00:00–24:00") && (
                <span className={gate.inSession ? "text-emerald-400" : "text-neutral-500"}>
                  Session {gate.inSession ? "open" : "closed"} ({gate.sessionHours})
                </span>
              )}
              {updatedAt != null && candles.length > 0 && (
                <span className="text-neutral-500" title="Times are in your local time zone">
                  Last closed candle {clock(candles[candles.length - 1].time * 1000 + CANDLE_MS)} · chart updated {clock(updatedAt, true)}
                </span>
              )}
              <span className="font-mono text-neutral-600">
                W {topDown.weekly} · D {topDown.daily} · {timeframe} {topDown.chart ?? topDown.h4}
              </span>
            </div>
            {/* the pattern setups (context, not sent): only while one of their layers is shown */}
            <div className={`grid gap-x-4 gap-y-1 sm:grid-cols-2 xl:grid-cols-4 ${layers.breakout || layers.aoi || layers.zones || layers.fib ? "" : "hidden"}`}>
              {legend.map((item) => (
                <div key={item.name} className="flex min-w-0 items-baseline gap-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-sm" style={{ backgroundColor: `rgb(${item.color})` }} />
                  <span className="shrink-0 font-medium text-neutral-200">{item.name}</span>
                  <span className={`truncate ${item.active ? "text-neutral-300" : "text-neutral-600"}`} title={item.state}>
                    {item.state}
                  </span>
                </div>
              ))}
            </div>
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
        <TrendTracker trend={trend} signals={pairSignals} />
        <ConfirmationTracker pair={pair} timeframe={timeframe} />
        <SignalFeed />
      </aside>
    </div>
  );
}
