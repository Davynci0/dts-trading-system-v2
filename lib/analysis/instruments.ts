/**
 * Per-instrument trading constants. Dependency-free so the analysis layer,
 * the backtest and the client components can all share one source of truth.
 */

/** Pip size per instrument (1 pip = 0.0001, JPY quotes 0.01, gold 0.1). */
export function pipSize(instrument: string): number {
  if (instrument.includes("JPY")) return 0.01;
  if (instrument.startsWith("XAU")) return 0.1;
  return 0.0001;
}

/** Typical spread per instrument, in pips (liquid-hours retail pricing). */
export const SPREAD_PIPS: Record<string, number> = {
  XAU_USD: 3.0,
  EUR_USD: 1.0,
  GBP_USD: 1.2,
  USD_JPY: 1.0,
  GBP_JPY: 2.5,
  EUR_JPY: 1.4,
  AUD_JPY: 1.6,
  GBP_AUD: 3.5,
  GBP_NZD: 4.5,
};
export const DEFAULT_SPREAD_PIPS = 1.5;
export const SLIPPAGE_PIPS = 0.5; // per side

/** Typical spread in price units. */
export function typicalSpread(instrument: string): number {
  return (SPREAD_PIPS[instrument] ?? DEFAULT_SPREAD_PIPS) * pipSize(instrument);
}

/**
 * What one entry costs in price terms: half the spread (mid → fill) plus
 * slippage. Stops are quoted from the fill, so this is the share of the risk
 * that is lost the moment the trade is opened.
 */
export function entryCost(instrument: string): number {
  return typicalSpread(instrument) / 2 + SLIPPAGE_PIPS * pipSize(instrument);
}

/**
 * Spacing of the round numbers traders actually anchor to: 50-pip handles on
 * FX (x.xx00 / x.xx50), $25 on gold. A fixed "50 pips" would be $5 on gold —
 * a grid so fine that every zone contains one.
 */
export function roundNumberStep(instrument: string): number {
  if (instrument.startsWith("XAU")) return 25;
  return 50 * pipSize(instrument);
}
