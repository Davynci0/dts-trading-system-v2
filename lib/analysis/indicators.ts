import type { Candle } from "@/lib/types";

function trueRange(c: Candle, prev: Candle): number {
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prev.close),
    Math.abs(c.low - prev.close)
  );
}

/** Wilder's ATR series, aligned to candles (null during warm-up). */
export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(candles[i], candles[i - 1]);
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRange(candles[i], candles[i - 1])) / period;
    out[i] = atr;
  }
  return out;
}

/** Latest ATR value, or null if there isn't enough data. */
export function atr(candles: Candle[], period = 14): number | null {
  const s = atrSeries(candles, period);
  return s[s.length - 1];
}

/** Wilder's RSI (latest value) — used by confirmation #3 in Stage 6. */
export function rsi(candles: Candle[], period = 14): number | null {
  const s = rsiSeries(candles, period);
  return s[s.length - 1];
}

/** Wilder's RSI series, aligned to candles (null during warm-up). */
export function rsiSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
