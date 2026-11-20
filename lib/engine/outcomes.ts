import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchCandles } from "@/lib/oanda";
import { trailThrough, TREND_MAX_HOLD_BARS } from "@/lib/analysis/trend";
import { EXECUTION_BAR_SECONDS } from "@/lib/analysis/execution";

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

/** A pattern trade that has reached neither level after six weeks is closed as expired. */
const EXPIRY_MS = 42 * 24 * 3600 * 1000;
/** Signals are settled on M15 candles, whatever timeframe produced them: the
 *  finer bar says which level was touched first more often than a larger one
 *  can. M15 candle duration. `candle.time` is the bar OPEN — the bar is tradeable
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

/** A trailing-stop trade (trend system) as stored: no target, a fixed trailing distance. */
export interface TrailInput {
  direction: "long" | "short";
  entry: number;
  /** the initial stop — one R is the distance from the entry to it */
  stop_loss: number;
  trail_distance: number;
  /** the stop as it stood when the candles were last followed */
  trail_stop: number;
  /** epoch ms: candles that opened before this have already been followed */
  checkedAt: number;
  firedAt: number;
}

/** A trend trade still open after TREND_MAX_HOLD_BARS candles of trading time is closed at market
 *  (the market trades about five days in seven, so calendar time is 7/5 of that). */
const TRAIL_EXPIRY_MS = Math.round(TREND_MAX_HOLD_BARS * EXECUTION_BAR_SECONDS * 1000 * (7 / 5));

/**
 * Follow a trailing-stop trade through the M15 candles since it was last
 * checked. Returns the settlement when the stop was hit (a win if it had
 * trailed into profit, a loss otherwise) or the trade expired, and in every
 * case where the stop now stands and how far the candles have been followed.
 */
export function settleTrailing(
  s: TrailInput,
  candles: { time: number; open: number; high: number; low: number; close: number }[],
  now = Date.now()
): { settlement: Settlement | null; trailStop: number; checkedAt: number } {
  // a candle counts when it CLOSED after the last check — the entry candle itself included
  const fresh = candles.filter((c) => c.time * 1000 + CANDLE_MS > s.checkedAt);
  const risk = Math.abs(s.entry - s.stop_loss);
  const dir = s.direction === "long" ? 1 : -1;
  const step = trailThrough(s.direction, s.trail_stop, s.trail_distance, fresh);
  const last = fresh[fresh.length - 1];
  const checkedAt = last ? last.time * 1000 + CANDLE_MS : s.checkedAt;
  if (step.exit) {
    const r = risk > 0 ? (dir * (step.exit.price - s.entry)) / risk : 0;
    return { settlement: { outcome: r > 0 ? "win" : "loss", r, hitTime: step.exit.time, hitPrice: step.exit.price }, trailStop: step.stop, checkedAt };
  }
  if (now - s.firedAt > TRAIL_EXPIRY_MS && last) {
    const r = risk > 0 ? (dir * (last.close - s.entry)) / risk : 0;
    return { settlement: { outcome: "expired", r, hitTime: last.time, hitPrice: last.close }, trailStop: step.stop, checkedAt };
  }
  return { settlement: null, trailStop: step.stop, checkedAt };
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
    .select("id, pair, created_at, direction, entry, stop_loss, take_profit, trail_distance, trail_stop, trail_checked_at")
    .is("outcome", null)
    .gt("stop_loss", 0) // legacy skipped rows stored SL/TP 0 — nothing to score
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
          {
            direction: r.direction,
            entry: r.entry,
            stop_loss: r.stop_loss,
            trail_distance: r.trail_distance,
            trail_stop: r.trail_stop ?? r.stop_loss,
            checkedAt: startOf(r),
            firedAt,
          },
          candles
        );
        res = followed.settlement;
        if (!res) {
          // still open: remember where the stop stands now
          await supabase
            .from("signals")
            .update({ trail_stop: followed.trailStop, trail_checked_at: new Date(followed.checkedAt).toISOString() })
            .eq("id", r.id);
          continue;
        }
        await supabase.from("signals").update({ trail_stop: followed.trailStop }).eq("id", r.id);
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

/** M15 candles from `fromMs` to now, paged — OANDA returns at most 5000 a request (about 52 days). */
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
