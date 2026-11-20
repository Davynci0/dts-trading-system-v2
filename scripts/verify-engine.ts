/**
 * Stage 4–6 + 9 verification: deterministic synthetic-chart tests.
 * Run: npx tsx scripts/verify-engine.ts
 */
import type { Candle } from "../lib/types";
import { detectPivots, significantPivots } from "../lib/analysis/pivots";
import { settleSignal } from "../lib/engine/outcomes";
import { compareTrades, formatAge, type OpenTrade, type NewSetup } from "../lib/engine/supersede";
import { atr } from "../lib/analysis/indicators";
import { detectZones, detectZoneEntry, ZONE_ENTRY_WINDOW } from "../lib/analysis/zones";
import { detectTrendlines, trendlineTouch, lineValueAt, lineValueAtTime } from "../lib/analysis/trendlines";
import { classifyStructure, detectStructureEvent } from "../lib/analysis/structure";
import { findFibSetup, inGoldenZone } from "../lib/analysis/fibonacci";
import { findSetForgetSetup, setForgetEntry } from "../lib/analysis/setForget";
import { scoreSetup, type ScoringContext } from "../lib/analysis/scoring";
import { runBacktest } from "../lib/backtest/engine";
import { setupDisposition, signalPairs } from "../lib/engine/scanner";
import { analyzeTopDown, topDownAgrees, topDownOpposes } from "../lib/analysis/topDown";
import { detectHeadShoulders } from "../lib/analysis/headshoulders";
import { goldenZoneHasPoi } from "../lib/analysis/confirmations";
import { inTradingSession, tradingHoursUtc } from "../lib/analysis/session";
import { closedBarCursor } from "../lib/backtest/engine";
import { passesSendGate, selectSignal, sendGateBlock, type SignalCandidate } from "../lib/engine/select";
import type { Pivot } from "../lib/analysis/pivots";

function mk(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: 1_700_000_000 + i * 900, open: o, high: h, low: l, close: c, volume: 1 };
}

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!cond) failures++;
}

// ============ Stage 4: zones ============
// 0-19 flat ~1.1000; 20-21 tight base; 22 bullish impulse; 23-45 away; 46 re-entry; 48 close-through
const Z: Candle[] = [];
for (let i = 0; i < 20; i++) Z.push(mk(i, 1.1, 1.1003, 1.0998, 1.1));
Z.push(mk(20, 1.1, 1.1003, 1.0998, 1.1001));
Z.push(mk(21, 1.1001, 1.1003, 1.0998, 1.1));
Z.push(mk(22, 1.1002, 1.1065, 1.1, 1.1062)); // bullish impulse
for (let i = 23; i <= 45; i++) Z.push(mk(i, 1.1055, 1.1059, 1.1051, 1.1055));
Z.push(mk(46, 1.105, 1.1052, 1.1002, 1.1008)); // dip into zone (touch)
Z.push(mk(47, 1.1008, 1.1012, 1.1004, 1.101));
Z.push(mk(48, 1.101, 1.1011, 1.0994, 1.0995)); // close through bottom → invalidated
for (let i = 49; i < 60; i++) Z.push(mk(i, 1.0995, 1.0997, 1.0992, 1.0995));

const zones = detectZones(Z);
const demand = zones.find((z) => z.kind === "demand");
console.log("\n[zones]", zones.map((z) => `${z.kind} ${z.bottom}-${z.top} touches=${z.touches} active=${z.active}`).join(" | "));
check("zones: demand zone detected", !!demand, demand ? `${demand.bottom}-${demand.top}` : "none");
if (demand) {
  check("zones: box spans base candles", demand.top === 1.1003 && demand.bottom === 1.0998, `${demand.bottom}-${demand.top}`);
  check("zones: re-entry counted as touch", demand.touches === 1, `touches=${demand.touches}`);
  check("zones: invalidated on close-through", !demand.active && demand.invalidatedIndex === 48, `inv@${demand.invalidatedIndex}`);
}

// ============ Zones: base walk must exclude the terminating large candle ============
// A big drop candle sits immediately before a tight base + bullish impulse.
// The old walk-back included that candle in the base, stretching the zone box
// into the opposite swing (and usually tripping the width limit, dropping
// the zone entirely). The box must span ONLY the small-bodied base candles.
{
  const ZB: Candle[] = [];
  for (let i = 0; i < 20; i++) ZB.push(mk(i, 1.2, 1.2003, 1.1998, 1.2)); // flat plateau
  ZB.push(mk(20, 1.2, 1.2003, 1.195, 1.1955)); // LARGE candle right before the base
  ZB.push(mk(21, 1.1955, 1.1958, 1.1952, 1.1956)); // small base candle
  ZB.push(mk(22, 1.1956, 1.1959, 1.1953, 1.1957)); // small base candle
  ZB.push(mk(23, 1.1955, 1.201, 1.1954, 1.2008)); // bullish impulse
  for (let i = 24; i < 40; i++) ZB.push(mk(i, 1.2004, 1.2008, 1.2001, 1.2005)); // price away
  const demandB = detectZones(ZB).find((z) => z.kind === "demand");
  check(
    "zones: base excludes the terminating large candle",
    demandB != null && Math.abs(demandB.top - 1.1959) < 1e-9 && Math.abs(demandB.bottom - 1.1952) < 1e-9,
    demandB ? `${demandB.bottom}-${demandB.top}` : "none"
  );
  check(
    "zones: box starts at the first base candle, not the large one before it",
    demandB?.startIndex === 21 && demandB.startTime === ZB[21].time,
    `start=${demandB?.startIndex}`
  );
}

// ============ Outcome settlement: the entry bar must be evaluated ============
// A signal fires just after a bar close. The NEXT bar is the entry bar; if it
// hits SL immediately that is a real loss. The old open-time comparison skipped
// it entirely, letting later bars rewrite the outcome.
{
  const t0 = 1_700_000_000;
  const firedAt = (t0 + 900) * 1000 + 12_000; // 12s after the source bar closed
  const settle = [
    { time: t0, high: 100, low: 90 }, // source bar: closed before the signal — excluded
    { time: t0 + 900, high: 99, low: 89 }, // entry bar: dips to SL — must count
  ];
  const res = settleSignal({ direction: "long", entry: 95, stop_loss: 90, take_profit: 110, firedAt }, settle);
  check("settlement: entry bar is evaluated (first-bar SL = loss)", res?.outcome === "loss" && res.hitPrice === 90, res ? `${res.outcome}@${res.hitPrice}` : "null");
  // signal fires exactly at the source bar's close: source excluded, entry bar still counts
  const resBoundary = settleSignal({ direction: "long", entry: 95, stop_loss: 90, take_profit: 110, firedAt: (t0 + 900) * 1000 }, settle);
  check("settlement: boundary-close signal still evaluates the entry bar", resBoundary?.outcome === "loss", resBoundary ? resBoundary.outcome : "null");
  // signal fires after the ENTRY bar closed: every candle in range predates it
  // → nothing to settle yet (well within the 7-day expiry)
  const resAfter = settleSignal(
    { direction: "long", entry: 95, stop_loss: 90, take_profit: 110, firedAt: (t0 + 1800) * 1000 + 1000 },
    settle,
    (t0 + 1800) * 1000 + 61_000
  );
  check("settlement: bars closed at/before the signal are excluded", resAfter === null, resAfter ? resAfter.outcome : "null");
}

// ============ Stage 5.1: trendlines ============
// descending resistance through pivot highs (10,1.1100) (25,1.1080) (40,1.1060); touch at last candle
const anchors: [number, number][] = [
  [10, 1.11],
  [25, 1.108],
  [40, 1.106],
];
const slope = (anchors[1][1] - anchors[0][1]) / (anchors[1][0] - anchors[0][0]);
const lineAt = (i: number) => anchors[0][1] + slope * (i - anchors[0][0]);
const T: Candle[] = [];
for (let i = 0; i < 60; i++) {
  const isAnchor = anchors.find(([ai]) => ai === i);
  const distNearest = Math.min(...anchors.map(([ai]) => Math.abs(ai - i)));
  const h = isAnchor ? isAnchor[1] : lineAt(i) - 0.0002 * distNearest;
  const l = h - 0.0004;
  T.push(mk(i, l + 0.0001, h, l, l + 0.0001));
}
// last candle: high exactly on the extended line → touch
const lastH = lineAt(59);
T[59] = mk(59, lastH - 0.0003, lastH, lastH - 0.0004, lastH - 0.0003);

const pivotsT = detectPivots(T);
const atrT = atr(T)!;
const lines = detectTrendlines(T, pivotsT, atrT);
const resistance = lines.find((l) => l.kind === "resistance");
console.log("\n[trendlines]", lines.map((l) => `${l.kind} touches=${l.touches} anchors=${l.anchors.map((a) => a.index).join(",")}`).join(" | "));
check("trendlines: resistance line found", !!resistance, resistance ? `${resistance.touches} touches` : "none");
if (resistance) {
  check("trendlines: >= 3 touches", resistance.touches >= 3, `${resistance.touches}`);
  check(
    "trendlines: line passes through real pivots",
    resistance.anchors.every((p) => Math.abs(p.price - lineValueAt(resistance, p.index)) < 1e-9),
    "anchors on line"
  );
  const touch = trendlineTouch(T, lines, atrT);
  check("trendlines: touch trigger fires short", touch?.direction === "short", touch ? touch.direction : "no trigger");

  const narrow = detectTrendlines(T, pivotsT, atrT, false, 50).find((l) => l.kind === "resistance");
  const wide = detectTrendlines(T, pivotsT, atrT, false, 55).find((l) => l.kind === "resistance");
  check(
    "trendlines: origin remains stable when lookback changes",
    narrow?.origin.index === wide?.origin.index && narrow?.definitionAnchor.index === wide?.definitionAnchor.index,
    `${narrow?.origin.index ?? "none"}->${narrow?.definitionAnchor.index ?? "none"} / ${wide?.origin.index ?? "none"}->${wide?.definitionAnchor.index ?? "none"}`
  );
}

// ============ Top-down: Weekly/Daily bias, H4 action line ============
const U: Candle[] = [];
const uptrendPoints: [number, number][] = [
  [0, 1.01], [5, 1.0], [10, 1.02], [15, 1.005], [20, 1.03], [25, 1.01],
  [30, 1.04], [35, 1.015], [40, 1.05], [45, 1.02], [50, 1.06], [55, 1.025], [60, 1.07],
];
for (let i = 0; i <= 60; i++) {
  let price = uptrendPoints[0][1];
  for (let point = 0; point < uptrendPoints.length - 1; point++) {
    const [x0, y0] = uptrendPoints[point];
    const [x1, y1] = uptrendPoints[point + 1];
    if (i >= x0 && i <= x1) {
      price = y0 + ((y1 - y0) / (x1 - x0)) * (i - x0);
      break;
    }
  }
  U.push(mk(i, price, price + 0.0002, price - 0.0002, price));
}
const topDownU = analyzeTopDown({ weekly: U, daily: U, h4: U, h1: U });
const actionU = topDownU.actionLine;
console.log(
  "\n[top-down]",
  `bias=${topDownU.bias} action=${actionU?.kind ?? "none"} origin=${actionU?.origin.index ?? "none"}`
);
check("top-down: W/D establishes bullish bias", topDownU.bias === "bullish", topDownU.bias);
check("top-down: bullish action is H4 support", actionU?.kind === "support", actionU?.kind ?? "none");
if (actionU) {
  check("top-down: action begins from true lower low", actionU.origin.index === 5, `origin=${actionU.origin.index}`);
  check(
    "top-down: time projection remains straight through defining pivots",
    Math.abs(lineValueAtTime(actionU, actionU.origin.time) - actionU.origin.price) < 1e-9 &&
      Math.abs(lineValueAtTime(actionU, actionU.definitionAnchor.time) - actionU.definitionAnchor.price) < 1e-9,
    `${actionU.origin.index}->${actionU.definitionAnchor.index}`
  );
}
check(
  "top-down: blocks countertrend shorts",
  !topDownAgrees(topDownU, "short") && topDownOpposes(topDownU, "short"),
  "short rejected"
);
const invertedU = U.map((c, index) =>
  mk(index, 2.1 - c.open, 2.1 - c.low, 2.1 - c.high, 2.1 - c.close)
);
// An M15 pullback entry is against H4/H1 by nature — only the weekly vetoes.
const topDownH4Pullback = analyzeTopDown({ weekly: U, daily: U, h4: invertedU, h1: U });
check(
  "top-down: an H4 pullback does not veto a weekly-aligned long",
  topDownAgrees(topDownH4Pullback, "long") && !topDownOpposes(topDownH4Pullback, "long"),
  `weekly=${topDownH4Pullback.weekly} H4=${topDownH4Pullback.h4}`
);
const topDownWeeklyBear = analyzeTopDown({ weekly: invertedU, daily: U, h4: U, h1: U });
check(
  "top-down: an opposing weekly vetoes the long",
  topDownOpposes(topDownWeeklyBear, "long") && !topDownAgrees(topDownWeeklyBear, "long"),
  `weekly=${topDownWeeklyBear.weekly}`
);

// ============ Trendline origin fix: must begin from the TRUE highest high ============
// An isolated true peak (idx 35, 1.1080) plus an unrelated ascending triple
// (idx 5/15/25) that also satisfies 3 touches on its own line. The old
// algorithm picked whichever pair had the most touches, so it could return
// the ascending triple while ignoring the actual highest high entirely.
const O: Candle[] = [];
const originAnchors: [number, number][] = [
  [0, 1.095], [5, 1.1], [10, 1.095], [15, 1.101], [20, 1.095],
  [25, 1.102], [30, 1.095], [35, 1.108], [40, 1.095], [45, 1.106],
  [50, 1.095], [55, 1.104], [60, 1.095],
];
for (let i = 0; i <= 60; i++) {
  let p = 1.095;
  for (let s = 0; s < originAnchors.length - 1; s++) {
    const [x0, y0] = originAnchors[s];
    const [x1, y1] = originAnchors[s + 1];
    if (i >= x0 && i <= x1) {
      p = y0 + ((y1 - y0) / (x1 - x0)) * (i - x0);
      break;
    }
  }
  O.push(mk(i, p, p, p - 0.0003, p));
}
const pivotsO = detectPivots(O);
const atrO = atr(O)!;
const resistanceO = detectTrendlines(O, pivotsO, atrO).find((l) => l.kind === "resistance");
console.log(
  "\n[trendline origin]",
  resistanceO ? `touches=${resistanceO.touches} anchors=${resistanceO.anchors.map((a) => a.index).join(",")}` : "none"
);
check("trendline origin: resistance found", !!resistanceO, resistanceO ? `${resistanceO.touches} touches` : "none");
if (resistanceO) {
  check(
    "trendline origin: includes the true highest high (idx 35, 1.1080)",
    resistanceO.anchors.some((a) => a.index === 35),
    resistanceO.anchors.map((a) => a.index).join(",")
  );
  check(
    "trendline origin: rejects the unrelated ascending triple (5,15,25)",
    !["5", "15", "25"].every((idx) => resistanceO.anchors.some((a) => a.index === Number(idx))),
    resistanceO.anchors.map((a) => a.index).join(",")
  );
}

// ============ Stage 5.2: market structure + BOS ============
// lows (10,1.1000) (30,1.1020); highs (20,1.1040) (40,1.1060) → uptrend;
// pullback 41-58 (no new pivots), then the LAST candle (59) closes above the swing high → BOS long
const S: Candle[] = [];
const zig: [number, number][] = [
  [0, 1.101],
  [10, 1.1],
  [20, 1.104],
  [30, 1.102],
  [40, 1.106],
];
for (let i = 0; i < 60; i++) {
  let p = 1.103;
  for (let s = 0; s < zig.length - 1; s++) {
    if (i >= zig[s][0] && i <= zig[s + 1][0]) {
      const [x0, y0] = zig[s];
      const [x1, y1] = zig[s + 1];
      p = y0 + ((y1 - y0) / (x1 - x0)) * (i - x0);
      break;
    }
  }
  if (i > 40) p = 1.106 - (i - 40) * 0.0001; // mild monotone pullback, no new pivots
  S.push(mk(i, p - 0.0001, p + 0.0003, p - 0.0003, p));
}
// last swing high = candle 40 at 1.1063 (p 1.106 + 0.0003 wick); last candle breaks it
S[59] = mk(59, 1.1042, 1.1068, 1.1041, 1.1066);

const pivotsS = detectPivots(S);
const state = classifyStructure(pivotsS);
const event = detectStructureEvent(S, pivotsS, [], atr(S) ?? undefined);
console.log("\n[structure] state=%s event=%o", state, event);
check("structure: uptrend classified (HH+HL)", state === "uptrend", state);
check("structure: BOS long detected", event?.type === "bos" && event.direction === "long", event ? `${event.type} ${event.direction} @${event.level}` : "none");

// ============ Supply/demand zone strategy ============
// tight base at 20-21, bullish impulse at 22, price away 23-39, then returns
// into the zone at 40-42; candle 42 is a bullish pin bar inside the zone
const D: Candle[] = [];
for (let i = 0; i < 20; i++) D.push(mk(i, 1.1, 1.1003, 1.0998, 1.1));
D.push(mk(20, 1.1, 1.1003, 1.0998, 1.1001));
D.push(mk(21, 1.1001, 1.1003, 1.0998, 1.1));
D.push(mk(22, 1.1002, 1.1065, 1.1, 1.1062)); // impulse
for (let i = 23; i <= 39; i++) D.push(mk(i, 1.1055, 1.1059, 1.1051, 1.1055));
D.push(mk(40, 1.1055, 1.1056, 1.1, 1.1008)); // into the zone
D.push(mk(41, 1.1008, 1.101, 1.0999, 1.1004)); // still inside
D.push(mk(42, 1.1005, 1.1007, 1.0995, 1.1006)); // bullish pin bar inside (long lower shadow, small body, close upper half)

const zonesD = detectZones(D);
const entryD = detectZoneEntry(D, zonesD);
console.log("\n[zones strategy]", entryD ? `${entryD.direction} zone ${entryD.zone.bottom}-${entryD.zone.top} inside=${entryD.candlesInside} touches=${entryD.zone.touches}` : "no entry");
check("zones: entry detected on return to demand zone", entryD?.direction === "long", entryD ? `${entryD.direction} inside=${entryD.candlesInside}` : "none");
if (entryD) {
  check("zones: visit is fresh (inside ≤ window)", entryD.candlesInside >= 1 && entryD.candlesInside <= ZONE_ENTRY_WINDOW, `inside=${entryD.candlesInside}`);

  const ctxD: ScoringContext = {
    instrument: "EUR_USD",
    candles: D,
    htfCandles: D,
    pivots: detectPivots(D),
    atrValue: atr(D)!,
    zones: zonesD,
    fib: null,
  };
  const scoredD = scoreSetup("zones", ctxD);
  console.log("[zones scoring]", scoredD.count, JSON.stringify(scoredD.confirmations));
  check("zones: rejection candle detected in zone", scoredD.confirmations["Rejection candle in zone"] === true, "pin bar");
  check("zones: freshness confirmed (1 touch ≤ 1)", entryD.zone.touches <= 1, `touches=${entryD.zone.touches}`);
  check("zones: fires at 5/6", scoredD.fired && scoredD.count === 5, `count=${scoredD.count}`);
}

// stale visit: price parked inside the zone beyond the entry window → no trigger
const Dstale = [...D, mk(43, 1.1006, 1.1008, 1.1001, 1.1005), mk(44, 1.1005, 1.1007, 1.1002, 1.1003)];
check("zones: stale visit lapses (no trigger after 5 candles inside)", detectZoneEntry(Dstale, detectZones(Dstale)) === null, "candlesInside > window");

// ============ Stage 5.3 + 6: fib golden zone + scoring ============
// swing low (10,1.1000) → swing high (40,1.1100), retrace into the golden zone at 56-58 (RSI below 50), then a bullish pin bar at 59.
const fibSeries = (dropPerBar: number): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    let p: number;
    if (i <= 10) p = 1.104 - (1.104 - 1.1) * (i / 10);
    else if (i <= 40) p = 1.1 + 0.01 * ((i - 10) / 30);
    else if (i <= 55) p = 1.11 - 0.006 * ((i - 40) / 15); // shallow retrace
    else p = 1.104 - dropPerBar * (i - 55); // final leg down into the golden zone
    out.push(mk(i, p - 0.0001, p + 0.00025, p - 0.00025, p));
  }
  return out;
};
const F = fibSeries(0.0005);
// golden zone: 1.11 - 0.618*0.01 = 1.10382 .. 1.11 - 0.786*0.01 = 1.10214
// last candle: bullish pin bar inside the zone, body in direction, lower wick ≥ body, close in upper half
F[59] = mk(59, 1.1035, 1.104, 1.102, 1.1039);

const pivotsF = detectPivots(F);
const atrF = atr(F)!;
const fib = findFibSetup(F, pivotsF, atrF);
console.log("\n[fib]", fib ? `${fib.direction} zone ${fib.goldenBottom.toFixed(5)}-${fib.goldenTop.toFixed(5)}` : "none");
check("fib: long setup found on the retracement", fib?.direction === "long", fib ? fib.direction : "none");
if (fib) {
  // expected bounds from the ACTUAL pivot prices (zig price ± 0.00025 wick):
  // swing high 1.11025, swing low 1.09975
  const hi = 1.11025;
  const lo = 1.09975;
  check(
    "fib: golden zone = 61.8-78.6% of swing",
    Math.abs(fib.goldenTop - (hi - 0.618 * (hi - lo))) < 1e-9 &&
      Math.abs(fib.goldenBottom - (hi - 0.786 * (hi - lo))) < 1e-9,
    `${fib.goldenBottom.toFixed(5)}-${fib.goldenTop.toFixed(5)}`
  );
  check("fib: last candle inside golden zone", inGoldenZone(F, fib), "inGoldenZone");

  const ctx: ScoringContext = {
    instrument: "EUR_USD",
    candles: F,
    htfCandles: F,
    pivots: pivotsF,
    atrValue: atrF,
    zones: detectZones(F),
    fib,
  };
  const noVision = scoreSetup("fibonacci", ctx);
  console.log("[scoring] fib:", noVision.count, JSON.stringify(noVision.confirmations));
  check("scoring: trigger present", noVision.hasTrigger, `count=${noVision.count}`);
  check("scoring: rejection candle detected", noVision.confirmations["Rejection candle in zone"] === true, "pin bar");
  check("scoring: fires at 4/6", noVision.fired && noVision.count === 4, `count=${noVision.count}`);
}

// A retracement that CLOSES below the swing origin has invalidated the swing:
// there is no golden zone left to trade, even if a later candle pokes back up.
{
  const broken = fibSeries(0.0015); // bar 58 closes at 1.0995, under the 1.09975 origin
  broken[59] = mk(59, 1.1035, 1.104, 1.102, 1.1039);
  const fibBroken = findFibSetup(broken, detectPivots(broken), atr(broken)!);
  check("fib: a swing closed through its origin is not a setup", fibBroken === null, fibBroken ? fibBroken.direction : "none");
}

// ============ Alex G set & forget: untested AOI first touch ============
// swing high(20,1.11) → pullback low(28,1.106) → impulse to a higher high
// (40,1.12) that BREAKS the 1.11 swing high. The structure-breaking leg is
// 1.106→1.12, so the AOI is its 50–61.8% retracement = 1.1113–1.1130. Price
// holds above the AOI after the leg until the LAST candle dips in.
const sfSeries = (legHigh: number): Candle[] => {
  const pts: [number, number][] = [
    [0, 1.105], [10, 1.1], [20, 1.11], [28, 1.106], [40, legHigh], [55, legHigh - 0.002],
  ];
  const out: Candle[] = [];
  for (let i = 0; i <= 55; i++) {
    let p = 1.105;
    for (let s = 0; s < pts.length - 1; s++) {
      const [x0, y0] = pts[s];
      const [x1, y1] = pts[s + 1];
      if (i >= x0 && i <= x1) {
        p = y0 + ((y1 - y0) / (x1 - x0)) * (i - x0);
        break;
      }
    }
    out.push(mk(i, p - 0.0001, p + 0.0002, p - 0.0002, p));
  }
  return out;
};
const G = sfSeries(1.12);
// last candle dips into the AOI (low reaches 1.1125) — first touch
G[55] = mk(55, 1.118, 1.1182, 1.1125, 1.1135);

const pivotsG = detectPivots(G);
const atrG = atr(G)!;
const sf = findSetForgetSetup(G, pivotsG, atrG);
console.log("\n[setforget]", sf ? `${sf.direction} AOI ${sf.aoiBottom.toFixed(5)}-${sf.aoiTop.toFixed(5)} tested=${sf.tested}` : "none");
check("setforget: long AOI setup found", sf?.direction === "long", sf ? sf.direction : "none");
if (sf) {
  // actual pivots carry the ±0.0002 wick: high 1.1202, low 1.1058, range 0.0144
  // AOI top = 1.1202 - 0.5·0.0144 = 1.1130; bottom = 1.1202 - 0.618·0.0144 = 1.1113
  check("setforget: AOI is 50–61.8% of the structure-breaking leg", Math.abs(sf.aoiTop - 1.113) < 1e-4 && Math.abs(sf.aoiBottom - 1.1113) < 1e-4, `${sf.aoiBottom.toFixed(5)}-${sf.aoiTop.toFixed(5)}`);
  check("setforget: the leg broke the swing high before it", sf.brokenLevel > 1.11 && sf.brokenLevel < 1.1105 && sf.legHigh.price > sf.brokenLevel, `broke ${sf.brokenLevel.toFixed(5)}`);
  const entry = setForgetEntry(G, sf);
  check("setforget: first touch fires (untested AOI)", entry?.direction === "long", entry ? "long" : "no entry");
  // after a visit, the AOI is spent → no trigger
  const gVisited = [...G, mk(56, 1.1135, 1.114, 1.1128, 1.1132)];
  const sf2 = findSetForgetSetup(gVisited, detectPivots(gVisited), atr(gVisited)!);
  check("setforget: spent AOI does not re-trigger", setForgetEntry(gVisited, sf2) === null, "tested");
}
// a rally that stops SHORT of the prior swing high broke nothing → no AOI
{
  const noBreak = sfSeries(1.1095);
  const sfNone = findSetForgetSetup(noBreak, detectPivots(noBreak), atr(noBreak)!);
  check("setforget: a leg that breaks no structure leaves no AOI", sfNone === null, sfNone ? `${sfNone.direction} AOI` : "none");
}

// ============ Scoring tracks a setup even when the send gate would veto it ============
// Reuse the zones firing context; a bearish weekly must not stop the setup
// being scored and tracked ("fired") — it only clears topDownAligned, which
// the send gate (lib/engine/select.ts) then refuses.
{
  const bearishTopDown = analyzeTopDown({ weekly: invertedU, daily: invertedU, h4: invertedU, h1: invertedU });
  const ctxSolo: ScoringContext = {
    instrument: "EUR_USD",
    candles: D,
    htfCandles: D,
    pivots: detectPivots(D),
    atrValue: atr(D)!,
    zones: detectZones(D),
    fib: null,
    topDown: bearishTopDown,
  };
  const solo = scoreSetup("zones", ctxSolo);
  check("solo fire: fires despite opposing top-down", solo.fired && solo.count >= 3, `count=${solo.count} topDownAligned=${solo.topDownAligned}`);
  check("solo fire: topDownAligned false but fired true (no veto)", solo.fired && !solo.topDownAligned, "no veto");
}

// ============ Zones: an invalidated zone must not suppress a fresh one ============
// Zone A (base 20-21, impulse 22) is closed through at 30. A new base + impulse
// then forms in the SAME price band (40-42). The old two-pass detector still
// saw zone A as active while scanning and dropped the new zone as a duplicate.
{
  const ZR: Candle[] = [];
  for (let i = 0; i < 20; i++) ZR.push(mk(i, 1.1, 1.1003, 1.0998, 1.1));
  ZR.push(mk(20, 1.1, 1.1003, 1.0998, 1.1001));
  ZR.push(mk(21, 1.1001, 1.1003, 1.0998, 1.1));
  ZR.push(mk(22, 1.1002, 1.1065, 1.1, 1.1062)); // impulse → zone A
  for (let i = 23; i < 30; i++) ZR.push(mk(i, 1.1055, 1.1059, 1.1051, 1.1055));
  ZR.push(mk(30, 1.1055, 1.1056, 1.0985, 1.099)); // closes through zone A
  for (let i = 31; i < 40; i++) ZR.push(mk(i, 1.099, 1.0996, 1.0988, 1.0992));
  ZR.push(mk(40, 1.0995, 1.1002, 1.0996, 1.1)); // new base, same band
  ZR.push(mk(41, 1.1, 1.1003, 1.0997, 1.1001));
  ZR.push(mk(42, 1.1002, 1.107, 1.1, 1.1066)); // impulse → zone B
  for (let i = 43; i < 50; i++) ZR.push(mk(i, 1.106, 1.1064, 1.1056, 1.106));
  const zr = detectZones(ZR).filter((z) => z.kind === "demand");
  const live = zr.filter((z) => z.active);
  check(
    "zones: a dead zone does not block a fresh zone in the same band",
    zr.some((z) => !z.active && z.invalidatedIndex === 30) && live.length === 1 && live[0].impulseIndex === 42,
    zr.map((z) => `imp@${z.impulseIndex} active=${z.active}`).join(" | ")
  );
}

// ============ Head & shoulders: only a FRESH neckline break is active ============
{
  const hsCandles = (closes: (i: number) => number): Candle[] =>
    Array.from({ length: 80 }, (_, i) => mk(i, closes(i), closes(i) + 0.0002, closes(i) - 0.0002, closes(i)));
  const at = (candles: Candle[], index: number, kind: Pivot["kind"], price: number): Pivot => ({ index, kind, price, time: candles[index].time });
  const shape = (candles: Candle[]): Pivot[] => [
    at(candles, 10, "high", 1.108),
    at(candles, 20, "low", 1.1),
    at(candles, 30, "high", 1.112),
    at(candles, 40, "low", 1.1),
    at(candles, 50, "high", 1.108),
  ];
  const fresh = hsCandles((i) => (i >= 78 ? 1.099 : 1.105));
  const hsFresh = detectHeadShoulders(fresh, shape(fresh), 0.001);
  check("h&s: fresh close through the neckline is active", hsFresh?.direction === "short" && hsFresh.triggerTime === fresh[78].time, hsFresh ? `short, break@${(hsFresh.triggerTime - fresh[0].time) / 900}` : "none");
  check("h&s: target = neckline minus head height", hsFresh != null && Math.abs(hsFresh.target - (1.1 - 0.012)) < 1e-9, hsFresh ? hsFresh.target.toFixed(4) : "none");
  const stale = hsCandles((i) => (i >= 55 ? 1.099 : 1.105));
  check("h&s: a break 24 bars old is no longer a signal", detectHeadShoulders(stale, shape(stale), 0.001) === null, "stale");
  const failed = hsCandles((i) => (i >= 75 && i < 79 ? 1.099 : 1.105));
  check("h&s: a close back above the neckline cancels the break", detectHeadShoulders(failed, shape(failed), 0.001) === null, "reclaimed");
}

// ============ POI confluence must be independent of the retracement itself ============
{
  const area = { goldenTop: 1.1038, goldenBottom: 1.1021 };
  const poi = (o: Partial<Parameters<typeof goldenZoneHasPoi>[1]>) =>
    goldenZoneHasPoi(area, { direction: "long", zones: [], pivots: [], legStartIndex: 100, instrument: "EUR_USD", atrValue: 0.001, ...o });
  check("poi: nothing nearby → no confluence", !poi({}), "false");
  check("poi: a swing printed during the retracement does not count", !poi({ pivots: [{ price: 1.103, index: 130 }] }), "after leg start");
  check("poi: a swing level from before the leg counts", poi({ pivots: [{ price: 1.103, index: 60 }] }), "prior level");
  check("poi: a demand zone under a long counts", poi({ zones: [{ kind: "demand", top: 1.103, bottom: 1.1025, active: true }] }), "same side");
  check("poi: an opposing supply zone is not confluence", !poi({ zones: [{ kind: "supply", top: 1.103, bottom: 1.1025, active: true }] }), "opposing");
  check("poi: a round number inside counts", goldenZoneHasPoi({ goldenTop: 1.1008, goldenBottom: 1.0992 }, { direction: "long", zones: [], pivots: [], legStartIndex: 0, instrument: "EUR_USD", atrValue: 0.001 }), "1.1000");
  check(
    "poi: gold uses a $25 grid, not $5",
    !goldenZoneHasPoi({ goldenTop: 4112, goldenBottom: 4104 }, { direction: "long", zones: [], pivots: [], legStartIndex: 0, instrument: "XAU_USD", atrValue: 5 }) &&
      goldenZoneHasPoi({ goldenTop: 4128, goldenBottom: 4122 }, { direction: "long", zones: [], pivots: [], legStartIndex: 0, instrument: "XAU_USD", atrValue: 5 }),
    "4105/4110 ignored, 4125 counts"
  );
}

// ============ Trading session gate ============
{
  const utc = (h: number, m = 0) => Date.UTC(2026, 10, 18, h, m) / 1000;
  check("session: default window is 12:00–21:00 UTC", tradingHoursUtc(undefined).join("-") === "12-21", tradingHoursUtc(undefined).join("-"));
  check("session: New York hours are tradeable", inTradingSession(utc(12), [12, 21]) && inTradingSession(utc(20, 45), [12, 21]), "12:00, 20:45");
  check("session: Asia and rollover are not", !inTradingSession(utc(3), [12, 21]) && !inTradingSession(utc(21), [12, 21]), "03:00, 21:00");
  check("session: override parses, garbage falls back", tradingHoursUtc("6-21").join("-") === "6-21" && tradingHoursUtc("soon").join("-") === "12-21", "6-21 / default");
  check("session: a window may wrap midnight; 0-24 disables", inTradingSession(utc(1), [22, 4]) && !inTradingSession(utc(12), [22, 4]) && inTradingSession(utc(3), [0, 24]), "22-4, 0-24");
}

// ============ Backtest: higher timeframes may only use CLOSED bars ============
{
  const h1 = [0, 3600, 7200].map((t, i) => ({ ...mk(i, 1, 1, 1, 1), time: t }));
  const closed = closedBarCursor(h1, 3600);
  const seen = [closed(900), closed(3599), closed(3600), closed(7199), closed(10800)];
  check("backtest: a forming HTF bar is never visible", seen.join(",") === "0,0,1,1,3", seen.join(","));
}

// ============ Send gate + selection (shared by scanner and backtest) ============
{
  const cand = (direction: "long" | "short", o: Partial<SignalCandidate["scored"]> = {}, riskOk = true): SignalCandidate => ({
    strategy: "zones",
    direction,
    scored: {
      strategy: "zones", direction, confirmations: {}, count: 4, fired: true,
      topDownAligned: true, m15Aligned: true, inSession: true, hasTrigger: true, trigger: null, ...o,
    },
    risk: riskOk
      ? { ok: true, levels: { direction, entry: 1, stopLoss: 0.99, takeProfit: 1.03, stopDistance: 0.01, rMultiple: 3, atr: 0.005, positionUnits: 1, riskAmount: 1, tpSource: "swing", stopBasis: "", targetBasis: "", riskPips: 100, rewardPips: 300 } }
      : { ok: false, reason: "structure only pays 1.20R", levels: null },
  });
  check("gate: a complete setup may be sent", passesSendGate(cand("long"), 4), "ok");
  check("gate: below the confirmation minimum is held", !passesSendGate(cand("long"), 5), sendGateBlock(cand("long"), 5) ?? "");
  check("gate: outside the session is held", /session/.test(sendGateBlock(cand("long", { inSession: false }), 4) ?? ""), sendGateBlock(cand("long", { inSession: false }), 4) ?? "");
  check("gate: against the weekly is held", /weekly/.test(sendGateBlock(cand("long", { topDownAligned: false }), 4) ?? ""), sendGateBlock(cand("long", { topDownAligned: false }), 4) ?? "");
  check("gate: failed risk reports the risk reason", sendGateBlock(cand("long", {}, false), 4) === "structure only pays 1.20R", "risk reason");
  const both = selectSignal([cand("long"), cand("short")], topDownU);
  check("select: HTF bias settles a long/short conflict", both?.side === "long" && both.winners.length === 1, both ? both.side : "none");
  const stronger = selectSignal([cand("long", { count: 4 }), cand("short", { count: 6 })]);
  check("select: without a bias the stronger side wins", stronger?.side === "short", stronger ? stronger.side : "none");
  check("select: nothing to select from → null", selectSignal([]) === null, "null");
}

// ============ Stage 9: backtest engine smoke ============
// seeded sine-wave series with structure; assert no crash + consistent metrics
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const B: Candle[] = [];
let price = 1.1;
for (let i = 0; i < 600; i++) {
  const wave = Math.sin(i / 9) * 0.0007;
  const noise = (rand() - 0.5) * 0.0003;
  const next = 1.1 + 0.004 * Math.sin(i / 45) + wave + noise;
  const h = Math.max(price, next) + 0.0002;
  const l = Math.min(price, next) - 0.0002;
  B.push(mk(i, price, h, l, next));
  price = next;
}
const report = runBacktest({ pair: "EUR_USD", timeframe: "M15", candles: B, htfCandles: B });
const comb = report.scopes.combined;
console.log("\n[backtest] trades IS=%d OOS=%d", comb.inSample.trades, comb.outOfSample.trades);
check("backtest: runs without crashing", report.candles === 600, `${report.candles} candles`);
check("backtest: scopes present", ["combined", "strategy:zones", "strategy:setforget", "strategy:fibonacci"].every((k) => report.scopes[k]), Object.keys(report.scopes).join(","));
check("backtest: metrics consistent", comb.inSample.wins <= comb.inSample.trades && comb.inSample.confidence3 + comb.inSample.confidence4 + comb.inSample.confidence5 <= comb.inSample.trades + 1, "buckets ≤ trades");
check("backtest: limitation noted", report.limitation.includes("6-point checklist"), "deterministic 6-point checklist documented");

// ============ Scanner state machine: a considered-but-not-sent setup is never silenced ============
// Regression test for the bug that zeroed the live feed: setups were marked
// signaled merely for crossing the watch threshold, so they could never fire at
// the strategy minimum. Signals mark signaled; skips must not.
{
  const prior = (over: Partial<{ signaled: boolean; lastSkip: string | null }> | null) =>
    over ? { signaled: false, lastSkip: null, ...over } : null;
  // below minimum → not a send candidate
  check(
    "scanner: below strategy minimum stays watch-only",
    setupDisposition(3, prior(null), 5).eligible === false && setupDisposition(3, prior(null), 5).signaled === false,
    "3 vs min 5"
  );
  // at minimum, never signaled → candidate
  check("scanner: at minimum is a send candidate", setupDisposition(5, prior(null), 5).eligible === true, "5 vs min 5");
  // skipped for risk (lastSkip set, still not signaled) → STILL a candidate next scan
  const afterSkip = setupDisposition(5, prior({ lastSkip: "structure only pays 1.40R" }), 5);
  check("scanner: risk-skip does not silence the setup", afterSkip.eligible === true && afterSkip.lastSkip === "structure only pays 1.40R", "eligible again");
  // skipped while a trade was open → STILL a candidate next scan
  check(
    "scanner: open-trade skip does not silence the setup",
    setupDisposition(5, prior({ lastSkip: "a trade is already open on XAU_USD — holding" }), 5).eligible === true,
    "eligible again"
  );
  // once a signal was actually sent → done, forever
  const afterSend = setupDisposition(6, prior({ signaled: true }), 5);
  check("scanner: sent signal permanently dedupes the setup", afterSend.eligible === false && afterSend.signaled === true, "signaled wins");
  // firmirin confluence-grade minimum: 5 is NOT enough, 6 is
  check("scanner: fibonacci 6-point gate", setupDisposition(5, prior(null), 6).eligible === false && setupDisposition(6, prior({ lastSkip: "x" }), 6).eligible === true, "5<6 gates");
  // only research-validated pairs may SEND signals; the rest stay watch-only
  check(
    "scanner: default signal pairs are the researched ones",
    signalPairs(undefined).has("XAU_USD") && signalPairs(undefined).has("GBP_AUD") && !signalPairs(undefined).has("EUR_JPY"),
    `[${[...signalPairs(undefined)].join(",")}]`
  );
  check(
    "scanner: SIGNAL_PAIRS override is respected",
    !signalPairs("XAU_USD,GBP_JPY").has("EUR_JPY") && signalPairs("XAU_USD,GBP_JPY").has("GBP_JPY"),
    "override list respected"
  );
}
{
  const perStrategy = runBacktest({
    pair: "EUR_USD",
    timeframe: "M15",
    candles: B,
    htfCandles: B,
    minConfidence: { zones: 99, setforget: 3, fibonacci: 3 },
    strategies: ["zones", "setforget", "fibonacci"],
  });
  check(
    "backtest: per-strategy confidence thresholds gate entry",
    perStrategy.trades.every((t) => t.strategy !== "zones"),
    `${perStrategy.trades.length} trades, zones blocked at 99`
  );
  const oneAtATime = runBacktest({
    pair: "EUR_USD",
    timeframe: "M15",
    candles: B,
    htfCandles: B,
    minConfidence: 3,
    oneTradePerPair: true,
  });
  let overlap = 0;
  for (const t of oneAtATime.trades as { entryIndex: number; exitIndex: number }[]) {
    if (oneAtATime.trades.some((o) => o !== t && o.entryIndex < t.exitIndex && t.entryIndex < o.exitIndex)) overlap++;
  }
  check("backtest: oneTradePerPair never overlaps positions", overlap === 0, `${oneAtATime.trades.length} trades, ${overlap} overlapping`);
}

// ============ significantPivots: zigzag keeps real swings, collapses noise ============
{
  const P = (index: number, kind: "high" | "low", price: number) => ({ index, time: 1000 + index, kind, price });
  const rising = significantPivots([P(20, "low", 1.0955), P(30, "high", 1.104), P(35, "low", 1.099), P(40, "high", 1.115)], 0.002);
  check("significantPivots: rising structure keeps every swing", rising.map((x) => x.kind).join(",") === "low,high,low,high", rising.map((x) => x.kind).join(","));
  const noise = significantPivots([P(1, "low", 1.1), P(5, "high", 1.1004), P(9, "low", 1.0999), P(15, "high", 1.12)], 0.002);
  check("significantPivots: sub-0.5-ATR wiggles collapse", noise.length === 2 && noise[0].price === 1.0999 && noise[1].price === 1.12, noise.map((x) => x.price).join(","));
  const alt = significantPivots([P(1, "low", 1.09), P(5, "low", 1.085), P(9, "high", 1.1)], 0.002);
  check("significantPivots: consecutive same-kind pivots keep the extreme", alt.length === 2 && alt[0].price === 1.085, alt.map((x) => x.price).join(","));
}

// ============ supersede: a stale open trade vs a fresh setup ============
{
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const DAY = 86_400_000;
  const oldTrade: OpenTrade = {
    id: "old",
    created_at: new Date(now - 6 * DAY).toISOString(),
    direction: "long",
    entry: 1.1,
    stop_loss: 1.095,
    take_profit: 1.115,
    confidence: 3,
    strategy: "fibonacci",
  };
  const better: NewSetup = { direction: "long", rMultiple: 3, riskPips: 40, rewardPips: 120, confidence: 4, label: "Market Structure", aligned: true };
  const run = (price: number, next: NewSetup, oldAligned = false, old = oldTrade) =>
    compareTrades({ old, oldLabel: "Fibonacci Retracement", oldAligned, next, price, pip: 0.0001, now });

  const stalled = run(1.101, better);
  check("supersede: stalled trade is replaced by a clearly better setup", stalled?.replace === true && stalled.points === 4, `${stalled?.replace} ${stalled?.points}/4`);
  check("supersede: explanation uses the real payoff numbers", !!stalled?.text.includes("risk 60 pips to make 140 pips") && !!stalled.text.includes("3.0R"), (stalled?.text.split("\n")[2] ?? "").slice(0, 80));
  check("supersede: explanation states age and confirmations", !!stalled?.text.includes("open 6d") && !!stalled.text.includes("3/5 on the old setup against 4/5"), "age + confirmations present");

  const working = run(1.109, better);
  check("supersede: a trade past halfway is never retired", working?.replace === false && !!working.text.includes("working"), `${working?.replace}`);

  const weaker = run(1.101, { ...better, rMultiple: 1.8, confidence: 3 }, true);
  check("supersede: a worse setup does not replace it", weaker?.replace === false, `${weaker?.replace} ${weaker?.points}/4`);

  check("supersede: nothing to compare once TP is reached", run(1.116, better) === null, "null");
  check("supersede: nothing to compare once SL is reached", run(1.094, better) === null, "null");

  const flip = run(1.098, { ...better, direction: "short" });
  check("supersede: an opposite-direction setup is labelled as such", !!flip?.text.includes("(opposite direction)"), flip?.text.split("\n")[0] ?? "none");
  check("supersede: a trade going against it reports pips toward the stop", !!flip?.text.includes("against it"), "against it");

  check("supersede: formatAge", formatAge(5) === "5h" && formatAge(24) === "1d" && formatAge(53) === "2d 5h", `${formatAge(5)} ${formatAge(24)} ${formatAge(53)}`);

  check(
    "supersede: each factor is marked and the verdict names what decided it",
    !!stalled?.text.includes("✓ It has stalled") && !!stalled.text.includes("(it has stalled, better payoff, more confirmations, structure agrees)"),
    (stalled?.text.split("\n").pop() ?? "").slice(0, 110)
  );
  check("supersede: a working trade shows a ✗ mark", !!working?.text.includes("✗ It is working"), "✗ present");

  // the real USD/JPY case: a 183-pip swing was retired for a 41-pip setup. That is now blocked.
  const jpy: OpenTrade = { id: "j", created_at: new Date(now - 5 * DAY).toISOString(), direction: "short", entry: 158.276, stop_loss: 159.16, take_profit: 156.375, confidence: 4, strategy: "fibonacci" };
  const jpyNew: NewSetup = { direction: "short", rMultiple: 2.96, riskPips: 14, rewardPips: 41, confidence: 4, label: "Fibonacci Retracement", aligned: true };
  const jpyCmp = compareTrades({ old: jpy, oldLabel: "Fibonacci Retracement", oldAligned: true, next: jpyNew, price: 158.206, pip: 0.01, now });
  check("supersede: a swing is not swapped for a much smaller same-direction setup", jpyCmp?.replace === false && !!jpyCmp.text.includes("swap a swing trade for a smaller one"), `${jpyCmp?.replace} ${jpyCmp?.points}/4`);
  const jpyBig = compareTrades({ old: jpy, oldLabel: "Fibonacci Retracement", oldAligned: true, next: { ...jpyNew, rewardPips: 160, riskPips: 50, rMultiple: 3.2 }, price: 158.206, pip: 0.01, now });
  check("supersede: the same pair is replaceable when the new setup is comparable in size", jpyBig?.replace === true, `${jpyBig?.replace} ${jpyBig?.points}/4`);
  const flipSmall = compareTrades({ old: jpy, oldLabel: "Fibonacci Retracement", oldAligned: false, next: { ...jpyNew, direction: "long", rewardPips: 41, aligned: true }, price: 158.206, pip: 0.01, now });
  check("supersede: the size guard does not block a reversal", !!flipSmall && !flipSmall.text.includes("swap a swing trade"), "opposite direction exempt");
}

console.log(failures === 0 ? "\nALL ENGINE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
