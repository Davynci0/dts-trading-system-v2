import type { Candle } from "@/lib/types";

const ENV_HOSTS = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
} as const;

export function oandaHost(): string {
  const env = (process.env.OANDA_ENV ?? "practice") as keyof typeof ENV_HOSTS;
  return ENV_HOSTS[env] ?? ENV_HOSTS.practice;
}

export interface OandaCandleQuery {
  instrument: string; // e.g. "EUR_USD"
  granularity: string; // e.g. "M5" | "M15" | "H1" | "H4" | "D"
  count?: number; // max 5000 per OANDA
  /** ISO timestamps; when both set they replace `count` (used by the backtester) */
  from?: string;
  to?: string;
  /** include the still-forming candle (for live charts) */
  includeIncomplete?: boolean;
}

interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid: { o: string; h: string; l: string; c: string };
}

/** Fetch historical candles from the OANDA v20 REST API. */
export async function fetchCandles({
  instrument,
  granularity,
  count = 500,
  from,
  to,
  includeIncomplete = false,
}: OandaCandleQuery): Promise<Candle[]> {
  const apiKey = process.env.OANDA_API_KEY;
  if (!apiKey) throw new Error("OANDA_API_KEY is not set");

  const range = from && to ? `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : `&count=${count}`;
  const url =
    `${oandaHost()}/v3/instruments/${instrument}/candles` +
    `?granularity=${granularity}${range}&price=M`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OANDA ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { candles: OandaCandle[] };
  return json.candles
    .filter((c) => c.complete || includeIncomplete)
    .map((c) => ({
      time: Math.floor(Date.parse(c.time) / 1000),
      open: Number(c.mid.o),
      high: Number(c.mid.h),
      low: Number(c.mid.l),
      close: Number(c.mid.c),
      volume: c.volume,
    }));
}

/** Latest live bid/ask for an instrument (cheap single-call poll for the chart). */
export async function fetchLatestPrice(instrument: string): Promise<Candle | null> {
  const apiKey = process.env.OANDA_API_KEY;
  if (!apiKey) throw new Error("OANDA_API_KEY is not set");
  const url = `${oandaHost()}/v3/instruments/${instrument}/price`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    time: string;
    bids: { price: string }[];
    asks: { price: string }[];
  };
  const bid = Number(json.bids[0]?.price);
  const ask = Number(json.asks[0]?.price);
  if (!bid) return null;
  const mid = (bid + (ask || bid)) / 2;
  return {
    time: Math.floor(Date.parse(json.time) / 1000),
    open: mid,
    high: mid,
    low: mid,
    close: mid,
    volume: 0,
  };
}
