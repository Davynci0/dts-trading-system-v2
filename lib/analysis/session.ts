/**
 * Trading-session gate. Signals are only sent during the New York session
 * (which opens inside the London overlap): 12:00–21:00 UTC.
 *
 *  - The Asian session is excluded: thin liquidity chops through zones built
 *    by London/NY volatility, and entries there lose in backtests year after
 *    year.
 *  - 21:00–23:00 UTC is the daily rollover, where real spreads are several
 *    times wider than any fixed-spread model assumes.
 *  - The London morning (06:00–12:00) is the judgement call; add it back with
 *    TRADING_HOURS_UTC="6-21".
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
