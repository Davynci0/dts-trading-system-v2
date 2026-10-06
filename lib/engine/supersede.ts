import type { createAdminClient } from "@/lib/supabase/admin";

/** A trade open for longer than this without hitting TP/SL is a candidate to be replaced. */
export const STALE_AFTER_HOURS = 24;
/** A trade at least this far to its target is working; never retire it. */
const WORKING_PROGRESS = 0.5;
/** Below this the old trade has not made real progress. */
const STALLED_PROGRESS = 0.33;
/** Points the new setup needs, out of 4 factors, to retire the old trade. */
const REPLACE_POINTS = 2;
/** A same-direction setup aiming for less than this share of what the old trade still offers is a downgrade. */
const MIN_SIZE_SHARE = 0.5;

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
 * Four factors, one point each way: whether the old trade has stalled, the
 * payoff still available from the current price, confirmations, and top-down
 * alignment. Each line is marked ✓ (favours the new setup), ✗ (favours the
 * old one) or = (neutral) so the verdict can be checked. A trade that is
 * working is never retired, and neither is a swing trade for a much smaller
 * same-direction setup. Returns null when the old trade has already reached
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
  const favours: string[] = [];
  const lines: string[] = [];
  const mark = (m: "✓" | "✗" | "=", text: string, name?: string) => {
    if (m === "✓") {
      points += 1;
      if (name) favours.push(name);
    } else if (m === "✗") {
      points -= 1;
    }
    lines.push(`${m} ${text}`);
  };

  const movePips = Math.abs(moved) / pip;
  lines.push(
    moved >= 0
      ? `Old trade: open ${formatAge(ageHours)}, price is ${movePips.toFixed(0)} pips in its favour, ${Math.round(progress * 100)}% of the way to its target.`
      : `Old trade: open ${formatAge(ageHours)}, price is ${movePips.toFixed(0)} pips against it, ${Math.round((-moved / stopSpan) * 100)}% of the way to its stop.`
  );

  // 1. has the old trade made real progress?
  if (progress < STALLED_PROGRESS) mark("✓", "It has stalled: no real progress toward its target.", "it has stalled");
  else if (progress >= WORKING_PROGRESS) mark("✗", "It is working: more than half way to its target.");
  else mark("=", "It has made some progress, which neither helps nor hurts the case.");

  // 2. payoff available from the current price
  const payoff = `From today's price the old trade would risk ${(toSl / pip).toFixed(0)} pips to make ${(toTp / pip).toFixed(0)} pips (${remainingR.toFixed(1)}R). The new setup risks ${next.riskPips.toFixed(0)} pips to make ${next.rewardPips.toFixed(0)} pips (${next.rMultiple.toFixed(1)}R).`;
  if (next.rMultiple - remainingR >= 0.5) mark("✓", payoff, "better payoff");
  else if (remainingR - next.rMultiple >= 0.5) mark("✗", payoff);
  else mark("=", payoff);

  // 3. confirmations
  const conf = `Confirmations: ${old.confidence}/5 on the old setup against ${next.confidence}/5 now.`;
  if (next.confidence - old.confidence >= 1) mark("✓", conf, "more confirmations");
  else if (old.confidence - next.confidence >= 1) mark("✗", conf);
  else mark("=", conf);

  // 4. top-down alignment
  if (next.aligned && !oldAligned) {
    mark("✓", "Weekly, Daily and H4 structure now agree with the new setup but no longer with the old one.", "structure agrees");
  } else if (!next.aligned && oldAligned) {
    mark("✗", "Weekly, Daily and H4 structure still agree with the old trade but not with the new setup.");
  } else {
    mark(
      "=",
      next.aligned
        ? "Top-down structure agrees with both, so it does not separate them."
        : "Top-down structure agrees with neither, so it does not separate them."
    );
  }

  // never trade a swing for a much smaller setup in the same direction
  const opposite = old.direction !== next.direction;
  const downgrade = !opposite && next.rewardPips < MIN_SIZE_SHARE * (toTp / pip);
  if (downgrade) {
    lines.push(
      `✗ Size: the new setup aims for ${next.rewardPips.toFixed(0)} pips but the old trade still has ${(toTp / pip).toFixed(0)} pips available, so replacing it would swap a swing trade for a smaller one.`
    );
  }

  const working = progress >= WORKING_PROGRESS;
  const replace = points >= REPLACE_POINTS && !working && !downgrade;
  const head = `${next.label} ${dir(next.direction)} compared with the open ${oldLabel} ${dir(old.direction)}${opposite ? " (opposite direction)" : ""}:`;
  let verdict: string;
  if (replace) {
    verdict = `Verdict: ${points} of 4 factors favour the new setup (${favours.join(", ")}), so the old trade is retired. It stays tracked so we can check whether this call was right.`;
  } else if (working) {
    verdict = "Verdict: the old trade is working, so it stays open and this is shown as an additional setup.";
  } else if (downgrade) {
    verdict = "Verdict: the new setup targets much less than the old trade still offers, so the old trade stays open and this is shown as an additional setup.";
  } else {
    verdict = `Verdict: only ${Math.max(points, 0)} of 4 factors favour the new setup, not enough to retire the old trade. Shown as an additional setup.`;
  }

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
