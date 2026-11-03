import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/oanda";
import { detectPivots, atr, detectZones, findFibSetup } from "@/lib/analysis";
import { analyzeTopDown } from "@/lib/analysis/topDown";
import { renderSetupPng } from "@/lib/vision/chartRender";
import { geminiAnalyze } from "@/lib/vision/gemini";
import { renderValidationPrompt } from "@/lib/vision/prompts";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;

/**
 * POST /api/vision/validate  { instrument, granularity }
 * Rendering validation check (Section 6, use #3): QA on the drawing engine.
 * Draws the detected overlays from the exact pivot/swing coordinates, asks
 * Gemini whether they visually line up with the chart, and logs mismatches.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    instrument?: string;
    granularity?: string;
  } | null;
  const instrument = body?.instrument ?? "XAU_USD";
  const granularity = body?.granularity ?? "M15";

  try {
    const [candles, weekly, daily, h4, h1] = await Promise.all([
      fetchCandles({ instrument, granularity, count: 300 }),
      fetchCandles({ instrument, granularity: "W", count: 160 }),
      fetchCandles({ instrument, granularity: "D", count: 260 }),
      fetchCandles({ instrument, granularity: "H4", count: 360 }),
      fetchCandles({ instrument, granularity: "H1", count: 240 }),
    ]);
    const pivots = detectPivots(candles);
    const atrValue = atr(candles);
    if (atrValue == null) throw new Error("insufficient data");

    const zones = detectZones(candles);
    const topDown = analyzeTopDown({ weekly, daily, h4, h1 });
    const trendlines = [topDown.actionLine, topDown.safetyLine].filter(
      (line): line is NonNullable<typeof line> => line != null
    );
    const fib = findFibSetup(candles, pivots, atrValue);

    const png = await renderSetupPng(candles, {
      trendlines,
      zones,
      fib: fib ?? undefined,
    });

    const coordinates = [
      ...trendlines.map(
        (t) =>
          `H4 ${t === topDown.actionLine ? "action" : "safety"} ${t.kind} line: origin (${new Date(t.origin.time * 1000).toISOString().slice(5, 16)}, ${t.origin.price}), defining anchor (${new Date(t.definitionAnchor.time * 1000).toISOString().slice(5, 16)}, ${t.definitionAnchor.price}), contacts ${t.anchors.map((a) => `(${new Date(a.time * 1000).toISOString().slice(5, 16)}, ${a.price})`).join(" ")}`
      ),
      ...zones.map(
        (z) => `${z.kind} zone ${z.bottom}–${z.top} from ${new Date(z.startTime * 1000).toISOString().slice(5, 16)} (${z.active ? "active" : "invalidated"})`
      ),
      ...(fib
        ? [
            `fib golden zone ${fib.goldenBottom.toFixed(5)}–${fib.goldenTop.toFixed(5)} on swing ${fib.swingLow.price}→${fib.swingHigh.price} (${fib.direction})`,
          ]
        : []),
    ].join("\n");

    const overlayDescription = `W/D bias ${topDown.bias}; ${trendlines.length} H4 action/safety line(s), ${zones.length} zone box(es)${fib ? ", 1 golden-zone box" : ""}`;

    const text = await geminiAnalyze({
      prompt: renderValidationPrompt({ overlayDescription, coordinates }),
      imageBase64: png.toString("base64"),
    });

    const ok = text.trimStart().toUpperCase().startsWith("OK");

    // log mismatches so drawing bugs get caught (Section 6, use #3)
    const supabase = createAdminClient();
    if (supabase) {
      await supabase.from("market_state").upsert(
        {
          pair: instrument,
          timeframe: granularity,
          kind: "pivot",
          dedupe_key: `render-check:${Date.now()}`,
          payload: { check: "rendering_validation", ok, note: text.slice(0, 500), overlays: overlayDescription },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "pair,timeframe,kind,dedupe_key" }
      );
    }

    return NextResponse.json({
      ok,
      note: text,
      overlayDescription,
      coordinates,
      image: `data:image/png;base64,${png.toString("base64")}`,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
