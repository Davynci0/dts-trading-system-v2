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
 * placed straight from it, then which entry fired, where the stop comes from
 * and how big the trade may be.
 */
export async function sendTrendSignal(opts: {
  pair: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  trigger: string;
  /** what the entry was, in a few words */
  why: string;
  /** where the stop comes from: the swing it sits beyond, or the limit it was set at */
  stopWhy: string;
  targetR: number;
  /** the profit lock: when price reaches `lockTrigger`, the stop is moved to `lockStop` */
  lockTrigger: number;
  lockStop: number;
  lockAtR: number;
  lockToR: number;
  /** hours after which an undecided trade is closed at market */
  holdHours: number;
  trendDays: number;
  /** how many of the six trend confirmations the trade has */
  confirmed: number;
  accountBalance: number;
  riskPct: number;
  /** minutes since the signal candle closed, when the signal was recovered late */
  lateMinutes?: number;
}): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  const risk = Math.abs(opts.entry - opts.stopLoss);
  const reward = Math.abs(opts.takeProfit - opts.entry);
  const up = opts.direction === "long";
  await sendTelegramMessage(
    [
      `${opts.lateMinutes == null ? "🚨 *SIGNAL" : "⏰ *LATE SIGNAL"}: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* (15-minute ${opts.trigger})`,
      ...(opts.lateMinutes == null ? [] : [`_Found ${opts.lateMinutes} minutes late: the scan that should have sent it did not. The stop is the original one; the entry, the target and the profit lock are worked out from the price now._`]),
      `*Entry:* \`${px(opts.entry)}\` (at market)`,
      `*Stop loss:* \`${px(opts.stopLoss)}\` — ${px(risk)} away, ${opts.stopWhy}`,
      `*Take profit:* \`${px(opts.takeProfit)}\` — ${px(reward)} away (1:${opts.targetR})`,
      `*Profit lock:* when price reaches \`${px(opts.lockTrigger)}\` (+${opts.lockAtR}R), move the stop to \`${px(opts.lockStop)}\` (+${opts.lockToR}R). You will get a message when it does.`,
      `Entry: ${opts.why}`,
      `Trend: 1-hour structure ${up ? "bullish (higher highs)" : "bearish (lower lows)"}, daily ${up ? "above" : "below"} its ${opts.trendDays}-day average`,
      `Confirmations: ${opts.confirmed} of 6 — the 1-hour and 15-minute averages, +DI/−DI, the distance from the ${opts.trendDays}-day average, the daily ADX`,
      sizeLine(risk, opts.accountBalance, opts.riskPct),
      `Close the trade at market if neither level is hit within ${opts.holdHours} hours. One trade at a time: no new signal until this one is closed, and after a full loss none until the trading day ends (17:00 New York). About seven in ten close in profit — most of them at the moved stop, with a small gain.`,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}

/** The profit lock has been reached: the stop of the open trade is to be moved into profit. */
export async function sendStopMoved(opts: { pair: string; direction: "long" | "short"; entry: number; stop: number; takeProfit: number; lockedR: number }): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  await sendTelegramMessage(
    [
      `🔒 *MOVE YOUR STOP: ${pairLabel(opts.pair)} ${opts.direction === "long" ? "BUY" : "SELL"}* from \`${px(opts.entry)}\``,
      `*New stop loss:* \`${px(opts.stop)}\` — ${px(Math.abs(opts.stop - opts.entry))} in profit (+${opts.lockedR}R)`,
      `Take profit stays at \`${px(opts.takeProfit)}\`.`,
      `If price is already back beyond the new stop, close the trade at market.`,
    ].join("\n")
  );
}
