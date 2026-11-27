import { fetchCandles } from "@/lib/oanda";
import type { Candle } from "@/lib/types";

/** The life of one setup, in epoch seconds: from the open of its entry candle to the close of the last 15-minute candle it may be held for. */
export interface MinuteWindow {
  entry: number;
  until: number;
}

/**
 * The 1-minute candles of each window, a few requests at a time. The profit
 * lock is moved within minutes of price touching its trigger, so a backtest
 * that follows trades on 15-minute candles cannot see what it does; the
 * minutes are only needed while a trade could be open, which is a small part
 * of the five years.
 */
export async function fetchMinuteWindows(pair: string, windows: MinuteWindow[], concurrency = 6): Promise<Map<number, Candle[]>> {
  const out = new Map<number, Candle[]>();
  const todo = [...windows];
  const worker = async () => {
    for (;;) {
      const w = todo.pop();
      if (!w) return;
      out.set(w.entry, await fetchCandles({ instrument: pair, granularity: "M1", from: new Date(w.entry * 1000).toISOString(), to: new Date(w.until * 1000).toISOString() }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  return out;
}
