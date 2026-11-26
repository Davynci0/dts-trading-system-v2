"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "@/components/Chart";
import MarketSwitch from "@/components/MarketSwitch";
import type { OverlayData } from "@/components/chartOverlay";
import type { BtcState } from "@/lib/analysis/btc";
import type { BtcStats, BtcTrade } from "@/lib/backtest/btc";
import type { Candle } from "@/lib/types";

interface Results {
  end: string;
  years: number;
  recentYears: number;
  cost: number;
  all: BtcStats;
  allCostsDoubled: BtcStats;
  recent: BtcStats;
  recentCostsDoubled: BtcStats;
  lastYear: BtcStats;
  byYear: { from: string; stats: BtcStats }[];
  buys: BtcStats;
  sells: BtcStats;
  exits: { stop: number; lock: number; target: number; time: number };
  averageWin: number;
  averageLoss: number;
  medianHours: number;
  stop: { low: number; high: number; median: number };
}
interface Rules {
  trendEma: number;
  targetR: number;
  lockAtR: number;
  lockToR: number;
  holdHours: number;
  minRiskAtr: number;
  maxRiskAtr: number;
  cost: number;
  maxCostShare: number;
  chartSeconds: number;
}
interface Payload {
  candles: Candle[];
  /** the 200-EMA of the closed 4-hour candles: the trend line the rules read */
  ema: { time: number; value: number }[];
  state: BtcState;
  price: number | null;
  trades: BtcTrade[];
  simulatedFrom: number | null;
  rules: Rules;
  results: Results;
  build: string | null;
  asOf: string | null;
}

const PAIR = "BTC_USD";
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;
const totalR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clock = (ms: number, seconds = false) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
const when = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const OUTCOME: Record<BtcTrade["outcome"], string> = { target: "target", stop: "stop", lock: "moved stop", time: "time limit", open: "open" };

/**
 * The Bitcoin system's page: the 4-hour chart with the trend line, yesterday's
 * high and low and the level the next trade needs, what the rules are waiting
 * for, the trades they would have taken over the last weeks, and the five-year
 * backtest. Nothing here is a sent signal.
 */
export default function BtcDashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [live, setLive] = useState<Candle | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef("");

  // setState only inside async callbacks (react-hooks/set-state-in-effect)
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    const review = new URLSearchParams(window.location.search).get("asOf");
    const load = (initial: boolean) =>
      fetch(`/api/btc${review ? `?to=${encodeURIComponent(review)}` : ""}`, { signal: controller.signal })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          const p = json as Payload;
          const sig = JSON.stringify({ t: p.candles[p.candles.length - 1]?.time, c: p.candles[p.candles.length - 1]?.close, s: p.state.readAt, n: p.trades.length });
          if (!initial && sig === sigRef.current) return;
          sigRef.current = sig;
          setData(p);
          setUpdatedAt(Date.now());
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name === "AbortError" || stopped) return;
          if (initial) setError(e.message);
        });
    load(true);
    const slow = review ? undefined : setInterval(() => load(false), 60_000);
    // the price now, to move the last candle between loads
    const fast = review
      ? undefined
      : setInterval(() => {
          fetch(`/api/live?instrument=${PAIR}&granularity=M15`, { signal: controller.signal })
            .then((r) => r.json())
            .then((j) => {
              if (!stopped && j.candle) setLive(j.candle);
            })
            .catch(() => undefined);
        }, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(slow);
      clearInterval(fast);
    };
  }, []);

  const candles = useMemo(() => data?.candles ?? [], [data]);
  const state = data?.state ?? null;
  const rules = data?.rules ?? null;
  const price = live?.close ?? data?.price ?? null;

  /** the 4-hour candle still forming, moved by the price now */
  const liveCandle = useMemo<Candle | null>(() => {
    const last = candles[candles.length - 1];
    if (!live || !last || !rules) return null;
    const bucket = Math.floor(live.time / rules.chartSeconds) * rules.chartSeconds;
    if (bucket === last.time) return { ...last, high: Math.max(last.high, live.high), low: Math.min(last.low, live.low), close: live.close };
    if (bucket > last.time) return { time: bucket, open: live.open, high: live.high, low: live.low, close: live.close, volume: live.volume };
    return null;
  }, [live, candles, rules]);

  const open = data?.trades.find((t) => t.outcome === "open") ?? null;

  const overlay = useMemo<OverlayData>(() => {
    if (!data || !state || candles.length === 0) return { digits: 0 };
    const barAt = (sec: number) => [...candles].reverse().find((c) => c.time <= sec) ?? candles[0];
    const first = candles[0].time;
    return {
      trend:
        state.trend !== 0 && state.nextLevel != null && state.nextArmed && state.nextLevelFinal && !open
          ? { direction: state.trend === 1 ? "long" : "short", levels: [{ label: "yesterday", price: state.nextLevel, armed: true }], ready: true, candleName: "4-hour" }
          : null,
      // what the rules read: the 200-EMA (the trend) and yesterday's high and low (the levels)
      emas: [{ period: 200, points: data.ema.filter((p) => p.time >= first) }],
      dayLevels: state.prevHigh != null && state.prevLow != null ? { high: state.prevHigh, low: state.prevLow } : null,
      positions: open
        ? [{ label: "BTC DAY-BREAK (simulated)", direction: open.direction, entry: open.entry, stopLoss: open.stopLoss, takeProfit: open.takeProfit, startTime: barAt(open.entryTime).time, rMultiple: data.rules.targetR }]
        : [],
      history: data.trades
        .filter((t) => t.outcome !== "open" && t.exitTime >= first)
        .map((t) => ({ direction: t.direction, entry: t.entry, startTime: barAt(t.entryTime).time, endTime: barAt(t.exitTime - 1).time, exitPrice: t.exitPrice, outcome: t.rAchieved > 0 ? ("win" as const) : ("loss" as const), r: t.rAchieved })),
      digits: 0,
    };
  }, [data, state, candles, open]);

  const sell = state?.trend === -1;
  const sideLine = !state
    ? null
    : state.trend === 0
      ? { side: "No trades", tone: "text-amber-400", why: "the trend is not clear" }
      : { side: sell ? "Sells only" : "Buys only", tone: sell ? "text-rose-400" : "text-emerald-400", why: `Bitcoin is ${sell ? "below" : "above"} its ${rules?.trendEma ?? 200}-EMA on the 4-hour chart, and trades are only taken with it` };
  const headline = !state
    ? null
    : open
      ? { text: `The rules have a ${open.direction === "long" ? "buy" : "sell"} open from ${usd(open.entry)} — no new trade until it closes.`, tone: "text-sky-300" }
      : state.setup
        ? { text: `${state.setup.direction === "long" ? "Buy" : "Sell"} on the 4-hour candle that has just closed.`, tone: state.setup.direction === "long" ? "text-emerald-400" : "text-rose-400" }
        : { text: `No trade right now: ${state.waiting ?? "nothing to wait for"}.`, tone: "text-amber-400" };
  const missing = state ? state.checks.filter((c) => !c.met) : [];
  const done = state ? state.checks.filter((c) => c.met) : [];
  const closed = (data?.trades ?? []).filter((t) => t.outcome !== "open");
  const closedTotal = closed.reduce((s, t) => s + t.rAchieved, 0);
  const res = data?.results ?? null;

  return (
    <div className="relative flex h-full flex-col gap-4 p-4 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <MarketSwitch active="btc" />
          <span className="rounded border border-neutral-800 px-2.5 py-1.5 text-sm text-neutral-400">4-hour chart</span>
          <span className="ml-auto rounded border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-200">Not sending signals — the rules are read here only</span>
        </div>

        {data?.asOf && (
          <p className="rounded border border-amber-900/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            Reviewing the chart as it stood at {new Date(data.asOf).toUTCString().slice(5, 22)} UTC — live updates are paused.{" "}
            <button onClick={() => window.location.assign(window.location.pathname)} className="underline">
              Back to live
            </button>
          </p>
        )}

        {sideLine && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-neutral-800 py-2 text-[11px] text-neutral-500">
            <span className="text-xs">
              <span className={`font-semibold ${sideLine.tone}`}>{sideLine.side}</span>
              <span className="text-neutral-400"> — {sideLine.why}.</span>
            </span>
            {state && updatedAt != null && (
              <span title="Times are in your local time zone">
                Last closed 4-hour candle {clock(state.readAt * 1000)} · updated {clock(updatedAt, true)}
                {price != null ? ` · price ${usd(price)}` : ""}
              </span>
            )}
          </div>
        )}
        {error && <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">{error}</p>}

        <div className="h-[50vh] min-h-[320px] shrink-0 rounded-lg border border-neutral-800 bg-[#0b0e11] lg:h-[67vh]">
          {candles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">{error ? "No candles" : "Loading candles…"}</div>
          ) : (
            <Chart candles={candles} overlay={overlay} timeframe="H4" liveCandle={liveCandle} viewKey={`${PAIR}:H4`} digits={0} />
          )}
        </div>
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-80">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-100">Bitcoin day-break (4-hour)</h2>
            <span className="text-xs text-neutral-500">{state ? `${done.length} of ${state.checks.length} conditions met` : ""}</span>
          </div>
          {!state || !headline || !rules ? (
            <p className="text-xs text-neutral-600">{error ? "Could not load." : "Loading…"}</p>
          ) : (
            <>
              <p className={`mb-3 text-sm font-medium leading-snug ${headline.tone}`}>{headline.text}</p>
              {state.setup && !open && (
                <div className="mb-3 rounded border border-neutral-700 p-2 font-mono text-xs text-neutral-300">
                  Entry {usd(state.setup.entry)} · SL {usd(state.setup.stopLoss)} · TP {usd(state.setup.takeProfit)}
                  <div className="mt-0.5 text-[10px] text-neutral-500">
                    At {usd(state.setup.lockTrigger)} the stop moves to {usd(state.setup.lockStop)}
                  </div>
                </div>
              )}
              {open && (
                <div className="mb-3 rounded border border-sky-900/60 bg-sky-950/30 p-2 text-xs">
                  <div className={`font-medium ${open.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
                    {open.direction === "long" ? "BUY" : "SELL"} from {usd(open.entry)} <span className="font-normal text-neutral-500">· since {when(open.entryTime)}</span>
                  </div>
                  <div className="mt-1 font-mono text-neutral-300">
                    SL {usd(open.stopLoss)} · TP {usd(open.takeProfit)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-neutral-400">
                    Simulated, not a sent signal. At +{rules.lockAtR}R the stop moves to +{rules.lockToR}R; closed at market after {rules.holdHours} hours of trading if neither level is hit.
                  </div>
                </div>
              )}
              {missing.length > 0 && !open && (
                <div className="mb-3">
                  <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">Still missing</h3>
                  <ul className="space-y-1">
                    {missing.map((c) => (
                      <li key={c.label} className="flex items-start gap-2 text-xs text-neutral-300">
                        <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500/70" />
                        {c.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <details className="border-t border-neutral-800 py-2 text-xs">
                <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">Conditions met ({done.length})</summary>
                <ul className="mt-2 space-y-1">
                  {done.map((c) => (
                    <li key={c.label} className="flex items-start gap-2 text-xs text-teal-300/90">
                      <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-teal-400" />
                      {c.label}
                    </li>
                  ))}
                </ul>
              </details>
              <details className="border-t border-neutral-800 pt-2 text-xs">
                <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">How the rules work</summary>
                <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                  Trend: the 4-hour close against the {rules.trendEma}-EMA of the 4-hour chart — above it only buys, below it only sells. Entry: the first 4-hour candle of the day that closes above yesterday&apos;s high (buy) or below yesterday&apos;s low (sell),
                  entered at that close; yesterday is the last daily candle closed (17:00 New York). Stop: just beyond the last two 4-hour candles, between {rules.minRiskAtr} and {rules.maxRiskAtr} ATR away
                  {state.minRisk != null && state.maxRisk != null ? ` (now ${usd(state.minRisk)} to ${usd(state.maxRisk)} a coin)` : ""}. Take-profit 1:{rules.targetR}; at +{rules.lockAtR}R the stop moves to +{rules.lockToR}R; closed at market after{" "}
                  {rules.holdHours} hours of trading. One trade at a time. No trade when costs (${rules.cost} a coin) are more than {rules.maxCostShare * 100}% of the risk, or when the market is closed at the 4-hour close.
                </p>
              </details>
            </>
          )}
        </div>

        {res && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-1 text-sm font-semibold text-neutral-100">Backtest</h2>
            <p className="mb-2 text-[11px] text-neutral-500">
              To {res.end}, after ${res.cost} a coin in costs. 1R is the risk of one trade.
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-neutral-500">
                  <th className="pb-1 font-normal"></th>
                  <th className="pb-1 text-right font-normal">{res.years} years</th>
                  <th className="pb-1 text-right font-normal">Last {res.recentYears}</th>
                </tr>
              </thead>
              <tbody className="font-mono text-neutral-300">
                {(
                  [
                    ["Trades", String(res.all.trades), String(res.recent.trades)],
                    ["Won", pct(res.all.winRate), pct(res.recent.winRate)],
                    ["Total", totalR(res.all.totalR), totalR(res.recent.totalR)],
                    ["Costs doubled", totalR(res.allCostsDoubled.totalR), totalR(res.recentCostsDoubled.totalR)],
                    ["Worst drawdown", `${res.all.maxDrawdownR.toFixed(1)}R`, `${res.recent.maxDrawdownR.toFixed(1)}R`],
                    ["Longest losing run", String(res.all.longestLosingRun), String(res.recent.longestLosingRun)],
                  ] as [string, string, string][]
                ).map(([name, a, b]) => (
                  <tr key={name} className="border-t border-neutral-800">
                    <td className="py-1 font-sans text-neutral-400">{name}</td>
                    <td className="py-1 text-right">{a}</td>
                    <td className="py-1 text-right">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-neutral-500">
              By year: {res.byYear.map((y) => `${totalR(y.stats.totalR)} (${y.stats.trades})`).join(" · ")}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-neutral-400">
              <li>
                A small edge: {res.all.avgR.toFixed(2)}R a trade, a little over one trade a week. Almost all of it comes from buys; sells about break even.
              </li>
              <li>
                About four trades in ten end at the moved stop (+{rules?.lockToR ?? 0.2}R); the average win is {res.averageWin.toFixed(2)}R, the average loss {Math.abs(res.averageLoss).toFixed(2)}R.
              </li>
              <li>
                Trades last far longer than the gold scalp: half are over within {Math.round(res.medianHours)} hours, some run the full {rules?.holdHours ?? 72}.
              </li>
              <li>
                The stop was ${usd(res.stop.low)} to ${usd(res.stop.high)} a coin in the last year (${usd(res.stop.median)} in the middle). Check the spread your broker charges; ${res.cost} is assumed.
              </li>
            </ul>
          </div>
        )}

        {data && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-neutral-100">Recent trades</h2>
              <span className="text-xs text-neutral-500">{closed.length > 0 ? `${closed.filter((t) => t.rAchieved > 0).length}/${closed.length} won · ${totalR(closedTotal)}` : ""}</span>
            </div>
            <p className="mb-2 text-[11px] text-neutral-500">
              What the rules would have taken{data.simulatedFrom ? ` since ${new Date(data.simulatedFrom * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""} — simulated, not sent signals.
            </p>
            {data.trades.length === 0 ? (
              <p className="text-xs text-neutral-600">No trade in this period.</p>
            ) : (
              <ul className="space-y-1.5">
                {[...data.trades].reverse().map((t) => (
                  <li key={t.entryTime} className="rounded border border-neutral-800 p-2 text-xs">
                    <div className="flex items-baseline justify-between">
                      <span className={`font-medium ${t.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
                        {t.direction === "long" ? "BUY" : "SELL"} {usd(t.entry)}
                      </span>
                      <span className="text-[10px] text-neutral-500">{when(t.entryTime)}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-neutral-400">
                      SL {usd(t.stopLoss)} · TP {usd(t.takeProfit)}
                    </div>
                    <div className={`mt-0.5 ${t.outcome === "open" ? "text-sky-300" : t.rAchieved > 0 ? "text-teal-400" : "text-red-400"}`}>
                      {t.outcome === "open" ? "open" : `${OUTCOME[t.outcome]} at ${usd(t.exitPrice)} · ${signedR(t.rAchieved)} · ${Math.round((t.bars * 15) / 60)} h`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
