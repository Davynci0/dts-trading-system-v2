/**
 * The chart the system trades on. Entries are taken on 15-minute candles; the
 * 1-hour, 4-hour and daily candles are read for the swing and the trend
 * (lib/analysis/fibonacci.ts).
 */
export const EXECUTION_TIMEFRAME = "M15" as const;
/** Length of one chart candle. */
export const EXECUTION_BAR_SECONDS = 15 * 60;
/** 15-minute candles the chart shows. */
export const EXECUTION_CANDLES = 500;

/**
 * Closed candles of each timeframe a scan reads: enough 1-hour history for the
 * swings and their ATR to be the same on every scan, enough 4-hour history for
 * the 50 EMA to have settled, and the daily candles behind the 50-day average.
 */
export const FIB_HISTORY = { m15: 500, h1: 1500, h4: 400, daily: 150 } as const;
