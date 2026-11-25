/**
 * Candle loader for the backtest: pages OANDA history by date and caches it
 * under .cache/candles (git-ignored), so repeat runs are instant and offline
 * and two code versions can be compared on identical data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchCandles } from "@/lib/oanda";
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
export async function loadPairData(pair: string): Promise<PairData> {
  const end = windowEnd();
  const span = BACKTEST_YEARS * 365 + WARMUP_DAYS;
  const file = `${CACHE_DIR}/${pair}-${BACKTEST_YEARS}y-${new Date(end).toISOString().slice(0, 10)}.json`;
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

/** Years of daily and weekly candles kept BEFORE the backtest window: the areas of interest look back three years. */
const ZONE_YEARS = 3;

export interface SwingData {
  /** 15-minute candles: open trades are followed on them, and the 30-minute and 1-hour candles are built from them */
  m15: Candle[];
  h2: Candle[];
  h4: Candle[];
  daily: Candle[];
  weekly: Candle[];
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

/** Everything the Set and Forget backtest reads for one market: the window, its warm-up, and three more years of daily and weekly candles for the areas of interest. */
export async function loadSwingData(pair: string): Promise<SwingData> {
  const end = windowEnd();
  const day = new Date(end).toISOString().slice(0, 10);
  const span = BACKTEST_YEARS * 365 + WARMUP_DAYS;
  const file = `${CACHE_DIR}/${pair}-swing-${BACKTEST_YEARS}y-${day}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SwingData;
  const scalp = `${CACHE_DIR}/${pair}-${BACKTEST_YEARS}y-${day}.json`;
  const m15 = existsSync(scalp) ? (JSON.parse(readFileSync(scalp, "utf8")) as PairData).m15 : await fetchRange(pair, "M15", end, span, 40);
  const long = span + (ZONE_YEARS + 1) * 365;
  const data: SwingData = {
    m15,
    h2: await fetchRange(pair, "H2", end, span + 120, 300),
    h4: await fetchRange(pair, "H4", end, span + 240, 600),
    daily: await fetchRange(pair, "D", end, long, 3000),
    weekly: await fetchRange(pair, "W", end, long, 6000),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}
