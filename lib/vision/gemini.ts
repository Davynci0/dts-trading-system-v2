/**
 * Vision AI client — now powered by OpenRouter for provider flexibility.
 * The public API (geminiAnalyze etc.) is kept for compatibility with the
 * existing validate route and scanner calls. Model comes from
 * OPENROUTER_VISION_MODEL (default "anthropic/claude-haiku-4.5") or
 * GEMINI_MODEL fallback for backwards compat.
 */

import { openrouterAnalyze } from "./openrouter";

export function geminiModel(): string {
  return process.env.OPENROUTER_VISION_MODEL ?? process.env.GEMINI_MODEL ?? "anthropic/claude-haiku-4.5";
}

export interface GeminiCall {
  prompt: string;
  /** base64-encoded PNG/JPEG, no data: prefix */
  imageBase64?: string;
  mimeType?: string;
}

/** Returns the model's text, or throws. Backed by OpenRouter vision. */
export async function geminiAnalyze({ prompt, imageBase64, mimeType = "image/png" }: GeminiCall): Promise<string> {
  return openrouterAnalyze({ prompt, imageBase64, mimeType });
}

/**
 * Structured setup review (confirmation #5, Section 6). Parses a leading
 * YES/NO verdict from the model; note is kept for the signal payload.
 */
export async function geminiSetupVerdict(
  prompt: string,
  imageBase64?: string
): Promise<{ supports: boolean; note: string }> {
  const text = await geminiAnalyze({ prompt, imageBase64 });
  const firstWord = text.trimStart().slice(0, 8).toUpperCase();
  return { supports: firstWord.startsWith("YES"), note: text.slice(0, 500) };
}

/**
 * Direction arbitration when strategies conflict. Returns "long" | "short"
 * (defaults to the majority/first side if the model is unparseable).
 */
export async function geminiArbitrate(
  prompt: string,
  imageBase64: string,
  fallback: "long" | "short"
): Promise<{ direction: "long" | "short"; note: string }> {
  const text = await geminiAnalyze({ prompt, imageBase64 });
  const head = text.trimStart().slice(0, 8).toUpperCase();
  const direction: "long" | "short" = head.startsWith("LONG")
    ? "long"
    : head.startsWith("SHORT")
      ? "short"
      : fallback;
  return { direction, note: text.slice(0, 500) };
}
