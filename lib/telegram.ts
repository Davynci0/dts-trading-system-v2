/**
 * Telegram is the system's communication channel: it carries the trade signal
 * — entry, stop loss and take profit — once every condition of an entry is
 * met. Everything else stays in the dashboard feed.
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

/** How big the trade may be: the ounces that risk `riskPct` of the account, and what the usual 1-ounce minimum would risk instead. */
function sizeLine(risk: number, accountBalance: number, riskPct: number): string {
  const budget = accountBalance * riskPct;
  const ounces = Math.floor((budget / risk) * 100) / 100;
  const pct = String(Number((riskPct * 100).toFixed(2)));
  const minRisk = risk * MIN_LOT_OUNCES;
  return ounces >= MIN_LOT_OUNCES
    ? `Size: ${ounces.toFixed(2)} oz (${(ounces / 100).toFixed(2)} lot) risks $${(ounces * risk).toFixed(2)}, ${pct}% of $${accountBalance.toFixed(0)}`
    : `Size: ${pct}% of $${accountBalance.toFixed(0)} is $${budget.toFixed(2)}, which is ${ounces.toFixed(2)} oz. The usual minimum (0.01 lot = 1 oz) would risk $${minRisk.toFixed(0)}, ${((minRisk / accountBalance) * 100).toFixed(0)}% of the account — only take this on a micro or cent account.`;
}

/**
 * A signal: entry, stop loss and take profit one per line, so the order can be
 * placed straight from it, then which entry fired, what the trend readings
 * were and how big the trade may be.
 */
export async function sendTrendSignal(opts: {
  pair: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  trigger: string;
  /** what the entry was, in a few words (the high broken, the candle's length) */
  why: string;
  stopAtr: number;
  targetR: number;
  /** hours of trading after which an undecided trade is closed at market */
  holdHours: number;
  /** trades that may be open together */
  maxOpen: number;
  trendDays: number;
  fastEma: number;
  slowEma: number;
  accountBalance: number;
  riskPct: number;
}): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  const risk = Math.abs(opts.entry - opts.stopLoss);
  const reward = Math.abs(opts.takeProfit - opts.entry);
  const up = opts.direction === "long";
  await sendTelegramMessage(
    [
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (15-minute ${opts.trigger})`,
      `*Entry:* \`${px(opts.entry)}\` (at market)`,
      `*Stop loss:* \`${px(opts.stopLoss)}\` — ${px(risk)} away (${opts.stopAtr} × the 15-minute ATR)`,
      `*Take profit:* \`${px(opts.takeProfit)}\` — ${px(reward)} away (1:${opts.targetR})`,
      `Entry: ${opts.why}`,
      `Trend: daily ${up ? "above" : "below"} its ${opts.trendDays}-day average, 1-hour ${opts.fastEma} EMA ${up ? "above" : "below"} the ${opts.slowEma} EMA, ${up ? "+DI above −DI" : "−DI above +DI"}`,
      sizeLine(risk, opts.accountBalance, opts.riskPct),
      `If neither level is hit in ${opts.holdHours} hours of trading, close the trade at market. Up to ${opts.maxOpen} trades can be open together; about one in three wins.`,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}
