/**
 * Checks for the trend system: the filters, the entries, the trailing stop,
 * the settlement of open trades and the backtest.
 * Usage: npx tsx scripts/verify-trend.ts
 */
import type { Candle } from "../lib/types";
import {
  buildTrendSeries,
  entryTriggers,
  trailThrough,
  trendSetupsAt,
  trendStateAt,
  trendWatchAt,
  TREND_EMA_BARS,
  TREND_FAST_DAYS,
  TREND_SLOW_DAYS,
  TREND_ENTRIES,
  TREND_STOP_ATR,
  TREND_TRAIL_ATR,
} from "../lib/analysis/trend";
import { runTrendBacktest } from "../lib/backtest/trend";
import { settleTrailing } from "../lib/engine/outcomes";
import { trendLevels, TREND_RISK_PCT } from "../lib/engine/trendScanner";
import { tradeCost } from "../lib/analysis/instruments";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!cond) failures++;
}

const DAY = 86400;
const H4 = 4 * 3600;
const D0 = Date.UTC(2025, 0, 1, 22) / 1000;
const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: 1 });

// (the candles below are spaced four hours apart; the rules read the bar length from the candles)
/** `n` daily candles moving `step` a day from 3000. */
const days = (n: number, step: number, from = 3000): Candle[] =>
  Array.from({ length: n }, (_, i) => bar(D0 + i * DAY, from + step * i, from + step * i + 6, from + step * i - 6, from + step * i));
const up = days(160, 2);
const down = days(160, -2, 3600);
/** A long rise and then `n` days of sharp falls: for some `n` the fast trend has turned down while the slow one is still up. */
const riseThenFall = (n: number) => [...days(150, 2), ...Array.from({ length: n }, (_, i) => bar(D0 + (150 + i) * DAY, 3298 - 8 * i, 3304 - 8 * i, 3288 - 8 * i, 3290 - 8 * i))];

/** 460 quiet candles swinging ±4 around 3320 — enough for the 400-candle average — starting once the daily averages exist. */
const H0 = D0 + 160 * DAY;
const quiet: Candle[] = Array.from({ length: 460 }, (_, i) => {
  const c = 3320 + 4 * Math.sin(i / 2);
  const o = 3320 + 4 * Math.sin((i - 1) / 2);
  return bar(H0 + i * H4, o, Math.max(o, c) + 1.5, Math.min(o, c) - 1.5, c);
});
const breakUp = bar(H0 + 460 * H4, quiet[459].close, 3331, quiet[459].close - 1, 3330);
const withBreak = [...quiet, breakUp];

// ───────── filters ─────────
{
  const s = buildTrendSeries(withBreak, up);
  const i = s.n - 1;
  const st = trendStateAt(s, i);
  check("filters: both daily trends up and price above its long average allow buys", st.fast === 1 && st.slow === 1 && st.emaAgrees && st.side === "long" && st.blocked === null, `fast ${st.fast} slow ${st.slow} close ${s.c[i]} vs average ${st.ema.toFixed(1)}`);

  const sd = trendStateAt(buildTrendSeries(withBreak, down), i);
  check("filters: with both daily trends down, a close above the long average is not sold", sd.fast === -1 && sd.side === null && !!sd.blocked?.includes(`${TREND_EMA_BARS}-candle average`), `${sd.blocked}`);

  const below = [...quiet, ...Array.from({ length: 30 }, (_, k) => bar(H0 + (460 + k) * H4, 3296, 3298, 3293, 3295))];
  const sb = buildTrendSeries(below, down);
  check("filters: both daily trends down and price below its long average allow sells", trendStateAt(sb, sb.n - 1).side === "short", `${trendStateAt(sb, sb.n - 1).side}`);
  const su = trendStateAt(buildTrendSeries(below, up), below.length - 1);
  check("filters: in an uptrend, price below its long average blocks buys", su.side === null && !!su.blocked?.includes("below"), `${su.blocked}`);

  const disagree = [1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => trendStateAt(buildTrendSeries(withBreak, riseThenFall(n)), i)).find((x) => x.fast === -1 && x.slow === 1);
  check(`filters: ${TREND_FAST_DAYS}-day and ${TREND_SLOW_DAYS}-day trends that disagree block every entry`, !!disagree && disagree.side === null && !!disagree.blocked?.includes("disagree"), disagree ? `${disagree.blocked}` : "no such case built");

  const young = buildTrendSeries(withBreak.slice(-200), up);
  check("filters: too few candles for the long average means no trade", trendStateAt(young, young.n - 1).side === null && trendSetupsAt(young, young.n - 1).length === 0, `${trendStateAt(young, young.n - 1).blocked}`);
}

// ───────── entries ─────────
{
  const s = buildTrendSeries(withBreak, up);
  const i = s.n - 1;
  const setups = trendSetupsAt(s, i);
  const ids = setups.map((x) => x.id);
  check("entries: a close above the range fires every channel breakout", ["don20", "don30", "don60", "don120", "don240"].every((id) => ids.includes(id)), ids.join(","));
  check("entries: a setup carries the stop and the trailing distance in ATRs", setups.every((x) => Math.abs(x.stopDistance - TREND_STOP_ATR * s.atr[i]) < 1e-9 && Math.abs(x.trailDistance - TREND_TRAIL_ATR * s.atr[i]) < 1e-9 && x.direction === "long" && x.price === 3330), `stop ${setups[0]?.stopDistance.toFixed(2)}`);
  check("entries: the same break against the daily trend is not taken", trendSetupsAt(buildTrendSeries(withBreak, down), i).length === 0, "none");
  check("entries: the trailing distance is wider than the stop", TREND_TRAIL_ATR > TREND_STOP_ATR, `${TREND_STOP_ATR} / ${TREND_TRAIL_ATR} ATR`);
  check("entries: nothing fires while price is inside the range", trendSetupsAt(buildTrendSeries(quiet, up), quiet.length - 1).every((x) => !x.id.startsWith("don")), "no channel entry");

  const held = [...withBreak, bar(H0 + 461 * H4, 3330, 3334, 3329, 3333)];
  const sh = buildTrendSeries(held, up);
  check("entries: a second close beyond the range is not a new breakout", !entryTriggers(sh, "don20", sh.n - 1, 1), "already broken");

  // momentum: the break candle closed far more than 1 ATR beyond the previous close
  check("entries: a candle closing more than 1 ATR beyond the last close is a momentum entry", ids.includes("impulse1") && s.c[i] - s.c[i - 1] > s.atr[i - 1], `move ${(s.c[i] - s.c[i - 1]).toFixed(1)} vs ATR ${s.atr[i - 1].toFixed(1)}`);

  // pullback to the 20 EMA: dip through it, close back above, bullish candle, previous close above
  const base = quiet.slice(0, 200).map((c, k) => bar(c.time, 3300 + k * 0.5, 3300 + k * 0.5 + 2, 3300 + k * 0.5 - 2, 3300 + k * 0.5 + 0.4));
  const sb = buildTrendSeries(base, up);
  const e20 = sb.ema20[sb.n - 1];
  const dip = [...base, bar(H0 + 200 * H4, e20 + 1, e20 + 3, e20 - 1, e20 + 2.5)];
  const sp = buildTrendSeries(dip, up);
  check("entries: a dip to the 20 EMA that closes back above it is a pullback entry", entryTriggers(sp, "ema20pb", sp.n - 1, 1) && !entryTriggers(sp, "ema20pb", sp.n - 1, -1), `ema ${e20.toFixed(1)}`);

  // inside bar, then a close above the candle that contained it
  const mother = bar(H0 + 461 * H4, 3330, 3336, 3326, 3331);
  const insideBar = bar(H0 + 462 * H4, 3331, 3334, 3328, 3332);
  const out = bar(H0 + 463 * H4, 3332, 3339, 3331, 3338);
  const si = buildTrendSeries([...withBreak, mother, insideBar, out], up);
  check("entries: a close beyond the candle that held an inside bar is an inside-bar entry", entryTriggers(si, "inside", si.n - 1, 1), "close 3338 > 3336");

  const watch = trendWatchAt(s, i);
  check("tracker: every entry reports what it is waiting for", watch.length === TREND_ENTRIES.length && watch.find((w) => w.id === "don20")?.level === 3331, `don20 level ${watch.find((w) => w.id === "don20")?.level}`);
}

// ───────── the trailing stop ─────────
{
  const b = (time: number, o: number, h: number, l: number) => ({ time, open: o, high: h, low: l });
  const rise = trailThrough("long", 90, 10, [b(1, 100, 104, 99), b(2, 104, 112, 103), b(3, 112, 113, 108)]);
  check("trail: the stop follows the best price at a fixed distance and never moves back", rise.exit === null && rise.stop === 103, `stop ${rise.stop}`);
  const hit = trailThrough("long", 103, 10, [b(4, 108, 109, 102)]);
  check("trail: a touch of the stop closes the trade there", hit.exit?.price === 103 && hit.exit.time === 4, `exit ${hit.exit?.price}`);
  const sameBar = trailThrough("long", 103, 10, [b(4, 110, 125, 102)]);
  check("trail: the stop is tested before the same candle's high may move it", sameBar.exit?.price === 103, `exit ${sameBar.exit?.price}`);
  const gap = trailThrough("long", 103, 10, [b(4, 98, 99, 95)]);
  check("trail: a gap through the stop fills at the open", gap.exit?.price === 98, `exit ${gap.exit?.price}`);
  const short = trailThrough("short", 110, 10, [b(1, 100, 101, 92), b(2, 93, 103, 92)]);
  check("trail: a short mirrors it", short.exit?.price === 102 && short.stop === 102, `stop ${short.stop} exit ${short.exit?.price}`);
}

// ───────── settling open trades ─────────
{
  const m = (min: number, o: number, h: number, l: number, c: number) => ({ time: 1_800_000_000 + min * 60, open: o, high: h, low: l, close: c });
  const fired = (1_800_000_000 + 10) * 1000; // ten seconds into the first candle
  const base = { direction: "long" as const, entry: 100, stop_loss: 90, trail_distance: 10, trail_stop: 90, checkedAt: fired, firedAt: fired };
  const open = settleTrailing(base, [m(0, 100, 106, 99, 105), m(15, 105, 111, 104, 110)], fired + 3600_000);
  check("settle: an open trade keeps running and remembers its stop", open.settlement === null && open.trailStop === 101 && open.checkedAt === (1_800_000_000 + 30 * 60) * 1000, `stop ${open.trailStop}`);
  const win = settleTrailing({ ...base, trail_stop: open.trailStop, checkedAt: open.checkedAt }, [m(15, 105, 111, 104, 110), m(30, 110, 112, 100, 101)], fired + 7200_000);
  check("settle: only candles after the last check are followed; a stop trailed into profit is a win", win.settlement?.outcome === "win" && Math.abs(win.settlement.r - 0.1) < 1e-9 && win.settlement.hitPrice === 101, `${win.settlement?.outcome} ${win.settlement?.r.toFixed(2)}R`);
  const loss = settleTrailing(base, [m(0, 100, 101, 89, 90)], fired + 3600_000);
  check("settle: the entry candle counts, and the initial stop is a full loss", loss.settlement?.outcome === "loss" && loss.settlement.r === -1, `${loss.settlement?.outcome} ${loss.settlement?.r}R`);
  const old = settleTrailing(base, [m(0, 100, 104, 99, 103)], fired + 100 * 86400_000);
  check("settle: a trade still open after 12 weeks is closed at market", old.settlement?.outcome === "expired" && Math.abs(old.settlement.r - 0.3) < 1e-9, `${old.settlement?.outcome} ${old.settlement?.r.toFixed(2)}R`);
}

// ───────── backtest and sizing ─────────
{
  const after = Array.from({ length: 30 }, (_, k) => bar(H0 + (461 + k) * H4, 3330 + 2 * k, 3334 + 2 * k, 3329 + 2 * k, 3332 + 2 * k));
  const fall = Array.from({ length: 16 }, (_, k) => bar(H0 + (491 + k) * H4, 3390 - 6 * k, 3391 - 6 * k, 3383 - 6 * k, 3384 - 6 * k));
  const series = [...withBreak, ...after, ...fall];
  const trades = runTrendBacktest({ pair: "XAU_USD", candles: series, daily: up });
  const first = trades.find((t) => t.entryId === "don20");
  check("backtest: a signal fills at the next candle's open plus the full cost", !!first && Math.abs(first.entry - (after[0].open + tradeCost("XAU_USD"))) < 1e-9, first ? `entry ${first.entry}` : "no trade");
  check("backtest: the rise is ridden and the trailing stop takes the profit", !!first && first.outcome === "trail" && first.rAchieved > 1, first ? `${first.outcome} ${first.rAchieved.toFixed(2)}R` : "no trade");
  const overlap = trades.some((a) => trades.some((b) => a !== b && a.entryId === b.entryId && a.entryTime < b.exitTime && b.entryTime < a.exitTime));
  check("backtest: an entry type never holds two positions at once", !overlap && trades.length > 3, `${trades.length} trades`);

  const setup = trendSetupsAt(buildTrendSeries(withBreak, up), withBreak.length - 1)[0];
  const lv = trendLevels(setup, 400_000);
  check("sizing: a tenth of a percent of the account, in whole units", TREND_RISK_PCT === 0.001 && lv.riskAmount === 400 && lv.positionUnits === Math.floor(400 / setup.stopDistance) && lv.stopLoss === setup.price - setup.stopDistance, `${lv.positionUnits} units, stop ${lv.stopLoss.toFixed(2)}`);
  check("sizing: a stop wider than the risk budget gives zero units (the signal says so)", trendLevels(setup, 1000).positionUnits === 0, "0 units");
}

console.log(failures === 0 ? "\nALL TREND TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
