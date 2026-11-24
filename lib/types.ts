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
  /** trades of the removed trailing-stop systems: the trailing distance and where the stop stands */
  trail_distance?: number | null;
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
 * How a signal of the system (the 15-minute market-structure scalp) is stored. The
 * database only accepts the strategy names in its `signals_strategy_check`
 * constraint, and "trend" is the one that fits. The removed 30-minute trend
 * system used the same name, so the two are told apart by `variant`: these
 * rows carry the key of their signal candle ("trend:<epoch seconds>"), the old
 * ones the name of an entry type ("don30", "ema20pb", …).
 */
export const TREND_STRATEGY = "trend" as const;
export const TREND_KEY_PREFIX = "trend:" as const;
/** True for a signal sent by the rules that are live now, false for one a removed strategy sent. */
export const isLiveSignal = (s: { strategy: string; variant?: string | null }): boolean =>
  s.strategy === TREND_STRATEGY && (s.variant ?? "").startsWith(TREND_KEY_PREFIX);
