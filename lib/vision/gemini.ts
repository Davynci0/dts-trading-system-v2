/**
 * Gemini API client (direct, no OpenRouter). Model: Gemini 3 Flash.
 * Vision AI is advisory in all three Section 6 uses — the deterministic
 * scoring system decides whether a signal fires.
 */

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
}

export interface GeminiCall {
  prompt: string;
  /** base64-encoded PNG/JPEG, no data: prefix */
  imageBase64?: string;
  mimeType?: string;
}

/** Returns the model's text, or throws. */
export async function geminiAnalyze({ prompt, imageBase64, mimeType = "image/png" }: GeminiCall): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const parts: unknown[] = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned no text");
  return text;
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
