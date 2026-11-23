/**
 * Telegram is the system's communication channel: it carries the trade signal
 * — entry, stop loss and take profit — once every condition of the Fibonacci
 * system is met. Everything else stays in the dashboard feed.
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
const dirLabel = (d: "long" | "short") => (d === "long" ? "🟢 BUY" : "🔴 SELL");

/** The smallest gold trade most brokers allow: 0.01 lot, which is one ounce. */
const MIN_LOT_OUNCES = 1;

/**
 * A Fibonacci signal: entry, stop loss and take profit one per line, so the
 * order can be placed straight from it, then why the trade is there and how
 * big it may be.
 */
export async function sendFibSignal(opts: {
  pair: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** reward ÷ risk */
  rr: number;
  trigger: string;
  /** how deep the pullback went, 0–1 */
  retracement: number;
  legFrom: number;
  legTo: number;
  /** leg length in 1-hour ATR */
  legAtr: number | null;
  trendDays: number;
  holdDays: number;
  accountBalance: number;
  riskPct: number;
}): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  const risk = Math.abs(opts.entry - opts.stopLoss);
  const reward = Math.abs(opts.takeProfit - opts.entry);
  const budget = opts.accountBalance * opts.riskPct;
  const ounces = Math.floor((budget / risk) * 100) / 100;
  const pct = String(Number((opts.riskPct * 100).toFixed(2)));
  const minRisk = risk * MIN_LOT_OUNCES;
  const sizeLine =
    ounces >= MIN_LOT_OUNCES
      ? `Size: ${ounces.toFixed(2)} oz (${(ounces / 100).toFixed(2)} lot) risks $${(ounces * risk).toFixed(2)}, ${pct}% of $${opts.accountBalance.toFixed(0)}`
      : `Size: ${pct}% of $${opts.accountBalance.toFixed(0)} is $${budget.toFixed(2)}, which is ${ounces.toFixed(2)} oz. The usual minimum (0.01 lot = 1 oz) would risk $${minRisk.toFixed(0)}, ${((minRisk / opts.accountBalance) * 100).toFixed(0)}% of the account — only take this on a micro or cent account.`;
  const up = opts.direction === "long";
  await sendTelegramMessage(
    [
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (Fibonacci retracement)`,
      `*Entry:* \`${px(opts.entry)}\` (at market)`,
      `*Stop loss:* \`${px(opts.stopLoss)}\` — ${px(risk)} away, beyond the start of the swing`,
      `*Take profit:* \`${px(opts.takeProfit)}\` — ${px(reward)} away, the 161.8% extension (${opts.rr.toFixed(1)}R)`,
      `Swing (1-hour): ${px(opts.legFrom)} → ${px(opts.legTo)}${opts.legAtr != null ? `, ${opts.legAtr.toFixed(1)} ATR` : ""}; price pulled back ${(opts.retracement * 100).toFixed(0)}% and a 15-minute ${opts.trigger} rejected the zone`,
      `Trend: daily ${up ? "above" : "below"} its ${opts.trendDays}-day average, 4-hour ${up ? "above a rising" : "below a falling"} 50 EMA`,
      sizeLine,
      `If neither level is hit in ${opts.holdDays} trading days, close the trade at market.`,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}
