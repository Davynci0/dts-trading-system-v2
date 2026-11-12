import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * Direct test of the AI vision pipeline — the exact code path the scanner
 * runs before sending a signal. Renders a real chart and asks OpenRouter
 * to review a hypothetical trade setup.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-vision.ts
 */
import { fetchCandles } from "@/lib/oanda";
import { analyzeM15 } from "@/lib/analysis/execution";
import { renderSetupPng } from "@/lib/vision/chartRender";
import { validateSetupVision } from "@/lib/vision/openrouter";

async function main() {
  const pair = "XAU_USD";
  console.log(`\n=== AI Vision Pipeline Test: ${pair} ===\n`);

  console.log("1. Fetching candles...");
  const candles = await fetchCandles({ instrument: pair, granularity: "M15", count: 500 });
  console.log(`   Got ${candles.length} candles, last close ${candles[candles.length-1].close}`);

  console.log("2. Running M15 analysis...");
  const analysis = analyzeM15(candles);
  if (!analysis) throw new Error("analysis null");
  console.log(`   zones=${analysis.zones.filter(z=>z.active).length} fib=${analysis.fib ? "yes" : "no"} sf=${analysis.setForget ? "yes" : "no"} trendlines=${analysis.trendlines.length} hs=${analysis.headShoulders.length}`);

  console.log("3. Rendering chart PNG (sharp)...");
  const last = candles[candles.length - 1];
  const entry = last.close;
  const stopLoss = analysis.fib ? entry - 3 * analysis.atrValue : entry - 30;
  const takeProfit = analysis.fib ? entry + 2.5 * 3 * analysis.atrValue : entry + 60;
  const png = await renderSetupPng(candles, {
    trendlines: analysis.trendlines,
    zones: analysis.zones.filter((z) => z.active).slice(0, 5),
    fib: analysis.fib ?? undefined,
    entry,
    stopLoss,
    takeProfit,
  });
  console.log(`   PNG rendered: ${png.length} bytes`);

  console.log("4. Calling OpenRouter vision (google/gemini-2.5-flash-lite)...");
  const verdict = await validateSetupVision({
    instrument: pair,
    direction: "long",
    strategy: "Test Setup",
    entry,
    stopLoss,
    takeProfit,
    rMultiple: (takeProfit - entry) / (entry - stopLoss),
    confirmationsMet: ["Price entered zone", "Zone fresh", "Momentum turning"],
    trendMode: { htf: false, m15: true },
    imageBase64: png.toString("base64"),
  });

  console.log("\n=== AI Vision Verdict ===");
  console.log(`  Verdict:     ${verdict.supports ? "✅ SUPPORTS" : "⛔ REJECTS"}`);
  console.log(`  Confidence:  ${verdict.confidence}/10`);
  console.log(`  Structure:   ${verdict.structure}`);
  console.log(`  Confluence:  ${verdict.confluence}`);
  console.log(`  Red flags:   ${verdict.redFlags.length ? verdict.redFlags.join("; ") : "none"}`);
  console.log(`\n  Full note: ${verdict.note.slice(0, 300)}\n`);
}

main().catch(console.error);
