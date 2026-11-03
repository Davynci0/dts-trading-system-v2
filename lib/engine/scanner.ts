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
import { renderSetupPng } from "@/lib/vision/chartRender";
import { geminiSetupVerdict, geminiArbitrate } from "@/lib/vision/gemini";
import { setupVerdictPrompt, arbitrationPrompt } from "@/lib/vision/prompts";
import { sendFinalSignal } from "@/lib/telegram";
import { createAdminClient } from "@/lib/supabase/admin";

const ENGINE_VERSION = "tori-v3";

const STRATEGY_LABELS: Record<StrategyId, string> = {
  zones: "Supply/Demand Zone",
  setforget: "Alex G Set & Forget",
  fibonacci: "Fibonacci Retracement",
};

/** Strategies enabled for live signals. Structure and trendline removed after
 *  backtest research showed they lost on the recent XAU/USD M15 window. */
const ENABLED_STRATEGIES: StrategyId[] = ["zones", "setforget", "fibonacci"];

/** Per-strategy minimum non-AI confirmations required before a signal is sent.
 *  Derived from 5,000-candle XAU/USD M15 research:
 *    - setforget >= 4: 50% WR, 2.19 PF
 *    - zones >= 5: 40% WR, 1.50 PF
 *    - fibonacci >= 5: 30.6% WR, 1.03 PF (marginal, included for confluence)
 */
const STRATEGY_MIN_CONFIDENCE: Record<StrategyId, number> = {
  zones: 5,
  setforget: 4,
  fibonacci: 5,
};


interface SetupState {
  confirmations: Record<string, boolean>;
  count: number;
  visionChecked: boolean;
  visionNote: string | null;
  signaled: boolean;
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
 * over each pair/timeframe, scores the 5-point confirmation checklist, calls
 * Gemini for confirmation #5 once the other checks start stacking, runs the
 * Section 4 risk check, persists state/signals to Supabase, and sends the
 * Section 8 Telegram messages.
 */
export async function runScan(opts: {
  pairs: Pair[];
  timeframes: Timeframe[];
  accountBalance?: number;
  useVision?: boolean;
  sendTelegrams?: boolean;
}): Promise<ScanSummary> {
  const {
    pairs,
    timeframes: _timeframes,
    accountBalance = Number(process.env.ACCOUNT_BALANCE ?? 10000),
    useVision = true,
    sendTelegrams = true,
  } = opts;
  const timeframes: Timeframe[] = [...TRADE_TIMEFRAMES];
  void _timeframes;

  const supabase = createAdminClient();
  const events: ScanEvent[] = [];
  let units = 0;

  // One pair, fully independent. Pairs run concurrently (see the worker pool
  // below) so a setup on one pair is never missed while another is being fetched.
  async function scanOnePair(pair: Pair): Promise<void> {
    let topDown;
    try {
      const [weekly, daily, h4] = await Promise.all([
        fetchCandles({ instrument: pair, granularity: "W", count: 160 }),
        fetchCandles({ instrument: pair, granularity: "D", count: 260 }),
        fetchCandles({ instrument: pair, granularity: "H4", count: 360 }),
      ]);
      topDown = analyzeTopDown({ weekly, daily, h4 });
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

        // Each strategy is evaluated independently — one firing is enough. We
        // collect the ones that newly crossed threshold this scan, then send a
        // single reconciled signal (confluence bonus, or AI arbitration on a
        // long/short disagreement).
        const fired: Firing[] = [];

        for (const strategy of ENABLED_STRATEGIES) {
          const firstPass = scoreSetup(strategy, ctx, null);
          if (!firstPass.hasTrigger) continue;

          const entry = candles[candles.length - 1].close;
          const setupKey = setupKeyOf(pair, tf, firstPass);
          const prior = await loadSetup(supabase, pair, tf, setupKey);

          // Vision check (#7): query Gemini only when the strategy-specific minimum
          // non-AI confirmations are already stacked. This matches the backtest research
          // thresholds so live signals mirror the profitable combinations.
          let visionOk: boolean | null = prior?.visionChecked
            ? firstPass.confirmations["Vision AI"] ?? null
            : null;
          let visionNote: string | null = prior?.visionNote ?? null;
          const nonAiCount = Object.entries(firstPass.confirmations)
            .filter(([k, v]) => k !== "Vision AI" && v)
            .length;
          const minNonAi = STRATEGY_MIN_CONFIDENCE[strategy];

          if (useVision && !prior?.visionChecked && nonAiCount >= minNonAi) {
            try {
              const risk = computeRiskLevels({
                instrument: pair,
                direction: firstPass.direction,
                entry,
                candles,
                pivots,
                zones,
                accountBalance,
              });
              const png = await renderSetupPng(candles, {
                zones,
                fib: fib ?? undefined,
                entry,
                stopLoss: risk.ok ? risk.levels.stopLoss : undefined,
                takeProfit: risk.ok ? risk.levels.takeProfit : undefined,
              });
              const verdict = await geminiSetupVerdict(
                setupVerdictPrompt({
                  instrument: pair,
                  timeframe: tf,
                  strategy,
                  direction: firstPass.direction,
                  entry,
                  stopLoss: risk.ok ? risk.levels.stopLoss : 0,
                  takeProfit: risk.ok ? risk.levels.takeProfit : 0,
                  confirmationsMet: Object.entries(firstPass.confirmations)
                    .filter(([k, v]) => k !== "Vision AI" && v)
                    .map(([k]) => k),
                }),
                png.toString("base64")
              );
              visionOk = verdict.supports;
              visionNote = verdict.note;
            } catch (e) {
              visionOk = null; // Gemini down/quota — #5 simply doesn't count
              visionNote = `vision unavailable: ${(e as Error).message.slice(0, 120)}`;
            }
          }

          const scored: ScoreResult =
            visionOk === null ? firstPass : scoreSetup(strategy, ctx, visionOk);

          // --- feed events only; Telegram is reserved for the actionable trade ---
          const now = Math.floor(Date.now() / 1000);

          if (!prior) {
            events.push({ pair, timeframe: tf, strategy, kind: "watching", detail: triggerDescription(scored) });
          }

          if (!scored.fired) {
            if (prior && scored.count !== prior.count) {
              events.push({ pair, timeframe: tf, strategy, kind: "update", detail: `${scored.count}/7` });
            }
          } else if (!prior?.signaled) {
            fired.push({
              strategy,
              direction: scored.direction,
              scored,
              visionNote,
              setupKey,
              risk: computeRiskLevels({
                instrument: pair,
                direction: scored.direction,
                entry,
                candles,
                pivots,
                zones,
                accountBalance,
              }),
            });
          }

          await saveSetup(supabase, pair, tf, setupKey, {
            confirmations: scored.confirmations,
            count: scored.count,
            visionChecked: visionOk !== null || prior?.visionChecked === true,
            visionNote,
            signaled: scored.fired ? true : prior?.signaled === true,
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
    return `price in golden zone ${scored.trigger.fib.goldenBottom.toFixed(5)}–${scored.trigger.fib.goldenTop.toFixed(5)}`;
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
  visionNote: string | null;
  setupKey: string;
  risk: ReturnType<typeof computeRiskLevels>;
}

/**
 * Turn the independently-fired setups for one pair/timeframe into a single
 * actionable signal:
 *  - one direction only → fire it; multiple agreeing strategies = confluence.
 *  - long AND short both fired → conflict. Ask Gemini (chart image) which side
 *    is more valid; fall back to the higher-confirmation / majority side.
 * The risk sanity check still gates the final order (never a bad-R signal).
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

  // One trade per pair: while a trade is open, take no new trade on this pair
  // until it hits TP or SL. No replacement, no second position.
  if (supabase) {
    const open = await findOpenTrades(supabase, pair);
    if (open.length > 0) {
      events.push({
        pair,
        timeframe: tf,
        strategy: fired[0]?.strategy ?? "zones",
        kind: "skipped",
        detail: `a trade is already open on ${pair} — holding until it hits TP or SL`,
      });
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
    return q;
  };
  // High-quality final signal gate. Live data shows confidence-3 signals win
  // only ~20% of the time, while 4+ hit ~50%. Require at least the strategy's
  // researched non-AI minimum + vision confirmation, valid risk, and R≥2.
  const highOdds = (f: Firing) => {
    if (!f.risk.ok || f.risk.levels.rMultiple < 2) return false;
    if (f.scored.count < STRATEGY_MIN_CONFIDENCE[f.scored.strategy] + 1) return false;
    const trendAligned = f.scored.topDownAligned || m15Agrees(classifyStructure(ctx.pivots), f.direction);
    if (!trendAligned) return false;
    return true;
  };

  const candidates = fired.filter(highOdds);
  if (candidates.length === 0) {
    events.push({
      pair,
      timeframe: tf,
      strategy: fired[0]?.strategy ?? "zones",
      kind: "skipped",
      detail: `no high-odds M15 setup (need strategy-specific confirmations + vision, HTF or M15 alignment, and R≥2)`,
    });
    for (const f of fired) {
      await saveSetup(supabase, pair, tf, f.setupKey, {
        confirmations: f.scored.confirmations,
        count: f.scored.count,
        visionChecked: true,
        visionNote: f.visionNote,
        signaled: true,
        lastSeen: Math.floor(Date.now() / 1000),
      }).catch(() => undefined);
    }
    return;
  }

  const longs = candidates.filter((f) => f.direction === "long");
  const shorts = candidates.filter((f) => f.direction === "short");

  // If both directions have candidates, require top-down alignment to pick a side;
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
    const fallback: "long" | "short" = sideScore(longs) >= sideScore(shorts) ? "long" : "short";
    winnerSide = fallback;
    try {
      const png = await renderSetupPng(candles, {
        zones: ctx.zones,
        fib: ctx.fib ?? undefined,
      });
      const describe = (arr: Firing[]) =>
        arr
          .map(
            (f) =>
              `${STRATEGY_LABELS[f.strategy]} (${f.scored.count}/7: ${triggerDescription(f.scored)})`
          )
          .join("; ");
      const result = await geminiArbitrate(
        arbitrationPrompt({
          instrument: pair,
          timeframe: tf,
          longCase: describe(longs),
          shortCase: describe(shorts),
        }),
        png.toString("base64"),
        fallback
      );
      winnerSide = result.direction;
      arbitrationNote = `CONFLICT (long: ${describe(longs)} | short: ${describe(shorts)}) → AI: ${result.direction.toUpperCase()} — ${result.note}`;
      } catch (e) {
        winnerSide = sideScore(longs) >= sideScore(shorts) ? "long" : "short";
        arbitrationNote = `arbitration failed (${(e as Error).message}); defaulted to ${winnerSide}`;
      }
    }

  const winners = winnerSide === "long" ? longs : shorts;
  const ranked = [...winners].sort((a, b) => quality(b) - quality(a));
  const primary = ranked[0];

  // mark every fired setup (winners and losers) as signaled so they don't re-alert
  for (const f of fired) {
    const prior = await loadSetup(supabase, pair, tf, f.setupKey);
    await saveSetup(supabase, pair, tf, f.setupKey, {
      confirmations: f.scored.confirmations,
      count: f.scored.count,
      visionChecked: true,
      visionNote: f.visionNote,
      signaled: true,
      lastSeen: Math.floor(Date.now() / 1000),
    }).catch(() => undefined);
    void prior;
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
      primary.visionNote,
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
        vision_note: note,
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
        visionNote: note,
        positionUnits: L.positionUnits,
        riskAmount: L.riskAmount,
      }).catch(() => undefined);
    }
    events.push({
      pair,
      timeframe: tf,
      strategy: primary.strategy,
      kind: "signal",
      detail: `${winnerSide} ${confidence}/5 R${L.rMultiple.toFixed(2)}${winners.length > 1 ? ` ×${winners.length} confluence` : ""}`,
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
        vision_note: arbitrationNote ?? primary.visionNote,
        confluence_strategies: confluence,
        status: "skipped",
        skip_reason: risk.reason,
      });
    }
    events.push({ pair, timeframe: tf, strategy: primary.strategy, kind: "skipped", detail: risk.reason });
  }
}
