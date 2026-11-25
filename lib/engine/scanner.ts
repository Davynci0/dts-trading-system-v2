import type { Candle, Pair, SignalDirection } from "@/lib/types";
import { TREND_KEY_PREFIX, TREND_STRATEGY } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import { EXECUTION_BAR_SECONDS, EXECUTION_TIMEFRAME, SCAN_HISTORY } from "@/lib/analysis/execution";
import {
  buildTrendSeries,
  trendStateAt,
  TREND_DAYS,
  TREND_LOCK_AT_R,
  TREND_LOCK_TO_R,
  TREND_MAX_HOLD_BARS,
  TREND_MAX_OPEN,
  TREND_MAX_RISK_ATR,
  TREND_MIN_CANDLES,
  TREND_MIN_H1_CANDLES,
  TREND_MIN_RISK_ATR,
  TREND_TARGET_R,
  lateEntry,
  reentryBlock,
  type LastEntry,
  type TrendSetup,
} from "@/lib/analysis/trend";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { sendToriAlert, sendTrendSignal } from "@/lib/telegram";
import { toriRead, TORI_HISTORY, TORI_TIMEFRAME } from "@/lib/analysis/tori";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ScanEvent {
  pair: string;
  timeframe: string;
  strategy: string;
  kind: "watching" | "signal" | "skipped" | "error";
  detail: string;
}

export interface ScanSummary {
  scannedAt: string;
  units: number;
  events: ScanEvent[];
}

/** Share of the account one trade risks. One trade is open at a time; the
 *  five-year backtest's worst drawdown was 27 times the risk of one trade and
 *  its longest losing run 7 trades, so the default is half a percent.
 *  Override with RISK_PCT (e.g. 0.01 for one percent); the older name
 *  FIB_RISK_PCT is still read. */
export const RISK_PCT = (() => {
  const raw = Number(process.env.RISK_PCT ?? process.env.FIB_RISK_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 0.05 ? raw : 0.005;
})();

/** Account size the position size in a signal is worked out from. Override with ACCOUNT_BALANCE. */
export const ACCOUNT_BALANCE = (() => {
  const raw = Number(process.env.ACCOUNT_BALANCE);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();

/** A Tori alert is only sent within this many minutes of its 4-hour candle's close. */
const TORI_ALERT_MAX_AGE_MIN = 30;

/** A signal is entered at the close of its candle. A scan that runs later than
 *  this many minutes after that close (missed runs, the weekend) must not send
 *  a trade at a price that is no longer there. The limit is one 15-minute
 *  candle plus five minutes: each scan also reads the candle before the newest
 *  one, so a signal is still recovered when ONE scan did not run, and the
 *  one-trade-per-candle rule keeps it from being sent twice. Override with
 *  MAX_ENTRY_AGE_MIN. */
const MAX_ENTRY_AGE_MIN = Math.max(5, Number(process.env.MAX_ENTRY_AGE_MIN ?? EXECUTION_BAR_SECONDS / 60 + 5));

/** The closed candles the system reads — 15-minute for the entries and the chart, 1-hour and daily for the trend — optionally as they stood at `to`. */
export async function fetchScanCandles(pair: string, to?: string, m15Count: number = SCAN_HISTORY.m15): Promise<{ m15: Candle[]; h1: Candle[]; daily: Candle[] }> {
  const [m15, h1, daily] = await Promise.all([
    fetchCandles({ instrument: pair, granularity: "M15", count: m15Count, to }),
    fetchCandles({ instrument: pair, granularity: "H1", count: SCAN_HISTORY.h1, to }),
    fetchCandles({ instrument: pair, granularity: "D", count: SCAN_HISTORY.daily, to }),
  ]);
  return { m15, h1, daily };
}

/** How often, and how long apart, a scan asks again when the candle that has just closed is not there yet. */
const CANDLE_RETRIES = 2;
const CANDLE_RETRY_MS = 4000;

/**
 * The scan's candles. A scan runs seconds after a candle closes, and the data
 * feed may not have marked that candle complete yet: when the newest candle is
 * exactly one behind, ask again instead of reading the old one.
 */
async function fetchFreshCandles(pair: string, now: number): Promise<{ data: Awaited<ReturnType<typeof fetchScanCandles>>; retries: number }> {
  const expected = Math.floor(now / 1000 / EXECUTION_BAR_SECONDS) * EXECUTION_BAR_SECONDS - EXECUTION_BAR_SECONDS;
  for (let retries = 0; ; retries++) {
    const data = await fetchScanCandles(pair);
    const last = data.m15[data.m15.length - 1]?.time ?? 0;
    if (last !== expected - EXECUTION_BAR_SECONDS || retries >= CANDLE_RETRIES) return { data, retries };
    await new Promise((resolve) => setTimeout(resolve, CANDLE_RETRY_MS));
  }
}

/** Scan results are kept for a week: one row per 15-minute slot of the week, overwritten the week after. */
const SCAN_LOG_SLOTS = 7 * 24 * 4;

/** The key of a scan's row in market_state. */
export function scanLogKey(now: number, source: "schedule" | "manual"): string {
  return `scan:${source}:${Math.floor(now / (EXECUTION_BAR_SECONDS * 1000)) % SCAN_LOG_SLOTS}`;
}

/** An earlier signal of the system, as far as the send rules need it. */
export interface EarlierSignal {
  variant: string | null;
  direction: SignalDirection;
  status: string;
  outcome: string | null;
  /** open time of the candle that closed the trade */
  outcome_at?: string | null;
  entry: number;
  stop_loss: number;
}

/** The close of a signal's candle (epoch seconds), read from its key "trend:<candle open>", or null for a row of another system. */
function keyTime(variant: string | null): number | null {
  if (!variant?.startsWith(TREND_KEY_PREFIX)) return null;
  const open = Number(variant.slice(TREND_KEY_PREFIX.length));
  return Number.isFinite(open) ? open + EXECUTION_BAR_SECONDS : null;
}

/** The most recent trade of this system among `earlier`, as the re-entry rule needs it. */
export function lastEntryOf(earlier: EarlierSignal[]): LastEntry | null {
  let last: LastEntry | null = null;
  for (const r of earlier) {
    const time = keyTime(r.variant);
    if (time == null || (last && time <= last.time)) continue;
    last = { direction: r.direction, time, entry: Number(r.entry), risk: Math.abs(Number(r.entry) - Number(r.stop_loss)) };
  }
  return last;
}

const ALREADY_SENT = "this signal has already been sent";

/**
 * Why a new trade may not be sent, or null when it may:
 *  - this signal candle has already been traded;
 *  - a trade is already open — the system holds one at a time;
 *  - it would duplicate the last trade: the same side, within an hour of its
 *    entry and within 1R of its price (reentryBlock).
 *
 * `late` = the signal belongs to an earlier candle whose scan did not run. The
 * rules are then applied as they stood when THAT candle closed — a trade that
 * was open then still blocks it, though it has closed since — and nothing is
 * sent once a newer signal has been.
 */
export function sendBlock(earlier: EarlierSignal[], trade: { key: string; direction: SignalDirection; time: number; entry: number }, late = false): string | null {
  if (earlier.some((r) => r.variant === trade.key)) return ALREADY_SENT;
  if (late) {
    if (earlier.some((r) => (keyTime(r.variant) ?? 0) > trade.time)) return "a newer signal has already been sent";
    const candleOpen = trade.time - EXECUTION_BAR_SECONDS;
    const wasOpen = earlier.find((r) => {
      const t = keyTime(r.variant);
      if (t == null || t > trade.time) return false;
      if (r.outcome == null) return r.status === "active";
      return r.outcome_at != null && Date.parse(r.outcome_at) / 1000 > candleOpen;
    });
    if (wasOpen) return `a ${wasOpen.direction === "long" ? "buy" : "sell"} was open when that candle closed — one trade at a time`;
  }
  const open = earlier.filter((r) => r.status === "active" && r.outcome == null);
  if (open.length >= TREND_MAX_OPEN) return `a ${open[0].direction === "long" ? "buy" : "sell"} is already open — one trade at a time`;
  return reentryBlock(lastEntryOf(earlier), trade);
}

/**
 * One scan: settle the open trades, then read the last closed 15-minute candle
 * of each pair (lib/analysis/trend.ts) — and the one before it, in case the
 * scan that should have read it did not run. A candle that completes an entry
 * is stored and sent to Telegram — unless the send rules above forbid it or the
 * candle closed too long ago. Every scan leaves a row in market_state, written
 * when it starts and again when it is done, so one that did not run or failed
 * can be seen afterwards.
 */
export async function runScan(opts: { pairs: Pair[]; accountBalance?: number; sendTelegrams?: boolean; now?: number; source?: "schedule" | "manual" }): Promise<ScanSummary> {
  const { pairs, accountBalance = ACCOUNT_BALANCE, sendTelegrams = true, source = "manual" } = opts;
  const now = opts.now ?? Date.now();
  const supabase = createAdminClient();
  const events: ScanEvent[] = [];
  let units = 0;
  const lastCandle: Record<string, string> = {};
  // the log never gets in the way of a signal
  const log = async (status: "started" | "done") => {
    if (!supabase) return;
    await supabase
      .from("market_state")
      .upsert(
        { pair: "ALL", timeframe: EXECUTION_TIMEFRAME, kind: "setup", dedupe_key: scanLogKey(now, source), updated_at: new Date().toISOString(), payload: { at: new Date(now).toISOString(), status, lastCandle, events } },
        { onConflict: "pair,timeframe,kind,dedupe_key" }
      )
      .then(undefined, () => undefined);
  };
  await log("started");

  // a trade that reached its stop or target since the last scan is closed first,
  // so it does not block the next one
  await scoreOpenSignals(supabase, { force: true }).catch((e) => {
    events.push({ pair: "ALL", timeframe: EXECUTION_TIMEFRAME, strategy: TREND_STRATEGY, kind: "error", detail: `open trades could not be settled: ${(e as Error).message.slice(0, 120)}` });
    return 0;
  });

  for (const pair of pairs) {
    units++;
    const push = (kind: ScanEvent["kind"], detail: string) => events.push({ pair, timeframe: EXECUTION_TIMEFRAME, strategy: TREND_STRATEGY, kind, detail });

    let data: Awaited<ReturnType<typeof fetchScanCandles>>;
    try {
      const fresh = await fetchFreshCandles(pair, now);
      data = fresh.data;
      const last = data.m15[data.m15.length - 1];
      if (last) lastCandle[pair] = `${new Date((last.time + EXECUTION_BAR_SECONDS) * 1000).toISOString()}${fresh.retries ? ` (asked ${fresh.retries + 1} times)` : ""}`;
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
      continue;
    }

    // Tori Trades' trendlines on the 4-hour chart: an alert, once per setup. It never touches the
    // signals table, so it neither counts as the open trade nor blocks one. Only her main setup — the
    // break of a 3-touch line, about three a month on gold — goes to Telegram; bounces (about two a
    // week) are shown on the dashboard only.
    try {
      const ev = toriRead(await fetchCandles({ instrument: pair, granularity: TORI_TIMEFRAME, count: TORI_HISTORY })).event;
      if (ev && ev.type === "break") {
        const ageMin = (now / 1000 - ev.time) / 60;
        // a setup whose candle closed a while ago has been alerted already, or is too late to act on
        if (ageMin <= TORI_ALERT_MAX_AGE_MIN && supabase) {
          // the unique (pair, timeframe, kind, dedupe_key) row is the record that this setup was alerted
          const { error: dupe } = await supabase
            .from("market_state")
            .insert({ pair, timeframe: TORI_TIMEFRAME, kind: "trendline", dedupe_key: ev.key, payload: { type: ev.type, direction: ev.direction, kind: ev.line.kind, touches: ev.line.touches, close: ev.close, stop: ev.stop, time: ev.time } });
          if (!dupe) {
            if (sendTelegrams) await sendToriAlert({ pair, type: ev.type, direction: ev.direction, kind: ev.line.kind, touches: ev.line.touches, close: ev.close, stop: ev.stop, safety: ev.safety }).catch((e) => push("error", `Tori alert recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
            push("watching", `Tori ${ev.type} alert: ${ev.direction === "long" ? "buy" : "sell"} idea, ${ev.line.touches}-touch ${ev.line.kind} line, close ${ev.close.toFixed(2)}`);
          }
        }
      }
    } catch (e) {
      push("error", `Tori trendlines: ${(e as Error).message.slice(0, 120)}`);
    }

    /** Checks the send rules, records the trade, and returns true when it may be announced. */
    const record = async (setup: { key: string; direction: SignalDirection; time: number; entry: number }, row: Record<string, unknown>, late: boolean): Promise<boolean> => {
      const ageMin = (now / 1000 - setup.time) / 60;
      if (ageMin > MAX_ENTRY_AGE_MIN) {
        push("skipped", `signal candle closed ${Math.round(ageMin)} min ago — too late to enter (limit ${MAX_ENTRY_AGE_MIN} min)`);
        return false;
      }
      if (!supabase) {
        // without the database there is no way to know what is already open or already sent
        push("skipped", "a setup was found but the database is unavailable — nothing sent");
        return false;
      }
      const { data: rows, error } = await supabase
        .from("signals")
        .select("variant, direction, status, outcome, outcome_at, entry, stop_loss")
        .eq("pair", pair)
        .eq("strategy", TREND_STRATEGY)
        // only this system's rows — the removed 30-minute system stored its trades under the same name
        .like("variant", `${TREND_KEY_PREFIX}%`)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) {
        push("skipped", `a setup was found but earlier signals could not be read: ${error.message}`);
        return false;
      }
      const block = sendBlock((rows ?? []) as EarlierSignal[], setup, late);
      if (block) {
        // the candle before the newest one is read on every scan; its signal having been sent on time is not news
        if (!(late && block === ALREADY_SENT)) push("skipped", late ? `the candle before: ${block}` : block);
        return false;
      }
      const { error: insertError } = await supabase.from("signals").insert({ pair, direction: setup.direction, strategy: TREND_STRATEGY, variant: setup.key, status: "active", ...row });
      if (insertError) {
        push("skipped", `the trade could not be recorded (${insertError.message}) — not sent`);
        return false;
      }
      return true;
    };

    try {
      if (data.m15.length <= TREND_MIN_CANDLES || data.h1.length <= TREND_MIN_H1_CANDLES) {
        push("error", "not enough candles returned");
        continue;
      }
      const series = buildTrendSeries(data);
      const newest = series.n - 1;
      // the candle before the newest first: a signal its own scan did not send is recovered while it is young enough
      for (const i of [newest - 1, newest]) {
      const late = i < newest;
      if (late && series.candles[newest].time - series.candles[i].time !== EXECUTION_BAR_SECONDS) continue;
      const state = trendStateAt(series, i, pair);
      const signal = state.setup;
      if (!signal) continue;
      if (late && (now / 1000 - signal.time) / 60 > MAX_ENTRY_AGE_MIN) continue;
      const setup: TrendSetup | null = late ? lateEntry(signal, series.candles.slice(i + 1), pair) : signal;
      if (!setup) continue;
      const up = setup.direction === "long";
      const c = series.candles[i];
      const hoursOf = (bars: number) => (bars * EXECUTION_BAR_SECONDS) / 3600;
      const why =
        setup.trigger === "break of structure"
          ? `the pullback ended — a 15-minute close ${up ? "above the last swing high" : "below the last swing low"}`
          : [
              setup.breakoutBars != null ? `a 15-minute close ${up ? "above" : "below"} the ${up ? "high" : "low"} of the last ${hoursOf(setup.breakoutBars)} hours` : null,
              setup.trigger !== "breakout" ? `a ${up ? "rising" : "falling"} candle ${((c.high - c.low) / setup.atr).toFixed(1)} ATR long` : null,
            ]
              .filter(Boolean)
              .join(", and ");
      // where the stop comes from, in words
      const swingName = `the ${up ? "low" : "high"} of the last two candles (${setup.swing.toFixed(2)})`;
      const stopWhy =
        setup.stopBasis === "zone" && setup.zone
          ? `just beyond the ${up ? "support" : "resistance"} zone at ${setup.zone.low.toFixed(2)}–${setup.zone.high.toFixed(2)} (${setup.zone.touches} touches on the 1-hour chart)`
          : setup.stopBasis === "swing"
          ? `just beyond ${swingName}`
          : setup.stopBasis === "nearest"
            ? `${TREND_MIN_RISK_ATR} ATR away — ${swingName} is closer than that`
            : `${TREND_MAX_RISK_ATR} ATR away — ${swingName} is further than that`;
      const holdHours = hoursOf(TREND_MAX_HOLD_BARS);
      // the send rules are applied to the signal itself; what is stored and sent is the trade as it can be entered now
      const recorded = await record(signal, {
        entry: setup.entry,
        stop_loss: setup.stopLoss,
        take_profit: setup.takeProfit,
        r_multiple: TREND_TARGET_R,
        sl_basis: stopWhy,
        tp_basis: `${TREND_TARGET_R} × the risk; the stop moves to +${TREND_LOCK_TO_R}R once price reaches +${TREND_LOCK_AT_R}R (${setup.lockTrigger.toFixed(2)}); closed at market after ${holdHours} hours if neither is hit`,
        confidence: state.checks.filter((x) => x.met).length,
        confirmations: { ...Object.fromEntries(state.checks.map((x) => [x.label, x.met])), [`Entry: ${setup.trigger}`]: true },
      }, late);
      if (!recorded) continue;
      if (sendTelegrams) {
        await sendTrendSignal({
          pair,
          direction: setup.direction,
          entry: setup.entry,
          stopLoss: setup.stopLoss,
          takeProfit: setup.takeProfit,
          trigger: setup.trigger,
          why,
          stopWhy,
          targetR: TREND_TARGET_R,
          lockTrigger: setup.lockTrigger,
          lockStop: setup.lockStop,
          lockAtR: TREND_LOCK_AT_R,
          lockToR: TREND_LOCK_TO_R,
          holdHours,
          trendDays: TREND_DAYS,
          accountBalance,
          riskPct: RISK_PCT,
          lateMinutes: late ? Math.round((now / 1000 - signal.time) / 60) : undefined,
        }).catch((e) => push("error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
      }
      push("signal", `${late ? "recovered late: " : ""}${up ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)} (${TREND_TARGET_R}R) — ${setup.trigger}`);
      }
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }
  }

  await log("done");
  return { scannedAt: new Date(now).toISOString(), units, events };
}
