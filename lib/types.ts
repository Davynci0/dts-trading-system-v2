export type StrategyId = "fibonacci" | "zones" | "setforget";
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
  strategy: StrategyId;
  entry: number;
  stop_loss: number;
  take_profit: number;
  r_multiple: number | null;
  /** 3 = standard confidence, 4-5 = high confidence */
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

/** XAU + hand-picked majors/crosses with wide ranges and sharp risk-shift moves:
 *  JPY quote pairs (GBP_JPY, USD_JPY, EUR_JPY, AUD_JPY), the classic
 *  GBP volatile set (GBP_USD, GBP_AUD, GBP_NZD) and gold. NZD_JPY removed
 *  because of persistent feed/liquidity noise. All use the same M15 pipeline. */
export const PAIRS = [
  "XAU_USD",
  "GBP_JPY",
  "GBP_USD",
  "AUD_JPY",
  "USD_JPY",
  "EUR_JPY",
  "GBP_AUD",
  "GBP_NZD",
] as const;

export type Pair = (typeof PAIRS)[number];

export const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Live scanning and chart TA are locked to 15-minute candles. */
export const TRADE_TIMEFRAMES = ["M15"] as const satisfies readonly Timeframe[];

export const STRATEGIES: { id: StrategyId; label: string }[] = [
  { id: "zones", label: "Supply/Demand Zone" },
  { id: "setforget", label: "Alex G Set & Forget" },
  { id: "fibonacci", label: "Fibonacci Retracement" },
];
