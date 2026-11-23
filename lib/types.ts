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
  /** "fibonacci" for every signal the system sends now; older rows keep the strategy that sent them */
  strategy: string;
  /** fibonacci: the key of the 1-hour leg the trade was taken on (one trade per leg) */
  variant?: string | null;
  confluence_strategies?: string[] | null;
  /** legacy trend-system rows: the trailing distance and where the trailing stop stands */
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

/** The chart timeframe entries are taken on (see lib/analysis/execution.ts). */
export const TRADE_TIMEFRAMES = ["M15"] as const satisfies readonly Timeframe[];

/** The strategy every new signal is stored under. */
export const FIB_STRATEGY = "fibonacci" as const;
