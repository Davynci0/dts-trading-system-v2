import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchCandles } from "@/lib/oanda";

export interface SettleInput {
  direction: "long" | "short";
  entry: number;
  stop_loss: number;
  take_profit: number;
  /** epoch ms when the signal was created */
  firedAt: number;
}

export interface Settlement {
  outcome: "win" | "loss" | "expired";
  r: number;
  /** epoch seconds of the candle that hit, or null when expired */
  hitTime: number | null;
  hitPrice: number | null;
}

const EXPIRY_MS = 7 * 24 * 3600 * 1000;
/** M15 candle duration. `candle.time` is the bar OPEN — the bar is tradeable
 *  from its open; a bar only predates the signal when it CLOSED before it. */
const CANDLE_MS = 15 * 60 * 1000;

/** First candle after firing that touches TP (win) or SL (loss); a candle touching both counts as a loss.
 *  A candle is considered when its close (open + CANDLE_MS) is after the signal
 *  time — the entry bar itself must be evaluated, an immediate SL/TP touch there
 *  is a real outcome (comparing open times would skip it). */
export function settleSignal(
  s: SettleInput,
  candles: { time: number; high: number; low: number }[],
  now = Date.now()
): Settlement | null {
  const long = s.direction === "long";
  for (const c of candles) {
    if (c.time * 1000 + CANDLE_MS <= s.firedAt) continue;
    const hitTp = long ? c.high >= s.take_profit : c.low <= s.take_profit;
    const hitSl = long ? c.low <= s.stop_loss : c.high >= s.stop_loss;
    if (hitTp && hitSl) return { outcome: "loss", r: -1, hitTime: c.time, hitPrice: s.stop_loss };
    if (hitSl) return { outcome: "loss", r: -1, hitTime: c.time, hitPrice: s.stop_loss };
    if (hitTp) {
      const r = Math.abs(s.take_profit - s.entry) / Math.abs(s.entry - s.stop_loss);
      return { outcome: "win", r, hitTime: c.time, hitPrice: s.take_profit };
    }
  }
  if (now - s.firedAt > EXPIRY_MS) return { outcome: "expired", r: 0, hitTime: null, hitPrice: null };
  return null;
}

interface Row extends Omit<SettleInput, "firedAt"> {
  id: string;
  pair: string;
  created_at: string;
}

let lastRun = 0;

/**
 * Settles every unscored signal that has real levels, using M15 candles from
 * the oldest signal's creation — independent of the timeframe that produced it,
 * so skipped trades resolve without waiting for a scan. Throttled so polling
 * the feed doesn't hammer OANDA.
 */
export async function scoreOpenSignals(
  supabase: ReturnType<typeof createAdminClient>,
  opts: { force?: boolean } = {}
): Promise<number> {
  if (!supabase) return 0;
  if (!opts.force && Date.now() - lastRun < 60_000) return 0;
  lastRun = Date.now();

  const { data, error } = await supabase
    .from("signals")
    .select("id, pair, created_at, direction, entry, stop_loss, take_profit")
    .is("outcome", null)
    .gt("stop_loss", 0) // legacy skipped rows stored SL/TP 0 — nothing to score
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !data?.length) return 0;

  const byPair = new Map<string, Row[]>();
  for (const r of data as Row[]) byPair.set(r.pair, [...(byPair.get(r.pair) ?? []), r]);

  let settled = 0;
  for (const [pair, rows] of byPair) {
    const from = Math.min(...rows.map((r) => new Date(r.created_at).getTime()));
    let candles;
    try {
      candles = await fetchCandles({
        instrument: pair,
        granularity: "M15",
        from: new Date(from).toISOString(),
        to: new Date().toISOString(),
      });
    } catch {
      continue;
    }
    for (const r of rows) {
      const res = settleSignal({ ...r, firedAt: new Date(r.created_at).getTime() }, candles);
      if (!res) continue;
      const { error: upErr } = await supabase
        .from("signals")
        .update({
          outcome: res.outcome,
          outcome_r: res.r,
          outcome_at: new Date((res.hitTime ?? Date.now() / 1000) * 1000).toISOString(),
          outcome_price: res.hitPrice,
        })
        .eq("id", r.id);
      if (!upErr) settled++;
    }
  }
  return settled;
}
