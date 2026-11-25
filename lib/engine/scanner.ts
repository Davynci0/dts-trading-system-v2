import type { Candle, Pair, SignalDirection, StrategyId } from "@/lib/types";
import { STRATEGY_IDS, strategyOf, TREND_KEY_PREFIX, TREND_STRATEGY } from "@/lib/types";
import { conflictBlock, contradict, STRATEGIES } from "@/lib/strategies";
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
import { sendStrategySignal, sendTrendSignal } from "@/lib/telegram";
import { readTrendlines, tlDailyTrend, tlSetup, TL_HISTORY, TL_LOCK_AT_R, TL_LOCK_TO_R, TL_MAX_HOLD_BARS, TL_MIN_RISK_ATR, TL_OPTIONS, TL_SECONDS, TL_TARGET_R, TL_TIMEFRAME } from "@/lib/analysis/trendline";
import { buildSfSeries, sfSetupAt, SF_ENTRY_SECONDS, SF_HISTORY, SF_LIVE, SF_LIVE_ENTRY } from "@/lib/analysis/setforget";
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

/** Share of the account one trade risks. Each of the three strategies can
 *  hold a trade, so up to three times this can be at risk at once; the
 *  five-year backtest's worst drawdown was 17 times the risk of one trade and
 *  its longest losing run 13 trades, so the default is half a percent.
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
async function fetchFreshCandles(pair: string, now: number, to?: string): Promise<{ data: Awaited<ReturnType<typeof fetchScanCandles>>; retries: number }> {
  const expected = Math.floor(now / 1000 / EXECUTION_BAR_SECONDS) * EXECUTION_BAR_SECONDS - EXECUTION_BAR_SECONDS;
  for (let retries = 0; ; retries++) {
    const data = await fetchScanCandles(pair, to);
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

/** An earlier signal of a strategy, as far as the send rules need it. */
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

/** An earlier signal with the strategy name it is stored under. */
export interface StoredSignal extends EarlierSignal {
  strategy: string;
}

const ALREADY_SENT = "this signal has already been sent";
const isOpen = (r: EarlierSignal) => r.status === "active" && r.outcome == null;

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
 * Why a signal of `strategy` may not be sent, or null when it may. `rows` are
 * the earlier signals of all three strategies.
 *  - Its own rules first: the trend scalp's send rules above; for the other
 *    two, a setup is traded once and the strategy holds one trade at a time.
 *  - Then the rule between strategies: nothing is sent against another
 *    strategy's open trade (lib/strategies.ts).
 */
export function strategyBlock(rows: StoredSignal[], strategy: StrategyId, trade: { key: string; direction: SignalDirection; time: number; entry: number }, late = false): string | null {
  const own = rows.filter((r) => strategyOf(r) === strategy);
  let block: string | null = null;
  if (strategy === "trend") block = sendBlock(own, trade, late);
  else if (own.some((r) => r.variant === trade.key)) block = ALREADY_SENT;
  else {
    const open = own.find(isOpen);
    if (open) block = `the ${STRATEGIES[strategy].name} ${open.direction === "long" ? "buy" : "sell"} is still open — one trade a strategy`;
  }
  if (block) return block;
  const open = rows.filter(isOpen).flatMap((r) => {
    const id = strategyOf(r);
    return id ? [{ strategy: id, direction: r.direction }] : [];
  });
  return conflictBlock(open, { strategy, direction: trade.direction });
}

/** The strategies that send signals: all three, unless ENABLED_STRATEGIES names fewer (e.g. "trend,setforget"). A strategy left out sends nothing new; its open trade is still followed to its end. */
export const ENABLED_STRATEGIES: StrategyId[] = (() => {
  const named = (process.env.ENABLED_STRATEGIES ?? "").split(",").map((x) => x.trim().toLowerCase());
  const chosen = STRATEGY_IDS.filter((id) => named.includes(id));
  return chosen.length > 0 ? chosen : [...STRATEGY_IDS];
})();

/** A signal a scan has found, before the send rules are applied. */
interface Candidate {
  strategy: StrategyId;
  /** the signal as the send rules see it: `time` is when its candle closed (epoch seconds) */
  signal: { key: string; direction: SignalDirection; time: number; entry: number };
  /** found on the candle before the newest: its own scan did not send it */
  late: boolean;
  /** the columns of the stored trade */
  row: { entry: number; stop_loss: number; take_profit: number } & Record<string, unknown>;
  /** the trade in a line, for the scan log */
  describe: string;
  announce: () => Promise<void>;
}

/**
 * One scan: settle the open trades, then let each of the three strategies read
 * its own chart —
 *  - the trend scalp the last closed 15-minute candle (and the one before it,
 *    in case the scan that should have read it did not run);
 *  - the trendline strategy the 1-hour candle that has just closed;
 *  - Set and Forget the 4-hour candle that has just closed.
 * A candle that completes an entry is stored and sent to Telegram — unless the
 * strategy's own send rules forbid it, it contradicts another strategy, or the
 * candle closed too long ago. Every scan leaves a row in market_state, written
 * when it starts and again when it is done, so one that did not run or failed
 * can be seen afterwards.
 */
export async function runScan(opts: {
  pairs: Pair[];
  accountBalance?: number;
  sendTelegrams?: boolean;
  now?: number;
  source?: "schedule" | "manual";
  /** read the charts as they stood at `now` and say what would be sent — nothing is stored, settled, logged or sent */
  dryRun?: boolean;
}): Promise<ScanSummary> {
  const { pairs, accountBalance = ACCOUNT_BALANCE, sendTelegrams = true, source = "manual", dryRun = false } = opts;
  const now = opts.now ?? Date.now();
  /** a dry run reads the candles that had closed by `now` */
  const to = dryRun && opts.now != null ? new Date(now).toISOString() : undefined;
  // asked for a past moment, the data feed also returns the candle that was still forming then — as it ended up
  const closedBy = (candles: Candle[], seconds: number) => (to ? candles.filter((c) => c.time + seconds <= now / 1000) : candles);
  const supabase = createAdminClient();
  const events: ScanEvent[] = [];
  let units = 0;
  const lastCandle: Record<string, string> = {};
  // the log never gets in the way of a signal
  const log = async (status: "started" | "done") => {
    if (!supabase || dryRun) return;
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
  if (!dryRun) await scoreOpenSignals(supabase, { force: true }).catch((e) => {
    events.push({ pair: "ALL", timeframe: EXECUTION_TIMEFRAME, strategy: TREND_STRATEGY, kind: "error", detail: `open trades could not be settled: ${(e as Error).message.slice(0, 120)}` });
    return 0;
  });

  for (const pair of pairs) {
    units++;
    const push = (kind: ScanEvent["kind"], detail: string, strategy: StrategyId = TREND_STRATEGY) => events.push({ pair, timeframe: EXECUTION_TIMEFRAME, strategy, kind, detail });

    let data: Awaited<ReturnType<typeof fetchScanCandles>>;
    try {
      const fresh = await fetchFreshCandles(pair, now, to);
      data = { m15: closedBy(fresh.data.m15, EXECUTION_BAR_SECONDS), h1: closedBy(fresh.data.h1, 3600), daily: closedBy(fresh.data.daily, 86_400) };
      const last = data.m15[data.m15.length - 1];
      if (last) lastCandle[pair] = `${new Date((last.time + EXECUTION_BAR_SECONDS) * 1000).toISOString()}${fresh.retries ? ` (asked ${fresh.retries + 1} times)` : ""}`;
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
      continue;
    }

    /** The earlier signals of the three strategies on this pair — the last 300 and every open one. Read once a scan, and kept current as trades are recorded. */
    let known: StoredSignal[] | null = null;
    const earlierSignals = async (): Promise<StoredSignal[] | string> => {
      if (known) return known;
      // without the database there is no way to know what is already open or already sent
      if (!supabase) return "the database is unavailable";
      const cols = "strategy, variant, direction, status, outcome, outcome_at, entry, stop_loss";
      const rows = () => supabase.from("signals").select(cols).eq("pair", pair).in("strategy", [...STRATEGY_IDS]);
      const [recent, open] = await Promise.all([rows().order("created_at", { ascending: false }).limit(300), rows().eq("status", "active").is("outcome", null).limit(50)]);
      const failed = recent.error ?? open.error;
      if (failed) return `earlier signals could not be read: ${failed.message}`;
      const seen = new Set<string>();
      known = ([...(recent.data ?? []), ...(open.data ?? [])] as StoredSignal[]).filter((r) => {
        const id = `${r.strategy}|${r.variant}`;
        // only the three live strategies — removed systems stored their trades under the same names
        if (strategyOf(r) === null || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return known;
    };
    /** Why a candidate may not be sent, or null. */
    const blockOf = async (c: Candidate): Promise<string | null> => {
      const ageMin = (now / 1000 - c.signal.time) / 60;
      if (ageMin > MAX_ENTRY_AGE_MIN) return `signal candle closed ${Math.round(ageMin)} min ago — too late to enter (limit ${MAX_ENTRY_AGE_MIN} min)`;
      const rows = await earlierSignals();
      if (typeof rows === "string") return `a setup was found but ${rows} — nothing sent`;
      return strategyBlock(rows, c.strategy, c.signal, c.late);
    };
    const candidates: Candidate[] = [];
    const px = (n: number) => n.toFixed(2);
    /** the price a trade found now is entered at: the close of the newest 15-minute candle */
    const priceNow = data.m15[data.m15.length - 1]?.close;
    /** seconds since the last candle of `seconds` length closed, given the open time of any candle of that length */
    const sinceClose = (anyOpen: number, seconds: number) => (((now / 1000 - anyOpen) % seconds) + seconds) % seconds;

    try {
      if (data.m15.length <= TREND_MIN_CANDLES || data.h1.length <= TREND_MIN_H1_CANDLES) {
        push("error", "not enough candles returned");
        continue;
      }
      const series = buildTrendSeries(data);
      // a strategy that is switched off reads nothing
      const newest = ENABLED_STRATEGIES.includes("trend") ? series.n - 1 : -9;
      // the candle before the newest first: a signal its own scan did not send is recovered while it is young enough
      for (const i of [newest - 1, newest]) {
      if (i < 0) continue;
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
      const lateMinutes = late ? Math.round((now / 1000 - signal.time) / 60) : undefined;
      // the send rules are applied to the signal itself; what is stored and sent is the trade as it can be entered now
      candidates.push({
        strategy: "trend",
        signal,
        late,
        row: {
          entry: setup.entry,
          stop_loss: setup.stopLoss,
          take_profit: setup.takeProfit,
          r_multiple: TREND_TARGET_R,
          sl_basis: stopWhy,
          tp_basis: `${TREND_TARGET_R} × the risk; the stop moves to +${TREND_LOCK_TO_R}R once price reaches +${TREND_LOCK_AT_R}R (${setup.lockTrigger.toFixed(2)}); closed at market after ${holdHours} hours if neither is hit`,
          confidence: state.checks.filter((x) => x.met).length,
          confirmations: { ...Object.fromEntries(state.checks.map((x) => [x.label, x.met])), [`Entry: ${setup.trigger}`]: true },
        },
        describe: `${late ? "recovered late: " : ""}${up ? "buy" : "sell"} at ${setup.entry.toFixed(2)}, stop ${setup.stopLoss.toFixed(2)}, target ${setup.takeProfit.toFixed(2)} (${TREND_TARGET_R}R) — ${setup.trigger}`,
        announce: () =>
          sendTrendSignal({
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
            lateMinutes,
          }),
      });
      }
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }

    // ── the trendline strategy: the 1-hour candle that has just closed ──
    try {
      const lastH1 = data.h1[data.h1.length - 1];
      if (ENABLED_STRATEGIES.includes("trendline") && lastH1 && priceNow != null && sinceClose(lastH1.time, TL_SECONDS) <= MAX_ENTRY_AGE_MIN * 60) {
        const h1 = closedBy(await fetchCandles({ instrument: pair, granularity: TL_TIMEFRAME, count: TL_HISTORY, to }), TL_SECONDS);
        const n = h1.length;
        // only the candle that has just closed: an older one was read by its own scan
        const found = (now / 1000 - (h1[n - 1].time + TL_SECONDS)) / 60 <= MAX_ENTRY_AGE_MIN ? readTrendlines(h1, TL_OPTIONS).events.filter((ev) => ev.index === n - 1) : [];
        const trend = found.length > 0 ? tlDailyTrend(data.daily, found[0].time) : 0;
        const plans = found.map((ev) => ({ ev, ...tlSetup(ev, h1[n - 1], trend, priceNow, pair) }));
        const lineOf = (ev: (typeof found)[number]) => `${ev.touches}-touch ${ev.line.kind === "up" ? "rising" : "falling"} trendline`;
        const taken = plans.find((x) => x.setup);
        // a candle can make more than one setup; the first that gives a trade is the trade
        for (const x of plans) if (x !== taken && !(taken && x.ev.type === "break")) push("watching", `${x.ev.type} of a ${lineOf(x.ev)}: no trade — ${x.setup ? "another setup of this candle is traded" : x.reason}`, "trendline");
        if (taken?.setup) {
          const setup = taken.setup;
          const lineName = lineOf(taken.ev);
          const up = setup.direction === "long";
          const why =
            setup.type === "bounce"
              ? `a 1-hour candle came back to a ${lineName} (at ${px(setup.line.value)}) and closed ${up ? "up" : "down"}, away from it — with the daily trend`
              : `price broke ${up ? "above" : "below"} a ${lineName}, came back to it (at ${px(setup.line.value)}) and closed ${up ? "up" : "down"} off it — the broken line held, with the daily trend`;
          const stopWhy = setup.stopBasis === "line" ? "just beyond the trendline" : `${TL_MIN_RISK_ATR} ATR away — the line is closer than that`;
          const days = (TL_MAX_HOLD_BARS * EXECUTION_BAR_SECONDS) / 86_400;
          const manage = `Close at market if neither level is hit within ${days} trading days.`;
          candidates.push({
            strategy: "trendline",
            signal: { key: setup.key, direction: setup.direction, time: setup.time, entry: setup.entry },
            late: false,
            row: {
              entry: setup.entry,
              stop_loss: setup.stopLoss,
              take_profit: setup.takeProfit,
              r_multiple: TL_TARGET_R,
              sl_basis: stopWhy,
              tp_basis: `${TL_TARGET_R} × the risk; the stop moves to +${TL_LOCK_TO_R}R once price reaches +${TL_LOCK_AT_R}R (${px(setup.lockTrigger)}); closed at market after ${days} trading days if neither is hit`,
              confidence: 5,
              confirmations: { [`Trendline ${setup.type}`]: true, "With the daily trend": true, "Line not too steep": true, "1-hour ADX under 40": true, "Stop within the limits": true },
            },
            describe: `${up ? "buy" : "sell"} at ${px(setup.entry)}, stop ${px(setup.stopLoss)}, target ${px(setup.takeProfit)} (${TL_TARGET_R}R) — trendline ${setup.type}`,
            announce: () =>
              sendStrategySignal({
                strategy: "trendline",
                headline: setup.type === "bounce" ? "1-hour trendline bounce" : "1-hour break and retest",
                pair,
                direction: setup.direction,
                entry: setup.entry,
                stopLoss: setup.stopLoss,
                takeProfit: setup.takeProfit,
                targetR: TL_TARGET_R,
                why,
                stopWhy,
                manage,
                lock: { trigger: setup.lockTrigger, stop: setup.lockStop, atR: TL_LOCK_AT_R, toR: TL_LOCK_TO_R },
                accountBalance,
                riskPct: RISK_PCT,
              }),
          });
        }
      }
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160), "trendline");
    }

    // ── Set and Forget: the 4-hour candle that has just closed ──
    try {
      const seconds = SF_ENTRY_SECONDS[SF_LIVE_ENTRY];
      const lastDay = data.daily[data.daily.length - 1];
      // 4-hour candles open on the same clock as the daily candle, so its close can be told without asking for it
      if (ENABLED_STRATEGIES.includes("setforget") && lastDay && priceNow != null && sinceClose(lastDay.time, seconds) <= MAX_ENTRY_AGE_MIN * 60) {
        const [h4, daily, weekly] = (
          await Promise.all([
            fetchCandles({ instrument: pair, granularity: SF_LIVE_ENTRY, count: SF_HISTORY.h4, to }),
            fetchCandles({ instrument: pair, granularity: "D", count: SF_HISTORY.daily, to }),
            fetchCandles({ instrument: pair, granularity: "W", count: SF_HISTORY.weekly, to }),
          ])
        ).map((c, k) => closedBy(c, [seconds, 86_400, 604_800][k]));
        const series = buildSfSeries({ entry: h4, h4, daily, weekly, entrySeconds: seconds }, SF_LIVE);
        const i = series.n - 1;
        const closed = i >= 0 ? h4[i].time + seconds : 0;
        const setup = i >= 2 && (now / 1000 - closed) / 60 <= MAX_ENTRY_AGE_MIN ? sfSetupAt(series, i, pair, SF_LIVE, priceNow) : null;
        if (setup) {
          const up = setup.direction === "long";
          const why = `the weekly, daily and 4-hour trend is ${up ? "up" : "down"}; price pulled back into a ${setup.zone.tf} area of interest (${px(setup.zone.low)}–${px(setup.zone.high)}, ${setup.zone.touches} touches), the 4-hour chart shifted structure back ${up ? "up" : "down"} and an engulfing candle confirmed it`;
          const stopWhy = `beyond the ${up ? "low" : "high"} the pullback made (${px(setup.pullback)})`;
          const manage = "Set and forget: the stop is never moved, not even to break-even. The trade ends at its stop or at its target — that can take days or weeks.";
          candidates.push({
            strategy: "setforget",
            signal: { key: setup.key, direction: setup.direction, time: closed, entry: setup.entry },
            late: false,
            row: {
              entry: setup.entry,
              stop_loss: setup.stopLoss,
              take_profit: setup.takeProfit,
              r_multiple: setup.targetR,
              sl_basis: stopWhy,
              tp_basis: `${setup.targetR} × the risk; the stop is never moved; held until the stop or the target is hit`,
              confidence: 5,
              confirmations: { "Weekly, daily and 4-hour agree": true, "Pullback into an area of interest": true, "Shift of structure on the 4-hour chart": true, "Engulfing candle": true, "Stop and target within the limits": true },
            },
            describe: `${up ? "buy" : "sell"} at ${px(setup.entry)}, stop ${px(setup.stopLoss)}, target ${px(setup.takeProfit)} (${setup.targetR}R) — Set and Forget`,
            announce: () =>
              sendStrategySignal({ strategy: "setforget", headline: "4-hour shift of structure at an area of interest", pair, direction: setup.direction, entry: setup.entry, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, targetR: setup.targetR, why, stopWhy, manage, accountBalance, riskPct: RISK_PCT }),
          });
        }
      }
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160), "setforget");
    }

    // ── what may be sent: each strategy's own rules, then the rules between them ──
    try {
      const sendable: Candidate[] = [];
      for (const c of candidates) {
        const block = await blockOf(c);
        if (!block) sendable.push(c);
        // a candle that is read on more than one scan having been sent on time is not news
        else if (!(block === ALREADY_SENT && (c.late || c.strategy !== "trend"))) push("skipped", c.late ? `the candle before: ${block}` : block, c.strategy);
      }
      if (contradict(sendable.map((c) => c.signal))) {
        for (const c of sendable) push("skipped", `${c.describe} — another strategy signalled the opposite way at the same time, so neither is sent`, c.strategy);
      } else {
        for (const c of sendable) {
          // a trade recorded a moment ago, on this scan, may now stand in its way
          const block = await blockOf(c);
          if (block) {
            push("skipped", c.late ? `the candle before: ${block}` : block, c.strategy);
            continue;
          }
          if (dryRun) {
            push("signal", `(dry run, nothing sent) ${c.describe}`, c.strategy);
            (known as StoredSignal[] | null)?.unshift({ strategy: c.strategy, variant: c.signal.key, direction: c.signal.direction, status: "active", outcome: null, outcome_at: null, entry: c.row.entry, stop_loss: c.row.stop_loss });
            continue;
          }
          const { error: insertError } = await supabase!.from("signals").insert({ pair, direction: c.signal.direction, strategy: c.strategy, variant: c.signal.key, status: "active", ...c.row });
          if (insertError) {
            push("skipped", `the trade could not be recorded (${insertError.message}) — not sent`, c.strategy);
            continue;
          }
          (known as StoredSignal[] | null)?.unshift({ strategy: c.strategy, variant: c.signal.key, direction: c.signal.direction, status: "active", outcome: null, outcome_at: null, entry: c.row.entry, stop_loss: c.row.stop_loss });
          if (sendTelegrams) await c.announce().catch((e) => push("error", `the trade was recorded but Telegram failed: ${(e as Error).message.slice(0, 120)}`, c.strategy));
          push("signal", c.describe, c.strategy);
        }
      }
    } catch (e) {
      push("error", (e as Error).message.slice(0, 160));
    }
  }

  await log("done");
  return { scannedAt: new Date(now).toISOString(), units, events };
}
