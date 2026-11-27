import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchCandles } from "@/lib/oanda";
import { TREND_LOCK_ACT_SECONDS, TREND_LOCK_AT_R, TREND_LOCK_TO_R, TREND_MAX_HOLD_BARS } from "@/lib/analysis/trend";
import { sendStopMoved } from "@/lib/telegram";
import { strategyOf } from "@/lib/types";

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
/** A trade of a removed strategy that has a fixed stop and target is closed at market after this many 15-minute candles (five trading days). */
const LEGACY_MAX_HOLD_BARS = 480;

/** The profit lock, in R: once price has gone `at` the trade's way, the stop is moved to `to` in profit. */
export interface ProfitLock {
  at: number;
  to: number;
}
/** The lock the live rules use. */
export const LIVE_LOCK: ProfitLock = { at: TREND_LOCK_AT_R, to: TREND_LOCK_TO_R };

/**
 * Follow a trade through the 15-minute candles since it was sent, exactly as
 * the backtest does. In each candle, in this order: the stop (a gap through it
 * fills at the candle's open), then the target — so a candle that touches both
 * counts as the stop — then the profit lock, which moves the stop for the
 * candles that FOLLOW, then the time limit: a trade that has reached neither
 * level by the close of its `maxHoldBars`-th candle is closed at that close
 * ("expired", with whatever it made or lost).
 *
 * Returns the settlement, or null while the trade is open, and where the stop
 * stands now. It reads every candle since the signal each time, so it needs no
 * stored state.
 */
export function followTrade(
  s: SettleInput,
  candles: { time: number; open: number; high: number; low: number; close: number }[],
  opts: { maxHoldBars?: number; lock?: ProfitLock | null } = {}
): { settlement: Settlement | null; stop: number } {
  const maxHoldBars = opts.maxHoldBars ?? TREND_MAX_HOLD_BARS;
  const long = s.direction === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(s.entry - s.stop_loss);
  const lockTrigger = opts.lock ? s.entry + dir * opts.lock.at * risk : NaN;
  const lockStop = opts.lock ? s.entry + dir * opts.lock.to * risk : NaN;
  let stop = s.stop_loss;
  let held = 0;
  for (const c of candles) {
    if (c.time * 1000 + CANDLE_MS <= s.firedAt) continue;
    if (long ? c.low <= stop : c.high >= stop) {
      const price = long ? Math.min(stop, c.open) : Math.max(stop, c.open);
      const r = risk > 0 ? (dir * (price - s.entry)) / risk : -1;
      // a stop that the lock moved into profit closes the trade as a win
      return { settlement: { outcome: r > 0 ? "win" : "loss", r, hitTime: c.time, hitPrice: price }, stop };
    }
    if (long ? c.high >= s.take_profit : c.low <= s.take_profit) {
      return { settlement: { outcome: "win", r: risk > 0 ? Math.abs(s.take_profit - s.entry) / risk : 0, hitTime: c.time, hitPrice: s.take_profit }, stop };
    }
    if (opts.lock && (long ? c.high >= lockTrigger : c.low <= lockTrigger)) stop = lockStop;
    // the close of the last candle the trade may be held for
    if (held + 1 >= maxHoldBars) {
      return { settlement: { outcome: "expired", r: risk > 0 ? (dir * (c.close - s.entry)) / risk : 0, hitTime: c.time, hitPrice: c.close }, stop };
    }
    held++;
  }
  return { settlement: null, stop };
}

/** The settlement alone (see followTrade). Without a lock this is a trade with a fixed stop and target. */
export function settleSignal(
  s: SettleInput,
  candles: { time: number; open: number; high: number; low: number; close: number }[],
  maxHoldBars: number = TREND_MAX_HOLD_BARS,
  lock: ProfitLock | null = null
): Settlement | null {
  return followTrade(s, candles, { maxHoldBars, lock }).settlement;
}

/** How a trade followed minute by minute ended. */
export type MinuteExit = "stop" | "lock" | "target" | "time";

/**
 * Follow a trade through 1-MINUTE candles — the same rules as followTrade, with
 * the profit lock as it is really applied: the stop is moved by hand, some time
 * after price has touched the trigger. In each minute candle, in this order:
 * the stop (a gap through it fills at the open), the target, then the touch of
 * the lock trigger, then the time limit — the close of the trade's
 * `maxHoldBars`-th 15-minute candle (a 15-minute candle exists when a minute
 * candle falls in it, so a closed market does not count).
 *
 * When the moved stop is in force:
 *  - `delaySeconds` (the backtest): that long after the START of the minute in
 *    which price first touched the trigger;
 *  - `movedAt` (live, epoch seconds): from then on — the time the "move your
 *    stop" message went out plus the time to act on it. Until a message has
 *    gone out the stop stays where it was, whatever price has touched.
 *
 * `minutes` may end with the candle still forming. `now` (epoch seconds) is
 * needed to close a trade on the clock when no later candle has arrived yet.
 * Returns the settlement, or null while the trade is open; where the stop
 * stands; how the trade ended; and the minute of the first touch of the trigger.
 */
export function followTradeMinutes(
  s: SettleInput,
  minutes: { time: number; open: number; high: number; low: number; close: number }[],
  opts: { lock: ProfitLock; maxHoldBars?: number; delaySeconds?: number; movedAt?: number | null; now?: number }
): { settlement: Settlement | null; stop: number; how: MinuteExit | null; touchedAt: number | null } {
  const maxHoldBars = opts.maxHoldBars ?? TREND_MAX_HOLD_BARS;
  const long = s.direction === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(s.entry - s.stop_loss);
  const lockTrigger = s.entry + dir * opts.lock.at * risk;
  const lockStop = s.entry + dir * opts.lock.to * risk;
  const r = (price: number) => (risk > 0 ? (dir * (price - s.entry)) / risk : 0);
  let stop = s.stop_loss;
  let movedAt = opts.movedAt ?? null;
  let touchedAt: number | null = null;
  let bucket = NaN;
  let bars = 0;
  let prev: (typeof minutes)[number] | null = null;
  for (const c of minutes) {
    if (c.time * 1000 + 60_000 <= s.firedAt) continue;
    const b = Math.floor(c.time / (CANDLE_MS / 1000));
    if (b !== bucket) {
      // a minute of the 15-minute candle after the last one the trade may be held for: it closed at that candle's close
      if (bars >= maxHoldBars && prev) {
        return { settlement: { outcome: "expired", r: r(prev.close), hitTime: bucket * (CANDLE_MS / 1000), hitPrice: prev.close }, stop, how: "time", touchedAt };
      }
      bucket = b;
      bars++;
    }
    if (movedAt != null && c.time >= movedAt && dir * (lockStop - stop) > 0) stop = lockStop;
    if (long ? c.low <= stop : c.high >= stop) {
      const price = long ? Math.min(stop, c.open) : Math.max(stop, c.open);
      return { settlement: { outcome: r(price) > 0 ? "win" : "loss", r: risk > 0 ? r(price) : -1, hitTime: c.time, hitPrice: price }, stop, how: stop === s.stop_loss ? "stop" : "lock", touchedAt };
    }
    if (long ? c.high >= s.take_profit : c.low <= s.take_profit) {
      return { settlement: { outcome: "win", r: risk > 0 ? Math.abs(s.take_profit - s.entry) / risk : 0, hitTime: c.time, hitPrice: s.take_profit }, stop, how: "target", touchedAt };
    }
    if (touchedAt == null && (long ? c.high >= lockTrigger : c.low <= lockTrigger)) {
      touchedAt = c.time;
      if (movedAt == null && opts.delaySeconds != null) movedAt = c.time + opts.delaySeconds;
    }
    prev = c;
  }
  // the last 15-minute candle the trade may be held for has closed and nothing has arrived since
  if (prev && bars >= maxHoldBars && (opts.now ?? prev.time + 60) >= (bucket + 1) * (CANDLE_MS / 1000)) {
    return { settlement: { outcome: "expired", r: r(prev.close), hitTime: bucket * (CANDLE_MS / 1000), hitPrice: prev.close }, stop, how: "time", touchedAt };
  }
  return { settlement: null, stop, how: null, touchedAt };
}

/** A trade of the removed trend systems as stored: a trailing stop a fixed distance behind the best price. */
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
 * Follow a trailing-stop trade through the 15-minute candles since it was last
 * followed: the stop is tested first, then the take-profit, then the stop
 * trails behind the candle's best price. The system no longer sends such
 * trades; one left open by the removed trend systems still ends this way.
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
  strategy: string;
  variant: string | null;
  created_at: string;
  trail_distance: number | null;
  trail_stop: number | null;
  trail_checked_at: string | null;
}

let lastRun = 0;

/**
 * Settles every open signal. A trade of the live rules is followed minute by
 * minute (followTradeMinutes), so that the "move your stop" message goes out
 * as soon as price has touched the lock trigger and the trade is then scored
 * with the stop moved from that message on; anything else, and a live trade
 * whose minute candles cannot be read, is followed on 15-minute candles as
 * before. Throttled so polling the feed doesn't hammer OANDA.
 *
 * `fast` is the one-minute check (/api/watch): only the open trades of the
 * live rules, and nothing is fetched when none is open.
 */
export async function scoreOpenSignals(
  supabase: ReturnType<typeof createAdminClient>,
  opts: { force?: boolean; /** false = do not send the "stop moved" message */ notify?: boolean; fast?: boolean } = {}
): Promise<number> {
  if (!supabase) return 0;
  if (!opts.force && Date.now() - lastRun < 60_000) return 0;
  lastRun = Date.now();

  const { data, error } = await supabase
    .from("signals")
    .select("id, pair, strategy, variant, created_at, direction, entry, stop_loss, take_profit, trail_distance, trail_stop, trail_checked_at")
    .is("outcome", null)
    .gt("stop_loss", 0)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !data?.length) return 0;

  /** a trade of the live rules, which is followed minute by minute */
  const isLive = (r: Row) => r.trail_distance == null && strategyOf(r) === "trend";
  const byPair = new Map<string, Row[]>();
  for (const r of data as Row[]) {
    if (opts.fast && !isLive(r)) continue;
    byPair.set(r.pair, [...(byPair.get(r.pair) ?? []), r]);
  }

  let settled = 0;
  for (const [pair, rows] of byPair) {
    // a trailing trade only needs the candles since it was last followed
    const startOf = (r: Row) => new Date(r.trail_distance != null ? (r.trail_checked_at ?? r.created_at) : r.created_at).getTime();
    // the minute candles of the open live trades, from the open of the oldest one's entry candle
    const live = rows.filter(isLive);
    let minutes: Awaited<ReturnType<typeof fetchCandles>> | null = null;
    let minutesFrom = Infinity;
    if (live.length) {
      minutesFrom = Math.floor(Math.min(...live.map((r) => new Date(r.created_at).getTime())) / CANDLE_MS) * CANDLE_MS;
      try {
        const got = await fetchM1Since(pair, minutesFrom);
        minutes = got.candles;
        minutesFrom = got.from;
      } catch {
        minutes = null;
      }
    }
    /** a live trade can be followed on the minute candles: they reach back to its entry, and its stop was not moved by the older 15-minute rule */
    const byMinute = (r: Row) => isLive(r) && minutes != null && minutesFrom <= new Date(r.created_at).getTime() && !(r.trail_stop != null && r.trail_checked_at == null);
    // the 15-minute candles are only read for a trade that needs them
    let candles: Awaited<ReturnType<typeof fetchCandles>> = [];
    const coarse = rows.filter((r) => !byMinute(r));
    if (coarse.length) {
      try {
        candles = await fetchM15Since(pair, Math.min(...coarse.map(startOf)));
      } catch {
        if (coarse.length === rows.length) continue;
      }
    }
    for (const r of rows) {
      const firedAt = new Date(r.created_at).getTime();
      let res: Settlement | null;
      if (byMinute(r)) {
        // the moved stop counts from the minute the message went out, plus the time to act on it
        const sentAt = r.trail_stop != null && r.trail_checked_at ? Date.parse(r.trail_checked_at) / 1000 : null;
        const followed = followTradeMinutes({ ...r, firedAt }, minutes!, {
          lock: LIVE_LOCK,
          movedAt: sentAt != null ? Math.floor(sentAt / 60) * 60 + TREND_LOCK_ACT_SECONDS : null,
          now: Date.now() / 1000,
        });
        res = followed.settlement;
        // price has touched the lock trigger of a trade that is still open: record it once, and say so at once
        if (!res && followed.touchedAt != null && r.trail_stop == null) {
          const dir = r.direction === "long" ? 1 : -1;
          const lockStop = r.entry + dir * TREND_LOCK_TO_R * Math.abs(r.entry - r.stop_loss);
          const { data: marked } = await supabase.from("signals").update({ trail_stop: lockStop, trail_checked_at: new Date().toISOString() }).eq("id", r.id).is("trail_stop", null).select("id");
          if (marked?.length && opts.notify !== false) {
            await sendStopMoved({ pair: r.pair, direction: r.direction, entry: r.entry, stop: lockStop, takeProfit: r.take_profit, lockedR: TREND_LOCK_TO_R }).catch(() => undefined);
          }
        }
        // stored as the open of the 15-minute candle that closed the trade, as the send rules read it
        if (res?.hitTime != null) res = { ...res, hitTime: Math.floor(res.hitTime / (CANDLE_MS / 1000)) * (CANDLE_MS / 1000) };
      } else if (!candles.length) {
        continue;
      } else if (r.trail_distance != null) {
        const followed = settleTrailing(
          { direction: r.direction, entry: r.entry, stop_loss: r.stop_loss, trail_distance: r.trail_distance, take_profit: r.take_profit, trail_stop: r.trail_stop ?? r.stop_loss, checkedAt: startOf(r) },
          candles
        );
        res = followed.settlement;
        await supabase
          .from("signals")
          .update({ trail_stop: followed.trailStop, ...(res ? {} : { trail_checked_at: new Date(followed.checkedAt).toISOString() }) })
          .eq("id", r.id);
      } else if (strategyOf(r) === "trend") {
        const followed = followTrade({ ...r, firedAt }, candles, { maxHoldBars: TREND_MAX_HOLD_BARS, lock: LIVE_LOCK });
        res = followed.settlement;
        // the profit lock has moved the stop of a trade that is still open: record it once, and say so once
        if (!res && followed.stop !== r.stop_loss && r.trail_stop == null) {
          const { data: marked } = await supabase.from("signals").update({ trail_stop: followed.stop }).eq("id", r.id).is("trail_stop", null).select("id");
          if (marked?.length && opts.notify !== false) {
            await sendStopMoved({ pair: r.pair, direction: r.direction, entry: r.entry, stop: followed.stop, takeProfit: r.take_profit, lockedR: TREND_LOCK_TO_R }).catch(() => undefined);
          }
        }
      } else {
        res = settleSignal({ ...r, firedAt }, candles, LEGACY_MAX_HOLD_BARS);
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

/** A trade of the live rules lasts five hours: minute candles are not read further back than this. */
const MINUTE_REACH_MS = 6 * 24 * 3600 * 1000;

/** 1-minute candles from `fromMs` to now, the forming one included, paged — and where they really start. */
async function fetchM1Since(pair: string, fromMs: number) {
  const PAGE_MS = 3 * 24 * 3600 * 1000;
  const end = Date.now();
  const from = Math.max(fromMs, end - MINUTE_REACH_MS);
  const out: Awaited<ReturnType<typeof fetchCandles>> = [];
  for (let a = from; a < end; a += PAGE_MS) {
    out.push(
      ...(await fetchCandles({
        instrument: pair,
        granularity: "M1",
        from: new Date(a).toISOString(),
        to: new Date(Math.min(end, a + PAGE_MS)).toISOString(),
        includeIncomplete: true,
      }))
    );
  }
  const seen = new Set<number>();
  return { from, candles: out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((x, y) => x.time - y.time) };
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
