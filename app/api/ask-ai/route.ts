import { NextRequest, NextResponse } from "next/server";
import { geminiAnalyze } from "@/lib/vision/gemini";
import { askAiPrompt } from "@/lib/vision/prompts";

/**
 * POST /api/ask-ai  { imageBase64: string (PNG, no data: prefix), question?: string }
 * Manual "Ask AI" (Section 6, use #2): the browser sends whatever is currently
 * on the chart; the response is advisory only.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    imageBase64?: string;
    question?: string;
  } | null;

  if (!body?.imageBase64) {
    return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 });
  }
  if (body.imageBase64.length > 8_000_000) {
    return NextResponse.json({ error: "image too large" }, { status: 413 });
  }

  try {
    const analysis = await geminiAnalyze({
      prompt: askAiPrompt(body.question),
      imageBase64: body.imageBase64,
    });
    return NextResponse.json({ analysis });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
