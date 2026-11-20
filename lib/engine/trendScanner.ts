import type { Candle } from "@/lib/types";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  buildTrendSeries,
  trendEntryDef,
  trendSetupsAt,
  trendStateAt,
  TREND_ADX_MAX,
  TREND_FAST_DAYS,
  TREND_SLOW_DAYS,
  type TrendSetup,
} from "@/lib/analysis/trend";
import { closeTimeOf } from "@/lib/analysis/breakout";
import { sendTrendSignal } from "@/lib/telegram";

/**
 * Risk per trend trade as a share of the account. Up to eleven trend positions
 * are open at once, all in the same direction, and on 30-minute candles the
 * backtest's worst drawdown was about 270R — so each trade risks a tenth of a
 * percent by default. Override with TREND_RISK_PCT (e.g. 0.0025 for 0.25%).
 */
export const TREND_RISK_PCT = (() => {
  const raw = Number(process.env.TREND_RISK_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 0.05 ? raw : 0.001;
})();

export interface TrendScanEvent {
  kind: "signal" | "skipped" | "watching";
  detail: string;
}

interface OpenTrendRow {
  id: string;
  variant: string | null;
  created_at: string;
}

/**
 * The trend system's part of a scan: every entry that fires on the candle that
 * just closed becomes a signal, unless that entry type already has a position
 * open or the candle closed too long ago to enter at its price.
 */
export async function scanTrend(opts: {
  pair: string;
  /** closed candles of the chart timeframe, newest last */
  candles: Candle[];
  /** closed daily candles */
  daily: Candle[];
  supabase: ReturnType<typeof createAdminClient>;
  accountBalance: number;
  sendTelegrams: boolean;
  /** minutes after the candle's close within which a signal may still be sent */
  maxEntryAgeMin: number;
  now?: number;
}): Promise<TrendScanEvent[]> {
  const { pair, candles, daily, supabase, accountBalance, sendTelegrams, maxEntryAgeMin } = opts;
  const now = opts.now ?? Date.now();
  const events: TrendScanEvent[] = [];
  if (candles.length < 60) return events;

  const series = buildTrendSeries(candles, daily);
  const i = series.n - 1;
  const state = trendStateAt(series, i);
  const setups = trendSetupsAt(series, i, pair);
  if (setups.length === 0) return events;

  const closeTime = closeTimeOf(candles);
  const ageMin = (now / 1000 - closeTime) / 60;
  if (ageMin > maxEntryAgeMin) {
    events.push({ kind: "skipped", detail: `${setups.length} trend entr${setups.length > 1 ? "ies" : "y"} on a candle that closed ${Math.round(ageMin)} min ago — too late to enter` });
    return events;
  }
  if (!supabase) {
    // without the database there is no way to know what is already open or already sent
    events.push({ kind: "skipped", detail: "trend entries found but the database is unavailable — nothing sent" });
    return events;
  }

  const { data: openRows, error } = await supabase
    .from("signals")
    .select("id, variant, created_at")
    .eq("pair", pair)
    .eq("strategy", "trend")
    .eq("status", "active")
    .is("outcome", null);
  if (error) {
    events.push({ kind: "skipped", detail: `trend entries found but open positions could not be read: ${error.message}` });
    return events;
  }
  const open = (openRows ?? []) as OpenTrendRow[];
  const openVariants = new Set(open.map((r) => r.variant));

  // an entry of this candle that was already sent (and perhaps already stopped out) is not sent twice
  const { data: sentRows } = await supabase
    .from("signals")
    .select("variant")
    .eq("pair", pair)
    .eq("strategy", "trend")
    .gte("created_at", new Date(closeTime * 1000).toISOString());
  const sentVariants = new Set(((sentRows ?? []) as { variant: string | null }[]).map((r) => r.variant));

  let openCount = open.length;
  for (const setup of setups) {
    if (openVariants.has(setup.id)) {
      events.push({ kind: "skipped", detail: `${setup.label}: already has a position open` });
      continue;
    }
    if (sentVariants.has(setup.id)) continue;

    const levels = trendLevels(setup, accountBalance);
    const confirmations: Record<string, boolean> = {
      [trendEntryDef(setup.id)?.rule ?? setup.label]: true,
      [`${TREND_FAST_DAYS}-day trend agrees`]: true,
      [`${TREND_SLOW_DAYS}-day trend agrees`]: true,
      [`Move not stretched (ADX below ${TREND_ADX_MAX})`]: true,
    };
    const { error: insertError } = await supabase.from("signals").insert({
      pair,
      direction: setup.direction,
      strategy: "trend",
      variant: setup.id,
      entry: levels.entry,
      stop_loss: levels.stopLoss,
      take_profit: 0,
      r_multiple: null,
      sl_basis: "3 ATR from the entry",
      tp_basis: "no target — trailing stop",
      trail_distance: setup.trailDistance,
      trail_stop: levels.stopLoss,
      trail_checked_at: new Date(now).toISOString(),
      confidence: 4,
      confirmations,
      status: "active",
    });
    if (insertError) {
      events.push({ kind: "skipped", detail: `${setup.label}: could not be recorded (${insertError.message}) — not sent` });
      continue;
    }
    openCount++;
    if (sendTelegrams) {
      await sendTrendSignal({
        pair,
        direction: setup.direction,
        label: setup.label,
        rule: trendEntryDef(setup.id)?.rule ?? "",
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        trailDistance: setup.trailDistance,
        adx: state.adx,
        openCount,
        positionUnits: levels.positionUnits,
        riskAmount: levels.riskAmount,
        riskPct: TREND_RISK_PCT,
      }).catch(() => undefined);
    }
    events.push({ kind: "signal", detail: `${setup.label}: ${setup.direction} at ${levels.entry.toFixed(2)}, stop ${levels.stopLoss.toFixed(2)}, trailing ${setup.trailDistance.toFixed(2)}` });
  }
  return events;
}

/** Entry, stop and size of a trend setup at the signal candle's close. */
export function trendLevels(setup: TrendSetup, accountBalance: number) {
  const dir = setup.direction === "long" ? 1 : -1;
  const entry = setup.price;
  const stopLoss = entry - dir * setup.stopDistance;
  const riskAmount = accountBalance * TREND_RISK_PCT;
  return { entry, stopLoss, riskAmount, positionUnits: Math.floor(riskAmount / setup.stopDistance) };
}
