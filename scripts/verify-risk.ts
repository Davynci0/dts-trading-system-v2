/**
 * Risk engine verification: SL and TP come from market structure (swings, zones,
 * measured move); ATR decides tradeability; pips are reported, never gated.
 * Run: npx tsx scripts/verify-risk.ts
 */
import { atr } from "../lib/analysis/indicators";
import { computeRiskLevels, MIN_RR } from "../lib/analysis/risk";
import type { Candle } from "../lib/types";
import type { Pivot } from "../lib/analysis/pivots";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!cond) failures++;
}

function mk(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: 1_700_000_000 + i * 900, open: o, high: h, low: l, close: c, volume: 1 };
}
const base: Candle[] = [];
for (let i = 0; i < 60; i++) {
  const c = i % 2 === 0 ? 1.1 : 1.101;
  base.push(mk(i, c, c + 0.001, c - 0.001, c));
}
const A = atr(base)!;
const buf = 0.25 * A;
const piv = (candles: Candle[]) => (index: number, kind: "high" | "low", price: number): Pivot => ({
  index,
  kind,
  price,
  time: candles[index].time,
});
const p = piv(base);
const run = (o: Partial<Parameters<typeof computeRiskLevels>[0]> & Pick<Parameters<typeof computeRiskLevels>[0], "direction" | "entry" | "pivots">) =>
  computeRiskLevels({ instrument: "EUR_USD", candles: base, accountBalance: 10000, ...o });

// ---- A: long, stop under the swing low, target at the swing high ----
const rA = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.0955), p(40, "high", 1.115)] });
console.log("\nA:", JSON.stringify(rA.levels));
check("A: passes", rA.ok, rA.ok ? "ok" : rA.reason);
if (rA.ok) {
  const L = rA.levels;
  check("A: stop = swing low − ATR buffer", Math.abs(L.stopLoss - (1.0955 - buf)) < 1e-9, `SL=${L.stopLoss.toFixed(5)}`);
  check("A: target = swing high", Math.abs(L.takeProfit - 1.115) < 1e-9, `TP=${L.takeProfit}`);
  check("A: bases name the structure", L.stopBasis.startsWith("below swing low") && L.targetBasis.startsWith("swing high"), `${L.stopBasis} | ${L.targetBasis}`);
  check("A: tpSource swing, R ≥ min", L.tpSource === "swing" && L.rMultiple >= MIN_RR, `${L.tpSource} ${L.rMultiple.toFixed(2)}R`);
  check("A: pips reported", Math.abs(L.riskPips - L.stopDistance / 0.0001) < 1e-6, `${L.riskPips.toFixed(1)} pips`);
  check("A: 1% sizing", L.positionUnits === Math.floor(100 / L.stopDistance), `${L.positionUnits}u`);
}

// ---- B: nearest swing high is too close to pay 1:2, so the next structural level is the target ----
const rB = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.0955), p(30, "high", 1.103), p(35, "low", 1.1), p(40, "high", 1.115)] });
check("B: skips past the too-close level to the viable one", rB.ok && Math.abs(rB.levels.takeProfit - 1.115) < 1e-9, rB.ok ? `TP=${rB.levels.takeProfit}` : rB.reason);

// ---- C: an opposing supply zone is a structural target ----
const rC = run({
  direction: "long",
  entry: 1.1,
  pivots: [p(20, "low", 1.0955)],
  zones: [{ kind: "supply", top: 1.114, bottom: 1.112, active: true }],
});
check("C: target is the supply zone edge", rC.ok && rC.levels.tpSource === "zone" && Math.abs(rC.levels.takeProfit - 1.112) < 1e-9, rC.ok ? rC.levels.targetBasis : rC.reason);
const rC2 = run({
  direction: "long",
  entry: 1.1,
  pivots: [p(20, "low", 1.0955)],
  zones: [{ kind: "supply", top: 1.114, bottom: 1.112, active: false }],
});
check("C: an invalidated zone is ignored", !(rC2.ok && rC2.levels.tpSource === "zone"), rC2.ok ? rC2.levels.tpSource : rC2.reason);

// ---- D: nothing ahead (fresh highs) → measured move of the last impulse leg ----
const rD = run({ direction: "long", entry: 1.1, pivots: [p(10, "low", 1.08), p(20, "high", 1.095), p(30, "low", 1.0975)] });
console.log("\nD:", JSON.stringify(rD.levels));
check("D: measured move of last impulse leg", rD.ok && rD.levels.tpSource === "measured_move" && Math.abs(rD.levels.takeProfit - 1.115) < 1e-9, rD.ok ? rD.levels.targetBasis : rD.reason);

// ---- E: structure can't pay 1:2 → skipped, but the levels are still returned for scoring ----
const rE = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.0955), p(30, "high", 1.103)] });
check("E: skipped, names the structure", !rE.ok && rE.reason.includes("structure only pays") && rE.reason.includes("swing"), !rE.ok ? rE.reason : "unexpectedly ok");
check("E: levels still carried", !rE.ok && rE.levels !== null && rE.levels.rMultiple < MIN_RR, !rE.ok ? `${rE.levels?.rMultiple.toFixed(2)}R` : "n/a");

// ---- F: structure puts the stop too far for the volatility → skipped ----
const rF = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.08), p(40, "high", 1.15)] });
check("F: skipped, stop beyond 3× ATR", !rF.ok && rF.reason.includes("puts the stop"), !rF.ok ? rF.reason : "unexpectedly ok");

// ---- G: a swing hugging price is inside the noise, so the stop goes beyond the next swing ----
const rG = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.095), p(28, "high", 1.105), p(35, "low", 1.0998), p(45, "high", 1.13)] });
check("G: stop skips the noise-level swing", rG.ok && Math.abs(rG.levels.stopLoss - (1.095 - buf)) < 1e-9, rG.ok ? `SL=${rG.levels.stopLoss.toFixed(5)}` : rG.reason);
check("G: first viable target past the weak 1.105 level", rG.ok && Math.abs(rG.levels.takeProfit - 1.13) < 1e-9, rG.ok ? `TP=${rG.levels.takeProfit}` : rG.reason);

// ---- H: shorts mirror longs ----
const rH = run({ direction: "short", entry: 1.1, pivots: [p(20, "high", 1.1045), p(40, "low", 1.085)] });
check("H: short stop above swing high, target swing low", rH.ok && rH.levels.stopBasis.startsWith("above swing high") && Math.abs(rH.levels.takeProfit - 1.085) < 1e-9, rH.ok ? `${rH.levels.stopBasis} | ${rH.levels.targetBasis}` : rH.reason);

// ---- I: gold uses the same structure logic; only the pip report is scaled ----
const gold: Candle[] = [];
for (let i = 0; i < 60; i++) {
  const c = i % 2 === 0 ? 4500 : 4510;
  gold.push({ time: 1_700_000_000 + i * 14400, open: c, high: c + 10, low: c - 10, close: c, volume: 1 });
}
const gp = piv(gold);
const rI = computeRiskLevels({
  instrument: "XAU_USD",
  direction: "long",
  entry: 4500,
  candles: gold,
  pivots: [gp(20, "low", 4455), gp(40, "high", 4650)],
  accountBalance: 10000,
});
check("I: gold passes on structure", rI.ok, rI.ok ? "ok" : rI.reason);
if (rI.ok) {
  check("I: gold pip report is price/0.1", Math.abs(rI.levels.riskPips - rI.levels.stopDistance / 0.1) < 1e-6, `${rI.levels.riskPips.toFixed(0)} pips`);
  check("I: gold basis formatted to 2dp", rI.levels.targetBasis === "swing high 4650.00", rI.levels.targetBasis);
}

// ---- J: no structure to anchor a stop ----
const rJ = run({ direction: "long", entry: 1.09, pivots: [p(20, "low", 1.0955), p(40, "high", 1.115)] });
check("J: skipped, nothing below entry", !rJ.ok && rJ.reason.includes("no swing low"), !rJ.ok ? rJ.reason : "unexpectedly ok");

// ---- K: micro swings are not structure ----
const rK = run({ direction: "long", entry: 1.1, pivots: [p(20, "low", 1.0955), p(25, "high", 1.0958), p(28, "low", 1.0956), p(40, "high", 1.115)] });
check("K: stop anchors on real swing, not the 0.3-pip wiggle", rK.ok && Math.abs(rK.levels.stopLoss - (1.0955 - buf)) < 1e-9, rK.ok ? `SL=${rK.levels.stopLoss.toFixed(5)}` : rK.reason);

// ---- L: JPY-quoted pair sizing uses the USD/JPY conversion ----
// A GBP_JPY long risking 1% of $10,000 = $100 with the structural stop in JPY
// must size units = 100 / (stopDistance/USD_JPY), not 100/stopDistance.
{
  const jpy: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const c = i % 2 === 0 ? 200 : 199.85;
    jpy.push({ time: 1_700_000_000 + i * 900, open: c, high: c + 0.1, low: c - 0.1, close: c, volume: 1 });
  }
  const jp = piv(jpy);
  const jpyAtr = atr(jpy)!;
  // swing ~0.6 below entry: stop = 0.6 + 0.25·ATR ≈ 1.5×ATR — inside the [0.5, 3]× band
  const swingLow = 200 - 0.6;
  const rL = computeRiskLevels({
    instrument: "GBP_JPY",
    direction: "long",
    entry: 200,
    candles: jpy,
    pivots: [jp(20, "low", swingLow), jp(40, "high", 203)],
    accountBalance: 10000,
    quoteUsdRate: 1 / 150,
  });
  const stopDist = 0.6 + 0.25 * jpyAtr;
  console.log("\nL:", JSON.stringify(rL.levels));
  check("L: JPY pair passes on structure", rL.ok, rL.ok ? "ok" : rL.reason);
  if (rL.ok) {
    const expected = Math.floor(100 / (stopDist / 150));
    check("L: units convert JPY quote to USD risk", rL.levels.positionUnits === expected, `${rL.levels.positionUnits}u vs ${expected}u`);
    check("L: JPY pip report uses 0.01", Math.abs(rL.levels.riskPips - rL.levels.stopDistance / 0.01) < 1e-6, `${rL.levels.riskPips.toFixed(0)} pips`);
  }
  const rL0 = computeRiskLevels({
    instrument: "GBP_JPY",
    direction: "long",
    entry: 200,
    candles: jpy,
    pivots: [jp(20, "low", swingLow), jp(40, "high", 203)],
    accountBalance: 10000,
    quoteUsdRate: 0, // conversion unavailable
  });
  check("L: missing conversion refuses to size", !rL0.ok && rL0.reason.includes("USD conversion"), !rL0.ok ? rL0.reason : "unexpectedly ok");
}

// ---- M: cross quote (GBP_AUD) sizing uses AUD/USD ----
{
  const aud: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const c = i % 2 === 0 ? 1.95 : 1.9506;
    aud.push({ time: 1_700_000_000 + i * 900, open: c, high: c + 0.0006, low: c - 0.0006, close: c, volume: 1 });
  }
  const ap = piv(aud);
  const audAtr = atr(aud)!;
  const swingLow = 1.95 - 0.0006 - 0.25 * audAtr; // stop lands ~1×ATR away
  const rM = computeRiskLevels({
    instrument: "GBP_AUD",
    direction: "long",
    entry: 1.95,
    candles: aud,
    pivots: [ap(20, "low", swingLow), ap(40, "high", 1.96)],
    accountBalance: 10000,
    quoteUsdRate: 0.65, // AUD/USD
  });
  check("M: cross sizes through AUD/USD", rM.ok, rM.ok ? "ok" : rM.reason);
  if (rM.ok) {
    const expected = Math.floor(100 / (rM.levels.stopDistance * 0.65));
    check("M: units × AUD/USD = $100 risk", rM.levels.positionUnits === expected, `${rM.levels.positionUnits}u vs ${expected}u`);
  }
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
