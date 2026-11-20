import type { Candle } from "@/lib/types";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  buildTrendSeries,
  trendEntryDef,
  trendSetupsAt,
  TREND_EMA_BARS,
  TREND_FAST_DAYS,
  TREND_SLOW_DAYS,
  TREND_STOP_ATR,
  TREND_TARGET_R,
  TREND_TRAIL_ATR,
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
  direction: "long" | "short";
  created_at: string;
  /** every entry type that fired on the signal candle (the position stands for all of them) */
  confluence_strategies?: string[] | null;
}

/**
 * Why a new entry may not be sent given the positions already open, or null
 * when it may. Two rules: an entry type holds one position at a time, and the
 * system is never on both sides — no buy while a sell is open, no sell while
 * a buy is. The open positions have to be stopped out first.
 */
export function blockedByOpen(setup: { id: string; label: string; direction: "long" | "short" }, open: { variant: string | null; direction: "long" | "short" }[]): string | null {
  if (open.some((p) => p.variant === setup.id)) return `${setup.label}: already has a position open`;
  const against = open.filter((p) => p.direction !== setup.direction).length;
  if (against > 0) {
    return `${setup.label}: a ${setup.direction === "long" ? "buy" : "sell"} is not sent while ${against} ${setup.direction === "long" ? "sell" : "buy"} position${against > 1 ? "s are" : " is"} still open`;
  }
  return null;
}

/**
 * The trend system's part of a scan: the entries that fire on the candle that
 * just closed become ONE signal and one position (they share the entry price,
 * the stop and the target), leaving out any entry type that already has a position
 * open. Nothing is sent when a position is open in the opposite direction, or the candle closed too
 * long ago to enter at its price.
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
    .select("id, variant, direction, created_at, confluence_strategies")
    .eq("pair", pair)
    .eq("strategy", "trend")
    .eq("status", "active")
    .is("outcome", null);
  if (error) {
    events.push({ kind: "skipped", detail: `trend entries found but open positions could not be read: ${error.message}` });
    return events;
  }
  const rows = (openRows ?? []) as OpenTrendRow[];
  // one position can stand for several entry types (those that fired on its candle)
  const open = rows.flatMap((r) => entriesOf(r).map((variant) => ({ variant, direction: r.direction })));

  // an entry of this candle that was already sent (and perhaps already stopped out) is not sent twice
  const { data: sentRows } = await supabase
    .from("signals")
    .select("variant, confluence_strategies")
    .eq("pair", pair)
    .eq("strategy", "trend")
    .gte("created_at", new Date(closeTime * 1000).toISOString());
  const sent = new Set(((sentRows ?? []) as Pick<OpenTrendRow, "variant" | "confluence_strategies">[]).flatMap(entriesOf));

  // Entries that fire on the same candle share one entry price, one stop and
  // one target: they are ONE trade, sent as one signal.
  const group: TrendSetup[] = [];
  for (const setup of setups) {
    const block = blockedByOpen(setup, open);
    if (block) {
      events.push({ kind: "skipped", detail: block });
      continue;
    }
    if (!sent.has(setup.id)) group.push(setup);
  }
  if (group.length === 0) return events;

  const lead = group[0];
  const levels = trendLevels(lead, accountBalance);
  const confirmations: Record<string, boolean> = {
    [`${TREND_FAST_DAYS}-day trend agrees`]: true,
    [`${TREND_SLOW_DAYS}-day trend agrees`]: true,
    [`Price on the trend's side of its ${TREND_EMA_BARS}-candle average`]: true,
  };
  for (const g of group) confirmations[`${g.label}: ${trendEntryDef(g.id)?.rule ?? ""}`] = true;
  const { error: insertError } = await supabase.from("signals").insert({
    pair,
    direction: lead.direction,
    strategy: "trend",
    variant: lead.id,
    confluence_strategies: group.map((g) => g.id),
    entry: levels.entry,
    stop_loss: levels.stopLoss,
    take_profit: levels.takeProfit,
    r_multiple: levels.takeProfit > 0 ? TREND_TARGET_R : null,
    sl_basis: `${TREND_STOP_ATR} ATR from the entry`,
    tp_basis: levels.takeProfit > 0 ? `${TREND_TARGET_R}× the risk; the ${TREND_TRAIL_ATR}-ATR trailing stop usually closes the trade first` : "no target — trailing stop",
    trail_distance: lead.trailDistance,
    trail_stop: levels.stopLoss,
    trail_checked_at: new Date(now).toISOString(),
    confidence: 3 + group.length,
    confirmations,
    status: "active",
  });
  const names = group.map((g) => g.label).join(", ");
  if (insertError) {
    events.push({ kind: "skipped", detail: `${names}: could not be recorded (${insertError.message}) — not sent` });
    return events;
  }
  if (sendTelegrams) {
    await sendTrendSignal({
      pair,
      direction: lead.direction,
      labels: group.map((g) => g.label),
      rule: trendEntryDef(lead.id)?.rule ?? "",
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      targetR: TREND_TARGET_R,
      trailDistance: lead.trailDistance,
      fastDays: TREND_FAST_DAYS,
      slowDays: TREND_SLOW_DAYS,
      emaBars: TREND_EMA_BARS,
      openCount: rows.length + 1,
      positionUnits: levels.positionUnits,
      riskAmount: levels.riskAmount,
      riskPct: TREND_RISK_PCT,
    }).catch(() => undefined);
  }
  events.push({ kind: "signal", detail: `${lead.direction} at ${levels.entry.toFixed(2)}, stop ${levels.stopLoss.toFixed(2)}, target ${levels.takeProfit.toFixed(2)}, trailing ${lead.trailDistance.toFixed(2)} — ${names}` });
  return events;
}

/** The entry types a stored position stands for: those that fired together on its candle. */
function entriesOf(row: { variant: string | null; confluence_strategies?: string[] | null }): string[] {
  const all = row.confluence_strategies?.length ? row.confluence_strategies : row.variant ? [row.variant] : [];
  return [...new Set(all)];
}

/** Entry, stop, take-profit and size of a trend setup at the signal candle's close. */
export function trendLevels(setup: TrendSetup, accountBalance: number) {
  const dir = setup.direction === "long" ? 1 : -1;
  const entry = setup.price;
  const stopLoss = entry - dir * setup.stopDistance;
  const takeProfit = setup.targetDistance > 0 ? entry + dir * setup.targetDistance : 0;
  const riskAmount = accountBalance * TREND_RISK_PCT;
  return { entry, stopLoss, takeProfit, riskAmount, positionUnits: Math.floor(riskAmount / setup.stopDistance) };
}
