import type { Candle, Pair } from "@/lib/types";
import { FIB_STRATEGY } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import { EXECUTION_BAR_SECONDS, EXECUTION_TIMEFRAME, FIB_HISTORY } from "@/lib/analysis/execution";
import { buildFibSeries, fibStateAt, FIB_MAX_HOLD_BARS, FIB_TARGET_EXTENSION, FIB_TREND_DAYS } from "@/lib/analysis/fibonacci";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { sendFibSignal } from "@/lib/telegram";
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
 *  backtest's worst losing run was about 10R, so the default is 1%. Override
 *  with FIB_RISK_PCT (e.g. 0.005 for half a percent). */
export const FIB_RISK_PCT = (() => {
  const raw = Number(process.env.FIB_RISK_PCT);
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
 *  minutes at whatever second it likes, so the limit is one candle plus five
 *  minutes of slack: every closed candle is read by at least one scan, and the
 *  one-trade-per-swing rule keeps a second scan from sending it twice.
 *  Override with MAX_ENTRY_AGE_MIN. */
const MAX_ENTRY_AGE_MIN = Math.max(5, Number(process.env.MAX_ENTRY_AGE_MIN ?? EXECUTION_BAR_SECONDS / 60 + 5));

/** The closed candles of the four timeframes the Fibonacci system reads, optionally as they stood at `to`. */
export async function fetchFibCandles(pair: string, to?: string, m15Count: number = FIB_HISTORY.m15): Promise<{ m15: Candle[]; h1: Candle[]; h4: Candle[]; daily: Candle[] }> {
  const [m15, h1, h4, daily] = await Promise.all([
    fetchCandles({ instrument: pair, granularity: "M15", count: m15Count, to }),
    fetchCandles({ instrument: pair, granularity: "H1", count: FIB_HISTORY.h1, to }),
    fetchCandles({ instrument: pair, granularity: "H4", count: FIB_HISTORY.h4, to }),
    fetchCandles({ instrument: pair, granularity: "D", count: FIB_HISTORY.daily, to }),
  ]);
  return { m15, h1, h4, daily };
}

/**
 * One scan: settle the open trades, then read the last closed 15-minute candle
 * of each pair. When it completes every condition of the Fibonacci system
 * (lib/analysis/fibonacci.ts) the trade is stored and sent to Telegram — unless
 * a Fibonacci trade is already open, this swing has already been traded, or the
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
    const push = (kind: ScanEvent["kind"], detail: string) => events.push({ pair, timeframe: EXECUTION_TIMEFRAME, strategy: FIB_STRATEGY, kind, detail });
    try {
      const data = await fetchFibCandles(pair);
      if (data.m15.length < 60) {
        push("error", "not enough 15-minute candles returned");
        continue;
      }
      const series = buildFibSeries(data);
      const state = fibStateAt(series, series.n - 1, pair);
      const setup = state.setup;
      if (!setup) {
        const waiting = state.checks.filter((c) => c.met).length;
        if (!state.blocked && waiting >= 4) push("watching", "price is in the zone — waiting for a 15-minute rejection candle");
        continue;
      }

      const ageMin = (now / 1000 - setup.time) / 60;
      if (ageMin > MAX_ENTRY_AGE_MIN) {
        push("skipped", `signal candle closed ${Math.round(ageMin)} min ago — too late to enter (limit ${MAX_ENTRY_AGE_MIN} min)`);
        continue;
      }
      if (!supabase) {
        // without the database there is no way to know what is already open or already sent
        push("skipped", "a setup was found but the database is unavailable — nothing sent");
        continue;
      }
      const { data: rows, error } = await supabase
        .from("signals")
        .select("id, variant, status, outcome")
        .eq("pair", pair)
        .eq("strategy", FIB_STRATEGY)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) {
        push("skipped", `a setup was found but earlier signals could not be read: ${error.message}`);
        continue;
      }
      const earlier = (rows ?? []) as { id: string; variant: string | null; status: string; outcome: string | null }[];
      if (earlier.some((r) => r.status === "active" && r.outcome == null)) {
        push("skipped", "a Fibonacci trade is already open — one trade at a time");
        continue;
      }
      if (earlier.some((r) => r.variant === setup.leg.key)) {
        push("skipped", "this swing has already been traded — one trade per swing");
        continue;
      }

      const confirmations = Object.fromEntries(state.checks.map((c) => [c.label, c.met]));
      const { error: insertError } = await supabase.from("signals").insert({
        pair,
        direction: setup.direction,
        strategy: FIB_STRATEGY,
        variant: setup.leg.key,
        entry: setup.entry,
        stop_loss: setup.stopLoss,
        take_profit: setup.takeProfit,
        r_multiple: setup.rr,
        sl_basis: `beyond the start of the 1-hour swing (${setup.leg.origin.price.toFixed(2)})`,
        tp_basis: `the ${((1 + FIB_TARGET_EXTENSION) * 100).toFixed(1)}% extension of the swing`,
        confidence: state.checks.filter((c) => c.met).length,
        confirmations,
        status: "active",
      });
      if (insertError) {
        push("skipped", `the trade could not be recorded (${insertError.message}) — not sent`);
        continue;
      }
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
          riskPct: FIB_RISK_PCT,
        }).catch((e) => push("error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`));
      }
      push("signal", `${setup.direction === "long" ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)} (${setup.rr.toFixed(1)}R) — ${setup.trigger} in the zone`);
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }
  }

  return { scannedAt: new Date(now).toISOString(), units, events };
}
