/**
 * Telegram is the system's single communication channel (Section 8):
 * watching alerts, confirmation updates, final signals, skipped-for-risk notes.
 * Credentials come from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars only.
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set");
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  }
}

const pairLabel = (pair: string) => pair.replace("_", "/");
const dirLabel = (d: "long" | "short") => (d === "long" ? "🟢 LONG" : "🔴 SHORT");

/** Watching alert: a core trigger fired, confirmations are building. Heads-up, not a signal. */
export async function sendWatchingAlert(opts: {
  pair: string;
  direction: "long" | "short";
  strategy: string;
  triggerDescription: string;
}): Promise<void> {
  await sendTelegramMessage(
    `👀 *Watching ${pairLabel(opts.pair)} ${opts.direction.toUpperCase()}* — ${opts.strategy}\n${opts.triggerDescription}\n_Confirmations building…_`
  );
}

/** Confirmation update: count changed while still below the 3/5 threshold. */
export async function sendConfirmationUpdate(opts: {
  pair: string;
  direction: "long" | "short";
  strategy: string;
  count: number;
  met: string[];
}): Promise<void> {
  await sendTelegramMessage(
    `⏳ *${pairLabel(opts.pair)} ${opts.direction.toUpperCase()}* (${opts.strategy}) — *${opts.count}/5 confirmed*\n${opts.met.map((m) => `✓ ${m}`).join("\n")}`
  );
}

/** Final signal: threshold reached. Includes structure-based SL/TP + R + confidence + vision note. */
export async function sendFinalSignal(opts: {
  pair: string;
  direction: "long" | "short";
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rMultiple: number;
  riskPips: number;
  rewardPips: number;
  stopBasis: string;
  targetBasis: string;
  confidence: number; // 3 = standard, 4-5 = high
  visionNote: string | null;
  positionUnits: number;
  riskAmount: number;
  /** comparison with a stale open trade on the same pair, when there is one */
  comparison?: string | null;
  replacedCount?: number;
}): Promise<void> {
  const confidence = opts.confidence >= 4 ? "HIGH ★" : "standard";
  await sendTelegramMessage(
    [
      opts.replacedCount
        ? `🔄 *NEW SETUP REPLACES YOUR STALE OPEN TRADE*`
        : opts.comparison
          ? `🆕 *NEW SETUP (your open trade stays)*`
          : null,
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (${opts.strategy})`,
      `Entry \`${opts.entry}\`  SL \`${opts.stopLoss}\`  TP \`${opts.takeProfit}\``,
      `Risk *${opts.riskPips.toFixed(1)} pips* → Target *${opts.rewardPips.toFixed(1)} pips*`,
      `SL ${opts.stopBasis} · TP at ${opts.targetBasis}`,
      `R:R *${opts.rMultiple.toFixed(2)}* · Confidence *${confidence}* (${opts.confidence}/5)`,
      `Size: ${opts.positionUnits.toLocaleString()} units (risk $${opts.riskAmount.toFixed(0)}, 1%)`,
      opts.visionNote ? `🤖 Vision AI: ${opts.visionNote}` : null,
      opts.comparison ? `\n${opts.comparison.replace(/[_*`\[]/g, " ")}` : null,
      `_Signal only — review and execute manually._`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

/** Skipped-for-risk note: threshold met but the trade failed the Section 4 sanity check. */
export async function sendSkippedForRisk(opts: {
  pair: string;
  direction: "long" | "short";
  strategy: string;
  reason: string;
}): Promise<void> {
  await sendTelegramMessage(
    `⚠️ *${pairLabel(opts.pair)} ${opts.direction.toUpperCase()}* (${opts.strategy}) reached the confirmation threshold but was *skipped*: ${opts.reason}. Logged, not actionable.`
  );
}
