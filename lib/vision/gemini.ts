/**
 * Vision AI client — now powered by OpenRouter for provider flexibility.
 * Used by the dashboard's Ask AI button. Model comes from
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
