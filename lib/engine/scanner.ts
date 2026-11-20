import type { Candle, Pair, StrategyId, Timeframe } from "@/lib/types";
import { CHECKS, TRADE_TIMEFRAMES } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import {
  scoreSetup,
  computeRiskLevels,
  analyzeM15,
  EXECUTION_HTF,
  trendModeFor,
  type ScoringContext,
  type ScoreResult,
} from "@/lib/analysis";
import { passesSendGate, selectSignal, sendGateBlock } from "@/lib/engine/select";
import { analyzeTopDown } from "@/lib/analysis/topDown";
import { buildSetupKey } from "@/lib/analysis/setupKey";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { findOpenTrades } from "@/lib/engine/supersede";
import { sendFinalSignal, sendZoneAlert } from "@/lib/telegram";
import { createAdminClient } from "@/lib/supabase/admin";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { fetchQuoteUsdRates, quoteUsdRateFor } from "@/lib/fx";
import { renderSetupPng } from "@/lib/vision/chartRender";
import { validateSetupVision, type VisionVerdict } from "@/lib/vision/openrouter";

const STRATEGY_LABELS: Record<StrategyId, string> = {
  breakout: "Trend Breakout",
  zones: "Supply/Demand Zone",
  setforget: "Alex G Set & Forget",
  fibonacci: "Fibonacci Retracement",
};

/** Every strategy is scanned and tracked; SIGNAL_STRATEGIES decides which may send. */
const ENABLED_STRATEGIES: StrategyId[] = ["breakout", "zones", "setforget", "fibonacci"];


interface SetupState {
  confirmations: Record<string, boolean>;
  count: number;
  /** true ONLY once this exact setup has produced a sent signal — never on a skip. */
  signaled: boolean;
  /** last reason this setup was considered but not sent (dedupes feed events). */
  lastSkip: string | null;
  lastSeen: number; // unix seconds
  /** true once a zone-touch Telegram alert has been sent for this setup. */
  zoneAlerted?: boolean;
  /** timestamp of the last signal actually sent for this setup (used with ALLOW_REPEAT_SIGNALS). */
  lastSignaledAt?: number;
  /** confirmation count at the time of the last signal. */
  lastSignaledCount?: number;
}

export interface ScanEvent {
  pair: string;
  timeframe: string;
  strategy: StrategyId;
  kind: "watching" | "update" | "signal" | "skipped" | "error";
  detail: string;
}

export interface ScanSummary {
  scannedAt: string;
  units: number;
  events: ScanEvent[];
}

/**
 * The scanning engine (Stages 5–8 wired together): runs all three strategies
 * over each pair/timeframe, scores the 6-point confirmation checklist, runs
 * the Section 4 risk check, persists state/signals to Supabase, and sends the
 * Section 8 Telegram messages.
 */
export async function runScan(opts: {
  pairs: Pair[];
  timeframes: Timeframe[];
  accountBalance?: number;
  sendTelegrams?: boolean;
}): Promise<ScanSummary> {
  const {
    pairs,
    timeframes: _timeframes,
    accountBalance = Number(process.env.ACCOUNT_BALANCE ?? 10000),
    sendTelegrams = true,
  } = opts;
  const timeframes: Timeframe[] = [...TRADE_TIMEFRAMES];
  void _timeframes;

  const supabase = createAdminClient();
  const events: ScanEvent[] = [];
  let units = 0;

  // Joint conversion rates for USD risk sizing (USD_JPY, AUD_USD, NZD_USD as
  // needed by the scanned pairs) — fetched ONCE per scan, not per pair.
  const quoteRates = await fetchQuoteUsdRates(pairs).catch(() => ({}) as Record<string, number>);

  // One pair, fully independent. Pairs run concurrently (see the worker pool
  // below) so a setup on one pair is never missed while another is being fetched.
  async function scanOnePair(pair: Pair): Promise<void> {
    const quoteUsdRate = quoteUsdRateFor(pair, quoteRates);
    let topDown;
    // closed daily candles: the trend breakout's daily-trend filter
    let dailyCandles: Candle[] = [];
    try {
      const [weekly, daily, h4, h1] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: "W", count: 52 }),
        fetchCandles({ instrument: pair, granularity: "D", count: 90 }),
        fetchCandles({ instrument: pair, granularity: "H4", count: 120 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 120 }),
      ]);
      topDown = analyzeTopDown({ weekly, daily, h4, h1 });
      dailyCandles = daily;
    } catch (e) {
      events.push({
        pair,
        timeframe: "H4",
        strategy: "zones",
        kind: "error",
        detail: `top-down analysis unavailable (continuing with M15 only): ${(e as Error).message.slice(0, 120)}`,
      });
      // Non-fatal: M15 scanning continues without top-down context.
      // For pairs with TREND_MODE=M15/HTF-only this doesn't affect signals
      // (the disabled trend check is auto-true; HTF falls back to H1 candles).
      // For TREND_MODE=BOTH pairs, scoring falls back to H1-based HTF agreement.
    }

    for (const tf of timeframes.filter((t) => t === "M15")) {
      units++;
      try {
        const candles = await fetchCandles({ instrument: pair, granularity: "M15", count: 500 });
        const htfCandles = await fetchCandles({
          instrument: pair,
          granularity: EXECUTION_HTF,
          count: 300,
        });
        const m15 = analyzeM15(candles, pair);
        if (!m15) continue;

        const { pivots, atrValue, zones, fib, setForget } = m15;

        const ctx: ScoringContext = {
          instrument: pair,
          candles,
          htfCandles,
          pivots,
          structuralPivots: m15.structuralPivots,
          atrValue,
          zones,
          fib,
          setForget,
          topDown,
          trendMode: trendModeFor(pair),
          headShoulders: m15.headShoulders,
          daily: dailyCandles,
        };

        // Each strategy is evaluated independently. We collect the setups that
        // reached their strategy's send threshold without having signaled
        // before, then reconcile them into a single actionable signal.
        const fired: Firing[] = [];

        for (const strategy of ENABLED_STRATEGIES) {
          const scored = scoreSetup(strategy, ctx);
          if (!scored.hasTrigger) continue;

          const entry = candles[candles.length - 1].close;
          const setupKey = setupKeyOf(pair, tf, scored);
          const prior = await loadSetup(supabase, pair, tf, setupKey);
          const minConfidence = minConfidenceFor(pair, strategy);

          // --- feed events only; Telegram is reserved for the actionable trade ---
          const now = Math.floor(Date.now() / 1000);

          if (!prior) {
            events.push({ pair, timeframe: tf, strategy, kind: "watching", detail: triggerDescription(scored) });
          } else if (scored.count !== prior.count) {
            events.push({ pair, timeframe: tf, strategy, kind: "update", detail: `${scored.count}/${CHECKS[strategy]}` });
          }

          // Early zone-touch alert: notify as soon as price enters a buy/sell zone,
          // before the full confirmation stack lines up. Deduplicated per zone.
          let zoneAlerted = prior?.zoneAlerted === true;
          // (only while the zones strategy is itself allowed to send — an early
          // warning for a watch-only strategy is noise)
          if (
            strategy === "zones" &&
            signalStrategies().has("zones") &&
            !zoneAlerted &&
            sendTelegrams &&
            zoneAlertPairs().has(pair)
          ) {
            const zone = scored.trigger?.zone;
            if (zone && zone.active) {
              await sendZoneAlert({
                pair,
                direction: scored.direction,
                zoneKind: zone.kind,
                zoneBottom: zone.bottom,
                zoneTop: zone.top,
                touches: zone.touches,
                price: entry,
              }).catch(() => undefined);
              zoneAlerted = true;
            }
          }

          // Send-eligible ONLY when the strategy's researched minimum is met
          // and the setup has never actually signaled. Considered-but-not-sent
          // setups (risk/alignment skip, open trade, lost conflict) remain
          // eligible so later scans can send them when conditions change.
          const disposition = setupDisposition(scored.count, prior, minConfidence);
          const recentlySignaled =
            ALLOW_REPEAT_SIGNALS &&
            prior?.lastSignaledAt != null &&
            now - prior.lastSignaledAt < REPEAT_SIGNAL_COOLDOWN_MIN * 60;
          const noNewConfirmations =
            ALLOW_REPEAT_SIGNALS &&
            prior?.lastSignaledCount != null &&
            scored.count <= prior.lastSignaledCount;
          const cooldownNote = recentlySignaled
            ? `repeat-signal cooldown (${REPEAT_SIGNAL_COOLDOWN_MIN}min)`
            : "no new confirmations since last signal";

          const watchOnly = !signalPairs().has(pair) || !signalStrategies().has(strategy);
          const watchNote = signalPairs().has(pair)
            ? "watch-only strategy — not in SIGNAL_STRATEGIES, so its setups are tracked but not sent"
            : "watch-only pair — not in SIGNAL_PAIRS, so setups are tracked but not sent";
          if (disposition.eligible && (recentlySignaled || noNewConfirmations)) {
            if (prior?.lastSkip !== cooldownNote) {
              events.push({ pair, timeframe: tf, strategy, kind: "skipped", detail: cooldownNote });
            }
            await saveSetup(supabase, pair, tf, setupKey, {
              confirmations: scored.confirmations,
              count: scored.count,
              signaled: prior?.signaled === true,
              lastSkip: cooldownNote,
              lastSeen: now,
              zoneAlerted,
              lastSignaledAt: prior?.lastSignaledAt,
              lastSignaledCount: prior?.lastSignaledCount,
            });
            continue;
          }
          if (disposition.eligible && watchOnly) {
            if (prior?.lastSkip !== watchNote) {
              events.push({ pair, timeframe: tf, strategy, kind: "skipped", detail: watchNote });
            }
            await saveSetup(supabase, pair, tf, setupKey, {
              confirmations: scored.confirmations,
              count: scored.count,
              signaled: prior?.signaled === true,
              lastSkip: watchNote,
              lastSeen: now,
              zoneAlerted,
              lastSignaledAt: prior?.lastSignaledAt,
              lastSignaledCount: prior?.lastSignaledCount,
            });
            continue;
          }
          if (disposition.eligible) {
            fired.push({
              strategy,
              direction: scored.direction,
              scored,
              setupKey,
              prior,
              risk: computeRiskLevels({
                instrument: pair,
                direction: scored.direction,
                entry,
                candles,
                pivots,
                zones,
                trigger: scored.trigger,
                accountBalance,
                quoteUsdRate,
              }),
            });
          }

          await saveSetup(supabase, pair, tf, setupKey, {
            confirmations: scored.confirmations,
            count: scored.count,
            signaled: prior?.signaled === true,
            lastSkip: prior?.lastSkip ?? null,
            lastSeen: now,
            zoneAlerted,
            lastSignaledAt: prior?.lastSignaledAt,
            lastSignaledCount: prior?.lastSignaledCount,
          });
        }

        // --- reconcile the fired setups into one actionable signal ---
        if (fired.length > 0) {
          await reconcileAndSignal({
            fired,
            pair,
            tf,
            candles,
            ctx,
            supabase,
            events,
            sendTelegrams,
          });
        }
      } catch (e) {
        events.push({
          pair,
          timeframe: tf,
          strategy: "zones",
          kind: "error",
          detail: (e as Error).message.slice(0, 200),
        });
      }
    }
  }

  // Run every pair concurrently through a small worker pool. Each pair is
  // fully independent (own top-down fetch, own timeframes, own reconcile), so
  // a setup is never missed while another pair is being fetched. The cap keeps
  // us inside OANDA/Gemini rate limits — raise via SCAN_CONCURRENCY if needed.
  const concurrency = Math.max(
    1,
    Math.min(Number(process.env.SCAN_CONCURRENCY ?? 3), pairs.length || 1)
  );
  // Small stagger when starting pair scans (reduces OANDA burst pressure
  // that their practice gateway can interpret as burst traffic → 504s).
  const STAGGER_MS = Number(process.env.SCAN_STAGGER_MS ?? 250);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pairs.length) {
      const idx = cursor++;
      await scanOnePair(pairs[idx]);
      if (cursor < pairs.length) await new Promise((r) => setTimeout(r, STAGGER_MS));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // expire stale setups (no trigger for 24h)
  if (supabase) {
    const { error } = await supabase
      .from("market_state")
      .delete()
      .eq("kind", "setup")
      .lt("updated_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    if (error) console.error("expire setups:", error.message);
  }

  await scoreOpenSignals(supabase, { force: true }).catch(() => 0);

  return { scannedAt: new Date().toISOString(), units, events };
}

function triggerDescription(scored: ScoreResult): string {
  if (scored.strategy === "breakout" && scored.trigger?.breakout) {
    const b = scored.trigger.breakout;
    return `closed ${b.direction === "long" ? "above" : "below"} the ${b.kind === "asian" ? "Asian range" : "1-week channel"} at ${b.level.toFixed(2)} with the daily trend`;
  }
  if (scored.strategy === "fibonacci" && scored.trigger?.fib) {
    const f = scored.trigger.fib;
    return `price in golden zone ${f.goldenBottom.toFixed(5)}–${f.goldenTop.toFixed(5)}`;
  }
  if (scored.strategy === "zones" && scored.trigger?.zone) {
    const z = scored.trigger.zone;
    return `price entered ${z.kind} zone ${z.bottom.toFixed(5)}–${z.top.toFixed(5)} (${z.touches} prior touches)`;
  }
  if (scored.strategy === "setforget" && scored.trigger?.setForget) {
    const s = scored.trigger.setForget;
    return `first touch of ${s.direction === "long" ? "demand" : "supply"} AOI ${s.aoiBottom.toFixed(5)}–${s.aoiTop.toFixed(5)}`;
  }
  return "core trigger";
}

function setupKeyOf(pair: string, tf: string, scored: ScoreResult): string {
  void pair;
  void tf;
  return buildSetupKey(ENGINE_VERSION, scored);
}

async function loadSetup(
  supabase: ReturnType<typeof createAdminClient>,
  pair: string,
  tf: string,
  dedupeKey: string
): Promise<SetupState | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("market_state")
    .select("payload")
    .eq("pair", pair)
    .eq("timeframe", tf)
    .eq("kind", "setup")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  return (data?.payload as SetupState) ?? null;
}

async function saveSetup(
  supabase: ReturnType<typeof createAdminClient>,
  pair: string,
  tf: string,
  dedupeKey: string,
  state: SetupState
): Promise<void> {
  if (!supabase) return;
  await supabase
    .from("market_state")
    .upsert(
      {
        pair,
        timeframe: tf,
        kind: "setup",
        dedupe_key: dedupeKey,
        payload: state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "pair,timeframe,kind,dedupe_key" }
    )
    .then(({ error }) => {
      if (error) console.error("saveSetup:", error.message);
    });
}

interface Firing {
  strategy: StrategyId;
  direction: "long" | "short";
  scored: ScoreResult;
  setupKey: string;
  prior: SetupState | null;
  risk: ReturnType<typeof computeRiskLevels>;
}

/** Why a send-eligible setup did not produce a signal — recorded so the
 *  feed doesn't repeat itself and the setup is re-considered when it changes. */
function skipReasonFor(pair: string, f: Firing): string {
  return sendGateBlock(f, minConfidenceFor(pair, f.scored.strategy)) ?? "not selected";
}

/** Per-strategy minimum confirmations required before a signal is sent.
 *  Zones and set & forget send at 4 of 6 — 3/6 is the weakest bucket for
 *  every strategy and nothing is gained above 4. Fibonacci is the most
 *  frequent setup and the weakest, so it needs a perfect 6/6.
 *
 *  Override with ZONES_MIN_CONFIDENCE / SETFORGET_MIN_CONFIDENCE /
 *  FIB_MIN_CONFIDENCE (1–6); check the effect with scripts/backtest.ts.
 */
const ZONES_MIN_CONFIDENCE = Math.max(1, Math.min(6, Number(process.env.ZONES_MIN_CONFIDENCE ?? 4)));
const FIB_MIN_CONFIDENCE = Math.max(1, Math.min(6, Number(process.env.FIB_MIN_CONFIDENCE ?? 6)));
const SETFORGET_MIN_CONFIDENCE = Math.max(1, Math.min(6, Number(process.env.SETFORGET_MIN_CONFIDENCE ?? 4)));
export const STRATEGY_MIN_CONFIDENCE: Record<StrategyId, number> = {
  // a breakout either meets all three of its conditions or does not exist
  breakout: 3,
  zones: ZONES_MIN_CONFIDENCE,
  setforget: SETFORGET_MIN_CONFIDENCE,
  fibonacci: FIB_MIN_CONFIDENCE,
};

/** Per-pair gate override: set FIB_MIN_CONFIDENCE_XAU_USD=4 (or ZONES_...,
 *  SETFORGET_...) to use a different confirmation minimum for one pair. */
export function minConfidenceFor(pair: string, strategy: StrategyId): number {
  const envName = `${strategy.toUpperCase()}_MIN_CONFIDENCE_${pair}`;
  const raw = Number(process.env[envName]);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 6) return Math.round(raw);
  return STRATEGY_MIN_CONFIDENCE[strategy];
}

/** Pairs allowed to SEND live signals (Telegram + signals table). A scanned
 *  pair that is not listed is watch-only: TA, confirmation trackers and feed
 *  events, but no signal. Override with the SIGNAL_PAIRS env. */
const DEFAULT_SIGNAL_PAIRS = ["XAU_USD"];

/** Allow the same setup to fire more than once (no permanent signaled dedup).
 *  Useful for scalping/re-entry styles. Default false. */
const ALLOW_REPEAT_SIGNALS = (process.env.ALLOW_REPEAT_SIGNALS ?? "false") === "true";
/** Minimum minutes between repeat signals for the same setup. Default 60. */
const REPEAT_SIGNAL_COOLDOWN_MIN = Math.max(0, Number(process.env.REPEAT_SIGNAL_COOLDOWN_MIN ?? 60));
/** Whether to run AI vision validation before sending a signal. Default true.
 *  Vision can only REJECT a signal; it never creates a setup. */
const AI_VISION_ENABLED = (process.env.AI_VISION_ENABLED ?? "true") !== "false";
/** Minimum AI vision confidence (1–10) to approve a signal. Default 5. */
const VISION_MIN_CONFIDENCE = Math.max(1, Math.min(10, Number(process.env.VISION_MIN_CONFIDENCE ?? 5)));

/** Strategies allowed to SEND live signals. The rest are still scanned and
 *  shown on the dashboard's tracker, but only as watch-only setups. Override
 *  with SIGNAL_STRATEGIES=breakout,setforget (ids from StrategyId). */
const DEFAULT_SIGNAL_STRATEGIES: StrategyId[] = ["breakout"];

export function signalStrategies(override?: string | undefined): Set<StrategyId> {
  const raw = override ?? process.env.SIGNAL_STRATEGIES;
  const wanted = raw && raw.trim() ? raw.split(",").map((s) => s.trim()) : DEFAULT_SIGNAL_STRATEGIES;
  return new Set(wanted.filter((s): s is StrategyId => ENABLED_STRATEGIES.includes(s as StrategyId)));
}

/** Pairs allowed to send live signals. Override with SIGNAL_PAIRS=XAU_USD,GBP_JPY. */
export function signalPairs(override?: string | undefined): Set<string> {
  const raw = override ?? process.env.SIGNAL_PAIRS;
  return new Set((raw && raw.trim()) ? raw.split(",").map((s) => s.trim()) : DEFAULT_SIGNAL_PAIRS);
}

/** Pairs that send early zone-touch Telegram alerts. Defaults to SIGNAL_PAIRS. */
function zoneAlertPairs(override?: string | undefined): Set<string> {
  const raw = override ?? process.env.ZONE_ALERT_PAIRS ?? process.env.SIGNAL_PAIRS;
  return new Set((raw && raw.trim()) ? raw.split(",").map((s) => s.trim()) : DEFAULT_SIGNAL_PAIRS);
}

/** Core state-machine decision for one (setup, prior-state, strategy-minimum):
 *  a setup is a SEND CANDIDATE once its count reaches the strategy minimum,
 *  and stays one across scans until a signal is actually sent — being
 *  considered-but-not-sent (risk skip, open trade, lost conflict) must never
 *  silence it, and neither must merely crossing the low watch threshold.
 *  Exported for regression tests (this is the bug that zeroed the live feed). */
export function setupDisposition(
  count: number,
  prior: Pick<SetupState, "signaled" | "lastSkip"> | null,
  minConfidence: number
): { eligible: boolean; signaled: boolean; lastSkip: string | null } {
  return {
    eligible: (ALLOW_REPEAT_SIGNALS || prior?.signaled !== true) && count >= minConfidence,
    signaled: !ALLOW_REPEAT_SIGNALS && prior?.signaled === true,
    lastSkip: prior?.lastSkip ?? null,
  };
}

/**
 * Turn the independently-fired setups for one pair/timeframe into a single
 * actionable signal:
 *  - one direction only → fire it; multiple agreeing strategies = confluence.
 *  - long AND short both fired → conflict, resolved by HTF bias then quality.
 * A setup is marked `signaled` ONLY when it contributed to a sent signal;
 * skipped setups remain eligible and are re-considered on later scans.
 */
async function reconcileAndSignal(args: {
  fired: Firing[];
  pair: string;
  tf: Timeframe;
  candles: import("@/lib/types").Candle[];
  ctx: ScoringContext;
  supabase: ReturnType<typeof createAdminClient>;
  events: ScanEvent[];
  sendTelegrams: boolean;
}): Promise<void> {
  const { fired, pair, tf, candles, ctx, supabase, events, sendTelegrams } = args;
  const now = Math.floor(Date.now() / 1000);

  const persist = (f: Firing, patch: Partial<SetupState>) =>
    saveSetup(supabase, pair, tf, f.setupKey, {
      confirmations: f.scored.confirmations,
      count: f.scored.count,
      signaled: f.prior?.signaled === true,
      lastSkip: f.prior?.lastSkip ?? null,
      lastSeen: now,
      lastSignaledAt: f.prior?.lastSignaledAt,
      lastSignaledCount: f.prior?.lastSignaledCount,
      ...patch,
    }).catch(() => undefined);

  // One trade per pair: while a trade is open, take no new trade on this pair
  // until it hits TP or SL. No replacement, no second position. The fired
  // setups stay un-signaled so they can fire once the trade settles.
  if (supabase) {
    const open = await findOpenTrades(supabase, pair);
    if (open.length > 0) {
      const detail = `a trade is already open on ${pair} — holding until it hits TP or SL`;
      for (const f of fired) {
        if (f.prior?.lastSkip !== detail) {
          events.push({ pair, timeframe: tf, strategy: f.strategy, kind: "skipped", detail });
        }
        await persist(f, { lastSkip: detail });
      }
      return;
    }
  }

  // Send gate + side/primary selection live in lib/engine/select.ts, shared
  // with the backtest: valid risk, the strategy's confirmation minimum, the
  // trading session, no opposing weekly structure and an agreeing M15 trend
  // (a trend check that is switched off for the pair evaluates to true).
  const candidates = fired.filter((f) => passesSendGate(f, minConfidenceFor(pair, f.scored.strategy)));
  const selection = selectSignal(candidates, ctx.topDown);
  if (!selection) {
    for (const f of fired) {
      const reason = skipReasonFor(pair, f);
      if (f.prior?.lastSkip !== reason) {
        events.push({ pair, timeframe: tf, strategy: f.strategy, kind: "skipped", detail: reason });
      }
      await persist(f, { lastSkip: reason });
    }
    return;
  }
  const { side: winnerSide, winners, primary, arbitrationNote } = selection;

  // The winning side produced its decision row for this pair (sent, or
  // recorded as skipped-for-risk) — done for these setups. Setups on the
  // rejected side stay eligible for a future, separate signal.
  for (const f of winners) {
    await persist(f, {
      signaled: ALLOW_REPEAT_SIGNALS ? false : true,
      lastSkip: null,
      lastSignaledAt: now,
      lastSignaledCount: f.scored.count,
    });
  }
  for (const f of fired) {
    if (!winners.includes(f)) {
      await persist(f, { lastSkip: `lost the ${winnerSide} conflict on this pair (${arbitrationNote ?? "side selection"})` });
    }
  }

  const confluence = winners.map((f) => f.strategy);
  const confluenceLabel =
    winners.length > 1
      ? winners.map((f) => STRATEGY_LABELS[f.strategy]).join(" + ")
      : STRATEGY_LABELS[primary.strategy];

  const risk = primary.risk;
  if (risk.ok) {
    const L = risk.levels;
    const confidence = Math.max(...winners.map((f) => f.scored.count));
    const note = [
      winners.length > 1 ? `Confluence: ${winners.length} strategies agree (${confluence.join(", ")}).` : null,
      arbitrationNote,
    ]
      .filter(Boolean)
      .join(" ") || null;

    // ── AI Vision validation ──────────────────────────────────────────────
    // The deterministic engine has already passed ALL confirmations and risk.
    // Here a vision model gets a second set of eyes on the chart. It can only
    // REJECT a signal — never create one. Vision failure is non-fatal: on any
    // error we send the deterministic signal and note the failure.
    let visionVerdict: VisionVerdict | null = null;
    let visionNote: string | null = null;
    let visionRejected = false;

    // The breakout's record was measured without the vision check, and nothing
    // shows a chart read improves it — so it is not allowed to veto one.
    if (AI_VISION_ENABLED && primary.strategy !== "breakout") {
      try {
        const png = await renderSetupPng(candles, {
          trendlines: ctx.topDown
            ? [ctx.topDown.actionLine, ctx.topDown.safetyLine].filter(
                (l): l is NonNullable<typeof l> => l != null
              )
            : [],
          zones: ctx.zones.filter((z) => z.active),
          fib: primary.scored.trigger?.fib ?? ctx.fib ?? undefined,
          entry: L.entry,
          stopLoss: L.stopLoss,
          takeProfit: L.takeProfit,
        });
        visionVerdict = await validateSetupVision({
          instrument: pair,
          direction: winnerSide,
          strategy: confluenceLabel,
          entry: L.entry,
          stopLoss: L.stopLoss,
          takeProfit: L.takeProfit,
          rMultiple: L.rMultiple,
          confirmationsMet: Object.entries(primary.scored.confirmations)
            .filter(([, v]) => v)
            .map(([k]) => k),
          trendMode: trendModeFor(pair),
          imageBase64: png.toString("base64"),
        });

        if (visionVerdict) {
          visionNote = `[AI ${visionVerdict.confidence}/10] ` 
            + `${visionVerdict.structure} ${visionVerdict.confluence}`
            + ` Red flags: ${visionVerdict.redFlags.length ? visionVerdict.redFlags.join("; ") : "none"}.`
            .slice(0, 300);

          if (!visionVerdict.supports || visionVerdict.confidence < VISION_MIN_CONFIDENCE) {
            visionRejected = true;
          }
        } else {
          visionNote = "[ vision analysis unavailable ]";
        }
      } catch (e) {
        visionNote = `[ vision error: ${(e as Error).message.slice(0, 60)} ]`;
      }
    }
    // ── end AI Vision ───────────────────────────────────────────────────

    const effectiveStatus = visionRejected ? "skipped" : "active";
    const effectiveSkipReason = visionRejected
      ? `AI vision rejects (${visionVerdict?.confidence ?? "?"}/10): ${visionVerdict?.note.slice(0, 200)}`
      : null;

    if (supabase) {
      await supabase.from("signals").insert({
        pair,
        direction: winnerSide,
        strategy: primary.strategy,
        entry: L.entry,
        stop_loss: L.stopLoss,
        take_profit: L.takeProfit,
        sl_basis: L.stopBasis,
        tp_basis: L.targetBasis,
        r_multiple: L.rMultiple,
        confidence,
        confirmations: primary.scored.confirmations,
        vision_note: visionNote ?? note,
        vision_verdict: visionRejected ? "rejects" : visionVerdict ? "supports" : "skipped",
        confluence_strategies: confluence,
        status: effectiveStatus,
        skip_reason: effectiveSkipReason,
      });
    }
    if (visionRejected) {
      events.push({
        pair, timeframe: tf, strategy: primary.strategy, kind: "skipped",
        detail: `AI vision rejects (${visionVerdict?.confidence ?? "?"}/10): ${visionVerdict?.note.slice(0, 80)}`,
      });
      return;
    }
    if (sendTelegrams) {
      await sendFinalSignal({
        pair,
        direction: winnerSide,
        strategy: confluenceLabel,
        entry: L.entry,
        stopLoss: L.stopLoss,
        takeProfit: L.takeProfit,
        rMultiple: L.rMultiple,
        riskPips: L.riskPips,
        rewardPips: L.rewardPips,
        stopBasis: L.stopBasis,
        targetBasis: L.targetBasis,
        confidence,
        checks: CHECKS[primary.strategy],
        visionNote: visionNote ?? note,
        positionUnits: L.positionUnits,
        riskAmount: L.riskAmount,
      }).catch(() => undefined);
    }
    events.push({
      pair,
      timeframe: tf,
      strategy: primary.strategy,
      kind: "signal",
      detail: `${winnerSide} ${confidence}/${CHECKS[primary.strategy]} R${L.rMultiple.toFixed(2)}${winners.length > 1 ? ` ×${winners.length} confluence` : ""}`,
    });
  } else {
    // Skipped for risk: still record the position that WOULD have been taken
    // (structural entry/SL/TP) so the feed shows it and outcome scoring can
    // later tell us whether skipping was the right call.
    const skipLevels = !risk.ok ? risk.levels : null;
    if (supabase) {
      await supabase.from("signals").insert({
        pair,
        direction: winnerSide,
        strategy: primary.strategy,
        entry: skipLevels?.entry ?? candles[candles.length - 1].close,
        stop_loss: skipLevels?.stopLoss ?? 0,
        take_profit: skipLevels?.takeProfit ?? 0,
        sl_basis: skipLevels?.stopBasis ?? null,
        tp_basis: skipLevels?.targetBasis ?? null,
        r_multiple: skipLevels ? skipLevels.rMultiple : null,
        confidence: primary.scored.count,
        confirmations: primary.scored.confirmations,
        vision_note: arbitrationNote,
        confluence_strategies: confluence,
        status: "skipped",
        skip_reason: risk.reason,
      });
    }
    events.push({ pair, timeframe: tf, strategy: primary.strategy, kind: "skipped", detail: risk.reason });
  }
}
