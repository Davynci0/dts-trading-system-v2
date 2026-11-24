/**
 * The chart the dashboard shows and the scanner steps on: 15-minute candles.
 * The entries are taken on closed 1-hour candles (lib/analysis/trend.ts); an
 * open trade is followed on the 15-minute ones.
 */
export const EXECUTION_TIMEFRAME = "M15" as const;
/** Length of one chart candle. */
export const EXECUTION_BAR_SECONDS = 15 * 60;
/** 15-minute candles the chart shows. */
export const EXECUTION_CANDLES = 500;

/**
 * Closed candles of each timeframe a scan reads: the chart's 15-minute
 * candles, enough 1-hour history for the 200 EMA, the ATR and the ADX to be
 * the same on every scan, and the daily candles behind the 50-day average.
 */
export const SCAN_HISTORY = { m15: 500, h1: 1500, daily: 150 } as const;
