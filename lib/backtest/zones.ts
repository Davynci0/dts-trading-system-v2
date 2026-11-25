import { readZones, znContext, znSetup, ZN_MAX_HOLD_BARS } from "@/lib/analysis/zones";
import { tradeCost } from "@/lib/analysis/instruments";
import type { Candle } from "@/lib/types";

/**
 * The supply and demand strategy, replayed. A rejection is read on a CLOSED
 * 15-minute candle and filled at the next candle's open. The trade is then
 * followed on 15-minute candles: the stop first (a candle that touches both
 * counts as the stop; a gap through it fills at the candle's open), then the
 * target, then the five-day limit. Nothing is moved in between. The full
 * spread plus slippage is charged once.
 */
export interface ZnTrade {
  direction: "long" | "short";
  kind: "demand" | "supply";
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  /** result in R after costs */
  rAchieved: number;
  /** 15-minute candles held */
  bars: number;
  outcome: "target" | "stop" | "time" | "open";
}

/** Every setup from `from` on, each followed on its own — whether or not another trade was open. */
export function znCandidates(opts: {
  pair: string;
  m15: Candle[];
  h1: Candle[];
  daily: Candle[];
  from?: number;
  costMultiplier?: number;
  /** research only: a variant of the rules to compare with the live ones */
  variant?: { minBase?: number; lockAtR?: number; lockToR?: number };
}): ZnTrade[] {
  const { pair, m15, h1, daily, from = 0, costMultiplier = 1 } = opts;
  const cost = tradeCost(pair) * Math.max(0, costMultiplier);
  const context = znContext(h1, daily);
  const out: ZnTrade[] = [];
  for (const ev of readZones(m15, 0).events) {
    const e = ev.index + 1;
    if (ev.time < from || e >= m15.length) continue;
    const { setup } = znSetup(ev, context(ev.time), m15[e].open, pair);
    if (!setup || setup.zone.base < (opts.variant?.minBase ?? 1)) continue;
    const dir = setup.direction === "long" ? 1 : -1;
    let exitPrice = NaN;
    let outcome: ZnTrade["outcome"] = "open";
    let stop = setup.stopLoss;
    let k = e;
    for (; k < m15.length; k++) {
      const c = m15[k];
      if (dir === 1 ? c.low <= stop : c.high >= stop) {
        exitPrice = dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open);
        outcome = "stop";
        break;
      }
      if (dir === 1 ? c.high >= setup.takeProfit : c.low <= setup.takeProfit) {
        exitPrice = setup.takeProfit;
        outcome = "target";
        break;
      }
      if (opts.variant?.lockAtR != null && (dir === 1 ? c.high >= setup.entry + opts.variant.lockAtR * setup.risk : c.low <= setup.entry - opts.variant.lockAtR * setup.risk)) {
        stop = setup.entry + dir * (opts.variant.lockToR ?? 0) * setup.risk;
      }
      if (k - e + 1 >= ZN_MAX_HOLD_BARS) {
        exitPrice = c.close;
        outcome = "time";
        break;
      }
    }
    if (outcome === "open") {
      k = m15.length - 1;
      exitPrice = m15[k].close;
    }
    out.push({
      direction: setup.direction,
      kind: setup.zone.kind,
      entryTime: m15[e].time,
      exitTime: m15[k].time + 900,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      rAchieved: (dir * (exitPrice - setup.entry) - cost) / setup.risk,
      bars: k - e + 1,
      outcome,
    });
  }
  return out;
}

/** The trades the strategy takes on its own: one at a time. Trades still open at the end of the data are left out. */
export function runZnBacktest(opts: Parameters<typeof znCandidates>[0]): ZnTrade[] {
  const taken: ZnTrade[] = [];
  let busy = 0;
  for (const t of znCandidates(opts)) {
    if (t.entryTime < busy) continue;
    busy = t.exitTime;
    if (t.outcome !== "open") taken.push(t);
  }
  return taken;
}
