import type { Candle } from "@/lib/types";
import { runFibBacktest, type FibTrade } from "@/lib/backtest/fib";
import { runTrendBacktest, type TrendTrade } from "@/lib/backtest/trend";

/**
 * The whole system on history: the trend entries and the Fibonacci
 * retracement, each with its own book (one trade at a time each), as the
 * scanner runs them.
 *
 * The live scanner also refuses a trade while the other book holds one the
 * other way. The two books are replayed separately here; on fifteen years of
 * gold that rule would have held back 17 of 865 trades, which together made
 * +4.5R — too few to change the picture.
 */
export interface SystemTrade {
  /** which book the trade belongs to */
  book: "trend" | "fibonacci";
  /** the entry that fired, as the results are grouped */
  entryType: "Trend — breakout" | "Trend — RSI pullback" | "Fibonacci retracement";
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  rAchieved: number;
  open: boolean;
}

export interface SystemBacktest {
  trend: TrendTrade[];
  fib: FibTrade[];
  /** both books, in the order the trades closed */
  all: SystemTrade[];
}

export function runSystemBacktest(opts: { pair: string; m15: Candle[]; h1: Candle[]; h4: Candle[]; daily: Candle[]; from?: number; costMultiplier?: number }): SystemBacktest {
  const trend = runTrendBacktest(opts);
  const fib = runFibBacktest(opts);
  const all: SystemTrade[] = [
    ...trend.map((t) => ({
      book: "trend" as const,
      // a candle that is both counts as a breakout
      entryType: t.trigger === "RSI pullback" ? ("Trend — RSI pullback" as const) : ("Trend — breakout" as const),
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      rAchieved: t.rAchieved,
      open: t.outcome === "open",
    })),
    ...fib.map((t) => ({
      book: "fibonacci" as const,
      entryType: "Fibonacci retracement" as const,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      rAchieved: t.rAchieved,
      open: t.outcome === "open",
    })),
  ].sort((a, b) => a.exitTime - b.exitTime);
  return { trend, fib, all };
}

export const ENTRY_TYPES: SystemTrade["entryType"][] = ["Trend — breakout", "Trend — RSI pullback", "Fibonacci retracement"];
