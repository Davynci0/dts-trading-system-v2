/**
 * The chart the dashboard shows and the scanner steps on: 15-minute candles.
 * The entries are taken on closed 15-minute candles (lib/analysis/trend.ts)
 * and an open trade is followed on them; the 1-hour and daily candles give
 * the trend.
 */
export const EXECUTION_TIMEFRAME = "M15" as const;
/** Length of one chart candle. */
export const EXECUTION_BAR_SECONDS = 15 * 60;
/** 15-minute candles the chart shows. */
export const EXECUTION_CANDLES = 500;

/**
 * Closed candles of each timeframe a scan reads: enough 15-minute candles for
 * the ATR and the 24-hour channel to be the same on every scan, enough 1-hour
 * history for the 200 EMA to have settled, and the daily candles behind the
 * 50-day average.
 */
export const SCAN_HISTORY = { m15: 500, h1: 1500, daily: 150 } as const;
