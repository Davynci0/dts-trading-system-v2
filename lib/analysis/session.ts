/**
 * Trading-session gate. Signals are only sent during the New York session
 * (which opens inside the London overlap): 12:00–21:00 UTC.
 *
 * Evidence, from a year of closed-bar M15 backtests across all eight pairs:
 *  - 00:00–06:00 UTC entries lost 0.11–0.25R per trade both in- and
 *    out-of-sample (a pre-declared test) — thin Asian liquidity chops through
 *    zones built by London/NY volatility.
 *  - 06:00–12:00 UTC was flat in the first eight months and clearly negative
 *    in the last four; 12:00–21:00 was the only block positive in both. That
 *    second cut was made after seeing the whole year, so it is the least
 *    certain rule in the gate — widen it with TRADING_HOURS_UTC="6-21".
 *  - 21:00–23:00 UTC is the daily rollover, where real spreads are several
 *    times wider than any fixed-spread model assumes.
 *
 * Override with TRADING_HOURS_UTC="start-end" ("0-24" disables the gate).
 * `end` is exclusive; a window may wrap midnight.
 */
const DEFAULT_HOURS: [number, number] = [12, 21];

export function tradingHoursUtc(raw: string | undefined = process.env.TRADING_HOURS_UTC): [number, number] {
  const m = raw?.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return DEFAULT_HOURS;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 24 || end > 24 || start === end) return DEFAULT_HOURS;
  return [start, end];
}

/** Is `epochSeconds` (the moment a trade would be entered) inside the window? */
export function inTradingSession(epochSeconds: number, hours: [number, number] = tradingHoursUtc()): boolean {
  const [start, end] = hours;
  if (start === 0 && end === 24) return true;
  const hour = new Date(epochSeconds * 1000).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
