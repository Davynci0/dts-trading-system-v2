import { STRATEGY_IDS, type SignalDirection, type StrategyId } from "@/lib/types";

/**
 * The three strategies. Each works on its own and holds at most ONE trade of
 * its own, so up to three trades can be open at once — but never in opposite
 * directions:
 *  - a signal that is opposite to another strategy's open trade is not sent;
 *  - signals that come on the same scan and point in opposite directions are
 *    all dropped.
 */
export interface StrategyInfo {
  id: StrategyId;
  name: string;
  /** the chart its entries are read on */
  chart: string;
  /** how a trade of it ends, in a sentence */
  exit: string;
  /** how often it trades */
  pace: string;
  /** what it did on its own in the five-year test on gold, in a sentence a signal can carry */
  tested: string;
}

export const STRATEGIES: Record<StrategyId, StrategyInfo> = {
  trend: {
    id: "trend",
    name: "Trend scalp",
    chart: "15-minute",
    exit: "1:3 target, the stop moved into profit at +0.4R, closed after 5 hours",
    pace: "about 1.4 trades a day",
    tested: "In the 5-year test about two in three closed in profit — half of them at the moved stop, with a small gain.",
  },
  zones: {
    id: "zones",
    name: "Supply and demand",
    chart: "15-minute, at 30-minute zones",
    exit: "1:3 target, the stop never moved, closed after 5 trading days",
    pace: "rare — about ten trades a year",
    tested: "In the 5-year test three trades in five reached the 3R target (60%); the rest were a full loss. Only 50 trades in five years.",
  },
  trendline: {
    id: "trendline",
    name: "Trendline",
    chart: "1-hour",
    exit: "1:3 target, the stop moved to +0.25R at +1R, closed after 5 trading days",
    pace: "about one trade a week",
    tested: "In the 5-year test just over half closed in profit (54%): about one in four reached the 3R target, as many closed at the moved stop with a small gain.",
  },
};

export const STRATEGY_LIST: StrategyInfo[] = STRATEGY_IDS.map((id) => STRATEGIES[id]);

const side = (d: SignalDirection) => (d === "long" ? "buy" : "sell");

/** Why a signal may not be sent because of what the OTHER strategies hold, or null. `open` = every open trade of the three. */
export function conflictBlock(open: { strategy: StrategyId; direction: SignalDirection }[], next: { strategy: StrategyId; direction: SignalDirection }): string | null {
  const against = open.find((t) => t.strategy !== next.strategy && t.direction !== next.direction);
  return against ? `opposite to the open ${STRATEGIES[against.strategy].name} ${side(against.direction)} — contradicting trades are not sent` : null;
}

/** True when signals found on the same scan point in opposite directions: none of them is sent. */
export function contradict(signals: { direction: SignalDirection }[]): boolean {
  return signals.some((s) => s.direction === "long") && signals.some((s) => s.direction === "short");
}

/** A trade of a backtest, as the combination needs it. */
export interface StrategyTrade {
  strategy: StrategyId;
  direction: SignalDirection;
  entryTime: number;
  exitTime: number;
  rAchieved: number;
}

/**
 * The three strategies run side by side, in time order. `signals` holds every
 * signal of each strategy, each already followed to its exit. A strategy takes
 * a signal when it holds no trade of its own, unless the signal is opposite to
 * another strategy's open trade or to another signal of the same moment.
 * `sameMoment` is how far apart two entries may be to count as the same scan.
 */
export function combineStrategies<T extends StrategyTrade>(signals: T[], sameMoment = 900): { taken: T[]; blocked: T[] } {
  const sorted = [...signals].sort((a, b) => a.entryTime - b.entryTime);
  const open: T[] = [];
  const taken: T[] = [];
  const blocked: T[] = [];
  for (let i = 0; i < sorted.length; ) {
    const slot = Math.floor(sorted[i].entryTime / sameMoment);
    let j = i;
    while (j < sorted.length && Math.floor(sorted[j].entryTime / sameMoment) === slot) j++;
    const now = sorted[i].entryTime;
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitTime <= now) open.splice(k, 1);
    // one signal a strategy, and only for a strategy that holds nothing
    const free: T[] = [];
    for (const t of sorted.slice(i, j)) if (!open.some((o) => o.strategy === t.strategy) && !free.some((f) => f.strategy === t.strategy)) free.push(t);
    const allowed = free.filter((t) => {
      if (conflictBlock(open, t)) {
        blocked.push(t);
        return false;
      }
      return true;
    });
    if (contradict(allowed)) blocked.push(...allowed);
    else for (const t of allowed) {
      open.push(t);
      taken.push(t);
    }
    i = j;
  }
  return { taken, blocked };
}
