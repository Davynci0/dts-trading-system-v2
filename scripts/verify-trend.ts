/**
 * Checks of the system — no network, no database: swings and structure on a
 * hand-built price path, then the rules, the backtest's bookkeeping, the
 * settlement of an open trade and the send rules on a long generated market
 * (seeded, so every run sees the same one).
 *
 * Usage: npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts
 */
import { readFileSync } from "node:fs";
import {
  buildTrendSeries,
  readStructure,
  trendStateAt,
  TREND_BREAKOUT_BARS,
  TREND_DAYS,
  TREND_MAX_COST_SHARE,
  TREND_MAX_HOLD_BARS,
  TREND_MAX_OPEN,
  TREND_MAX_RISK_ATR,
  TREND_MIN_CANDLES,
  TREND_MIN_H1_CANDLES,
  TREND_MIN_RISK_ATR,
  TREND_MOMENTUM_ATR,
  TREND_MOMENTUM_CLOSE,
  TREND_STOP_BARS,
  TREND_STOP_BUFFER_ATR,
  TREND_SWING,
  TREND_TARGET_R,
} from "../lib/analysis/trend";
import { tradeCost } from "../lib/analysis/instruments";
import { entryTypeOf, runTrendBacktest, TREND_ENTRY_TYPES } from "../lib/backtest/trend";
import { settleSignal } from "../lib/engine/outcomes";
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

/**
 * 15-minute candles along a path of closes, each opening at the previous
 * close. A rising candle has a long upper wick and a falling one a long lower
 * wick, so a turning point's high (or low) is strictly beyond its neighbours'.
 */
function quarters(closes: number[]): Candle[] {
  let open = closes[0];
  return closes.map((close, k) => {
    const up = close >= open;
    const c = { time: WEEK_OPEN + k * M15, open, high: Math.max(open, close) + (up ? 0.3 : 0.1), low: Math.min(open, close) - (up ? 0.1 : 0.3), close, volume: 1 };
    open = close;
    return c;
  });
}
/** Closes moving one unit a candle from waypoint to waypoint. */
function walk(points: number[]): number[] {
  const out = [points[0]];
  for (let p = 1; p < points.length; p++) {
    const step = Math.sign(points[p] - points[p - 1]);
    for (let v = points[p - 1] + step; step > 0 ? v <= points[p] : v >= points[p]; v += step) out.push(v);
  }
  return out;
}
const LONGEST = TREND_BREAKOUT_BARS[TREND_BREAKOUT_BARS.length - 1];

// ───────────── swings and structure on a hand-built path ─────────────
console.log("swings and structure");
{
  // up to 110, down to 104, a lower high at 107, down through the low, then up through everything
  const closes = walk([100, 110, 104, 107, 99, 112]);
  const cs = quarters(closes);
  const s = readStructure(cs);
  const at = (v: number, from = 0) => closes.indexOf(v, from);
  const peak = at(110);
  const trough = at(104, peak);
  const lowerHigh = at(107, trough);
  check("a swing is a high/low with three lower highs / higher lows on each side", TREND_SWING === 3);
  check("a swing high is only known three candles after it", Number.isNaN(s.swingHigh[peak + 2]) && near(s.swingHigh[peak + 3], cs[peak].high));
  check("the swing low after it is found the same way", Number.isNaN(s.swingLow[trough + 2]) && near(s.swingLow[trough + 3], cs[trough].low));
  const brk = cs.findIndex((c, k) => k > lowerHigh && c.close < cs[trough].low);
  check("no structure before a swing has been broken", s.dir[brk - 1] === 0 && s.leg[brk - 1] === 0);
  check("a candle CLOSING below the last swing low makes the structure bearish", s.dir[brk] === -1 && s.leg[brk] === 1);
  check("the break's origin is the lower high the pullback made — where a sell's stop belongs", near(s.origin[brk], cs[lowerHigh].high) && cs[lowerHigh].high < cs[peak].high);
  check("a broken swing is no longer a level to break", near(s.openLow[brk - 1], cs[trough].low) && Number.isNaN(s.openLow[brk]) && near(s.swingLow[brk], cs[trough].low));
  // the same path with a wick through the low on the candle before the break: a wick is not a close
  const wick = cs.map((c) => ({ ...c }));
  wick[brk - 1].low = cs[trough].low - 2;
  check("a wick below the swing low does not break structure", readStructure(wick).dir[brk - 1] === 0 && readStructure(wick).dir[brk] === -1);
  const flip = cs.findIndex((c, k) => k > brk && c.close > cs[lowerHigh].high);
  check("it stays bearish until a close above the last swing high (a change of character)", s.dir[flip - 1] === -1 && s.dir[flip] === 1 && s.leg[flip] === 2);
  const bottom = at(99, lowerHigh);
  check("…and that break's origin is the low the rise started from", near(s.origin[flip], cs[bottom].low));
}

// ───────────── indicators ─────────────
console.log("\nindicators");
{
  const n = 4 * (TREND_MIN_H1_CANDLES + 60);
  const up = quarters(Array.from({ length: n }, (_, k) => 1000 + 2 * k));
  const upH1 = aggregate(up, H1, M15);
  const rise = buildTrendSeries({ m15: up, h1: upH1, daily: [] });
  const i = n - 1;
  // every candle spans 2.4 (2 of body, 0.3 above, 0.1 below) and opens at the previous close
  check("ATR is the candles' true range", near(rise.atr[i], 2.4, 1e-6));
  check(
    "each channel is the high/low of that many candles BEFORE this one",
    TREND_BREAKOUT_BARS.every((bars, b) => near(rise.channelHigh[b][i], up[i - 1].high) && near(rise.channelLow[b][i], up[i - bars].low))
  );
  check("a market that only rises never makes a swing, so it has no structure to trade", rise.h1Trend[i] === 0 && rise.structure.dir[i] === 0);
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
  const flat = quarters(Array.from({ length: Math.round((last.time + DAY - WEEK_OPEN) / M15) }, () => 1000));
  const s = buildTrendSeries({ m15: flat, h1: aggregate(flat, H1, M15), daily });
  const before = flat.findIndex((c) => c.time + M15 === last.time + DAY) - 1;
  check("a day is only read once it has closed", s.dailyTrend[before] === 1 && s.dailyTrend[before + 1] === -1, `${s.dailyTrend[before]} then ${s.dailyTrend[before + 1]}`);
  check("no trend before there are 50 closed days", s.dailyTrend[0] === 0);
  // an empty weekend candle that would flip the reading is ignored
  const sat = { time: last.time - 2 * DAY, open: 1, high: 1, low: 1, close: 1, volume: 0 };
  const friOrSat = [5, 6].includes(new Date(sat.time * 1000).getUTCDay()) ? sat : { ...sat, time: daily.find((d) => new Date((d.time + DAY) * 1000).getUTCDay() === 5)!.time + DAY };
  const withWeekend = buildTrendSeries({ m15: flat, h1: aggregate(flat, H1, M15), daily: [...daily, friOrSat].sort((a, b) => a.time - b.time) });
  check("an empty weekend candle is not a trading day", withWeekend.dailyTrend[before] === 1 && near(withWeekend.dailyAverage[before], s.dailyAverage[before]));
}

// ───────────── a generated market: 70 weeks of 15-minute candles with trends both ways ─────────────
let seed = 20261123;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const m15: Candle[] = [];
{
  let price = 3000;
  let drift = 0.1;
  let left = 0;
  for (let week = 0; week < 70; week++) {
    for (let k = 0; k < 5 * 96; k++) {
      if (left-- <= 0) {
        // a new regime: up, down or flat, for one to five weeks
        drift = [0.4, -0.4, 0.3, -0.3, 0][Math.floor(rand() * 5)];
        left = Math.floor(480 + rand() * 1920);
      }
      const open = price;
      price = Math.max(500, price + drift + 2.4 * gauss());
      const hi = Math.max(open, price) + Math.abs(gauss());
      const lo = Math.min(open, price) - Math.abs(gauss());
      m15.push({ time: WEEK_OPEN + week * 7 * DAY + k * M15, open, high: hi, low: lo, close: price, volume: 1 });
    }
    // the weekend gap
    price += 6 * gauss();
  }
}
const h1 = aggregate(m15, H1, M15);
const daily = aggregate(m15, DAY, M15, 22 * H1);
const series = buildTrendSeries({ m15, h1, daily });
const states = m15.map((_, i) => trendStateAt(series, i));
const setups = states.map((s, i) => ({ s, i })).filter((x) => x.s.setup);
const st = series.structure;

console.log("\nrules, on the generated market");
{
  const kinds = (t: string) => setups.filter((x) => x.s.setup!.trigger === t).length;
  check(
    "the market produces every kind of signal (the checks below are not empty)",
    kinds("break of structure") >= 20 && kinds("breakout") >= 5 && kinds("momentum candle") >= 20 && setups.some((x) => x.s.setup!.direction === "long") && setups.some((x) => x.s.setup!.direction === "short"),
    `${setups.length} setups: structure ${kinds("break of structure")}, breakout ${kinds("breakout")}, momentum ${kinds("momentum candle")}, both ${kinds("breakout and momentum candle")}`
  );
  const ok = (f: (x: (typeof setups)[number], dir: number) => boolean) => setups.every((x) => f(x, x.s.setup!.direction === "long" ? 1 : -1));
  check("a signal is always with the daily trend", ok((x, d) => series.dailyTrend[x.i] === d));
  check("…and with the 1-hour structure", ok((x, d) => series.h1Trend[x.i] === d));
  // the 1-hour structure a 15-minute candle sees is the one of the last 1-hour candle CLOSED by then
  const hourly = readStructure(h1);
  let carried = true;
  for (let i = 4 * TREND_MIN_H1_CANDLES + 8; i < m15.length; i += 37) {
    const end = m15[i].time + M15;
    let j = -1;
    while (j + 1 < h1.length && h1[j + 1].time + H1 <= end) j++;
    if (series.h1Trend[i] !== hourly.dir[j]) carried = false;
  }
  check("a 1-hour candle is only read once it has closed", carried);
  check(
    "a break of structure is the candle that closes beyond the last swing, in the trend's direction",
    setups.filter((x) => x.s.setup!.trigger === "break of structure").every(({ i, s }) => {
      const d = s.setup!.direction === "long" ? 1 : -1;
      const level = d === 1 ? st.openHigh[i - 1] : st.openLow[i - 1];
      return st.leg[i] === st.leg[i - 1] + 1 && st.dir[i] === d && (d === 1 ? m15[i].close > level : m15[i].close < level);
    })
  );
  check("a candle that breaks structure AGAINST the trend is never a signal", states.every((s, i) => i === 0 || st.leg[i] === st.leg[i - 1] || !s.setup || (s.setup.direction === "long" ? 1 : -1) === st.dir[i]));
  const firstBeyond = (i: number, b: number, up: boolean) =>
    up ? m15[i].close > series.channelHigh[b][i] && m15[i - 1].close <= series.channelHigh[b][i - 1] : m15[i].close < series.channelLow[b][i] && m15[i - 1].close >= series.channelLow[b][i - 1];
  check(
    "a breakout is the FIRST close beyond a channel, and the longest one broken is the one reported",
    setups.filter((x) => x.s.setup!.breakoutBars != null).every(({ i, s }) => {
      const up = s.setup!.direction === "long";
      const broken = TREND_BREAKOUT_BARS.filter((_, b) => firstBeyond(i, b, up));
      return broken.length > 0 && broken[broken.length - 1] === s.setup!.breakoutBars;
    })
  );
  check("the breakout lengths are 3, 6, 12 and 24 hours of 15-minute candles", TREND_BREAKOUT_BARS.join() === "12,24,48,96");
  check(
    "a momentum candle is 1.2 ATR or longer and closes in the outer quarter of its range, with the trend",
    setups.filter((x) => x.s.setup!.trigger.includes("momentum")).every(({ i, s }) => {
      const c = m15[i];
      const range = c.high - c.low;
      const up = s.setup!.direction === "long";
      return TREND_MOMENTUM_ATR === 1.2 && range >= TREND_MOMENTUM_ATR * series.atr[i] && (up ? c.close >= c.high - TREND_MOMENTUM_CLOSE * range && c.close > c.open : c.close <= c.low + TREND_MOMENTUM_CLOSE * range && c.close < c.open);
    })
  );

  // the stop: set by the last two candles, inside the two limits
  const basis = (b: string) => setups.filter((x) => x.s.setup!.stopBasis === b);
  check("stops come from the level itself and from the far limit", basis("swing").length >= 20 && basis("furthest").length >= 20, `level ${basis("swing").length}, nearest ${basis("nearest").length}, furthest ${basis("furthest").length}`);
  check("most stops are set by the candles, not by a limit", basis("swing").length > setups.length / 2, `${basis("swing").length} of ${setups.length}`);
  check(
    "the level is the low of the last two candles for a buy and their high for a sell — the same for every entry",
    TREND_STOP_BARS === 2 && ok((x, d) => near(x.s.setup!.swing, d === 1 ? Math.min(m15[x.i].low, m15[x.i - 1].low) : Math.max(m15[x.i].high, m15[x.i - 1].high)))
  );
  check(
    "the stop sits 0.2 ATR beyond that level",
    basis("swing").every(({ i, s }) => {
      const u = s.setup!;
      const d = u.direction === "long" ? 1 : -1;
      return near(u.stopLoss, u.swing - d * TREND_STOP_BUFFER_ATR * series.atr[i], 1e-9) && d * (u.entry - u.swing) > 0;
    })
  );
  check(
    "the risk is never under 0.75 ATR or over 2 ATR: a level that is closer or further puts the stop at the limit",
    TREND_MIN_RISK_ATR === 0.75 &&
      TREND_MAX_RISK_ATR === 2 &&
      ok((x) => x.s.setup!.risk >= 0.75 * series.atr[x.i] - 1e-9 && x.s.setup!.risk <= 2 * series.atr[x.i] + 1e-9) &&
      basis("nearest").every((x) => near(x.s.setup!.risk, 0.75 * series.atr[x.i])) &&
      basis("furthest").every((x) => near(x.s.setup!.risk, 2 * series.atr[x.i]))
  );
  check("the stop is the risk away from the entry and the take-profit three times that", TREND_TARGET_R === 3 && ok((x, d) => near(x.s.setup!.stopLoss, x.s.setup!.entry - d * x.s.setup!.risk) && near(x.s.setup!.takeProfit, x.s.setup!.entry + d * 3 * x.s.setup!.risk)));
  check(`costs are never more than ${TREND_MAX_COST_SHARE * 100}% of the risk`, TREND_MAX_COST_SHARE === 0.06 && ok((x) => tradeCost("XAU_USD") / x.s.setup!.risk <= 0.06));
  check("the entry is the candle's close and the signal is timed at that close", ok((x) => x.s.setup!.entry === m15[x.i].close && x.s.setup!.time === m15[x.i].time + M15 && x.s.setup!.key === `trend:${m15[x.i].time}`));
  check("nothing is signalled while a condition is unmet", states.every((s) => !(s.blocked && s.setup)) && states.every((s) => !s.setup || s.checks.every((c) => c.met)));
  check("no signal before the history has settled", setups.every((x) => x.i >= TREND_MIN_CANDLES && m15[x.i].time + M15 >= h1[TREND_MIN_H1_CANDLES].time + H1));
  const pending = states.findIndex((s, i) => i > 4 * TREND_MIN_H1_CANDLES + LONGEST && !s.blocked && !s.setup && s.levels.length === TREND_BREAKOUT_BARS.length + 1);
  check("with the trend confirmed and no entry yet, only the entry is missing", pending > 0 && states[pending].checks.length === 4 && states[pending].checks.filter((c) => !c.met).length === 1 && !states[pending].checks[3].met);
  const lvl = states[pending];
  check(
    "the levels shown are the ones the NEXT candle has to close beyond: the last swing and each channel",
    near(lvl.levels[0].price, lvl.dailyTrend === 1 ? st.openHigh[pending] : st.openLow[pending]) &&
      TREND_BREAKOUT_BARS.every((bars, b) => {
        const window = m15.slice(pending + 1 - bars, pending + 1);
        return near(lvl.levels[b + 1].price, lvl.dailyTrend === 1 ? Math.max(...window.map((c) => c.high)) : Math.min(...window.map((c) => c.low)));
      })
  );
  check(
    "a break of structure on the next candle is always through the swing level shown",
    setups.filter((x) => x.s.setup!.trigger === "break of structure" && !states[x.i - 1].blocked).every(({ i, s }) => {
      const l = states[i - 1].levels.find((v) => v.label.startsWith("last swing"));
      return !!l && (s.setup!.direction === "long" ? m15[i].close > l.price : m15[i].close < l.price);
    })
  );

  // the same candle read from history that stops at it must give the same answer
  let same = true;
  for (const { i } of setups.filter((_, k) => k % 40 === 0).concat(setups.slice(-3))) {
    const end = m15[i].time + M15;
    const cut = buildTrendSeries({ m15: m15.slice(0, i + 1), h1: h1.filter((c) => c.time + H1 <= end), daily: daily.filter((c) => c.time + DAY <= end) });
    const a = trendStateAt(cut, i).setup;
    const b = states[i].setup!;
    if (!a || a.direction !== b.direction || a.trigger !== b.trigger || !near(a.stopLoss, b.stopLoss, 1e-6) || !near(a.takeProfit, b.takeProfit, 1e-6)) same = false;
  }
  check("no look-ahead: a signal reads the same when history ends at its candle", same);
  // the live scanner reads 500 15-minute candles, 1,000 1-hour candles and 150 daily candles, not the whole history
  let agree = 0;
  let compared = 0;
  for (const { i } of setups.filter((x) => m15[x.i].time >= h1[1100].time).filter((_, k) => k % 10 === 0)) {
    const end = m15[i].time + M15;
    const w = buildTrendSeries({ m15: m15.slice(i - 499, i + 1), h1: h1.filter((c) => c.time + H1 <= end).slice(-1000), daily: daily.filter((c) => c.time + DAY <= end).slice(-150) });
    const a = trendStateAt(w, w.n - 1).setup;
    const b = states[i].setup!;
    compared++;
    if (a && a.direction === b.direction && a.trigger === b.trigger && near(a.stopLoss, b.stopLoss, 0.01)) agree++;
  }
  check("the scanner's window (500 15-minute, 1,000 1-hour, 150 daily candles) gives the same signal as the full history", compared > 20 && agree === compared, `${agree} of ${compared}`);

  const one = setups[0];
  const end = m15[one.i].time + M15;
  // the same market at a tenth of the price: every candle and every stop is ten times smaller, the cost is not
  const tenth = (cs: Candle[]) => cs.map((c) => ({ ...c, open: c.open / 10, high: c.high / 10, low: c.low / 10, close: c.close / 10 }));
  const small = trendStateAt(buildTrendSeries({ m15: tenth(m15.slice(0, one.i + 1)), h1: tenth(h1.filter((c) => c.time + H1 <= end)), daily: tenth(daily) }), one.i);
  check(
    "when costs are more than 6% of even the widest stop there is no trade, and the panel says why",
    near(small.costShare!, 10 * states[one.i].costShare!, 1e-9) && small.costShare! > 0.06 && small.setup == null && !!small.blocked?.startsWith("the candles are too small") && small.checks[2].met === false
  );
}

// ───────────── the backtest ─────────────
console.log("\nbacktest");
const trades = runTrendBacktest({ pair: "XAU_USD", m15, h1, daily });
{
  check("the generated market is traded", trades.length >= 100, `${trades.length} trades`);
  check("one trade at a time: a trade is entered only after the one before it has closed", TREND_MAX_OPEN === 1 && trades.every((t, k) => k === 0 || t.entryTime >= trades[k - 1].exitTime));
  check(
    "a trade fills at the open of the candle after its signal candle",
    trades.every((t) => {
      const e = m15.findIndex((x) => x.time === t.entryTime);
      // the stop is measured from the fill, so the trade is the signal candle read again at the next open
      const sig = trendStateAt(series, e - 1, "XAU_USD", m15[e].open).setup;
      return m15[e].open === t.entry && !!sig && sig.direction === t.direction && sig.trigger === t.trigger && near(sig.stopLoss, t.stopLoss) && near(sig.takeProfit, t.takeProfit);
    })
  );
  check(
    "the stop is measured from the fill price, so a gap at the open cannot leave it on the wrong side",
    trades.every((t) => (t.direction === "long" ? t.stopLoss < t.entry && t.takeProfit > t.entry : t.stopLoss > t.entry && t.takeProfit < t.entry))
  );
  const cost = tradeCost("XAU_USD");
  check(
    "the result is the price move less the full spread + slippage, in units of the stop",
    trades.every((t) => near(t.rAchieved, ((t.direction === "long" ? 1 : -1) * (t.exitPrice - t.entry) - cost) / Math.abs(t.entry - t.stopLoss), 1e-9))
  );
  check("a stopped trade loses 1R plus costs, or more on a gap", trades.filter((t) => t.outcome === "stop").every((t) => t.rAchieved <= -1 - cost / Math.abs(t.entry - t.stopLoss) + 1e-9));
  check("a take-profit pays 3R less costs", trades.some((t) => t.outcome === "target") && trades.filter((t) => t.outcome === "target").every((t) => near(t.rAchieved, 3 - cost / Math.abs(t.entry - t.stopLoss), 1e-9)));
  const timed = trades.filter((t) => t.outcome === "time");
  check(
    "a trade that reaches neither level is closed at the close of its 20th candle — five hours",
    TREND_MAX_HOLD_BARS === 20 &&
      timed.length > 0 &&
      timed.every((t) => {
        const e = m15.findIndex((x) => x.time === t.entryTime);
        const d = t.direction === "long" ? 1 : -1;
        return t.bars === 20 && t.exitPrice === m15[e + 19].close && t.exitTime === m15[e + 19].time + M15 && d * (t.exitPrice - t.stopLoss) > 0 && d * (t.takeProfit - t.exitPrice) > 0;
      }),
    `${timed.length} timed out`
  );
  check("no trade is held for more than 20 candles", trades.every((t) => t.outcome === "open" || t.bars <= 20));
  const doubled = runTrendBacktest({ pair: "XAU_USD", m15, h1, daily, costMultiplier: 2 });
  const sum = (g: { rAchieved: number }[]) => g.reduce((s, t) => s + t.rAchieved, 0);
  check("doubling the costs takes exactly one more cost off every trade", doubled.length === trades.length && near(sum(trades) - sum(doubled), trades.reduce((s, t) => s + cost / Math.abs(t.entry - t.stopLoss), 0), 1e-6));
  const from = trades[Math.floor(trades.length / 2)].entryTime;
  const later = runTrendBacktest({ pair: "XAU_USD", m15, h1, daily, from });
  check("`from` keeps only trades entered at or after it", later.length > 0 && later.every((t) => t.entryTime >= from));
  check("every trade counts under exactly one of the three entries", trades.every((t) => TREND_ENTRY_TYPES.includes(entryTypeOf(t))) && TREND_ENTRY_TYPES.reduce((n, type) => n + trades.filter((t) => entryTypeOf(t) === type).length, 0) === trades.length);
}

// ───────────── settlement: the live system follows a trade exactly as the backtest does ─────────────
console.log("\nsettlement");
{
  let agree = 0;
  const closed = trades.filter((t) => t.outcome !== "open");
  for (const t of closed) {
    // the signal is stored a few seconds after its candle closed, which is when the entry candle opens
    const res = settleSignal({ direction: t.direction, entry: t.entry, stop_loss: t.stopLoss, take_profit: t.takeProfit, firedAt: (t.entryTime + 8) * 1000 }, m15.filter((c) => c.time >= t.entryTime - 4 * M15 && c.time < t.exitTime + 4 * M15));
    const kind = res?.outcome === "expired" ? "time" : res && near(res.hitPrice!, t.takeProfit, 1e-9) ? "target" : "stop";
    if (res && near(res.hitPrice!, t.exitPrice, 1e-9) && res.hitTime === t.exitTime - M15 && kind === t.outcome) agree++;
  }
  check("every closed backtest trade settles at the same candle, price and outcome when followed live", closed.length > 0 && agree === closed.length, `${agree} of ${closed.length}`);
  const t0 = WEEK_OPEN;
  const bar = (k: number, open: number, high: number, low: number, close: number) => ({ time: t0 + k * M15, open, high, low, close });
  const buy = { direction: "long" as const, entry: 100, stop_loss: 90, take_profit: 130, firedAt: t0 * 1000 + 8000 };
  check("the candle the signal was read on is not followed", settleSignal(buy, [bar(-1, 100, 140, 80, 100)]) == null);
  const tp = settleSignal(buy, [bar(0, 100, 131, 99, 130)]);
  check("the take-profit closes it at 3R", tp?.outcome === "win" && tp.hitPrice === 130 && near(tp.r, 3));
  const sl = settleSignal(buy, [bar(0, 100, 135, 89, 120)]);
  check("a candle touching the stop and the target counts as the stop", sl?.outcome === "loss" && sl.hitPrice === 90 && near(sl.r, -1));
  const gap = settleSignal(buy, [bar(0, 100, 101, 99, 100), bar(1, 85, 86, 84, 85)]);
  check("a gap through the stop fills at the open", gap?.outcome === "loss" && gap.hitPrice === 85 && near(gap.r, -1.5));
  const quiet = Array.from({ length: TREND_MAX_HOLD_BARS + 5 }, (_, k) => bar(k, 100, 104, 99, 103));
  const late = settleSignal(buy, quiet);
  check("a trade that reaches neither level is closed at market at the close of its 20th candle", late?.outcome === "expired" && late.hitTime === quiet[TREND_MAX_HOLD_BARS - 1].time && near(late.r, 0.3));
  check("…and is still open one candle before that", settleSignal(buy, quiet.slice(0, TREND_MAX_HOLD_BARS - 1)) == null);
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
  check("a signal of these rules is told apart from one of the removed systems", setups.length > 0 && setups.every((x) => isLiveSignal({ strategy: TREND_STRATEGY, variant: x.s.setup!.key })) && !isLiveSignal({ strategy: TREND_STRATEGY, variant: "don30" }) && !isLiveSignal({ strategy: "fibonacci", variant: "trend:1" }));
  check("nothing open: a signal is sent", sendBlock([], trade) == null && sendBlock([row("short", false)], trade) == null);
  check("one trade at a time: nothing is sent while a trade is open, the same way or the other", sendBlock([row("long", true)], trade) != null && sendBlock([row("short", true)], trade) != null);
  check("a signal candle is sent once, even after its trade has closed", sendBlock([row("long", false, "trend:1")], trade) != null);
  check("a closed trade of another candle is not in the way", sendBlock([row("long", false, "trend:0")], trade) == null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
