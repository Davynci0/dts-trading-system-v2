export type SignalDirection = "long" | "short";

export interface Candle {
  /** epoch seconds (UTC) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  created_at: string;
  pair: string;
  direction: SignalDirection;
  /** "trend" for the signals the system sends now (see isLiveSignal); older rows keep the strategy that sent them */
  strategy: string;
  /** the key of the 15-minute signal candle — a candle is traded once */
  variant?: string | null;
  confluence_strategies?: string[] | null;
  /** trades of the removed trailing-stop systems: the trailing distance */
  trail_distance?: number | null;
  /** where the stop stands once it has been moved — by the profit lock, or by a trailing stop of a removed system */
  trail_stop?: number | null;
  entry: number;
  stop_loss: number;
  take_profit: number;
  /** planned reward ÷ risk */
  r_multiple: number | null;
  /** conditions met */
  confidence: number;
  confirmations: Record<string, boolean>;
  vision_note: string | null;
  vision_verdict: "supports" | "rejects" | "skipped" | "error" | null;
  status: "active" | "closed" | "skipped";
  skip_reason: string | null;
  /** null until price touches the target (win) or the stop (loss), or the trade runs out of time (expired) */
  outcome: "win" | "loss" | "expired" | null;
  outcome_r: number | null;
  outcome_at: string | null;
  /** price the trade closed at */
  outcome_price: number | null;
  /** what each level is anchored to */
  sl_basis: string | null;
  tp_basis: string | null;
  replaces: string | null;
  replace_reason: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
}

/** The instruments the system scans, charts and backtests. Gold only. */
export const PAIRS = ["XAU_USD"] as const;
export type Pair = (typeof PAIRS)[number];

export const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** The chart's timeframe, on which open trades are followed (see lib/analysis/execution.ts). */
export const TRADE_TIMEFRAMES = ["M15"] as const satisfies readonly Timeframe[];

/**
 * How a signal of the system (the 15-minute market-structure scalp, "the trend
 * scalp") is stored. The database only accepts the strategy names in its
 * `signals_strategy_check` constraint, and "trend" is the one that fits.
 * Removed systems used the same names, so a live signal is told apart by the
 * start of its `variant` — the key of its signal candle
 * ("trend:<epoch seconds>"). Rows of the removed systems carry something else
 * there ("don30", "tl:…", "sd:…").
 */
export const TREND_STRATEGY = "trend" as const;
export const TREND_KEY_PREFIX = "trend:" as const;
export const STRATEGY_IDS = ["trend"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];
/** The start of the signal keys. The stored strategy name is the id itself. */
export const STRATEGY_KEY_PREFIX: Record<StrategyId, string> = { trend: TREND_KEY_PREFIX };

/** The strategy that sent a signal, or null for a row of a removed system. */
export function strategyOf(s: { strategy: string; variant?: string | null }): StrategyId | null {
  for (const id of STRATEGY_IDS) if (s.strategy === id && (s.variant ?? "").startsWith(STRATEGY_KEY_PREFIX[id])) return id;
  return null;
}
/** True for a signal sent by the rules that are live now, false for one a removed strategy sent. */
export const isLiveSignal = (s: { strategy: string; variant?: string | null }): boolean => strategyOf(s) !== null;
