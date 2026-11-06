/**
 * Telegram is the system's communication channel (Section 8). It sends:
 *  - early zone-touch alerts when price enters a buy/sell zone, and
 *  - the final actionable trade signal with entry/SL/TP once all confirmations line up.
 * Watching, confirmation-update and skipped-for-risk notes stay in the dashboard feed.
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

/** Zone-touch alert: price just entered a buy (demand) or sell (supply) zone.
 *  This is an early-warning notification, separate from the final trade signal.
 */
export async function sendZoneAlert(opts: {
  pair: string;
  direction: "long" | "short";
  zoneKind: "demand" | "supply";
  zoneBottom: number;
  zoneTop: number;
  touches: number;
  price: number;
}): Promise<void> {
  const label = opts.zoneKind === "demand" ? "🟩 BUY ZONE" : "🟥 SELL ZONE";
  const dir = dirLabel(opts.direction);
  await sendTelegramMessage(
    [
      `🎯 *ZONE TOUCH: ${pairLabel(opts.pair)} ${label}*`,
      `${dir} · price \`${opts.price.toFixed(5)}\``,
      `Zone \`${opts.zoneBottom.toFixed(5)} – ${opts.zoneTop.toFixed(5)}\` · ${opts.touches} prior touch${opts.touches === 1 ? "" : "es"}`,
      `_Waiting for remaining confirmations before a signal is sent._`,
    ].join("\n")
  );
}

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
      opts.visionNote ? `📝 Context: ${opts.visionNote}` : null,
      opts.comparison ? `\n${opts.comparison.replace(/[_*`\[]/g, " ")}` : null,
      `_Signal only — review and execute manually._`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}
