/**
 * Checks of the trend entries — no network, no database: the indicators on
 * hand-built price paths, then the rules, the backtest's bookkeeping, the
 * settlement of an open trade and the send rules on a long generated market
 * (seeded, so every run sees the same one).
 *
 * Usage: npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts
 */
import { readFileSync } from "node:fs";
import {
  buildTrendSeries,
  trendStateAt,
  TREND_ADX_MIN,
  TREND_BREAKOUT_BARS,
  TREND_DAYS,
  TREND_MIN_CANDLES,
  TREND_RSI_LEVEL,
  TREND_STOP_ATR,
  TREND_TARGET_R,
  TREND_TRAIL_ATR,
} from "../lib/analysis/trend";
import { tradeCost } from "../lib/analysis/instruments";
import { entryTypeOf, runTrendBacktest, TREND_ENTRY_TYPES } from "../lib/backtest/trend";
import { settleTrailing } from "../lib/engine/outcomes";
import { sendBlock, type EarlierSignal } from "../lib/engine/scanner";
import { isLiveSignal, TREND_STRATEGY, type Candle } from "../lib/types";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const M15 = 900;
const H1 = 3600;
const DAY = 86400;
/** Sunday 22:00 UTC — where a trading week (and OANDA's Monday candle) opens. */
const WEEK_OPEN = Date.UTC(2024, 0, 7, 22) / 1000;

/** Candles of `seconds` built from finer ones; `offset` shifts the bucket edges (22:00 UTC for trading days). A bucket still forming is left out. */
function aggregate(fine: Candle[], seconds: number, fineSeconds: number, offset = 0): Candle[] {
  const out: Candle[] = [];
  for (const b of fine) {
    const t = Math.floor((b.time - offset) / seconds) * seconds + offset;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
    } else out.push({ ...b, time: t });
  }
  const end = fine[fine.length - 1].time + fineSeconds;
  return out.filter((c) => c.time + seconds <= end);
}

/** 1-hour candles along a path of closes, each opening at the previous close with a fixed overshoot at both ends. */
function hourly(closes: number[], wiggle = 0.5): Candle[] {
  let open = closes[0];
  return closes.map((close, k) => {
    const c = { time: WEEK_OPEN + k * H1, open, high: Math.max(open, close) + wiggle, low: Math.min(open, close) - wiggle, close, volume: 1 };
    open = close;
    return c;
  });
}

// ───────────── indicators on hand-built paths ─────────────
console.log("indicators");
{
  const n = 600;
  const rise = buildTrendSeries({ h1: hourly(Array.from({ length: n }, (_, k) => 1000 + 2 * k)), daily: [] });
  const i = n - 1;
  check("a steady rise: RSI 100", near(rise.rsi[i], 100));
  check("a steady rise: +DI above −DI and −DI zero", rise.plusDi[i] > 50 && near(rise.minusDi[i], 0));
  check("a steady rise: ADX near 100", rise.adx[i] > 95);
  check("a steady rise: the 50 EMA is above the 200 EMA", rise.emaFast[i] > rise.emaSlow[i]);
  // every candle spans 3 (2 of body, 0.5 each end) and opens at the previous close
  check("ATR is the candles' true range", near(rise.atr[i], 3, 1e-6));
  check("the channel is the high of the 240 candles BEFORE this one", near(rise.channelHigh[i], rise.candles[i - 1].high) && near(rise.channelLow[i], rise.candles[i - TREND_BREAKOUT_BARS].low));
  check("the 200 EMA is not read before it has settled", Number.isNaN(rise.emaSlow[TREND_MIN_CANDLES - 1]) && Number.isFinite(rise.emaSlow[TREND_MIN_CANDLES]));

  const fall = buildTrendSeries({ h1: hourly(Array.from({ length: n }, (_, k) => 3000 - 2 * k)), daily: [] });
  check("a steady fall mirrors it", near(fall.rsi[i], 0) && fall.minusDi[i] > 50 && near(fall.plusDi[i], 0) && fall.adx[i] > 95 && fall.emaFast[i] < fall.emaSlow[i]);

  // up 2, down 2, down 2, up 2: highs and lows step up as often as they step down
  const chop = buildTrendSeries({ h1: hourly(Array.from({ length: n }, (_, k) => 1000 + [0, 2, 0, -2][k % 4])), daily: [] });
  check("a sideways market: RSI near 50 and ADX low", Math.abs(chop.rsi[i] - 50) < 5 && chop.adx[i] < 15, `rsi ${chop.rsi[i]} adx ${chop.adx[i]}`);
}

// ───────────── the daily trend ─────────────
console.log("\ndaily trend");
{
  const days = TREND_DAYS + 10;
  // trading days open at 22:00 UTC, Sunday to Thursday; closes rise by 1 a day, then the last day collapses
  const daily: Candle[] = [];
  let t = WEEK_OPEN;
  for (; daily.length < days; t += DAY) {
    const wd = new Date(t * 1000).getUTCDay();
    if (wd === 5 || wd === 6) continue;
    const close = 1000 + daily.length;
    daily.push({ time: t, open: close - 1, high: close + 1, low: close - 2, close, volume: 1 });
  }
  const last = daily[daily.length - 1];
  last.close = 900;
  last.low = 890;
  const h1 = hourly(Array.from({ length: Math.round((last.time + DAY - WEEK_OPEN) / H1) }, () => 1000));
  const s = buildTrendSeries({ h1, daily });
  const before = h1.findIndex((c) => c.time + H1 === last.time + DAY) - 1;
  check("a day is only read once it has closed", s.dailyTrend[before] === 1 && s.dailyTrend[before + 1] === -1, `${s.dailyTrend[before]} then ${s.dailyTrend[before + 1]}`);
  check("no trend before there are 50 closed days", s.dailyTrend[0] === 0);
  // an empty weekend candle that would flip the reading is ignored
  const sat = { time: last.time - 2 * DAY, open: 1, high: 1, low: 1, close: 1, volume: 0 };
  const friOrSat = [5, 6].includes(new Date(sat.time * 1000).getUTCDay()) ? sat : { ...sat, time: daily.find((d) => new Date((d.time + DAY) * 1000).getUTCDay() === 5)!.time + DAY };
  const withWeekend = buildTrendSeries({ h1, daily: [...daily, friOrSat].sort((a, b) => a.time - b.time) });
  check("an empty weekend candle is not a trading day", withWeekend.dailyTrend[before] === 1 && near(withWeekend.dailyAverage[before], s.dailyAverage[before]));
}

// ───────────── a generated market: 60 weeks of 15-minute candles with trends both ways ─────────────
let seed = 20261123;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const m15: Candle[] = [];
{
  let price = 2000;
  let drift = 0.1;
  let left = 0;
  for (let week = 0; week < 60; week++) {
    for (let k = 0; k < 5 * 96; k++) {
      if (left-- <= 0) {
        // a new regime: up, down or flat, for one to five weeks
        drift = [0.12, -0.12, 0.1, -0.1, 0][Math.floor(rand() * 5)];
        left = Math.floor(480 + rand() * 1920);
      }
      const open = price;
      price = Math.max(500, price + drift + 0.7 * gauss());
      const hi = Math.max(open, price) + 0.3 * Math.abs(gauss());
      const lo = Math.min(open, price) - 0.3 * Math.abs(gauss());
      m15.push({ time: WEEK_OPEN + week * 7 * DAY + k * M15, open, high: hi, low: lo, close: price, volume: 1 });
    }
    // the weekend gap
    price += 2 * gauss();
  }
}
const h1 = aggregate(m15, H1, M15);
const daily = aggregate(m15, DAY, M15, 22 * H1);
const series = buildTrendSeries({ h1, daily });
const states = h1.map((_, i) => trendStateAt(series, i));
const setups = states.map((s, i) => ({ s, i })).filter((x) => x.s.setup);

console.log("\nrules, on the generated market");
{
  const kinds = (t: string) => setups.filter((x) => x.s.setup!.trigger === t).length;
  check(
    "the market produces every kind of signal (the checks below are not empty)",
    kinds("breakout") >= 5 && kinds("RSI pullback") >= 5 && setups.some((x) => x.s.setup!.direction === "long") && setups.some((x) => x.s.setup!.direction === "short"),
    `${setups.length} setups: breakout ${kinds("breakout")}, pullback ${kinds("RSI pullback")}, both ${kinds("breakout and RSI pullback")}`
  );
  const ok = (f: (x: (typeof setups)[number], dir: number) => boolean) => setups.every((x) => f(x, x.s.setup!.direction === "long" ? 1 : -1));
  check("a signal is always with the daily trend", ok((x, d) => series.dailyTrend[x.i] === d));
  check("…with the 50 EMA on the trend's side of the 200 EMA", ok((x, d) => Math.sign(series.emaFast[x.i] - series.emaSlow[x.i]) === d));
  check("…with +DI/−DI pointing the same way", ok((x, d) => Math.sign(series.plusDi[x.i] - series.minusDi[x.i]) === d));
  check(`…and only when ADX is ${TREND_ADX_MIN} or more`, ok((x) => series.adx[x.i] >= TREND_ADX_MIN));
  check(
    "a breakout is the FIRST close beyond the 240-candle high/low",
    setups.filter((x) => x.s.setup!.trigger !== "RSI pullback").every(({ i, s }) => {
      const up = s.setup!.direction === "long";
      return up ? h1[i].close > series.channelHigh[i] && h1[i - 1].close <= series.channelHigh[i - 1] : h1[i].close < series.channelLow[i] && h1[i - 1].close >= series.channelLow[i - 1];
    })
  );
  check(
    "an RSI pullback is RSI coming back through 50 with the trend",
    setups.filter((x) => x.s.setup!.trigger !== "breakout").every(({ i, s }) => {
      const up = s.setup!.direction === "long";
      return up ? series.rsi[i - 1] < TREND_RSI_LEVEL && series.rsi[i] >= TREND_RSI_LEVEL : series.rsi[i - 1] > 100 - TREND_RSI_LEVEL && series.rsi[i] <= 100 - TREND_RSI_LEVEL;
    })
  );
  check(
    "stop 2.5 ATR from the entry, take-profit 8R, trailing distance 6 ATR",
    ok((x, d) => {
      const u = x.s.setup!;
      return near(u.risk, TREND_STOP_ATR * series.atr[x.i]) && near(u.stopLoss, u.entry - d * u.risk) && near(u.takeProfit, u.entry + d * TREND_TARGET_R * u.risk) && near(u.trailDistance, TREND_TRAIL_ATR * series.atr[x.i]);
    })
  );
  check("the entry is the candle's close and the signal is timed at that close", ok((x) => x.s.setup!.entry === h1[x.i].close && x.s.setup!.time === h1[x.i].time + H1 && x.s.setup!.key === `trend:${h1[x.i].time}`));
  check("nothing is signalled while a condition is unmet", states.every((s) => !(s.blocked && s.setup)) && states.every((s) => !s.setup || s.checks.every((c) => c.met)));
  check("no signal before the 200 EMA has settled", setups.every((x) => x.i >= TREND_MIN_CANDLES));
  const pending = states.findIndex((s, i) => i > TREND_MIN_CANDLES && !s.blocked && !s.setup);
  check("with the trend confirmed and no entry yet, only the entry is missing", pending > 0 && states[pending].checks.filter((c) => !c.met).length === 1 && !states[pending].checks[4].met);
  const lvl = states[pending];
  const want = lvl.dailyTrend === 1 ? Math.max(...h1.slice(pending + 1 - TREND_BREAKOUT_BARS, pending + 1).map((c) => c.high)) : Math.min(...h1.slice(pending + 1 - TREND_BREAKOUT_BARS, pending + 1).map((c) => c.low));
  check("the breakout level shown is the one the NEXT candle has to close beyond", lvl.breakoutLevel != null && near(lvl.breakoutLevel, want));

  // the same candle read from history that stops at it must give the same answer
  let same = true;
  for (const { i } of setups.filter((_, k) => k % 7 === 0).concat(setups.slice(-3))) {
    const cut = buildTrendSeries({ h1: h1.slice(0, i + 1), daily });
    const a = trendStateAt(cut, i).setup;
    const b = states[i].setup!;
    if (!a || a.direction !== b.direction || a.trigger !== b.trigger || !near(a.stopLoss, b.stopLoss, 1e-6) || !near(a.trailDistance, b.trailDistance, 1e-6)) same = false;
  }
  check("no look-ahead: a signal reads the same when history ends at its candle", same);
  // the live scanner reads 1,500 candles, not the whole history
  let live = true;
  for (const { i } of setups.filter((x) => x.i >= 1500).filter((_, k) => k % 5 === 0)) {
    const window = h1.slice(i - 1499, i + 1);
    const w = buildTrendSeries({ h1: window, daily });
    const a = trendStateAt(w, w.n - 1).setup;
    const b = states[i].setup!;
    if (!a || a.direction !== b.direction || a.trigger !== b.trigger || !near(a.stopLoss, b.stopLoss, 0.01)) live = false;
  }
  check("the scanner's 1,500-candle window gives the same signal as the full history", live);

  const one = setups[0];
  const cheap = trendStateAt(buildTrendSeries({ h1: h1.slice(0, one.i + 1), daily }), one.i, "GBP_NZD");
  check("a trade whose costs are more than 10% of its risk is refused", tradeCost("XAU_USD") / one.s.setup!.risk <= 0.1 && (tradeCost("GBP_NZD") / (TREND_STOP_ATR * series.atr[one.i]) > 0.1 ? cheap.setup == null : true));
}

// ───────────── the backtest ─────────────
console.log("\nbacktest");
const trades = runTrendBacktest({ pair: "XAU_USD", h1, m15, daily });
{
  check("the generated market is traded", trades.length >= 10, `${trades.length} trades`);
  check("one trend trade at a time", trades.every((t, k) => k === 0 || t.entryTime >= trades[k - 1].exitTime));
  check(
    "a trade fills at the open of the first 15-minute candle after its 1-hour signal candle",
    trades.every((t) => {
      const c = m15.find((x) => x.time === t.entryTime)!;
      const sig = setups.find((x) => x.s.setup!.time <= t.entryTime && t.entryTime - x.s.setup!.time < 3 * DAY && h1[x.i].time + H1 <= t.entryTime && x.s.setup!.direction === t.direction);
      return c.open === t.entry && !!sig;
    })
  );
  const cost = tradeCost("XAU_USD");
  check(
    "the result is the price move less the full spread + slippage, in units of the first stop",
    trades.every((t) => near(t.rAchieved, ((t.direction === "long" ? 1 : -1) * (t.exitPrice - t.entry) - cost) / Math.abs(t.entry - t.stopLoss), 1e-9))
  );
  check("a trade stopped at its first stop loses 1R plus costs, or more on a gap", trades.filter((t) => t.outcome === "stop").every((t) => t.rAchieved <= -1 - cost / Math.abs(t.entry - t.stopLoss) + 1e-9));
  check("a take-profit pays 8R less costs", trades.filter((t) => t.outcome === "target").every((t) => near(t.rAchieved, TREND_TARGET_R - cost / Math.abs(t.entry - t.stopLoss), 1e-9)));
  check("the trailing stop closes trades too", trades.some((t) => t.outcome === "trail"));
  check(
    "a trailing-stop exit is never worse than the first stop and never beyond the target",
    trades.filter((t) => t.outcome === "trail").every((t) => {
      const d = t.direction === "long" ? 1 : -1;
      return d * (t.exitPrice - t.stopLoss) >= -1e-9 - 5 && d * (t.takeProfit - t.exitPrice) > 0;
    })
  );
  const doubled = runTrendBacktest({ pair: "XAU_USD", h1, m15, daily, costMultiplier: 2 });
  const sum = (g: { rAchieved: number }[]) => g.reduce((s, t) => s + t.rAchieved, 0);
  check("doubling the costs takes exactly one more cost off every trade", doubled.length === trades.length && near(sum(trades) - sum(doubled), trades.reduce((s, t) => s + cost / Math.abs(t.entry - t.stopLoss), 0), 1e-6));
  const from = trades[Math.floor(trades.length / 2)].entryTime;
  const later = runTrendBacktest({ pair: "XAU_USD", h1, m15, daily, from });
  check("`from` keeps only trades entered at or after it", later.length > 0 && later.every((t) => t.entryTime >= from));
  check("one trade at a time: a trade is entered only after the one before it has closed", trades.every((t, k) => k === 0 || t.entryTime >= trades[k - 1].exitTime));
  check("every trade counts under exactly one of the two entries", trades.every((t) => TREND_ENTRY_TYPES.includes(entryTypeOf(t))) && TREND_ENTRY_TYPES.reduce((n, type) => n + trades.filter((t) => entryTypeOf(t) === type).length, 0) === trades.length);
}

// ───────────── settlement: the live system follows a trade exactly as the backtest does ─────────────
console.log("\nsettlement");
{
  let agree = 0;
  const closed = trades.filter((t) => t.outcome !== "open");
  for (const t of closed) {
    const sig = [...setups].reverse().find((x) => x.s.setup!.time <= t.entryTime && x.s.setup!.direction === t.direction)!;
    const input = {
      direction: t.direction,
      entry: t.entry,
      stop_loss: t.stopLoss,
      trail_distance: sig.s.setup!.trailDistance,
      take_profit: t.takeProfit,
      trail_stop: t.stopLoss,
      checkedAt: t.entryTime * 1000,
    };
    // followed in two sittings, as two scans would
    const candles = m15.filter((c) => c.time >= t.entryTime && c.time < t.exitTime);
    const half = Math.floor(candles.length / 2);
    const first = settleTrailing(input, candles.slice(0, half));
    const res = first.settlement ? first : settleTrailing({ ...input, trail_stop: first.trailStop, checkedAt: first.checkedAt }, candles);
    if (res.settlement && near(res.settlement.hitPrice!, t.exitPrice, 1e-9) && res.settlement.hitTime === t.exitTime - M15) agree++;
  }
  check("every closed backtest trade settles at the same candle and price when followed live, across two scans", closed.length > 0 && agree === closed.length, `${agree} of ${closed.length}`);
  const t0 = WEEK_OPEN;
  const bar = (k: number, open: number, high: number, low: number, close: number) => ({ time: t0 + k * M15, open, high, low, close });
  const buy = { direction: "long" as const, entry: 100, stop_loss: 90, trail_distance: 24, take_profit: 180, trail_stop: 90, checkedAt: t0 * 1000 };
  const moved = settleTrailing(buy, [bar(0, 100, 110, 99, 109)]);
  check("the trailing stop does not move until price is further away than its distance", moved.settlement == null && moved.trailStop === 90);
  const trailed = settleTrailing(buy, [bar(0, 100, 130, 99, 129)]);
  check("then it follows 24 behind the best price", trailed.trailStop === 106);
  const out = settleTrailing({ ...buy, trail_stop: 106, checkedAt: (t0 + M15) * 1000 }, [bar(1, 129, 129, 105, 106)]);
  check("a trailing stop above the entry closes the trade in profit", out.settlement?.outcome === "win" && out.settlement.hitPrice === 106 && near(out.settlement.r, 0.6));
  const tp = settleTrailing(buy, [bar(0, 100, 181, 99, 180)]);
  check("the take-profit closes it at 8R", tp.settlement?.outcome === "win" && tp.settlement.hitPrice === 180 && near(tp.settlement.r, 8));
  const sl = settleTrailing(buy, [bar(0, 100, 185, 89, 150)]);
  check("a candle touching the stop and the target counts as the stop", sl.settlement?.outcome === "loss" && sl.settlement.hitPrice === 90);
}

// ───────────── what may be sent ─────────────
console.log("\nsend rules");
{
  const row = (direction: "long" | "short", open: boolean, variant = "x"): EarlierSignal => ({ variant, direction, status: "active", outcome: open ? null : "loss" });
  const trade = { key: "trend:1" };
  // the names the database's signals_strategy_check constraint accepts (supabase/schema.sql)
  const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const allowed = /strategy text not null check \(strategy in \(([^)]*)\)\)/.exec(schema)?.[1] ?? "";
  check("the database accepts the name the signals are stored under", allowed.split(",").map((x) => x.trim().replace(/'/g, "")).includes(TREND_STRATEGY), allowed);
  check("a signal of these rules is told apart from one of the removed 30-minute system", setups.length > 0 && setups.every((x) => isLiveSignal({ strategy: TREND_STRATEGY, variant: x.s.setup!.key })) && !isLiveSignal({ strategy: TREND_STRATEGY, variant: "don30" }) && !isLiveSignal({ strategy: "fibonacci", variant: "trend:1" }));
  check("nothing open: a signal is sent", sendBlock([], trade) == null && sendBlock([row("short", false)], trade) == null);
  check("a trade is open: no second trade the same way", sendBlock([row("long", true)], trade) != null);
  check("never a buy and a sell at once", sendBlock([row("short", true)], trade) != null);
  check("a signal candle is sent once, even after its trade has closed", sendBlock([row("long", false, "trend:1")], trade) != null);
  check("a closed trade of another candle is not in the way", sendBlock([row("long", false, "trend:0")], trade) == null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
