import { runTrendBacktest } from "@/lib/backtest/trend";
import { sfCandidates } from "@/lib/backtest/setforget";
import { tlCandidates } from "@/lib/backtest/trendline";
import { SF_ENTRY_SECONDS, SF_LIVE, SF_LIVE_ENTRY } from "@/lib/analysis/setforget";
import { combineStrategies, type StrategyTrade } from "@/lib/strategies";
import { STRATEGY_IDS, type Candle, type StrategyId } from "@/lib/types";

/**
 * The three strategies replayed side by side on the same candles, each with
 * its own detection and its own exits, under the rules of lib/strategies.ts:
 * one trade a strategy, and no trade against another strategy's open trade.
 */
export interface ThreeData {
  /** 15-minute candles: the trend scalp's entries, and every fill and exit */
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  /** the daily candles behind the 50-day average */
  daily: Candle[];
  /** three more years of daily and weekly candles, for Set and Forget's areas of interest */
  dailyLong: Candle[];
  weekly: Candle[];
}

export interface ThreeTrade extends StrategyTrade {
  /** how the trade ended; "open" = still open at the end of the data */
  outcome: string;
  /** what kind of entry it was, within its strategy */
  entryType: string;
}

export interface ThreeResult {
  /** each strategy on its own: one trade at a time, nothing else running */
  alone: Record<StrategyId, ThreeTrade[]>;
  /** the three together */
  together: ThreeTrade[];
  /** signals not taken because they contradicted another strategy */
  blocked: ThreeTrade[];
}

export function runThree(pair: string, d: ThreeData, from = 0, costMultiplier = 1): ThreeResult {
  // the trend scalp's own rules already hold it to one trade and no duplicate entry
  const trend: ThreeTrade[] = runTrendBacktest({ pair, m15: d.m15, h1: d.h1, daily: d.daily, from, costMultiplier }).map((t) => ({
    strategy: "trend",
    direction: t.direction,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    rAchieved: t.rAchieved,
    outcome: t.outcome,
    entryType: t.trigger,
  }));
  const sf: ThreeTrade[] = sfCandidates(pair, { m15: d.m15, entry: d.h4, h4: d.h4, daily: d.dailyLong, weekly: d.weekly }, SF_ENTRY_SECONDS[SF_LIVE_ENTRY], SF_LIVE, from, costMultiplier).map((t) => ({
    strategy: "setforget",
    direction: t.direction,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    rAchieved: t.rAchieved,
    outcome: t.outcome,
    entryType: `${t.zoneTf} area`,
  }));
  const tl: ThreeTrade[] = tlCandidates({ pair, m15: d.m15, h1: d.h1, daily: d.daily, from, costMultiplier }).map((t) => ({
    strategy: "trendline",
    direction: t.direction,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    rAchieved: t.rAchieved,
    outcome: t.outcome,
    entryType: t.type,
  }));
  const closed = (g: ThreeTrade[]) => g.filter((t) => t.outcome !== "open");
  const alone = Object.fromEntries(STRATEGY_IDS.map((id) => [id, [] as ThreeTrade[]])) as Record<StrategyId, ThreeTrade[]>;
  alone.trend = closed(trend);
  alone.setforget = closed(combineStrategies(sf).taken);
  alone.trendline = closed(combineStrategies(tl).taken);
  const both = combineStrategies([...trend, ...sf, ...tl]);
  return { alone, together: closed(both.taken), blocked: both.blocked };
}
