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
  confidence: number; // confirmations met
  /** how many checks the strategy's list has */
  checks?: number;
  /** the flipped support/resistance level just behind the entry, when there is one */
  keyLevel?: { price: number; touches: number } | null;
  visionNote: string | null;
  positionUnits: number;
  riskAmount: number;
  /** comparison with a stale open trade on the same pair, when there is one */
  comparison?: string | null;
  replacedCount?: number;
}): Promise<void> {
  const checks = opts.checks ?? 6;
  const digits = opts.pair.startsWith("XAU") ? 2 : opts.pair.includes("JPY") ? 3 : 5;
  const px = (n: number) => n.toFixed(digits);
  // A wide stop on a small account: 1% of the balance can be less than
  // one unit's risk. Say so instead of printing a size of zero.
  const unitRisk = Math.abs(opts.entry - opts.stopLoss);
  const sizeLine =
    opts.positionUnits >= 1
      ? `Size: ${opts.positionUnits.toLocaleString()} units (risk $${opts.riskAmount.toFixed(0)}, 1%)`
      : `Size: the stop is too wide for 1% risk — the smallest size (1 unit, 0.01 lot) risks $${unitRisk.toFixed(0)}, 1% of the account is $${opts.riskAmount.toFixed(0)}`;
  await sendTelegramMessage(
    [
      opts.replacedCount
        ? `🔄 *NEW SETUP REPLACES YOUR STALE OPEN TRADE*`
        : opts.comparison
          ? `🆕 *NEW SETUP (your open trade stays)*`
          : null,
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (${opts.strategy})`,
      `Entry \`${px(opts.entry)}\`  SL \`${px(opts.stopLoss)}\`  TP \`${px(opts.takeProfit)}\``,
      `Risk *${opts.riskPips.toFixed(1)} pips* → Target *${opts.rewardPips.toFixed(1)} pips*`,
      `SL ${opts.stopBasis} · TP at ${opts.targetBasis}`,
      `R:R *${opts.rMultiple.toFixed(2)}* · *A setup* · confirmations ${opts.confidence}/${checks}`,
      opts.keyLevel
        ? `Key level behind the entry: ${px(opts.keyLevel.price)} (support and resistance, ${opts.keyLevel.touches} touches)`
        : `No key level behind the entry`,
      sizeLine,
      opts.visionNote ? `📝 Context: ${opts.visionNote}` : null,
      opts.comparison ? `\n${opts.comparison.replace(/[_*`\[]/g, " ")}` : null,
      `_Signal only — review and execute manually._`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

/**
 * A trend-system signal: no target — the trade is managed by a trailing stop
 * at a fixed distance, which the broker can run.
 */
export async function sendTrendSignal(opts: {
  pair: string;
  direction: "long" | "short";
  /** the entry type, e.g. "30-candle breakout" */
  label: string;
  rule: string;
  entry: number;
  stopLoss: number;
  /** trailing distance in price */
  trailDistance: number;
  adx: number;
  /** trend positions open, this one included */
  openCount: number;
  positionUnits: number;
  riskAmount: number;
  riskPct: number;
}): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  const unitRisk = Math.abs(opts.entry - opts.stopLoss);
  const pct = String(Number((opts.riskPct * 100).toFixed(2)));
  const sizeLine =
    opts.positionUnits >= 1
      ? `Size: ${opts.positionUnits.toLocaleString()} units (risk $${opts.riskAmount.toFixed(0)}, ${pct}%)`
      : `Size: the stop is too wide for ${pct}% risk — the smallest size (1 unit, 0.01 lot) risks $${unitRisk.toFixed(0)}, ${pct}% of the account is $${opts.riskAmount.toFixed(0)}`;
  await sendTelegramMessage(
    [
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (${opts.label})`,
      `Entry \`${px(opts.entry)}\` at market · Stop \`${px(opts.stopLoss)}\``,
      `*Trailing stop: ${px(opts.trailDistance)}* — set your broker's trailing stop to this distance. No take-profit.`,
      `Why: ${opts.rule}; the 50-day and 100-day trends both point ${opts.direction === "long" ? "up" : "down"}; ADX ${opts.adx.toFixed(0)}`,
      `Trend positions open now: ${opts.openCount}`,
      sizeLine,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}
