export type StrategyId = "breakout" | "fibonacci" | "zones" | "setforget" | "sr";
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
  /** a pattern strategy, or "trend" for the trend system (see `variant`) */
  strategy: StrategyId | "trend";
  /** trend system: the entry type that fired (TREND_ENTRIES id) */
  variant?: string | null;
  /** trend system: fixed trailing distance in price — such a trade has no take-profit */
  trail_distance?: number | null;
  /** trend system: where the trailing stop stands now */
  trail_stop?: number | null;
  entry: number;
  stop_loss: number;
  /** 0 for a trailing-stop trade */
  take_profit: number;
  r_multiple: number | null;
  /** confirmations met (out of CHECKS[strategy]) */
  confidence: number;
  confirmations: Record<string, boolean>;
  vision_note: string | null;
  vision_verdict: "supports" | "rejects" | "skipped" | "error" | null;
  status: "active" | "closed" | "skipped";
  skip_reason: string | null;
  /** null until price later touches TP (win), SL (loss), or the row expires */
  outcome: "win" | "loss" | "expired" | null;
  outcome_r: number | null;
  outcome_at: string | null;
  /** price where TP/SL was hit */
  outcome_price: number | null;
  /** the market structure each level is anchored to */
  sl_basis: string | null;
  tp_basis: string | null;
  /** the stale open trade this setup retired, and the detailed comparison */
  replaces: string | null;
  replace_reason: string | null;
  /** set when a newer, better setup on the same pair retired this one */
  superseded_by: string | null;
  superseded_at: string | null;
}

/** The instruments the system scans, charts and backtests. Gold only: every
 *  scan, the dashboard and the default backtest work on this list, so adding
 *  an instrument here (plus its spread in lib/analysis/instruments.ts) is all
 *  it takes to bring one back. */
export const PAIRS = ["XAU_USD"] as const;

export type Pair = (typeof PAIRS)[number];

export const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Live scanning and chart TA are locked to this one timeframe (see lib/analysis/execution.ts). */
export const TRADE_TIMEFRAMES = ["M30"] as const satisfies readonly Timeframe[];

export const STRATEGIES: { id: StrategyId; label: string }[] = [
  { id: "breakout", label: "Trend Breakout" },
  { id: "zones", label: "Supply/Demand Zone" },
  { id: "setforget", label: "Alex G Set & Forget" },
  { id: "fibonacci", label: "Fibonacci Retracement" },
  { id: "sr", label: "Support/Resistance Retest" },
];

/**
 * Confirmations a setup needs to be an **A setup** — the only kind that is sent
 * to Telegram. A setup with fewer is a B setup: tracked and shown, not sent.
 *
 *  - breakout: its three rule checks (close beyond the channel, daily trend,
 *    entry window) — they are all-or-nothing, so every breakout is an A setup;
 *  - pullbacks and the retest: the trigger and the daily trend (always met
 *    when the rule passes) plus at least two more of the remaining checks.
 */
export const MIN_CONFIRMATIONS: Record<StrategyId, number> = {
  breakout: 3,
  zones: 4,
  setforget: 4,
  fibonacci: 4,
  sr: 4,
};
export const isASetup = (strategy: StrategyId, confirmations: number): boolean =>
  confirmations >= (MIN_CONFIRMATIONS[strategy] ?? 4);

/** How many checks each strategy's confirmation list has. */
export const CHECKS: Record<StrategyId, number> = {
  breakout: 4,
  zones: 7,
  setforget: 7,
  fibonacci: 7,
  sr: 5,
};
