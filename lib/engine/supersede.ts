import type { createAdminClient } from "@/lib/supabase/admin";

/** A trade open for longer than this without hitting TP/SL is a candidate to be replaced. */
export const STALE_AFTER_HOURS = 24;
/** A trade at least this far to its target is working; never retire it. */
const WORKING_PROGRESS = 0.5;
/** Points the new setup needs, out of 4 factors, to retire the old trade. */
const REPLACE_POINTS = 2;

export interface OpenTrade {
  id: string;
  created_at: string;
  direction: "long" | "short";
  entry: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  strategy: string;
}

export interface NewSetup {
  direction: "long" | "short";
  rMultiple: number;
  riskPips: number;
  rewardPips: number;
  confidence: number;
  label: string;
  /** weekly/daily/H4 bias agrees with this direction */
  aligned: boolean;
}

export interface Comparison {
  replace: boolean;
  points: number;
  /** a human explanation built from the actual numbers */
  text: string;
}

export function formatAge(hours: number): string {
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

const dir = (d: "long" | "short") => d.toUpperCase();

/**
 * Compare a stale open trade with a freshly fired setup on the same pair.
 * Four factors, one point each way: the payoff still available from the
 * current price, whether the old trade has stalled, confirmations, and
 * top-down alignment. Returns null when the old trade has already reached
 * TP or SL (the outcome scorer settles those).
 */
export function compareTrades(opts: {
  old: OpenTrade;
  oldLabel: string;
  oldAligned: boolean;
  next: NewSetup;
  price: number;
  pip: number;
  now?: number;
}): Comparison | null {
  const { old, oldLabel, oldAligned, next, price, pip } = opts;
  const now = opts.now ?? Date.now();
  const long = old.direction === "long";

  const toTp = long ? old.take_profit - price : price - old.take_profit;
  const toSl = long ? price - old.stop_loss : old.stop_loss - price;
  if (toTp <= 0 || toSl <= 0) return null;

  const ageHours = (now - new Date(old.created_at).getTime()) / 3_600_000;
  const moved = long ? price - old.entry : old.entry - price; // + = in its favour
  const targetSpan = Math.abs(old.take_profit - old.entry);
  const stopSpan = Math.abs(old.entry - old.stop_loss);
  const progress = moved / targetSpan; // negative when it has gone against the trade
  const remainingR = toTp / toSl;

  let points = 0;
  const lines: string[] = [];

  // 1. progress / stalled
  const movePips = Math.abs(moved) / pip;
  if (moved >= 0) {
    lines.push(
      `Old trade: open ${formatAge(ageHours)}, price is ${movePips.toFixed(0)} pips in its favour, ${Math.round(progress * 100)}% of the way to its target.`
    );
  } else {
    lines.push(
      `Old trade: open ${formatAge(ageHours)}, price is ${movePips.toFixed(0)} pips against it, ${Math.round((-moved / stopSpan) * 100)}% of the way to its stop.`
    );
  }
  if (progress < 0.33) {
    points += 1;
    lines.push("It has stalled: it has not made real progress toward its target.");
  } else if (progress >= WORKING_PROGRESS) {
    points -= 1;
    lines.push("It is working: more than half way to its target.");
  }

  // 2. payoff available from the current price
  lines.push(
    `From today's price the old trade would risk ${(toSl / pip).toFixed(0)} pips to make ${(toTp / pip).toFixed(0)} pips (${remainingR.toFixed(1)}R). The new setup risks ${next.riskPips.toFixed(0)} pips to make ${next.rewardPips.toFixed(0)} pips (${next.rMultiple.toFixed(1)}R).`
  );
  if (next.rMultiple - remainingR >= 0.5) points += 1;
  else if (remainingR - next.rMultiple >= 0.5) points -= 1;

  // 3. confirmations
  lines.push(`Confirmations: ${old.confidence}/5 on the old setup against ${next.confidence}/5 now.`);
  if (next.confidence - old.confidence >= 1) points += 1;
  else if (old.confidence - next.confidence >= 1) points -= 1;

  // 4. top-down alignment
  if (next.aligned && !oldAligned) {
    points += 1;
    lines.push("Weekly, Daily and H4 structure now agree with the new setup but no longer with the old one.");
  } else if (!next.aligned && oldAligned) {
    points -= 1;
    lines.push("Weekly, Daily and H4 structure still agree with the old trade but not with the new setup.");
  } else {
    lines.push(
      next.aligned
        ? "Top-down structure agrees with both, so it does not separate them."
        : "Top-down structure agrees with neither, so it does not separate them."
    );
  }

  const opposite = old.direction !== next.direction;
  const replace = points >= REPLACE_POINTS && progress < WORKING_PROGRESS;
  const head = `${next.label} ${dir(next.direction)} compared with the open ${oldLabel} ${dir(old.direction)}${opposite ? " (opposite direction)" : ""}:`;
  const verdict = replace
    ? `Verdict: ${points} of 4 factors favour the new setup, so the old trade is retired. It stays tracked so we can check whether this call was right.`
    : progress >= WORKING_PROGRESS
      ? "Verdict: the old trade is working, so it stays open and this is shown as an additional setup."
      : `Verdict: only ${points} of 4 factors favour the new setup, not enough to retire the old trade. Shown as an additional setup.`;

  return { replace, points, text: [head, ...lines.map((l) => `- ${l}`), verdict].join("\n") };
}

/** Open, never-retired active trades on this pair older than the stale threshold. */
export async function findStaleOpenTrades(
  supabase: ReturnType<typeof createAdminClient>,
  pair: string,
  now = Date.now()
): Promise<OpenTrade[]> {
  if (!supabase) return [];
  const cutoff = new Date(now - STALE_AFTER_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id, created_at, direction, entry, stop_loss, take_profit, confidence, strategy")
    .eq("pair", pair)
    .eq("status", "active")
    .is("outcome", null)
    .is("superseded_by", null)
    .gt("stop_loss", 0)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(5);
  if (error || !data) return [];
  return data as OpenTrade[];
}

/** Mark the retired trades as superseded by the new signal. */
export async function retireTrades(
  supabase: ReturnType<typeof createAdminClient>,
  oldIds: string[],
  newId: string
): Promise<void> {
  if (!supabase || oldIds.length === 0) return;
  await supabase
    .from("signals")
    .update({ superseded_by: newId, superseded_at: new Date().toISOString() })
    .in("id", oldIds);
}
