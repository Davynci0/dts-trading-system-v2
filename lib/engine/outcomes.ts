import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchCandles } from "@/lib/oanda";
import { FIB_MAX_HOLD_BARS } from "@/lib/analysis/fibonacci";

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
  /** epoch seconds of the candle that closed the trade */
  hitTime: number | null;
  hitPrice: number | null;
}

/** Signals are settled on 15-minute candles. `candle.time` is the candle's OPEN;
 *  a candle only predates the signal when it CLOSED before it. */
const CANDLE_MS = 15 * 60 * 1000;

/**
 * Follow a trade through the 15-minute candles since it was sent: the first
 * candle to touch the stop is a loss, the first to touch the target a win, and
 * a candle that touches both counts as a loss. A trade that has reached
 * neither after FIB_MAX_HOLD_BARS candles is closed at that candle's close
 * ("expired", with whatever it made or lost). A gap through the stop fills at
 * the candle's open.
 */
export function settleSignal(s: SettleInput, candles: { time: number; open: number; high: number; low: number; close: number }[]): Settlement | null {
  const long = s.direction === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(s.entry - s.stop_loss);
  let held = 0;
  for (const c of candles) {
    if (c.time * 1000 + CANDLE_MS <= s.firedAt) continue;
    if (long ? c.low <= s.stop_loss : c.high >= s.stop_loss) {
      const price = long ? Math.min(s.stop_loss, c.open) : Math.max(s.stop_loss, c.open);
      return { outcome: "loss", r: risk > 0 ? (dir * (price - s.entry)) / risk : -1, hitTime: c.time, hitPrice: price };
    }
    if (long ? c.high >= s.take_profit : c.low <= s.take_profit) {
      return { outcome: "win", r: risk > 0 ? Math.abs(s.take_profit - s.entry) / risk : 0, hitTime: c.time, hitPrice: s.take_profit };
    }
    if (held >= FIB_MAX_HOLD_BARS) {
      return { outcome: "expired", r: risk > 0 ? (dir * (c.close - s.entry)) / risk : 0, hitTime: c.time, hitPrice: c.close };
    }
    held++;
  }
  return null;
}

/** A trade of the retired trend system as stored: a trailing stop a fixed distance behind the best price. */
export interface TrailInput {
  direction: "long" | "short";
  entry: number;
  /** the initial stop — one R is the distance from the entry to it */
  stop_loss: number;
  trail_distance: number;
  /** take-profit price; 0 or less when the trade has none */
  take_profit?: number;
  /** the stop as it stood when the candles were last followed */
  trail_stop: number;
  /** epoch ms: candles that closed before this have already been followed */
  checkedAt: number;
}

/**
 * The trend system no longer sends signals, but its trades that were still
 * open when it was retired are followed to their end: the trailing stop is
 * tested first, then the take-profit, then the stop trails behind the candle's
 * best price.
 */
export function settleTrailing(
  s: TrailInput,
  candles: { time: number; open: number; high: number; low: number; close: number }[]
): { settlement: Settlement | null; trailStop: number; checkedAt: number } {
  const fresh = candles.filter((c) => c.time * 1000 + CANDLE_MS > s.checkedAt);
  const risk = Math.abs(s.entry - s.stop_loss);
  const dir = s.direction === "long" ? 1 : -1;
  const target = s.take_profit != null && s.take_profit > 0 ? s.take_profit : NaN;
  const last = fresh[fresh.length - 1];
  const checkedAt = last ? last.time * 1000 + CANDLE_MS : s.checkedAt;
  let stop = s.trail_stop;
  for (const c of fresh) {
    if (dir === 1 ? c.low <= stop : c.high >= stop) {
      const price = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
      const r = risk > 0 ? (dir * (price - s.entry)) / risk : 0;
      return { settlement: { outcome: r > 0 ? "win" : "loss", r, hitTime: c.time, hitPrice: price }, trailStop: stop, checkedAt };
    }
    if (dir === 1 ? c.high >= target : c.low <= target) {
      const r = risk > 0 ? (dir * (target - s.entry)) / risk : 0;
      return { settlement: { outcome: "win", r, hitTime: c.time, hitPrice: target }, trailStop: stop, checkedAt };
    }
    const next = (dir === 1 ? c.high : c.low) - dir * s.trail_distance;
    stop = dir === 1 ? Math.max(stop, next) : Math.min(stop, next);
  }
  return { settlement: null, trailStop: stop, checkedAt };
}

interface Row extends Omit<SettleInput, "firedAt"> {
  id: string;
  pair: string;
  created_at: string;
  trail_distance: number | null;
  trail_stop: number | null;
  trail_checked_at: string | null;
}

let lastRun = 0;

/**
 * Settles every open signal on 15-minute candles from the oldest one's
 * creation. Throttled so polling the feed doesn't hammer OANDA.
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
    .select("id, pair, created_at, direction, entry, stop_loss, take_profit, trail_distance, trail_stop, trail_checked_at")
    .is("outcome", null)
    .gt("stop_loss", 0)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !data?.length) return 0;

  const byPair = new Map<string, Row[]>();
  for (const r of data as Row[]) byPair.set(r.pair, [...(byPair.get(r.pair) ?? []), r]);

  let settled = 0;
  for (const [pair, rows] of byPair) {
    // a trailing trade only needs the candles since it was last followed
    const startOf = (r: Row) => new Date(r.trail_distance != null ? (r.trail_checked_at ?? r.created_at) : r.created_at).getTime();
    const from = Math.min(...rows.map(startOf));
    let candles: Awaited<ReturnType<typeof fetchCandles>>;
    try {
      candles = await fetchM15Since(pair, from);
    } catch {
      continue;
    }
    for (const r of rows) {
      const firedAt = new Date(r.created_at).getTime();
      let res: Settlement | null;
      if (r.trail_distance != null) {
        const followed = settleTrailing(
          { direction: r.direction, entry: r.entry, stop_loss: r.stop_loss, trail_distance: r.trail_distance, take_profit: r.take_profit, trail_stop: r.trail_stop ?? r.stop_loss, checkedAt: startOf(r) },
          candles
        );
        res = followed.settlement;
        await supabase
          .from("signals")
          .update({ trail_stop: followed.trailStop, ...(res ? {} : { trail_checked_at: new Date(followed.checkedAt).toISOString() }) })
          .eq("id", r.id);
      } else {
        res = settleSignal({ ...r, firedAt }, candles);
      }
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

/** 15-minute candles from `fromMs` to now, paged — OANDA returns at most 5000 a request (about 52 days). */
async function fetchM15Since(pair: string, fromMs: number) {
  const PAGE_MS = 40 * 24 * 3600 * 1000;
  const out: Awaited<ReturnType<typeof fetchCandles>> = [];
  const end = Date.now();
  for (let a = fromMs; a < end; a += PAGE_MS) {
    out.push(
      ...(await fetchCandles({
        instrument: pair,
        granularity: "M15",
        from: new Date(a).toISOString(),
        to: new Date(Math.min(end, a + PAGE_MS)).toISOString(),
      }))
    );
  }
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((x, y) => x.time - y.time);
}
