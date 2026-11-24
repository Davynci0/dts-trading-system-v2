import type { Candle, Pair, SignalDirection } from "@/lib/types";
import { TREND_KEY_PREFIX, TREND_STRATEGY } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import { EXECUTION_BAR_SECONDS, SCAN_HISTORY } from "@/lib/analysis/execution";
import {
  buildTrendSeries,
  trendStateAt,
  TREND_ADX_MIN,
  TREND_BREAKOUT_BARS,
  TREND_DAYS,
  TREND_FAST_EMA,
  TREND_MIN_CANDLES,
  TREND_RSI_LEVEL,
  TREND_SLOW_EMA,
  TREND_STOP_ATR,
  TREND_TARGET_R,
  TREND_TRAIL_ATR,
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

/** Share of the account one trade risks. One trade is open at a time and the
 *  backtest's worst losing run was 12 trades — the default is 1%. Override
 *  with RISK_PCT (e.g. 0.005 for half a percent); the older name FIB_RISK_PCT
 *  is still read. */
export const RISK_PCT = (() => {
  const raw = Number(process.env.RISK_PCT ?? process.env.FIB_RISK_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 0.05 ? raw : 0.01;
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

/** The closed candles the system reads — 1-hour and daily for the entries, 15-minute for the chart — optionally as they stood at `to`. */
export async function fetchScanCandles(pair: string, to?: string, m15Count: number = SCAN_HISTORY.m15): Promise<{ m15: Candle[]; h1: Candle[]; daily: Candle[] }> {
  const [m15, h1, daily] = await Promise.all([
    fetchCandles({ instrument: pair, granularity: "M15", count: m15Count, to }),
    fetchCandles({ instrument: pair, granularity: "H1", count: SCAN_HISTORY.h1, to }),
    fetchCandles({ instrument: pair, granularity: "D", count: SCAN_HISTORY.daily, to }),
  ]);
  return { m15, h1, daily };
}

/** An earlier trend signal, as far as the send rules need it. */
export interface EarlierSignal {
  variant: string | null;
  direction: SignalDirection;
  status: string;
  outcome: string | null;
}

/**
 * Why a new trade may not be sent, or null when it may:
 *  - a trade is already open (one at a time — so never a buy and a sell together);
 *  - this signal candle has already been traded.
 */
export function sendBlock(earlier: EarlierSignal[], trade: { key: string }): string | null {
  const open = earlier.find((r) => r.status === "active" && r.outcome == null);
  if (open) return `a ${open.direction === "long" ? "buy" : "sell"} is already open — one trade at a time`;
  if (earlier.some((r) => r.variant === trade.key)) return "this signal has already been sent";
  return null;
}

/**
 * One scan: settle the open trades, then read the last closed 1-hour candle of
 * each pair (the trend entries, lib/analysis/trend.ts). A candle that completes
 * every condition of an entry is stored and sent to Telegram — unless the send
 * rules above forbid it or the candle closed too long ago to enter at its
 * price.
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
    const push = (kind: ScanEvent["kind"], detail: string) => events.push({ pair, timeframe: "H1", strategy: TREND_STRATEGY, kind, detail });

    let data: Awaited<ReturnType<typeof fetchScanCandles>>;
    try {
      data = await fetchScanCandles(pair);
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
      continue;
    }

    /** Checks the send rules, records the trade, and returns true when it may be announced. */
    const record = async (setup: { key: string; direction: SignalDirection; time: number }, row: Record<string, unknown>): Promise<boolean> => {
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
        .select("variant, direction, status, outcome")
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

    // ── the trend entries, on the last closed 1-hour candle ──
    try {
      if (data.h1.length <= TREND_MIN_CANDLES) {
        push("error", "not enough 1-hour candles returned");
        continue;
      }
      const series = buildTrendSeries(data);
      const i = series.n - 1;
      const state = trendStateAt(series, i, pair);
      const setup = state.setup;
      if (!setup) continue;
      const up = setup.direction === "long";
      const level = up ? series.channelHigh[i] : series.channelLow[i];
      const parts: string[] = [];
      if (setup.trigger !== "RSI pullback") parts.push(`a 1-hour close ${up ? "above" : "below"} the ${TREND_BREAKOUT_BARS}-candle ${up ? "high" : "low"} (${level.toFixed(2)})`);
      if (setup.trigger !== "breakout") parts.push(`RSI back ${up ? "above" : "below"} ${TREND_RSI_LEVEL} after a pullback (${series.rsi[i - 1].toFixed(0)} → ${series.rsi[i].toFixed(0)})`);
      const why = parts.join(", and ");
      const recorded = await record(setup, {
        entry: setup.entry,
        stop_loss: setup.stopLoss,
        take_profit: setup.takeProfit,
        r_multiple: TREND_TARGET_R,
        trail_distance: setup.trailDistance,
        trail_stop: setup.stopLoss,
        trail_checked_at: new Date(now).toISOString(),
        sl_basis: `${TREND_STOP_ATR} × the 1-hour ATR (${setup.atr.toFixed(2)}), then trailing ${TREND_TRAIL_ATR} × ATR behind the best price`,
        tp_basis: `${TREND_TARGET_R} × the risk`,
        confidence: state.checks.filter((c) => c.met).length,
        confirmations: { ...Object.fromEntries(state.checks.map((c) => [c.label, c.met])), [`Entry: ${setup.trigger}`]: true },
      });
      if (!recorded) continue;
      if (sendTelegrams) {
        await sendTrendSignal({
          pair,
          direction: setup.direction,
          entry: setup.entry,
          stopLoss: setup.stopLoss,
          takeProfit: setup.takeProfit,
          trailDistance: setup.trailDistance,
          trigger: setup.trigger,
          why,
          adx: state.adx,
          stopAtr: TREND_STOP_ATR,
          trailAtr: TREND_TRAIL_ATR,
          targetR: TREND_TARGET_R,
          trendDays: TREND_DAYS,
          fastEma: TREND_FAST_EMA,
          slowEma: TREND_SLOW_EMA,
          accountBalance,
          riskPct: RISK_PCT,
        }).catch((e) => push("error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
      }
      push("signal", `${up ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)}, trailing ${setup.trailDistance.toFixed(2)} — ${setup.trigger} (ADX ${state.adx?.toFixed(0) ?? "?"}, needs ${TREND_ADX_MIN})`);
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }
  }

  return { scannedAt: new Date(now).toISOString(), units, events };
}
