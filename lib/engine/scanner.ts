import type { Pair, StrategyId, Timeframe } from "@/lib/types";
import { TRADE_TIMEFRAMES } from "@/lib/types";
import { fetchCandles } from "@/lib/oanda";
import {
  scoreSetup,
  computeRiskLevels,
  analyzeM15,
  EXECUTION_HTF,
  m15Agrees,
  topDownAgrees,
  type ScoringContext,
  type ScoreResult,
} from "@/lib/analysis";
import { analyzeTopDown } from "@/lib/analysis/topDown";
import { classifyStructure } from "@/lib/analysis/structure";
import { buildSetupKey } from "@/lib/analysis/setupKey";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { findOpenTrades } from "@/lib/engine/supersede";
import { sendFinalSignal } from "@/lib/telegram";
import { createAdminClient } from "@/lib/supabase/admin";
import { ENGINE_VERSION } from "@/lib/engine/version";
import { fetchQuoteUsdRates, quoteUsdRateFor } from "@/lib/fx";

const STRATEGY_LABELS: Record<StrategyId, string> = {
  zones: "Supply/Demand Zone",
  setforget: "Alex G Set & Forget",
  fibonacci: "Fibonacci Retracement",
};

/** Strategies enabled for live signals. Structure and trendline removed after
 *  backtest research showed they lost on the recent XAU/USD M15 window. */
const ENABLED_STRATEGIES: StrategyId[] = ["zones", "setforget", "fibonacci"];

/** Per-strategy minimum confirmations required before a signal is sent.
 *  Measured post-fix on 5,000 XAU/USD M15 candles (52 days), one trade per pair,
 *  validated on split halves (scripts/research-live2.ts / research-fib6.ts):
 *    - zones >= 5, setforget >= 4, fibonacci >= 5 (old gate): 139 trades, PF 0.92 — negative
 *    - zones >= 5, setforget >= 4 (fib OFF): PF 1.57 but only 12 trades
 *    - fibonacci >= 6 (confluence-grade, below): PF 1.23, 31 trades, halves 0.94/1.69
 *  Fibonacci's standalone edge at 5 is negative, so it only sends at a perfect
 *  6/6 where it doubles as confluence for a zones/setforget setup.
 */
const STRATEGY_MIN_CONFIDENCE: Record<StrategyId, number> = {
  zones: 5,
  setforget: 4,
  fibonacci: 6,
};


interface SetupState {
  confirmations: Record<string, boolean>;
  count: number;
  /** true ONLY once this exact setup has produced a sent signal — never on a skip. */
  signaled: boolean;
  /** last reason this setup was considered but not sent (dedupes feed events). */
  lastSkip: string | null;
  lastSeen: number; // unix seconds
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
    try {
      const [weekly, daily, h4, h1] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: "W", count: 52 }),
        fetchCandles({ instrument: pair, granularity: "D", count: 90 }),
        fetchCandles({ instrument: pair, granularity: "H4", count: 120 }),
        fetchCandles({ instrument: pair, granularity: "H1", count: 120 }),
      ]);
      topDown = analyzeTopDown({ weekly, daily, h4, h1 });
    } catch (e) {
      events.push({
        pair,
        timeframe: "H4",
        strategy: "zones",
        kind: "error",
        detail: `top-down analysis unavailable: ${(e as Error).message.slice(0, 160)}`,
      });
      return;
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
        const m15 = analyzeM15(candles);
        if (!m15) continue;

        const { pivots, atrValue, zones, fib, setForget } = m15;

        const ctx: ScoringContext = {
          instrument: pair,
          candles,
          htfCandles,
          pivots,
          atrValue,
          zones,
          fib,
          setForget,
          topDown,
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
          const minConfidence = STRATEGY_MIN_CONFIDENCE[strategy];

          // --- feed events only; Telegram is reserved for the actionable trade ---
          const now = Math.floor(Date.now() / 1000);

          if (!prior) {
            events.push({ pair, timeframe: tf, strategy, kind: "watching", detail: triggerDescription(scored) });
          } else if (scored.count !== prior.count) {
            events.push({ pair, timeframe: tf, strategy, kind: "update", detail: `${scored.count}/6` });
          }

          // Send-eligible ONLY when the strategy's researched minimum is met
          // and the setup has never actually signaled. Considered-but-not-sent
          // setups (risk/alignment skip, open trade, lost conflict) remain
          // eligible so later scans can send them when conditions change.
          const disposition = setupDisposition(scored.count, prior, minConfidence);
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
  let cursor = 0;
  const worker = async () => {
    while (cursor < pairs.length) {
      const idx = cursor++;
      await scanOnePair(pairs[idx]);
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
function skipReasonFor(f: Firing): string {
  if (!f.risk.ok) return f.risk.reason;
  if (f.risk.levels.rMultiple < 2) {
    return `structure only pays ${f.risk.levels.rMultiple.toFixed(2)}R (min 2)`;
  }
  return `counter-trend: neither HTF nor M15 structure agrees with the ${f.direction}`;
}

/** Research-ranked strategy preference: setforget (PF 2.19) > zones (1.50) >
 *  fibonacci (1.03). The primary strategy's risk levels define the trade. */
const STRATEGY_QUALITY_BONUS: Record<StrategyId, number> = {
  setforget: 8,
  zones: 4,
  fibonacci: 0,
};

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
    eligible: prior?.signaled !== true && count >= minConfidence,
    signaled: prior?.signaled === true,
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

  const quality = (f: Firing): number => {
    let q = f.scored.count * 10;
    if (f.scored.topDownAligned) q += 35; // alignment is the strongest edge
    const rejection = Object.entries(f.scored.confirmations).some(
      ([k, v]) => v && /Rejection|Momentum/.test(k)
    );
    if (rejection) q += 12;
    if (f.risk.ok) {
      q += Math.min(14, f.risk.levels.rMultiple * 3); // reward potential
      q += Math.min(8, 1 / Math.max(0.1, f.risk.levels.stopDistance / f.risk.levels.atr)); // tighter SL relative to ATR is better
    } else {
      q -= 50;
    }
    q += STRATEGY_QUALITY_BONUS[f.scored.strategy];
    return q;
  };
  // High-quality final signal gate: valid risk, R≥2 and alignment with the
  // higher or execution timeframe. (The strategy confirmation minimum was
  // already required before the setup entered this reconciliation.)
  const highOdds = (f: Firing) => {
    if (!f.risk.ok || f.risk.levels.rMultiple < 2) return false;
    if (f.scored.count < STRATEGY_MIN_CONFIDENCE[f.scored.strategy]) return false;
    const trendAligned = f.scored.topDownAligned || m15Agrees(classifyStructure(ctx.pivots), f.direction);
    if (!trendAligned) return false;
    return true;
  };

  const candidates = fired.filter(highOdds);
  if (candidates.length === 0) {
    for (const f of fired) {
      const reason = skipReasonFor(f);
      if (f.prior?.lastSkip !== reason) {
        events.push({ pair, timeframe: tf, strategy: f.strategy, kind: "skipped", detail: reason });
      }
      await persist(f, { lastSkip: reason });
    }
    return;
  }

  const longs = candidates.filter((f) => f.direction === "long");
  const shorts = candidates.filter((f) => f.direction === "short");

  // If both directions have candidates, use top-down alignment to pick a side;
  // otherwise pick the side with candidates. This prevents counter-trend signals
  // when the higher timeframe is clearly bearish/bullish.
  let winnerSide: "long" | "short";
  let arbitrationNote: string | null = null;

  if (longs.length === 0 || shorts.length === 0) {
    winnerSide = longs.length > 0 ? "long" : "short";
  } else if (ctx.topDown) {
    winnerSide = topDownAgrees(ctx.topDown, "long") ? "long" : "short";
    arbitrationNote = `both sides present — chose ${winnerSide} via HTF bias`;
  } else {
    const sideScore = (arr: Firing[]) => arr.reduce((s, f) => s + quality(f), 0);
    winnerSide = sideScore(longs) >= sideScore(shorts) ? "long" : "short";
    arbitrationNote = `conflict resolved by confirmation majority: ${winnerSide}`;
  }

  const winners = winnerSide === "long" ? longs : shorts;
  const ranked = [...winners].sort((a, b) => quality(b) - quality(a));
  const primary = ranked[0];

  // The winning side produced its decision row for this pair (sent, or
  // recorded as skipped-for-risk) — done for these setups. Setups on the
  // rejected side stay eligible for a future, separate signal.
  for (const f of winners) {
    await persist(f, { signaled: true, lastSkip: null });
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
        vision_note: arbitrationNote,
        confluence_strategies: confluence,
        status: "active",
      });
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
        visionNote: arbitrationNote,
        positionUnits: L.positionUnits,
        riskAmount: L.riskAmount,
      }).catch(() => undefined);
    }
    events.push({
      pair,
      timeframe: tf,
      strategy: primary.strategy,
      kind: "signal",
      detail: `${winnerSide} ${confidence}/6 R${L.rMultiple.toFixed(2)}${winners.length > 1 ? ` ×${winners.length} confluence` : ""}`,
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
