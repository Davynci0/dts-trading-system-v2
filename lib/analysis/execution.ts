/**
 * The chart the dashboard shows and the scanner steps on. The Fibonacci entry
 * is taken on these 15-minute candles (lib/analysis/fibonacci.ts); the trend
 * entries are taken on closed 1-hour candles (lib/analysis/trend.ts). The
 * 1-hour, 4-hour and daily candles are read for the swings and the trends.
 */
export const EXECUTION_TIMEFRAME = "M15" as const;
/** Length of one chart candle. */
export const EXECUTION_BAR_SECONDS = 15 * 60;
/** 15-minute candles the chart shows. */
export const EXECUTION_CANDLES = 500;

/**
 * Closed candles of each timeframe a scan reads: enough 1-hour history for the
 * swings, their ATR and the 200 EMA to be the same on every scan, enough
 * 4-hour history for the 50 EMA to have settled, and the daily candles behind
 * the 50-day average.
 */
export const FIB_HISTORY = { m15: 500, h1: 1500, h4: 400, daily: 150 } as const;
