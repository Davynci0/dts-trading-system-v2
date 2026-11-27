/**
 * Candle loader for the backtest: pages OANDA history by date and caches it
 * under .cache/candles (git-ignored), so repeat runs are instant and offline
 * and two code versions can be compared on identical data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchCandles } from "@/lib/oanda";
import { fetchMinuteWindows, type MinuteWindow } from "@/lib/backtest/minutes";
import type { Candle } from "@/lib/types";

export const DAY_MS = 86_400_000;
const CACHE_DIR = ".cache/candles";

/** The backtest window: always five years, with the last three shown next to it (SOUL.md). */
export const BACKTEST_YEARS = 5;
export const RECENT_YEARS = 3;
/** Days of candles loaded before the window so the first traded day already has its indicators. */
const WARMUP_DAYS = 60;

export interface PairData {
  m15: Candle[];
  h1: Candle[];
  daily: Candle[];
}

/** Today 00:00 UTC — every run on the same day reads the same cache. BACKTEST_END=2026-11-24 repeats an earlier day's window on its cached candles. */
export function windowEnd(): number {
  const fixed = Date.parse(`${process.env.BACKTEST_END ?? ""}T00:00:00Z`);
  return Number.isFinite(fixed) ? fixed : Math.floor(Date.now() / DAY_MS) * DAY_MS;
}

/** OANDA caps a request at 5000 candles, so each series is paged by date. */
async function fetchRange(instrument: string, granularity: string, end: number, days: number, pageDays: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let from = end - days * DAY_MS; from < end; from += pageDays * DAY_MS) {
    const to = Math.min(end, from + pageDays * DAY_MS);
    out.push(
      ...(await fetchCandles({ instrument, granularity, from: new Date(from).toISOString(), to: new Date(to).toISOString() }))
    );
  }
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((a, b) => a.time - b.time);
}

/** The backtest window of 15-minute and 1-hour candles plus the warm-up before it, and the daily candles behind the 50-day average. */
export async function loadPairData(pair: string, warmupDays: number = WARMUP_DAYS): Promise<PairData> {
  const end = windowEnd();
  const span = BACKTEST_YEARS * 365 + warmupDays;
  // a longer warm-up (a slow average that needs more history) gets its own cache file
  const file = `${CACHE_DIR}/${pair}-${BACKTEST_YEARS}y${warmupDays === WARMUP_DAYS ? "" : `-w${warmupDays}`}-${new Date(end).toISOString().slice(0, 10)}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as PairData;
  const data: PairData = {
    m15: await fetchRange(pair, "M15", end, span, 40),
    h1: await fetchRange(pair, "H1", end, span, 90),
    daily: await fetchRange(pair, "D", end, span + 155, 600),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

/**
 * The 1-minute candles of each setup's life, cached under .cache/candles by the
 * open of the entry candle. A window that had not ended two days before the
 * cache was last written may be incomplete in it, so recent ones are read again.
 */
export async function loadMinuteCandles(pair: string, windows: MinuteWindow[]): Promise<Map<number, Candle[]>> {
  const file = `${CACHE_DIR}/${pair}-m1-setups.json`;
  const stored: Record<string, number[][]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const recent = Date.now() / 1000 - 2 * 86400;
  const missing = windows.filter((w) => !stored[w.entry] || w.until >= recent);
  if (missing.length) {
    for (const [entry, candles] of await fetchMinuteWindows(pair, missing)) stored[entry] = candles.map((c) => [c.time, c.open, c.high, c.low, c.close]);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(stored));
  }
  return new Map(windows.map((w) => [w.entry, (stored[w.entry] ?? []).map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 0 }))]));
}

/** Candles of `seconds` length built from shorter ones (OANDA aligns 30-minute and 1-hour candles to the clock, so these match its own). */
export function aggregate(candles: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  return out;
}
