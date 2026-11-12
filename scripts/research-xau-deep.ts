import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

/**
 * XAU/USD DEEP RESEARCH SWEEP
 *
 * Tests on ~52 days (5000 M15 candles):
 *  Phase 1: Each strategy alone at every gate (1-6)
 *  Phase 2: Every strategy pair at every gate combo
 *  Phase 3: All 3 strategies at every gate combo
 *  Phase 4: Trend filter modes (none, HTF only, M15 only, both)
 *  Phase 5: Individual confirmation require/exclude (rejection, RSI, HTF, M15)
 *  Phase 6: Split-half validation of top 10 configs
 *
 * Run: npx tsx --env-file=.env.local scripts/research-xau-deep.ts
 */
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { fetchCandles } from "@/lib/oanda";

const PAIR = "XAU_USD";

async function main() {
  console.log(`Fetching ${PAIR} data...`);
  const [candles, htfCandles, weekly, daily, h4, h1] = await Promise.all([
    fetchCandles({ instrument: PAIR, granularity: "M15", count: 5000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "W", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "D", count: 500 }),
    fetchCandles({ instrument: PAIR, granularity: "H4", count: 1000 }),
    fetchCandles({ instrument: PAIR, granularity: "H1", count: 1000 }),
  ]);
  console.log(`Got ${candles.length} M15 candles (~${Math.round(candles.length * 15 / 60 / 24)} days)\n`);

  const mid = Math.floor(candles.length / 2);
  const rate = 1; // XAU_USD is USD-quoted

  const metrics = (trades: BacktestTrade[]) => {
    const wins = trades.filter((t) => t.rAchieved > 0).length;
    const grossWin = trades.filter((t) => t.rAchieved > 0).reduce((s, t) => s + t.rAchieved, 0);
    const grossLoss = trades.filter((t) => t.rAchieved <= 0).reduce((s, t) => s + Math.abs(t.rAchieved), 0);
    const totalR = trades.reduce((s, t) => s + t.rAchieved, 0);
    let peak = 0, cum = 0, dd = 0;
    for (const t of trades) { cum += t.rAchieved; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { n: trades.length, wins, totalR, avgR: trades.length ? totalR / trades.length : 0, pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0, dd };
  };

  const bt = (strategies: string[], min: any, require?: string[], exclude?: string[], window?: any) => {
    const report = runBacktest({
      pair: PAIR, timeframe: "M15",
      candles: window ?? candles, htfCandles,
      topDownCandles: { weekly, daily, h4, h1 },
      accountBalance: 25000,
      minConfidence: min,
      oneTradePerPair: true,
      strategies: strategies as never,
      requireChecks: require,
      excludeChecks: exclude,
      quoteUsdRate: rate,
    });
    return report.trades as BacktestTrade[];
  };

  interface Result {
    label: string; strategies: string[]; min: any;
    require?: string[]; exclude?: string[];
    n: number; wins: number; totalR: number; avgR: number; pf: number; dd: number;
    isR: number; isN: number; oosR: number; oosN: number;
  }

  const results: Result[] = [];
  const TREND_BOTH = ["HTF trend agrees", "M15 trend agrees"];
  const TREND_HTF = ["HTF trend agrees"];
  const TREND_M15 = ["M15 trend agrees"];

  // ============================================================
  // PHASE 1: Each strategy alone at every gate (1-6), with both trend
  // ============================================================
  console.log("=== PHASE 1: Individual strategies at every gate (with dual trend) ===\n");
  const strategies = ["zones", "setforget", "fibonacci"] as const;

  for (const strat of strategies) {
    for (let gate = 1; gate <= 6; gate++) {
      const min = { [strat]: gate };
      const full = metrics(bt([strat], min, TREND_BOTH));
      const is = metrics(bt([strat], min, TREND_BOTH, undefined, candles.slice(0, mid)));
      const oos = metrics(bt([strat], min, TREND_BOTH, undefined, candles.slice(mid)));
      results.push({ label: `${strat} @ ${gate}`, strategies: [strat], min, require: TREND_BOTH, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
    }
  }

  // ============================================================
  // PHASE 2: Each strategy alone at every gate, NO trend filter
  // ============================================================
  console.log("=== PHASE 2: Individual strategies at every gate (no trend filter) ===\n");
  for (const strat of strategies) {
    for (let gate = 1; gate <= 6; gate++) {
      const min = { [strat]: gate };
      const full = metrics(bt([strat], min));
      const is = metrics(bt([strat], min, undefined, undefined, candles.slice(0, mid)));
      const oos = metrics(bt([strat], min, undefined, undefined, candles.slice(mid)));
      results.push({ label: `${strat} @ ${gate} NO-TREND`, strategies: [strat], min, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
    }
  }

  // ============================================================
  // PHASE 3: Each strategy with HTF trend only vs M15 trend only
  // ============================================================
  console.log("=== PHASE 3: Trend filter modes (HTF only vs M15 only vs both) ===\n");
  const trendModes = [
    { name: "HTF-only", checks: TREND_HTF },
    { name: "M15-only", checks: TREND_M15 },
    { name: "both", checks: TREND_BOTH },
  ];
  for (const strat of strategies) {
    for (let gate = 3; gate <= 6; gate++) {
      for (const tm of trendModes) {
        const min = { [strat]: gate };
        const full = metrics(bt([strat], min, tm.checks));
        const is = metrics(bt([strat], min, tm.checks, undefined, candles.slice(0, mid)));
        const oos = metrics(bt([strat], min, tm.checks, undefined, candles.slice(mid)));
        results.push({ label: `${strat} @ ${gate} trend:${tm.name}`, strategies: [strat], min, require: tm.checks, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
      }
    }
  }

  // ============================================================
  // PHASE 4: Strategy pairs at researched gates with both trend
  // ============================================================
  console.log("=== PHASE 4: Strategy pairs ===\n");
  const pairs: [string, string][] = [["zones", "setforget"], ["zones", "fibonacci"], ["setforget", "fibonacci"]];
  for (const [s1, s2] of pairs) {
    for (let g1 = 4; g1 <= 6; g1++) {
      for (let g2 = 4; g2 <= 6; g2++) {
        const min = { [s1]: g1, [s2]: g2 };
        const full = metrics(bt([s1, s2], min, TREND_BOTH));
        const is = metrics(bt([s1, s2], min, TREND_BOTH, undefined, candles.slice(0, mid)));
        const oos = metrics(bt([s1, s2], min, TREND_BOTH, undefined, candles.slice(mid)));
        results.push({ label: `${s1}@${g1}+${s2}@${g2} both-trend`, strategies: [s1, s2], min, require: TREND_BOTH, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
      }
    }
  }

  // ============================================================
  // PHASE 5: All 3 strategies at gate combos (3-6 range)
  // ============================================================
  console.log("=== PHASE 5: All 3 strategies ===\n");
  for (let gz = 4; gz <= 6; gz++) {
    for (let gs = 4; gs <= 6; gs++) {
      for (let gf = 4; gf <= 6; gf++) {
        const min = { zones: gz, setforget: gs, fibonacci: gf };
        const full = metrics(bt(["zones", "setforget", "fibonacci"], min, TREND_BOTH));
        const is = metrics(bt(["zones", "setforget", "fibonacci"], min, TREND_BOTH, undefined, candles.slice(0, mid)));
        const oos = metrics(bt(["zones", "setforget", "fibonacci"], min, TREND_BOTH, undefined, candles.slice(mid)));
        results.push({ label: `all z${gz}/s${gs}/f${gf} both-trend`, strategies: ["zones", "setforget", "fibonacci"], min, require: TREND_BOTH, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });
      }
    }
  }

  // ============================================================
  // PHASE 6: Confirmation require/exclude variations on best gate
  // ============================================================
  console.log("=== PHASE 6: Confirmation filters ===\n");
  const confirmations = [
    "Rejection candle in zone",
    "Momentum (RSI) turning",
    "Zone fresh (≤1 touch)",
    "Zone overlaps another POI",
  ];
  const baseGates: Record<string, number>[] = [
    { zones: 5 }, { setforget: 4 }, { fibonacci: 5 },
  ];
  for (const base of baseGates) {
    const strat = Object.keys(base)[0];
    for (const conf of confirmations) {
      // Require this confirmation
      const req = [...TREND_BOTH, conf];
      const full = metrics(bt([strat], base, req));
      const is = metrics(bt([strat], base, req, undefined, candles.slice(0, mid)));
      const oos = metrics(bt([strat], base, req, undefined, candles.slice(mid)));
      results.push({ label: `${strat}@${base[strat]} REQ ${conf}`, strategies: [strat], min: base, require: req, ...full, isR: is.totalR, isN: is.n, oosR: oos.totalR, oosN: oos.n });

      // Exclude this confirmation (opposite must be true)
      const excl = [conf];
      const full2 = metrics(bt([strat], base, TREND_BOTH, excl));
      const is2 = metrics(bt([strat], base, TREND_BOTH, excl, candles.slice(0, mid)));
      const oos2 = metrics(bt([strat], base, TREND_BOTH, excl, candles.slice(mid)));
      results.push({ label: `${strat}@${base[strat]} EXCL ${conf}`, strategies: [strat], min: base, exclude: excl, ...full2, isR: is2.totalR, isN: is2.n, oosR: oos2.totalR, oosN: oos2.n });
    }
  }

  // ============================================================
  // ANALYSIS
  // ============================================================
  console.log(`\nTotal configs tested: ${results.length}\n`);

  // Sort by totalR
  const sorted = [...results].sort((a, b) => b.totalR - a.totalR);

  console.log("=== TOP 30 BY TOTAL R (any criteria) ===\n");
  console.log("config | n | win% | avgR | totalR | PF | DD | IS | OOS");
  console.log("-".repeat(110));
  for (const r of sorted.slice(0, 30)) {
    const winPct = r.n ? Math.round((r.wins / r.n) * 100) : 0;
    const viable = r.n >= 3 && r.isR >= 0 && r.oosR >= 0 ? "✓" : " ";
    console.log(
      `${viable} ${r.label.padEnd(40)} | ${String(r.n).padStart(3)} | ${String(winPct).padStart(3)}% | ${r.avgR.toFixed(2).padStart(6)} | ${r.totalR >= 0 ? "+" : ""}${r.totalR.toFixed(2).padStart(6)}R | ${r.pf.toFixed(2).padStart(5)} | ${r.dd.toFixed(1).padStart(5)} | ${r.isR >= 0 ? "+" : ""}${r.isR.toFixed(1).padStart(5)} | ${r.oosR >= 0 ? "+" : ""}${r.oosR.toFixed(1).padStart(5)}`
    );
  }

  // Viable = n≥3, totalR>0, IS≥0, OOS≥0
  console.log("\n=== VIABLE CONFIGS (n≥3, R>0, PF≥1, IS≥0, OOS≥0) ===\n");
  const viable = sorted.filter((r) => r.n >= 3 && r.totalR > 0 && r.pf >= 1 && r.isR >= 0 && r.oosR >= 0);
  console.log(`Found ${viable.length} viable configs\n`);
  console.log("config | n | win% | avgR | totalR | PF | DD | IS | OOS");
  console.log("-".repeat(110));
  for (const r of viable) {
    const winPct = r.n ? Math.round((r.wins / r.n) * 100) : 0;
    console.log(
      `  ${r.label.padEnd(40)} | ${String(r.n).padStart(3)} | ${String(winPct).padStart(3)}% | ${r.avgR.toFixed(2).padStart(6)} | ${r.totalR >= 0 ? "+" : ""}${r.totalR.toFixed(2).padStart(6)}R | ${r.pf.toFixed(2).padStart(5)} | ${r.dd.toFixed(1).padStart(5)} | ${r.isR >= 0 ? "+" : ""}${r.isR.toFixed(1).padStart(5)} | ${r.oosR >= 0 ? "+" : ""}${r.oosR.toFixed(1).padStart(5)}`
    );
  }

  // Relaxed viable: n≥2, totalR>0, OOS≥0
  console.log("\n=== RELAXED VIABLE (n≥2, R>0, OOS≥0) ===\n");
  const relaxed = sorted.filter((r) => r.n >= 2 && r.totalR > 0 && r.oosR >= 0);
  console.log(`Found ${relaxed.length} relaxed configs\n`);
  for (const r of relaxed.slice(0, 20)) {
    const winPct = r.n ? Math.round((r.wins / r.n) * 100) : 0;
    console.log(
      `  ${r.label.padEnd(40)} | ${String(r.n).padStart(3)} | ${String(winPct).padStart(3)}% | ${r.totalR >= 0 ? "+" : ""}${r.totalR.toFixed(2).padStart(6)}R | PF=${r.pf.toFixed(2).padStart(5)} | IS=${r.isR >= 0 ? "+" : ""}${r.isR.toFixed(1)} | OOS=${r.oosR >= 0 ? "+" : ""}${r.oosR.toFixed(1)}`
    );
  }

  // Best per strategy
  console.log("\n=== BEST VIABLE PER STRATEGY ===\n");
  for (const strat of strategies) {
    const sv = viable.filter((r) => r.strategies.includes(strat));
    if (sv.length > 0) {
      const best = sv[0];
      console.log(`  ${strat.padEnd(12)} ✓ ${best.label}  ${best.n}tr  +${best.totalR.toFixed(2)}R  PF=${best.pf.toFixed(2)}`);
    } else {
      const sr = relaxed.filter((r) => r.strategies.includes(strat));
      const best = sr[0];
      if (best) {
        console.log(`  ${strat.padEnd(12)} ~ ${best.label}  ${best.n}tr  +${best.totalR.toFixed(2)}R  PF=${best.pf.toFixed(2)}  (relaxed)`);
      } else {
        console.log(`  ${strat.padEnd(12)} ✗ no profitable config found`);
      }
    }
  }

  console.log(`\nNote: XAU/USD on this 52-day window was previously unprofitable at all gates.`);
  console.log(`This deep sweep tests ${results.length} configurations to find any viable edge.`);
  console.log(`If no viable config exists, XAU/USD should stay excluded from SIGNAL_PAIRS.`);
}

main().catch(console.error);
