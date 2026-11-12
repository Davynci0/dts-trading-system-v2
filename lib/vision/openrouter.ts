/**
 * OpenRouter vision client. Supports image input for chart analysis.
 * Vision AI is advisory: it's called AFTER all deterministic checks pass,
 * and can only REJECT a signal (skip it), never create one.
 *
 * Env:
 *   OPENROUTER_API_KEY      — required
 *   OPENROUTER_VISION_MODEL — default: "anthropic/claude-haiku-4.5"
 */

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const MAX_TOKENS = 500;

export interface OpenRouterVisionCall {
  prompt: string;
  /** base64-encoded PNG/JPEG, no data: prefix */
  imageBase64?: string;
  mimeType?: string;
  model?: string;
  maxTokens?: number;
}

/** Returns the model's text, or throws. */
export async function openrouterAnalyze({ prompt, imageBase64, mimeType = "image/png", model, maxTokens = MAX_TOKENS }: OpenRouterVisionCall): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const parts: unknown[] = [{ type: "text", text: prompt }];
  if (imageBase64) {
    parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } });
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.VERCEL_URL || "https://dts-trading-system-v2.vercel.app",
      "X-Title": "DTS Trading System",
    },
    body: JSON.stringify({
      model: model ?? process.env.OPENROUTER_VISION_MODEL ?? DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: parts }],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned no text");
  return text;
}

/** Structured setup validation verdict. */
export interface VisionVerdict {
  supports: boolean;
  /** 1–10 confidence model's conviction. Gate: skip if < MIN_CONFIDENCE. */
  confidence: number;
  structure: string;   // one sentence on market structure alignment
  confluence: string;  // one sentence on zone/fib/structure confluence
  redFlags: string[];  // short list of red flags (empty if none)
  note: string;        // raw model output (truncated for storage)
}

/** Parse the structured "discussion-style" vision response into a typed verdict.
 *  Verdict (SUPPORTS / REJECTS) appears on the first or last line. */
export function parseVisionVerdict(text: string): VisionVerdict {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0]?.toUpperCase() ?? "";
  const lastLine = lines[lines.length - 1]?.toUpperCase() ?? "";
  const supports = (firstLine.startsWith("SUPPORTS") || lastLine.startsWith("SUPPORTS")) &&
    !firstLine.startsWith("REJECTS") && !lastLine.startsWith("REJECTS");

  let confidence = 5;
  for (const line of lines) {
    const m = line.match(/^CONFIDENCE[:\s]*(\d+)/i);
    if (m) { confidence = Math.max(1, Math.min(10, Number(m[1]))); break; }
  }

  const getField = (label: string): string => {
    for (const line of lines) {
      const re = new RegExp(`^${label}[:\\s]+(.+)`, "i");
      const m = line.match(re);
      if (m) return m[1];
    }
    return "";
  };

  const redFlagsRaw = getField("RED[ -_]?FLAGS");
  const redFlags = redFlagsRaw.toLowerCase().includes("none")
    ? []
    : redFlagsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);

  return {
    supports,
    confidence,
    structure: getField("STRUCTURE"),
    confluence: getField("CONFLUENCE"),
    redFlags,
    note: text.slice(0, 600),
  };
}

/**
 * "Discussion-style" setup validation. Asks the vision model to give a
 * structured analysis: structure check, confluence check, red flags,
 * confidence, then a binary verdict. Supports is a gate, not an endorsement.
 */
export async function validateSetupVision(args: {
  instrument: string;
  direction: "long" | "short";
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rMultiple: number;
  confirmationsMet: string[];
  trendMode: { htf: boolean; m15: boolean };
  imageBase64: string;
}): Promise<VisionVerdict> {
  const met = args.confirmationsMet.length > 0 ? args.confirmationsMet.join("; ") : "none listed";
  const trendDesc = [
    args.trendMode.htf ? "HTF trend required" : null,
    args.trendMode.m15 ? "M15 trend required" : null,
  ].filter(Boolean).join(" + ") || "no trend gate";

  const prompt = `You are a senior price-action trader validating a ${args.direction.toUpperCase()} trade setup on ${args.instrument} (M15) from a deterministic "${args.strategy}" strategy engine.

The engine has already passed ALL deterministic confirmations. Your job is a second set of eyes: you can only REJECT or APPROVE. Never create a setup.

Planned: entry ${args.entry}, stop ${args.stopLoss}, target ${args.takeProfit} (R${args.rMultiple.toFixed(2)}).
Confirmations already met: ${met}.
Trend gate: ${trendDesc}.

Look at the chart: candles, drawn supply/demand zones, fib golden zone, dashed stop/target lines. Analyze in this exact order and be specific:

1. STRUCTURE — one sentence: is the higher-timeframe and M15 structure supportive? Price at a real support/resistance level?
2. CONFLUENCE — one sentence: does this setup sit at a real zone/fib/structure confluence, or mid-range?
3. RED FLAGS — short list of any visual red flags opposing the trade (or "none")
4. CONFIDENCE — a number 1–10 (10 = would take this trade without hesitation)

Then on the FINAL LINE only:
SUPPORTS
or
REJECTS

Now begin with "STRUCTURE:", "CONFLUENCE:", "RED FLAGS:", "CONFIDENCE:" lines, then the verdict line.`;

  const text = await openrouterAnalyze({ prompt, imageBase64: args.imageBase64 });
  return parseVisionVerdict(text);
}
