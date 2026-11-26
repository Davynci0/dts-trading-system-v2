/**
 * Checks of the Bitcoin system (lib/analysis/btc.ts, lib/backtest/btc.ts) on a
 * generated market: the 4-hour chart, yesterday's high and low, the trend, the
 * entry, the stop, the exits and the one-trade-at-a-time rule, each recomputed
 * here from the candles and compared with what the code did.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/verify-btc.ts
 */
import {
  btcStateAt,
  buildBtcSeries,
  fourHour,
  BTC_CHART_SECONDS,
  BTC_COST,
  BTC_LOCK_AT_R,
  BTC_LOCK_TO_R,
  BTC_MAX_COST_SHARE,
  BTC_MAX_ENTRY_DELAY,
  BTC_MAX_HOLD_BARS,
  BTC_MAX_RISK_ATR,
  BTC_MIN_CANDLES,
  BTC_MIN_RISK_ATR,
  BTC_STOP_BUFFER_ATR,
  BTC_STOP_CANDLES,
  BTC_TARGET_R,
  BTC_TREND_EMA,
} from "../lib/analysis/btc";
import { btcStats, runBtcBacktest } from "../lib/backtest/btc";
import type { Candle } from "../lib/types";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ───────────── a generated market: 15-minute candles, weekdays only, with trends and ranges ─────────────
let seed = 20261126;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const START = Date.UTC(2025, 0, 5, 22) / 1000; // a Sunday, 22:00 UTC
const m15: Candle[] = [];
{
  let price = 60000;
  let drift = 0;
  for (let k = 0; k < 96 * 7 * 60; k++) {
    const t = START + k * 900;
    const d = new Date(t * 1000);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    // closed from Friday 22:00 to Sunday 22:00 UTC
    if ((day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22)) continue;
    if (k % (96 * 6) === 0) drift = (rnd() - 0.5) * 0.0016;
    const open = price;
    const close = open * (1 + drift + gauss() * 0.0022);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.0008);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.0008);
    m15.push({ time: t, open, high, low, close, volume: 1 });
    price = close;
  }
}
function aggregate(src: Candle[], key: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (const c of src) {
    const t = key(c.time);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: 1 });
  }
  return out;
}
const h1 = aggregate(m15, (t) => Math.floor(t / 3600) * 3600);
// daily candles open at 22:00 UTC, as the data provider's do
const daily = aggregate(m15, (t) => Math.floor((t - 22 * 3600) / 86400) * 86400 + 22 * 3600);

console.log("the 4-hour chart");
const h4 = fourHour(h1);
{
  check("4-hour candles sit on the UTC clock (00:00, 04:00, …)", h4.every((c) => c.time % BTC_CHART_SECONDS === 0));
  const j = Math.floor(h4.length / 2);
  const inside = m15.filter((c) => c.time >= h4[j].time && c.time < h4[j].time + BTC_CHART_SECONDS);
  check(
    "a 4-hour candle is the open, high, low and close of the candles inside it",
    near(h4[j].open, inside[0].open) && near(h4[j].close, inside[inside.length - 1].close) && near(h4[j].high, Math.max(...inside.map((c) => c.high))) && near(h4[j].low, Math.min(...inside.map((c) => c.low)))
  );
  check("built from 1-hour candles or from 15-minute candles, the 4-hour chart is the same", JSON.stringify(fourHour(m15).map((c) => [c.time, c.open, c.high, c.low, c.close])) === JSON.stringify(h4.map((c) => [c.time, c.open, c.high, c.low, c.close])));
}

console.log("\nthe series");
const s = buildBtcSeries({ h1, daily });
const weekdays = daily.filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
/** yesterday for the 4-hour candle j, worked out here: the last daily candle closed a quarter of an hour before the candle's last hour ended */
const yesterdayOf = (j: number) => {
  const inside = h1.filter((c) => c.time >= s.h4[j].time && c.time < s.h4[j].time + BTC_CHART_SECONDS);
  const known = inside[inside.length - 1].time + 3600 - 900;
  let p = -1;
  while (p + 1 < weekdays.length && weekdays[p + 1].time + 86400 <= known) p++;
  return p;
};
{
  const j = s.n - 7;
  const p = yesterdayOf(j);
  check("yesterday's high and low are the last daily candle CLOSED when the 4-hour candle closed", s.day[j] === p && near(s.prevHigh[j], weekdays[p].high) && near(s.prevLow[j], weekdays[p].low));
  check("the ATR is known and positive once there is enough history", s.atr.slice(BTC_MIN_CANDLES).every((x) => x > 0));
  const k = 2 / (BTC_TREND_EMA + 1);
  let e = s.h4[0].close;
  for (let q = 1; q <= j; q++) e = s.h4[q].close * k + e * (1 - k);
  check(`the trend line is the ${BTC_TREND_EMA}-EMA of the 4-hour closes`, near(s.ema[j], e, 1e-9));
  // the first close beyond yesterday's high / low of each day, counted here with a set
  const seen = new Set<string>();
  let same = true;
  for (let q = 0; q < s.n; q++) {
    const d = yesterdayOf(q);
    if (d < 0) continue;
    const up = s.h4[q].close > weekdays[d].high && !seen.has(d + "u");
    const down = s.h4[q].close < weekdays[d].low && !seen.has(d + "d");
    if (up) seen.add(d + "u");
    if (down) seen.add(d + "d");
    if (!!s.firstAbove[q] !== up || !!s.firstBelow[q] !== down) same = false;
  }
  check("the first close beyond yesterday's high or low is marked once a day on each side", same && s.firstAbove.some((x) => x === 1) && s.firstBelow.some((x) => x === 1));
  const cut = buildBtcSeries({ h1, daily, now: s.h4[s.n - 1].time + 3600 });
  check("a 4-hour candle that has not closed yet is not read", cut.n === s.n - 1);
}

console.log("\nthe entry and the stop");
const states = Array.from({ length: s.n }, (_, j) => (j >= BTC_MIN_CANDLES ? btcStateAt(s, j) : null));
const setups = states.map((x, j) => ({ x, j })).filter((q) => q.x?.setup);
{
  check("the generated market gives setups on both sides", setups.some((q) => q.x!.setup!.direction === "long") && setups.some((q) => q.x!.setup!.direction === "short"), `${setups.length} setups`);
  check(
    `every setup is with the trend: a buy closes above the ${BTC_TREND_EMA}-EMA, a sell below it`,
    setups.every((q) => (q.x!.setup!.direction === "long" ? s.h4[q.j].close > s.ema[q.j] : s.h4[q.j].close < s.ema[q.j]))
  );
  check(
    "every setup is a 4-hour close beyond yesterday's high (buy) or low (sell)",
    setups.every((q) => (q.x!.setup!.direction === "long" ? s.h4[q.j].close > s.prevHigh[q.j] && near(q.x!.setup!.level, s.prevHigh[q.j]) : s.h4[q.j].close < s.prevLow[q.j] && near(q.x!.setup!.level, s.prevLow[q.j])))
  );
  check(
    "…and the first one of its day: no earlier candle of that day had closed beyond it",
    setups.every((q) => {
      const up = q.x!.setup!.direction === "long";
      for (let k = q.j - 1; k >= 0 && s.day[k] === s.day[q.j]; k--) if (up ? s.h4[k].close > s.prevHigh[q.j] : s.h4[k].close < s.prevLow[q.j]) return false;
      return true;
    })
  );
  const later = states.filter((x, j) => x && !x.setup && x.trend !== 0 && (x.trend === 1 ? s.h4[j].close > s.prevHigh[j] && !s.firstAbove[j] : s.h4[j].close < s.prevLow[j] && !s.firstBelow[j]));
  check("a later close beyond the same level is not traded", later.length > 0 && later.every((x) => x!.waiting?.includes("already closed")), `${later.length} such candles`);
  const against = states.filter((x, j) => x && ((s.firstAbove[j] && s.h4[j].close < s.ema[j]) || (s.firstBelow[j] && s.h4[j].close > s.ema[j])));
  check("a first close beyond the level against the trend is not traded", against.length > 0 && against.every((x) => !x!.setup && x!.waiting?.includes("against the trend")), `${against.length} such candles`);
  check(
    `the risk is between ${BTC_MIN_RISK_ATR} and ${BTC_MAX_RISK_ATR} ATR`,
    setups.every((q) => q.x!.setup!.risk >= BTC_MIN_RISK_ATR * s.atr[q.j] - 1e-6 && q.x!.setup!.risk <= BTC_MAX_RISK_ATR * s.atr[q.j] + 1e-6)
  );
  check(
    `a stop inside the limits sits ${BTC_STOP_BUFFER_ATR} ATR beyond the last ${BTC_STOP_CANDLES} candles; one outside is brought to the limit`,
    setups.every((q) => {
      const u = q.x!.setup!;
      const dir = u.direction === "long" ? 1 : -1;
      const two = s.h4.slice(q.j - BTC_STOP_CANDLES + 1, q.j + 1);
      const extreme = dir === 1 ? Math.min(...two.map((c) => c.low)) : Math.max(...two.map((c) => c.high));
      const raw = dir * (u.entry - (extreme - dir * BTC_STOP_BUFFER_ATR * s.atr[q.j]));
      const want = Math.min(Math.max(raw, BTC_MIN_RISK_ATR * s.atr[q.j]), BTC_MAX_RISK_ATR * s.atr[q.j]);
      return near(u.risk, want) && u.stopBasis === (raw > BTC_MAX_RISK_ATR * s.atr[q.j] ? "limit" : raw < BTC_MIN_RISK_ATR * s.atr[q.j] ? "minimum" : "candles");
    })
  );
  check(
    `the take-profit is ${BTC_TARGET_R} times the risk, the lock at +${BTC_LOCK_AT_R}R moves the stop to +${BTC_LOCK_TO_R}R`,
    setups.every((q) => {
      const u = q.x!.setup!;
      const dir = u.direction === "long" ? 1 : -1;
      return near(u.takeProfit, u.entry + dir * BTC_TARGET_R * u.risk) && near(u.lockTrigger, u.entry + dir * BTC_LOCK_AT_R * u.risk) && near(u.lockStop, u.entry + dir * BTC_LOCK_TO_R * u.risk) && near(u.stopLoss, u.entry - dir * u.risk);
    })
  );
  check(`no setup when costs are more than ${BTC_MAX_COST_SHARE * 100}% of the risk`, setups.every((q) => BTC_COST / q.x!.setup!.risk <= BTC_MAX_COST_SHARE + 1e-9));
  const waitingOnes = states.filter((x) => x && !x.setup);
  check("a candle without a trade says what it is waiting for", waitingOnes.length > 0 && waitingOnes.every((x) => !!x!.waiting) && setups.every((q) => q.x!.waiting == null));
  // the level shown for the next candle, where the next candle is a whole one (not cut by the weekend)
  // (candles cut short by the weekend are left out: by their clock's end the day has already closed)
  const whole = (j: number) => j + 2 < s.n && s.h4[j + 2].time - s.h4[j + 1].time === BTC_CHART_SECONDS && s.h4[j + 1].time - s.h4[j].time === BTC_CHART_SECONDS;
  const shown = states.map((x, j) => ({ x, j })).filter((q) => q.x && q.x.nextLevel != null && q.x.nextLevelFinal && whole(q.j));
  check(
    "the level shown for the next candle is yesterday's high or low as that candle will be read",
    shown.length > 0 && shown.every((q) => near(q.x!.nextLevel!, q.x!.trend === 1 ? s.prevHigh[q.j + 1] : s.prevLow[q.j + 1]))
  );
  check(
    "the level is shown as still open only while that side has not been used today",
    shown.every((q) => q.x!.nextArmed === !(q.x!.trend === 1 ? s.usedAbove[q.j] : s.usedBelow[q.j]))
  );
  // a level that will be replaced before the next candle closes is marked as such: the next candle belongs to a new day
  const provisional = states.map((x, j) => ({ x, j })).filter((q) => q.x && q.x.nextLevel != null && !q.x.nextLevelFinal && whole(q.j));
  check("when the day closes before the next 4-hour candle does, the level shown is marked as not final", provisional.length > 0 && provisional.every((q) => s.day[q.j + 1] !== s.day[q.j]) && shown.every((q) => s.day[q.j + 1] === s.day[q.j]), `${provisional.length} such candles`);
  // once that day has closed, the page (read later) shows the new level
  const after = provisional.slice(0, 40).map((q) => btcStateAt(s, q.j, undefined, s.h4[q.j].time + 2 * BTC_CHART_SECONDS - 900));
  check("…and once the day has closed, the level shown is the new day's", after.every((x, k) => near(x.nextLevel!, x.trend === 1 ? s.prevHigh[provisional[k].j + 1] : s.prevLow[provisional[k].j + 1]) && x.nextArmed && x.nextLevelFinal));
}

console.log("\nthe backtest");
const trades = runBtcBacktest({ m15, h1, daily });
{
  check("the generated market is traded", trades.length >= 20, `${trades.length} trades`);
  check("one trade at a time: a trade is entered only after the one before it has closed", trades.every((t, k) => k === 0 || t.entryTime >= trades[k - 1].exitTime));
  check("a trade is filled on the first 15-minute candle after a 4-hour close", trades.every((t) => t.entryTime % BTC_CHART_SECONDS === 0 || m15.some((c) => c.time === t.entryTime && c.time - Math.floor(c.time / BTC_CHART_SECONDS) * BTC_CHART_SECONDS <= BTC_MAX_ENTRY_DELAY)));
  // no entry when the market was closed at the 4-hour close: the Friday candle closes at 00:00 UTC on Saturday, the market opens on Sunday
  check("no trade is entered when the market was closed at the 4-hour close (the weekend)", trades.every((t) => new Date(t.entryTime * 1000).getUTCDay() !== 0 || new Date(t.entryTime * 1000).getUTCHours() !== 22));
  check(`no trade is held longer than ${BTC_MAX_HOLD_BARS} fifteen-minute candles`, trades.every((t) => t.bars <= BTC_MAX_HOLD_BARS) && trades.some((t) => t.outcome === "time" && t.bars === BTC_MAX_HOLD_BARS));
  const priceR = (t: (typeof trades)[number]) => ((t.direction === "long" ? 1 : -1) * (t.exitPrice - t.entry)) / Math.abs(t.entry - t.stopLoss);
  check("a trade closed at the target made 3R before costs", trades.filter((t) => t.outcome === "target").every((t) => near(priceR(t), BTC_TARGET_R, 1e-6)) && trades.some((t) => t.outcome === "target"));
  check("a trade closed at the first stop lost 1R or more before costs", trades.filter((t) => t.outcome === "stop").every((t) => priceR(t) <= -1 + 1e-6) && trades.some((t) => t.outcome === "stop"));
  check(`a trade closed at the moved stop made +${BTC_LOCK_TO_R}R before costs, or less after a gap`, trades.filter((t) => t.outcome === "lock").every((t) => priceR(t) <= BTC_LOCK_TO_R + 1e-6) && trades.filter((t) => t.outcome === "lock").some((t) => near(priceR(t), BTC_LOCK_TO_R, 1e-6)));
  check("the cost is charged once, in full", trades.every((t) => near(t.rAchieved, priceR(t) - BTC_COST / Math.abs(t.entry - t.stopLoss), 1e-6)));
  const doubled = runBtcBacktest({ m15, h1, daily, costMultiplier: 2 });
  check("doubled costs take the same trades and make less", doubled.length === trades.length && btcStats(doubled).totalR < btcStats(trades).totalR);
  // followed by hand: the stop is tested before the target, and the lock applies from the candle after it is reached
  const t = trades.find((q) => q.outcome === "lock")!;
  const e = m15.findIndex((c) => c.time === t.entryTime);
  const dir = t.direction === "long" ? 1 : -1;
  const risk = Math.abs(t.entry - t.stopLoss);
  let stop = t.stopLoss;
  let exit = NaN;
  for (let k = e; k < m15.length; k++) {
    const c = m15[k];
    if (dir === 1 ? c.low <= stop : c.high >= stop) {
      exit = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
      break;
    }
    if (dir === 1 ? c.high >= t.takeProfit : c.low <= t.takeProfit) break;
    if (dir === 1 ? c.high >= t.entry + BTC_LOCK_AT_R * risk : c.low <= t.entry - BTC_LOCK_AT_R * risk) stop = t.entry + dir * BTC_LOCK_TO_R * risk;
  }
  check("a locked trade, followed candle by candle here, closes where the backtest closed it", near(exit, t.exitPrice));
  const from = trades[Math.floor(trades.length / 2)].entryTime;
  check("`from` keeps only the trades entered at or after it", runBtcBacktest({ m15, h1, daily, from }).every((q) => q.entryTime >= from));
}

console.log("\nthe page reads what the backtest reads");
{
  // the page loads a window of candles; its read of a candle has to be the read of the full history
  let same = 0;
  let total = 0;
  for (let j = s.n - 200; j < s.n; j += 3) {
    const closed = s.h4[j].time + BTC_CHART_SECONDS;
    const win = buildBtcSeries({ h1: h1.filter((c) => c.time + 3600 <= closed).slice(-5000), daily: daily.filter((d) => d.time + 86400 <= closed).slice(-120), now: closed });
    const got = btcStateAt(win, win.n - 1);
    const want = states[j]!;
    total++;
    if ((got.setup == null) === (want.setup == null) && got.trend === want.trend && near(got.nextLevel ?? 0, want.nextLevel ?? 0) && got.nextArmed === want.nextArmed && got.nextLevelFinal === want.nextLevelFinal && (!got.setup || near(got.setup.stopLoss, want.setup!.stopLoss, 1e-4))) same++;
  }
  check("a window of 5,000 one-hour and 120 daily candles reads a candle as the full history does", same === total, `${same} of ${total}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
