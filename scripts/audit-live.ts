/**
 * Audit of what the live site draws, against the provider's raw candles and a calculation written here from scratch
 * (not the site's own code): candles, swing points and their labels, breaks of structure, moving averages, yesterday's
 * high and low, the entry levels — on the 15-minute, 1-hour and 4-hour gold charts — and the Bitcoin page.
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/audit-live.ts
 *   SITE_URL=http://localhost:3000 …    # another deployment
 */
import { fetchCandles } from "../lib/oanda";
import type { Candle } from "../lib/types";

const SITE = process.env.SITE_URL ?? "https://dts-trading-system-v2.vercel.app";
let ok = 0, bad = 0;
const check = (name: string, pass: boolean, detail = "") => { if (pass) ok++; else bad++; console.log("  " + (pass ? "ok  " : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

async function gold(view: "M15" | "H1" | "H4") {
  console.log("\ngold, " + view + " chart");
  const j = (await (await fetch(SITE + "/api/analysis?instrument=XAU_USD&view=" + view + "&count=500")).json()) as {
    candles: Candle[];
    structure: { points: { time: number; price: number; kind: "high" | "low"; label: string }[]; breaks: { time: number; level: number; levelTime: number; dir: 1 | -1; kind: string }[] };
    emas: { period: number; points: { time: number; value: number }[] }[];
    context: { prevDayHigh: number; prevDayLow: number };
    trend: { swingHigh: number | null; swingLow: number | null; dailyTrend: number; levels: { label: string; price: number; armed: boolean }[]; zones: { low: number; high: number; touches: number }[]; atr: number | null; stopLevel: number | null; readAt: number } | null;
  };
  const c = j.candles;
  const raw = await fetchCandles({ instrument: "XAU_USD", granularity: view, count: 500 });
  const byTime = new Map(raw.map((x) => [x.time, x]));
  const common = c.filter((x) => byTime.has(x.time));
  check("the chart's candles are the provider's candles, price for price", common.length >= 480 && common.every((x) => { const r = byTime.get(x.time)!; return r.open === x.open && r.high === x.high && r.low === x.low && r.close === x.close; }), common.length + " candles compared");
  check("candles are in order, without doubles, and each one's high and low contain its open and close", c.every((x, k) => (k === 0 || x.time > c[k - 1].time) && x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close)));
  const idx = new Map(c.map((x, k) => [x.time, k]));
  const K = 3;
  // swings, from scratch: a high with three lower highs on each side
  const pts = j.structure.points.filter((p) => idx.has(p.time));
  check("every swing label sits on the candle's own high or low", pts.every((p) => { const x = c[idx.get(p.time)!]; return near(p.price, p.kind === "high" ? x.high : x.low); }), pts.length + " swings");
  const isSwing = (k: number, kind: "high" | "low") => {
    if (k < K || k + K >= c.length) return true;
    for (let q = k - K; q <= k + K; q++) if (q !== k && (kind === "high" ? c[q].high > c[k].high : c[q].low < c[k].low)) return false;
    return true;
  };
  check("every marked swing is the highest high (lowest low) of the three candles on each side", pts.every((p) => isSwing(idx.get(p.time)!, p.kind)));
  // …and none is missing: every candle that is strictly such a swing is marked
  let missing = 0;
  const marked = new Set(pts.map((p) => p.kind + p.time));
  for (let k = K + 1; k + K < c.length; k++) for (const kind of ["high", "low"] as const) {
    let strict = true;
    for (let q = k - K; q <= k + K; q++) if (q !== k && (kind === "high" ? c[q].high >= c[k].high : c[q].low <= c[k].low)) strict = false;
    if (strict && !marked.has(kind + c[k].time) && c[k].time > (pts[0]?.time ?? Infinity)) missing++;
  }
  check("no swing is missing from the chart", missing === 0, missing + " unmarked");
  const lab = (kind: "high" | "low") => { const q = pts.filter((p) => p.kind === kind); return q.every((p, k) => k === 0 || p.label === (kind === "high" ? (p.price > q[k - 1].price ? "HH" : "LH") : p.price > q[k - 1].price ? "HL" : "LL")); };
  check("HH / LH / HL / LL labels follow from the swing before", lab("high") && lab("low"));
  const br = j.structure.breaks.filter((b) => idx.has(b.time));
  check("every break of structure is a candle that closed beyond the level it names", br.every((b) => { const x = c[idx.get(b.time)!]; return b.dir === 1 ? x.close > b.level : x.close < b.level; }), br.length + " breaks");
  check("every break's level is a marked swing's price", br.filter((b) => idx.has(b.levelTime)).every((b) => pts.some((p) => p.time === b.levelTime && near(p.price, b.level))));
  check("BOS continues the direction of the break before it, CHoCH turns it", br.every((b, k) => k === 0 || b.kind === (br[k - 1].dir === b.dir ? "BOS" : "CHoCH")));
  // moving averages, from scratch
  for (const period of [20, 50]) {
    const mult = 2 / (period + 1);
    let v = c[0].close;
    for (let k = 1; k < c.length; k++) v = c[k].close * mult + v * (1 - mult);
    const drawn = j.emas.find((e) => e.period === period)!.points;
    check("the " + period + "-EMA line ends where a fresh calculation ends", near(drawn[drawn.length - 1].value, v, 2e-5), drawn[drawn.length - 1].value.toFixed(3) + " against " + v.toFixed(3));
  }
  const e200 = j.emas.find((e) => e.period === 200)!.points;
  check("the 200-EMA line covers every candle shown", e200.length === c.length && e200.every((p, k) => p.time === c[k].time && Number.isFinite(p.value)));
  const days = (await fetchCandles({ instrument: "XAU_USD", granularity: "D", count: 8 })).filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
  const y = days[days.length - 1];
  check("yesterday's high and low are the last closed daily candle's", near(j.context.prevDayHigh, y.high) && near(j.context.prevDayLow, y.low), y.high + " / " + y.low);
  if (view === "M15" && j.trend) {
    const t = j.trend;
    const lastHigh = [...pts].reverse().find((p) => p.kind === "high" && idx.get(p.time)! + K < c.length);
    const lastLow = [...pts].reverse().find((p) => p.kind === "low" && idx.get(p.time)! + K < c.length);
    check("the panel's last swing high and low are the last ones marked on the chart", (t.swingHigh == null || (!!lastHigh && near(t.swingHigh, lastHigh.price))) && (t.swingLow == null || (!!lastLow && near(t.swingLow, lastLow.price))), t.swingHigh + " / " + t.swingLow);
    // the channel levels: the low/high of the last 3, 6, 12 and 24 hours of candles before the candle now forming
    const closed = c.filter((x) => x.time + 900 <= t.readAt);
    const chan = [12, 24, 48, 96].map((len) => (t.dailyTrend === 1 ? Math.max(...closed.slice(-len).map((x) => x.high)) : Math.min(...closed.slice(-len).map((x) => x.low))));
    const drawn = t.levels.filter((l) => /hour/.test(l.label)).map((l) => l.price);
    check("the 3-, 6-, 12- and 24-hour levels are the real highs/lows of those hours", drawn.length === 4 && drawn.every((p, k) => near(p, chan[k])), drawn.join(", "));
    const two = closed.slice(-2);
    const sl = t.dailyTrend === 1 ? Math.min(...two.map((x) => x.low)) : Math.max(...two.map((x) => x.high));
    check("the stop level shown is the extreme of the last two candles", t.stopLevel == null || near(t.stopLevel, sl), String(t.stopLevel));
    check("support/resistance zones are well-formed, in order, with three touches or more", t.zones.every((z) => z.high > z.low && z.touches >= 3) && t.zones.every((z, k) => k === 0 || z.low >= t.zones[k - 1].low));
  }
}

async function btc() {
  console.log("\nBitcoin page");
  const j = (await (await fetch(SITE + "/api/btc")).json()) as {
    candles: Candle[];
    ema: { time: number; value: number }[];
    state: { readAt: number; candleTime: number; trend: number; ema: number; prevHigh: number; prevLow: number; nextLevel: number | null; nextLevelFinal: boolean; close: number };
    trades: { entryTime: number; entry: number; stopLoss: number; takeProfit: number; direction: string; exitTime: number; exitPrice: number; outcome: string }[];
  };
  const m15 = await fetchCandles({ instrument: "BTC_USD", granularity: "M15", count: 5000 });
  const h1 = await fetchCandles({ instrument: "BTC_USD", granularity: "H1", count: 5000 });
  // 4-hour candles from scratch
  const add = (src: Candle[]) => {
    const agg = new Map<number, Candle>();
    for (const x of src) { const t = Math.floor(x.time / 14400) * 14400; const a = agg.get(t); if (!a) agg.set(t, { ...x, time: t }); else { a.high = Math.max(a.high, x.high); a.low = Math.min(a.low, x.low); a.close = x.close; } }
    return agg;
  };
  const agg = add(m15);
  const full = j.candles.filter((x) => agg.has(x.time) && x.time + 14400 <= j.state.readAt && x.time > m15[0].time);
  check("the 4-hour candles drawn are the 15-minute candles added up", full.length > 150 && full.every((x) => { const a = agg.get(x.time)!; return near(a.open, x.open) && near(a.high, x.high) && near(a.low, x.low) && near(a.close, x.close); }), full.length + " candles compared");
  const closed = j.candles.filter((x) => x.time + 14400 <= j.state.readAt);
  const last = closed[closed.length - 1];
  check("the system reads the last CLOSED 4-hour candle", last.time === j.state.candleTime && near(last.close, j.state.close));
  // the 200-EMA of the 4-hour closes, from scratch, over all the history the provider gives at once
  const long = [...add(h1).values()].filter((x) => x.time + 14400 <= j.state.readAt).sort((x, y) => x.time - y.time);
  const k = 2 / 201;
  const fresh = new Map<number, number>();
  let e = long[0].close;
  for (const x of long) { e = x === long[0] ? e : x.close * k + e * (1 - k); fresh.set(x.time, e); }
  check("the trend line is the 200-EMA of the 4-hour closes, and the trend is the close against it", near(j.state.ema, e, 1e-6) && j.state.trend === Math.sign(last.close - e), j.state.ema.toFixed(1) + " against " + e.toFixed(1));
  check("every point of the trend line drawn is that average", j.ema.length > 100 && j.ema.every((p) => fresh.has(p.time) && near(p.value, fresh.get(p.time)!, 1e-6)), j.ema.length + " points");
  const weekdays = (await fetchCandles({ instrument: "BTC_USD", granularity: "D", count: 12 })).filter((d) => ![5, 6].includes(new Date(d.time * 1000).getUTCDay()));
  const dayAt = (t: number) => [...weekdays].reverse().find((d) => d.time + 86400 <= t)!;
  const y = dayAt(j.state.readAt - 900);
  check("yesterday's high and low are the last daily candle closed when the 4-hour candle closed", near(j.state.prevHigh, y.high) && near(j.state.prevLow, y.low), y.high + " / " + y.low);
  const nextDay = dayAt(Math.min(Date.now() / 1000, j.state.readAt + 14400 - 900));
  check("the level shown for the next trade is the last closed day's high (buys) or low (sells)", j.state.nextLevel == null || near(j.state.nextLevel, j.state.trend === 1 ? nextDay.high : nextDay.low), String(j.state.nextLevel) + (j.state.nextLevelFinal ? "" : " (not final: the day closes first)"));
  const byT = new Map(m15.map((x) => [x.time, x]));
  check("every trade listed was entered at a real 15-minute open, right after a 4-hour close", j.trades.every((t) => { const x = byT.get(t.entryTime); return !!x && near(x.open, t.entry) && t.entryTime % 14400 === 0; }), j.trades.length + " trades");
  check("every trade's target is three times its risk", j.trades.every((t) => near(Math.abs(t.takeProfit - t.entry), 3 * Math.abs(t.entry - t.stopLoss), 1e-6)));
  // a candle that opens beyond the target (a weekend gap) is booked at the target, not at the better open: the one case where the exit is not a traded price
  const gapped = (t: (typeof j.trades)[number], x: Candle) => t.outcome === "target" && (t.direction === "long" ? x.open > t.takeProfit : x.open < t.takeProfit) && near(t.exitPrice, t.takeProfit);
  const exits = j.trades.filter((t) => t.outcome !== "open");
  check(
    "every closed trade's exit price was really traded in its last candle (or is a target that price gapped through)",
    exits.every((t) => { const x = byT.get(t.exitTime - 900); return !!x && ((t.exitPrice <= x.high + 1e-6 && t.exitPrice >= x.low - 1e-6) || gapped(t, x)); }),
    exits.filter((t) => { const x = byT.get(t.exitTime - 900); return !!x && gapped(t, x); }).length + " booked at a gapped target"
  );
}

(async () => {
  for (const v of ["M15", "H1", "H4"] as const) await gold(v);
  await btc();
  console.log("\n" + ok + " passed, " + bad + " failed");
  if (bad) process.exit(1);
})();
