/**
 * Checks of the Fibonacci system on hand-built price paths — no network, no
 * database: the trends, the swing, the zone, the entry candle, the levels, the
 * rules that refuse a trade, the backtest's bookkeeping and the settlement of
 * an open trade.
 *
 * Usage: npx tsx --tsconfig tsconfig.json scripts/verify-fib.ts
 */
import {
  buildFibSeries,
  fibPrice,
  fibStateAt,
  FIB_MAX_HOLD_BARS,
  FIB_STOP_BUFFER_ATR,
  FIB_TARGET_EXTENSION,
  FIB_ZONE_DEEP,
  FIB_ZONE_SHALLOW,
} from "../lib/analysis/fibonacci";
import { runFibBacktest } from "../lib/backtest/fib";
import { settleSignal, settleTrailing } from "../lib/engine/outcomes";
import type { Candle } from "../lib/types";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const M15 = 900;
const START = Date.UTC(2024, 0, 1) / 1000; // a Monday, 00:00 UTC
const WIGGLE = 0.5;

/** 15-minute candles along a path of closes: each opens at the previous close and overshoots both ends a little. */
function candlesFrom(closes: number[], startTime = START, firstOpen = closes[0]): Candle[] {
  const out: Candle[] = [];
  let open = firstOpen;
  closes.forEach((close, k) => {
    out.push({ time: startTime + k * M15, open, high: Math.max(open, close) + WIGGLE, low: Math.min(open, close) - WIGGLE, close, volume: 1 });
    open = close;
  });
  return out;
}

/** Closed candles of a longer timeframe built from the 15-minute ones (a bucket still forming is left out). */
function aggregate(fine: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const b of fine) {
    const t = Math.floor(b.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
    } else out.push({ ...b, time: t });
  }
  const end = fine[fine.length - 1].time + M15;
  return out.filter((c) => c.time + seconds <= end);
}

const frames = (m15: Candle[]) => ({ m15, h1: aggregate(m15, 3600), h4: aggregate(m15, 14400), daily: aggregate(m15, 86400) });

/** Closes moving `total` in steps of `step` from `from`. */
function move(from: number, total: number, step: number): number[] {
  const n = Math.max(1, Math.round(Math.abs(total) / step));
  return Array.from({ length: n }, (_, k) => from + (total * (k + 1)) / n);
}

/**
 * The reference path, in a market that trends `sign` (+1 up, −1 down):
 * 100 days of steady trend, a counter-move, an impulse leg of `legAtr` ATR
 * with the trend, and a pullback of `pullbackAtr` ATR. Returns the closes and
 * the ATR unit the moves were measured in.
 */
function path(sign: 1 | -1, legAtr = 14, pullbackAtr = 6.5): { closes: number[]; unit: number } {
  const base = Array.from({ length: 100 * 96 }, (_, k) => 2000 + sign * 0.03 * k);
  const unit = aggregate(candlesFrom(base), 3600).slice(-50).reduce((sum, c) => sum + (c.high - c.low), 0) / 50;
  let closes = base;
  const last = () => closes[closes.length - 1];
  closes = closes.concat(move(last(), -sign * 9 * unit, 0.06)); // counter-move: sets the start of the leg
  closes = closes.concat(move(last(), sign * legAtr * unit, 0.06)); // the impulse leg
  closes = closes.concat(move(last(), -sign * pullbackAtr * unit, 0.06)); // the pullback
  // finish the hour, flat, so the last 1-hour candle is closed
  while (closes.length % 4 !== 0) closes.push(last());
  return { closes, unit };
}

/** Appends the entry candle: it dips a little further, then closes beyond the previous candle's far side. */
function withRejection(m15: Candle[], sign: 1 | -1): Candle[] {
  const prev = m15[m15.length - 1];
  const open = prev.close;
  const close = sign === 1 ? prev.high + 0.4 : prev.low - 0.4;
  return [...m15, { time: prev.time + M15, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume: 1 }];
}

function stateOf(m15: Candle[]) {
  const s = buildFibSeries(frames(m15));
  return { s, state: fibStateAt(s, s.n - 1) };
}

// ── 1. a buy setup ──────────────────────────────────────────────────────────
console.log("\nbuy setup");
{
  const { closes } = path(1);
  const pulled = candlesFrom(closes);
  const before = stateOf(pulled).state;
  check("daily trend up", before.dailyTrend === 1);
  check("4-hour trend up", before.h4Trend === 1);
  check("side is buys", before.side === "long");
  check("an up-leg is in force", before.leg?.direction === "long", `leg ${before.leg?.direction}`);
  check("the leg is long enough", before.legAtr != null && before.legAtr >= 8, `leg ${before.legAtr?.toFixed(1)} ATR`);
  check("nothing blocks a trade", before.blocked == null, before.blocked ?? "");
  check("no trade without the rejection candle", before.setup == null);

  const m15 = withRejection(pulled, 1);
  const { state } = stateOf(m15);
  const setup = state.setup;
  check("the rejection candle makes a trade", setup != null, state.blocked ?? state.checks.filter((c) => !c.met).map((c) => c.label).join("; "));
  if (setup && state.leg) {
    const leg = state.leg;
    const hi = Math.max(...m15.map((c) => c.high));
    check("the leg ends at the highest high", Math.abs(leg.end.price - hi) < 1e-9, `${leg.end.price} vs ${hi}`);
    const legStart = m15.findIndex((c) => c.time === leg.origin.time);
    check("the leg starts at the low before it", legStart > 0 && Math.abs(leg.origin.price - Math.min(...m15.slice(legStart - 4, legStart + 8).map((c) => c.low))) < 1e-9);
    check("direction is long", setup.direction === "long");
    check("entry is the candle's close", setup.entry === m15[m15.length - 1].close);
    check("the stop is below the start of the leg", setup.stopLoss < leg.origin.price && leg.origin.price - setup.stopLoss < FIB_STOP_BUFFER_ATR * 3);
    check("the target is the 161.8% extension", Math.abs(setup.takeProfit - (leg.end.price + FIB_TARGET_EXTENSION * leg.range)) < 1e-9);
    check("the target is above the swing high", setup.takeProfit > leg.end.price);
    const low = m15[m15.length - 1].low;
    check("the candle traded inside the zone", low <= fibPrice(leg, FIB_ZONE_SHALLOW) && setup.entry >= fibPrice(leg, FIB_ZONE_DEEP));
    check("reward is at least the risk", setup.rr >= 1, `rr ${setup.rr.toFixed(2)}`);
    check("retracement is between the zone's edges", setup.retracement >= FIB_ZONE_SHALLOW && setup.retracement <= FIB_ZONE_DEEP, `${setup.retracement.toFixed(3)}`);
    check("all five conditions are met", state.checks.length === 5 && state.checks.every((c) => c.met));
  }
}

// ── 2. the mirror image: a sell setup ───────────────────────────────────────
console.log("\nsell setup");
{
  const { closes } = path(-1);
  const m15 = withRejection(candlesFrom(closes), -1);
  const { state } = stateOf(m15);
  check("daily and 4-hour trend down", state.dailyTrend === -1 && state.h4Trend === -1);
  check("a sell is found", state.setup?.direction === "short", state.blocked ?? "");
  if (state.setup && state.leg) {
    check("the stop is above the start of the leg", state.setup.stopLoss > state.leg.origin.price);
    check("the target is below the swing low", state.setup.takeProfit < state.leg.end.price);
    check("the target is the 161.8% extension", Math.abs(state.setup.takeProfit - (state.leg.end.price - FIB_TARGET_EXTENSION * state.leg.range)) < 1e-9);
  }
}

// ── 3. what refuses a trade ─────────────────────────────────────────────────
console.log("\nrefusals");
{
  const { closes } = path(1);
  const good = withRejection(candlesFrom(closes), 1);
  const f = frames(good);

  // the daily trend points the other way
  const fallingDays = f.daily.map((c, k) => ({ ...c, close: 3000 - k, open: 3001 - k, high: 3002 - k, low: 2999 - k }));
  const s1 = buildFibSeries({ ...f, daily: fallingDays });
  const st1 = fibStateAt(s1, s1.n - 1);
  check("no buy when the daily trend is down", st1.setup == null && st1.dailyTrend === -1 && st1.side == null);

  // the 4-hour trend points the other way
  const fallingH4 = f.h4.map((c, k) => ({ ...c, close: 3000 - k, open: 3001 - k, high: 3002 - k, low: 2999 - k }));
  const s2 = buildFibSeries({ ...f, h4: fallingH4 });
  const st2 = fibStateAt(s2, s2.n - 1);
  check("no buy when the 4-hour trend is down", st2.setup == null && st2.h4Trend === -1 && st2.blocked != null);

  // a candle in the zone that does not reject it
  const flat = [...good.slice(0, -1), { ...good[good.length - 1], close: good[good.length - 1].open, high: good[good.length - 1].open + 0.1, low: good[good.length - 1].open - 0.1 }];
  const st3 = stateOf(flat).state;
  check("no trade on a candle that does not reject the zone", st3.setup == null && st3.checks[3].met && !st3.checks[4].met);

  // a leg that is too short
  const short = path(1, 6, 5.6);
  const st4 = stateOf(withRejection(candlesFrom(short.closes), 1)).state;
  check("no trade on a leg under 8 ATR", st4.setup == null, `leg ${st4.legAtr?.toFixed(1)} ATR, blocked: ${st4.blocked}`);

  // a pullback that is too shallow: the candle never reaches the zone
  const shallow = path(1, 22, 6);
  const st5 = stateOf(withRejection(candlesFrom(shallow.closes), 1)).state;
  check("no trade above the zone (pullback under 38.2%)", st5.setup == null && st5.leg?.direction === "long" && !st5.checks[3].met, `${st5.blocked}`);

  // price trades through the start of the leg: the leg is finished for good
  const base = candlesFrom(closes);
  const leg = stateOf(base).state.leg!;
  const lastClose = closes[closes.length - 1];
  const crash = closes.concat(move(lastClose, leg.origin.price - 1.5 - lastClose, 0.4)).concat(move(leg.origin.price - 1.5, lastClose - (leg.origin.price - 1.5), 0.4));
  const st6 = stateOf(withRejection(candlesFrom(crash), 1));
  check("no trade after price has traded through the start of the leg", st6.state.setup == null);

  // nothing looks ahead: the read of a candle does not change when later candles are added
  const s7 = buildFibSeries(frames(good));
  const early = good.length - 40;
  const cut = good.slice(0, early + 1);
  const a = fibStateAt(buildFibSeries(frames(cut)), early);
  const b = fibStateAt(s7, early);
  check("a candle's read is the same with and without the candles after it", a.leg?.key === b.leg?.key && a.dailyTrend === b.dailyTrend && a.h4Trend === b.h4Trend && (a.setup == null) === (b.setup == null));
}

// ── 4. the backtest's bookkeeping ───────────────────────────────────────────
console.log("\nbacktest");
{
  const { closes, unit } = path(1);
  const m15 = withRejection(candlesFrom(closes), 1);
  const setup = stateOf(m15).state.setup!;
  // after the entry: straight up through the target
  const last = m15[m15.length - 1];
  const up = candlesFrom(move(last.close, setup.takeProfit - last.close + 3, 0.5), last.time + M15, last.close);
  const win = runFibBacktest({ pair: "XAU_USD", ...frames([...m15, ...up]) });
  check("one trade is taken", win.length === 1, `${win.length} trades`);
  check("it is filled at the next candle's open", win[0]?.entry === up[0].open && win[0]?.entryTime === up[0].time);
  check("it closes at the target", win[0]?.outcome === "target" && win[0]?.exitPrice === setup.takeProfit);
  check("the result is the planned reward less the cost", win[0] != null && Math.abs(win[0].rAchieved - (setup.takeProfit - win[0].entry - 0.35) / (win[0].entry - setup.stopLoss)) < 1e-9);

  // after the entry: straight down through the stop
  const down = candlesFrom(move(last.close, setup.stopLoss - last.close - 3, 0.5), last.time + M15, last.close);
  const loss = runFibBacktest({ pair: "XAU_USD", ...frames([...m15, ...down]) });
  check("a trade that falls to its stop is a loss of a little over 1R", loss.length === 1 && loss[0].outcome === "stop" && loss[0].rAchieved < -1 && loss[0].rAchieved > -1.2, `${loss[0]?.rAchieved}`);
  check("only one trade per leg", loss.length === 1);

  // after the entry: nothing happens for more than five trading days
  const sideways = candlesFrom(Array.from({ length: FIB_MAX_HOLD_BARS + 40 }, (_, k) => last.close + (k % 2 ? 0.2 : -0.2)), last.time + M15, last.close);
  const timed = runFibBacktest({ pair: "XAU_USD", ...frames([...m15, ...sideways]) });
  check("a trade that goes nowhere is closed at the time limit", timed.length >= 1 && timed[0].outcome === "time" && (timed[0].exitTime - timed[0].entryTime) / M15 === FIB_MAX_HOLD_BARS + 1, `${timed[0]?.outcome} after ${(timed[0]?.exitTime - timed[0]?.entryTime) / M15} candles`);
  void unit;
}

// ── 5. settling an open signal ──────────────────────────────────────────────
console.log("\nsettlement");
{
  const t0 = START;
  const bar = (k: number, open: number, high: number, low: number, close: number) => ({ time: t0 + k * M15, open, high, low, close });
  const buy = { direction: "long" as const, entry: 100, stop_loss: 90, take_profit: 120, firedAt: t0 * 1000 + 1000 };
  check("a candle that closed before the signal is ignored", settleSignal(buy, [bar(-1, 100, 130, 80, 100)]) == null);
  const tp = settleSignal(buy, [bar(0, 100, 105, 99, 104), bar(1, 104, 121, 103, 120)]);
  check("the target is a win of the planned reward", tp?.outcome === "win" && tp.r === 2 && tp.hitPrice === 120);
  const sl = settleSignal(buy, [bar(0, 100, 101, 89, 90)]);
  check("the stop is a loss of 1R", sl?.outcome === "loss" && sl.r === -1 && sl.hitPrice === 90);
  const both = settleSignal(buy, [bar(0, 100, 125, 85, 110)]);
  check("a candle touching both levels counts as a loss", both?.outcome === "loss");
  const gap = settleSignal(buy, [bar(0, 85, 86, 84, 85)]);
  check("a gap through the stop fills at the open", gap?.outcome === "loss" && gap.hitPrice === 85 && gap.r === -1.5);
  const quiet = Array.from({ length: FIB_MAX_HOLD_BARS + 5 }, (_, k) => bar(k, 100, 104, 99, 103));
  const exp = settleSignal(buy, quiet);
  check("a trade past the time limit is closed at market", exp?.outcome === "expired" && exp.hitPrice === 103 && Math.abs(exp.r - 0.3) < 1e-9 && exp.hitTime === t0 + FIB_MAX_HOLD_BARS * M15);
  check("a trade inside the time limit stays open", settleSignal(buy, quiet.slice(0, FIB_MAX_HOLD_BARS)) == null);
  const sell = { direction: "short" as const, entry: 100, stop_loss: 110, take_profit: 80, firedAt: t0 * 1000 + 1000 };
  check("sells mirror buys", settleSignal(sell, [bar(0, 100, 101, 79, 80)])?.outcome === "win" && settleSignal(sell, [bar(0, 100, 111, 99, 110)])?.outcome === "loss");

  // trades left open by the retired trend system keep their trailing stop
  const trail = { direction: "long" as const, entry: 100, stop_loss: 90, trail_distance: 20, take_profit: 0, trail_stop: 90, checkedAt: t0 * 1000 };
  const followed = settleTrailing(trail, [bar(0, 100, 125, 99, 124)]);
  check("an old trend trade's stop still trails", followed.settlement == null && followed.trailStop === 105);
  const stopped = settleTrailing({ ...trail, trail_stop: 105, checkedAt: (t0 + M15) * 1000 }, [bar(1, 124, 124, 104, 105)]);
  check("and closes when the trailing stop is hit", stopped.settlement?.outcome === "win" && stopped.settlement.hitPrice === 105);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
