import type { StrategyId, SignalDirection } from "@/lib/types";

/** Section 6 prompt builders — vision AI is advisory in all three uses. */

export function setupVerdictPrompt(opts: {
  instrument: string;
  timeframe: string;
  strategy: StrategyId;
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confirmationsMet: string[];
}): string {
  return `You are reviewing a ${opts.direction.toUpperCase()} trade setup on ${opts.instrument} (${opts.timeframe}) from a deterministic "${opts.strategy}" strategy engine.

The attached chart shows candles plus the engine's drawn overlays: trendlines with anchor-pivot dots, supply/demand zone boxes, the fibonacci golden-zone box, and dashed entry/SL/TP levels.

Planned: entry ${opts.entry}, stop ${opts.stopLoss}, target ${opts.takeProfit}.
Non-AI confirmations already met: ${opts.confirmationsMet.join("; ") || "none yet"}.

Question: does the VISUAL structure of this chart support the ${opts.direction} trade? Consider whether the setup sits at a real area of confluence and flag any red flags (e.g. price mid-range, opposing structure, messy price action).

Answer with the single word YES or NO on the first line, then at most two short sentences of reasoning.`;
}

export function renderValidationPrompt(opts: {
  overlayDescription: string;
  coordinates: string;
}): string {
  return `This chart image was drawn programmatically. QA task — drawing accuracy ONLY, not trade quality.

Overlays drawn: ${opts.overlayDescription}.
The engine used these exact coordinates: ${opts.coordinates}.

Verify whether each overlay visually lines up with the chart (e.g. trendline passes through the swing highs/lows it claims to connect, zone box covers the base candles before the impulsive move, fib box spans the correct swing).

Answer with the single word OK or MISMATCH on the first line, then at most two short sentences noting any misalignment.`;
}

export function askAiPrompt(question?: string): string {
  return `You are a trading chart analyst. Analyze the attached chart screenshot: trend, key structure, notable levels, and anything actionable. ${
    question ? `The user also asks: ${question}` : ""
  } Keep it under 6 short sentences. This is advisory only — the user makes the final call.`;
}

/**
 * Conflict arbitration: several strategies fired on the same pair/timeframe but
 * disagree on direction. Ask the model which side is more valid given the chart.
 */
export function arbitrationPrompt(opts: {
  instrument: string;
  timeframe: string;
  longCase: string;
  shortCase: string;
}): string {
  return `On ${opts.instrument} (${opts.timeframe}) multiple strategies fired but DISAGREE on direction.

LONG case: ${opts.longCase}

SHORT case: ${opts.shortCase}

Look at the attached chart and decide which direction is more valid RIGHT NOW given market structure (higher highs/lows vs lower highs/lows), where price sits relative to those levels, and which side has stronger confluence.

Answer with the single word LONG or SHORT on the first line, then at most two short sentences of reasoning.`;
}
