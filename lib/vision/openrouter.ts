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
