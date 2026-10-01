/**
 * Live-data trendline quality check: prints each detected line and verifies
 * the envelope rule (no pivot pokes through a live line).
 * Run: node --env-file=.env.local --import tsx scripts/check-trendlines.ts
 */
import { fetchCandles } from "../lib/oanda";
import { detectPivots } from "../lib/analysis/pivots";
import { atr } from "../lib/analysis/indicators";
import { detectTrendlines, lineValueAtTime, TOUCH_TOLERANCE_ATR } from "../lib/analysis/trendlines";

async function main() {
  let violations = 0;
  // Gold-only system now: verify the trendline envelope on every timeframe we trade.
  const checks: [string, string][] = [
    ["XAU_USD", "M5"],
    ["XAU_USD", "M15"],
    ["XAU_USD", "H1"],
    ["XAU_USD", "H4"],
    ["XAU_USD", "D"],
  ];
  for (const [pair, tf] of checks) {
    const candles = await fetchCandles({ instrument: pair, granularity: tf, count: 500 });
    const pivots = detectPivots(candles);
    const a = atr(candles, 14)!;
    const lines = detectTrendlines(candles, pivots, a, false);
    const digits = pair.startsWith("XAU") ? 2 : pair.includes("JPY") ? 3 : 5;
    console.log(`\n${pair} ${tf} (${candles.length} candles, ${pivots.length} pivots, ATR ${a.toFixed(digits)}):`);
    if (lines.length === 0) console.log("  (no lines)");
    for (const l of lines) {
      console.log(
        `  ${l.kind} ${l.broken ? "[BROKEN]" : "[live]"} touches=${l.touches}` +
          ` origin idx ${l.origin.index} @ ${l.origin.price.toFixed(digits)}` +
          ` -> def idx ${l.definitionAnchor.index} @ ${l.definitionAnchor.price.toFixed(digits)}` +
          ` anchors [${l.anchors.map((p) => p.index).join(",")}]`
      );
      const tol = TOUCH_TOLERANCE_ATR * a;
      const bad = pivots.filter(
        (p) =>
          p.index >= l.origin.index &&
          p.index <= l.lastAnchorIndex &&
          (l.kind === "resistance"
            ? p.price > lineValueAtTime(l, p.time) + tol
            : p.price < lineValueAtTime(l, p.time) - tol)
      );
      if (bad.length) {
        violations++;
        console.log(`   !! envelope violations at pivots: ${bad.map((p) => p.index).join(",")}`);
      }
    }
  }
  console.log(violations === 0 ? "\nENVELOPE CLEAN — no pivot pokes through any live line" : `\n${violations} LINE(S) VIOLATE THE ENVELOPE`);
  process.exit(violations === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
