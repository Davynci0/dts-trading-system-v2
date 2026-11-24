/**
 * Candle loader for the research scripts: pages OANDA history by date and
 * caches it under .cache/candles (git-ignored), so repeat runs are instant and
 * offline and two code versions can be compared on identical data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchCandles } from "@/lib/oanda";
import type { Candle } from "@/lib/types";

export const DAY_MS = 86_400_000;
const CACHE_DIR = ".cache/candles";

export interface PairData {
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  daily: Candle[];
  weekly: Candle[];
}

/** Today 00:00 UTC — every run on the same day reads the same cache. */
export function windowEnd(): number {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS;
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

/** `spanDays` of history plus enough higher-timeframe history before it that
 *  the very first bar already has weekly/daily context. The M15 series (the
 *  bulk of the download) is only fetched when `withM15` is set — the backtest
 *  follows every open trade on it. */
export async function loadPairData(pair: string, spanDays: number, withM15 = false): Promise<PairData> {
  const end = windowEnd();
  const file = `${CACHE_DIR}/${pair}-${spanDays}d${withM15 ? "" : "-h4"}-${new Date(end).toISOString().slice(0, 10)}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as PairData;
  const data: PairData = {
    m15: withM15 ? await fetchRange(pair, "M15", end, spanDays, 40) : [],
    h1: await fetchRange(pair, "H1", end, spanDays + 15, 90),
    h4: await fetchRange(pair, "H4", end, spanDays + 35, 300),
    daily: await fetchRange(pair, "D", end, spanDays + 155, 600),
    weekly: await fetchRange(pair, "W", end, spanDays + 435, 2000),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}
