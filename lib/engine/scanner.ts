import type { Candle, Pair, SignalDirection } from "@/lib/types";
import { FIB_STRATEGY, LIVE_STRATEGIES, TREND_STRATEGY } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import { EXECUTION_BAR_SECONDS, EXECUTION_TIMEFRAME, FIB_HISTORY } from "@/lib/analysis/execution";
import { buildFibSeries, fibStateAt, FIB_MAX_HOLD_BARS, FIB_TARGET_EXTENSION, FIB_TREND_DAYS } from "@/lib/analysis/fibonacci";
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
import { sendFibSignal, sendTrendSignal } from "@/lib/telegram";
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

/** Share of the account one trade risks. Each strategy holds one trade at a
 *  time, so at most two are open, and the backtest's worst losing run was 12
 *  trades — the default is 1%. Override with RISK_PCT (e.g. 0.005 for half a
 *  percent); FIB_RISK_PCT is still read. */
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
 *  scan, and the one-trade-per-swing / one-trade-per-candle rules keep a second
 *  scan from sending it twice. Override with MAX_ENTRY_AGE_MIN. */
const MAX_ENTRY_AGE_MIN = Math.max(5, Number(process.env.MAX_ENTRY_AGE_MIN ?? EXECUTION_BAR_SECONDS / 60 + 5));

/** The closed candles of the four timeframes the system reads, optionally as they stood at `to`. */
export async function fetchFibCandles(pair: string, to?: string, m15Count: number = FIB_HISTORY.m15): Promise<{ m15: Candle[]; h1: Candle[]; h4: Candle[]; daily: Candle[] }> {
  const [m15, h1, h4, daily] = await Promise.all([
    fetchCandles({ instrument: pair, granularity: "M15", count: m15Count, to }),
    fetchCandles({ instrument: pair, granularity: "H1", count: FIB_HISTORY.h1, to }),
    fetchCandles({ instrument: pair, granularity: "H4", count: FIB_HISTORY.h4, to }),
    fetchCandles({ instrument: pair, granularity: "D", count: FIB_HISTORY.daily, to }),
  ]);
  return { m15, h1, h4, daily };
}

/** An earlier signal of one of the live strategies, as far as the send rules need it. */
export interface EarlierSignal {
  strategy: string;
  variant: string | null;
  direction: SignalDirection;
  status: string;
  outcome: string | null;
}

/**
 * Why a new trade may not be sent, or null when it may:
 *  - the strategy already has a trade open (each holds one at a time);
 *  - this swing / this signal candle has already been traded;
 *  - the other strategy holds a trade the other way — never a buy and a sell at once.
 */
export function sendBlock(earlier: EarlierSignal[], trade: { strategy: string; key: string; direction: SignalDirection }): string | null {
  const open = earlier.filter((r) => r.status === "active" && r.outcome == null);
  const name = trade.strategy === FIB_STRATEGY ? "Fibonacci" : "trend";
  if (open.some((r) => r.strategy === trade.strategy)) return `a ${name} trade is already open — one at a time`;
  if (earlier.some((r) => r.strategy === trade.strategy && r.variant === trade.key)) {
    return trade.strategy === FIB_STRATEGY ? "this swing has already been traded — one trade per swing" : "this signal has already been sent";
  }
  if (open.some((r) => r.direction !== trade.direction)) {
    return `a ${trade.direction === "long" ? "sell" : "buy"} is still open — never a buy and a sell at the same time`;
  }
  return null;
}

/**
 * One scan: settle the open trades, then read the last closed 15-minute candle
 * (the Fibonacci entry, lib/analysis/fibonacci.ts) and the last closed 1-hour
 * candle (the trend entries, lib/analysis/trend.ts) of each pair. A candle
 * that completes every condition of its entry is stored and sent to Telegram —
 * unless the send rules above forbid it or the candle closed too long ago to
 * enter at its price.
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
    const push = (strategy: string, kind: ScanEvent["kind"], detail: string) =>
      events.push({ pair, timeframe: strategy === TREND_STRATEGY ? "H1" : EXECUTION_TIMEFRAME, strategy, kind, detail });

    let data: Awaited<ReturnType<typeof fetchFibCandles>>;
    try {
      data = await fetchFibCandles(pair);
    } catch (e) {
      push(FIB_STRATEGY, "error", (e as Error).message.slice(0, 160));
      continue;
    }

    // earlier signals are only read when there is something to send, and once per pair
    let earlier: EarlierSignal[] | null = null;
    /** Checks the send rules, records the trade, and returns true when it may be announced. */
    const record = async (strategy: string, setup: { key: string; direction: SignalDirection; time: number }, row: Record<string, unknown>): Promise<boolean> => {
      const ageMin = (now / 1000 - setup.time) / 60;
      if (ageMin > MAX_ENTRY_AGE_MIN) {
        push(strategy, "skipped", `signal candle closed ${Math.round(ageMin)} min ago — too late to enter (limit ${MAX_ENTRY_AGE_MIN} min)`);
        return false;
      }
      if (!supabase) {
        // without the database there is no way to know what is already open or already sent
        push(strategy, "skipped", "a setup was found but the database is unavailable — nothing sent");
        return false;
      }
      if (!earlier) {
        const { data: rows, error } = await supabase
          .from("signals")
          .select("strategy, variant, direction, status, outcome")
          .eq("pair", pair)
          .in("strategy", [...LIVE_STRATEGIES])
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) {
          push(strategy, "skipped", `a setup was found but earlier signals could not be read: ${error.message}`);
          return false;
        }
        earlier = (rows ?? []) as EarlierSignal[];
      }
      const block = sendBlock(earlier, { strategy, key: setup.key, direction: setup.direction });
      if (block) {
        push(strategy, "skipped", block);
        return false;
      }
      const { error: insertError } = await supabase.from("signals").insert({ pair, direction: setup.direction, strategy, variant: setup.key, status: "active", ...row });
      if (insertError) {
        push(strategy, "skipped", `the trade could not be recorded (${insertError.message}) — not sent`);
        return false;
      }
      earlier.unshift({ strategy, variant: setup.key, direction: setup.direction, status: "active", outcome: null });
      return true;
    };

    // ── the Fibonacci retracement, on the last closed 15-minute candle ──
    try {
      if (data.m15.length < 60) {
        push(FIB_STRATEGY, "error", "not enough 15-minute candles returned");
      } else {
        const series = buildFibSeries(data);
        const state = fibStateAt(series, series.n - 1, pair);
        const setup = state.setup;
        if (!setup) {
          const waiting = state.checks.filter((c) => c.met).length;
          if (!state.blocked && waiting >= 4) push(FIB_STRATEGY, "watching", "price is in the zone — waiting for a 15-minute rejection candle");
        } else if (
          await record(FIB_STRATEGY, { key: setup.leg.key, direction: setup.direction, time: setup.time }, {
            entry: setup.entry,
            stop_loss: setup.stopLoss,
            take_profit: setup.takeProfit,
            r_multiple: setup.rr,
            sl_basis: `beyond the start of the 1-hour swing (${setup.leg.origin.price.toFixed(2)})`,
            tp_basis: `the ${((1 + FIB_TARGET_EXTENSION) * 100).toFixed(1)}% extension of the swing`,
            confidence: state.checks.filter((c) => c.met).length,
            confirmations: Object.fromEntries(state.checks.map((c) => [c.label, c.met])),
          })
        ) {
          if (sendTelegrams) {
            await sendFibSignal({
              pair,
              direction: setup.direction,
              entry: setup.entry,
              stopLoss: setup.stopLoss,
              takeProfit: setup.takeProfit,
              rr: setup.rr,
              trigger: setup.trigger,
              retracement: setup.retracement,
              legFrom: setup.leg.origin.price,
              legTo: setup.leg.end.price,
              legAtr: state.legAtr,
              trendDays: FIB_TREND_DAYS,
              holdDays: Math.round((FIB_MAX_HOLD_BARS * EXECUTION_BAR_SECONDS) / 86400),
              accountBalance,
              riskPct: RISK_PCT,
            }).catch((e) => push(FIB_STRATEGY, "error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
          }
          push(FIB_STRATEGY, "signal", `${setup.direction === "long" ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)} (${setup.rr.toFixed(1)}R) — ${setup.trigger} in the zone`);
        }
      }
    } catch (e) {
      push(FIB_STRATEGY, "error", (e as Error).message.slice(0, 160));
    }

    // ── the trend entries, on the last closed 1-hour candle ──
    try {
      if (data.h1.length <= TREND_MIN_CANDLES) {
        push(TREND_STRATEGY, "error", "not enough 1-hour candles returned");
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
      const recorded = await record(TREND_STRATEGY, setup, {
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
        }).catch((e) => push(TREND_STRATEGY, "error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
      }
      push(TREND_STRATEGY, "signal", `${up ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)}, trailing ${setup.trailDistance.toFixed(2)} — ${setup.trigger} (ADX ${state.adx?.toFixed(0) ?? "?"}, needs ${TREND_ADX_MIN})`);
    } catch (e) {
      push(TREND_STRATEGY, "error", (e as Error).message.slice(0, 160));
    }
  }

  return { scannedAt: new Date(now).toISOString(), units, events };
}
