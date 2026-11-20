/**
 * Trading-session gate. On 4-hour candles every close is tradeable, so the
 * default is the whole day: a stop of 3 H4 ATRs is tens of dollars on gold,
 * and the spread — even widened at the daily rollover — is a percent or two of
 * it. Restricting entries to London/New York hours was tested on fifteen years
 * and was worse.
 *
 * Override with TRADING_HOURS_UTC="start-end" (e.g. "7-20"). `end` is
 * exclusive; a window may wrap midnight. The hour tested is the entry time —
 * the close of the signal candle.
 */
const DEFAULT_HOURS: [number, number] = [0, 24];

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
