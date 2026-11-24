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
  reentryBlock,
  type LastEntry,
} from "@/lib/analysis/trend";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { sendTrendSignal } from "@/lib/telegram";
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

/** A signal is entered at the close of its candle. A scan that runs later than
 *  this many minutes after that close (a missed run, the weekend) must not send
 *  a trade at a price that is no longer there. The scheduler runs every 15
 *  minutes at whatever second it likes, so the limit is one 15-minute candle
 *  plus five minutes of slack: every closed candle is read by at least one
 *  scan, and the one-trade-per-candle rule keeps a second scan from sending it
 *  twice. Override with MAX_ENTRY_AGE_MIN. */
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

/** An earlier signal of the system, as far as the send rules need it. */
export interface EarlierSignal {
  variant: string | null;
  direction: SignalDirection;
  status: string;
  outcome: string | null;
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

/**
 * Why a new trade may not be sent, or null when it may:
 *  - this signal candle has already been traded;
 *  - a trade is already open — the system holds one at a time;
 *  - it would duplicate the last trade: the same side, within an hour of its
 *    entry and within 1R of its price (reentryBlock).
 */
export function sendBlock(earlier: EarlierSignal[], trade: { key: string; direction: SignalDirection; time: number; entry: number }): string | null {
  if (earlier.some((r) => r.variant === trade.key)) return "this signal has already been sent";
  const open = earlier.filter((r) => r.status === "active" && r.outcome == null);
  if (open.length >= TREND_MAX_OPEN) return `a ${open[0].direction === "long" ? "buy" : "sell"} is already open — one trade at a time`;
  return reentryBlock(lastEntryOf(earlier), trade);
}

/**
 * One scan: settle the open trades, then read the last closed 15-minute candle
 * of each pair (lib/analysis/trend.ts). A candle that completes an entry is
 * stored and sent to Telegram — unless the send rules above forbid it or the
 * candle closed too long ago to enter at its price.
 */
export async function runScan(opts: { pairs: Pair[]; accountBalance?: number; sendTelegrams?: boolean; now?: number }): Promise<ScanSummary> {
  const { pairs, accountBalance = ACCOUNT_BALANCE, sendTelegrams = true } = opts;
  const now = opts.now ?? Date.now();
  const supabase = createAdminClient();
  const events: ScanEvent[] = [];
  let units = 0;

  // a trade that reached its stop or target since the last scan is closed first,
  // so it does not block the next one
  await scoreOpenSignals(supabase, { force: true }).catch(() => 0);

  for (const pair of pairs) {
    units++;
    const push = (kind: ScanEvent["kind"], detail: string) => events.push({ pair, timeframe: EXECUTION_TIMEFRAME, strategy: TREND_STRATEGY, kind, detail });

    let data: Awaited<ReturnType<typeof fetchScanCandles>>;
    try {
      data = await fetchScanCandles(pair);
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
      continue;
    }

    /** Checks the send rules, records the trade, and returns true when it may be announced. */
    const record = async (setup: { key: string; direction: SignalDirection; time: number; entry: number }, row: Record<string, unknown>): Promise<boolean> => {
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
        .select("variant, direction, status, outcome, entry, stop_loss")
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
      const block = sendBlock((rows ?? []) as EarlierSignal[], setup);
      if (block) {
        push("skipped", block);
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
      const i = series.n - 1;
      const state = trendStateAt(series, i, pair);
      const setup = state.setup;
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
      const recorded = await record(setup, {
        entry: setup.entry,
        stop_loss: setup.stopLoss,
        take_profit: setup.takeProfit,
        r_multiple: TREND_TARGET_R,
        sl_basis: stopWhy,
        tp_basis: `${TREND_TARGET_R} × the risk; the stop moves to +${TREND_LOCK_TO_R}R once price reaches +${TREND_LOCK_AT_R}R (${setup.lockTrigger.toFixed(2)}); closed at market after ${holdHours} hours if neither is hit`,
        confidence: state.checks.filter((x) => x.met).length,
        confirmations: { ...Object.fromEntries(state.checks.map((x) => [x.label, x.met])), [`Entry: ${setup.trigger}`]: true },
      });
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
        }).catch((e) => push("error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
      }
      push("signal", `${up ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)} (${TREND_TARGET_R}R) — ${setup.trigger}`);
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }
  }

  return { scannedAt: new Date(now).toISOString(), units, events };
}
