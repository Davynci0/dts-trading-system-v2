import { STRATEGIES } from "@/lib/strategies";
import type { StrategyId } from "@/lib/types";

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

/** The rule between the three strategies, said once in every signal. */
const OTHERS_NOTE = "Each of the three strategies holds one trade of its own, so this can be open next to a trade of another strategy — never in the opposite direction.";

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
      `${opts.lateMinutes == null ? "🚨 *SIGNAL" : "⏰ *LATE SIGNAL"}: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* — ${STRATEGIES.trend.name} (15-minute ${opts.trigger})`,
      ...(opts.lateMinutes == null ? [] : [`_Found ${opts.lateMinutes} minutes late: the scan that should have sent it did not. The stop is the original one; the entry, the target and the profit lock are worked out from the price now._`]),
      `*Entry:* \`${px(opts.entry)}\` (at market)`,
      `*Stop loss:* \`${px(opts.stopLoss)}\` — ${px(risk)} away, ${opts.stopWhy}`,
      `*Take profit:* \`${px(opts.takeProfit)}\` — ${px(reward)} away (1:${opts.targetR})`,
      `*Profit lock:* when price reaches \`${px(opts.lockTrigger)}\` (+${opts.lockAtR}R), move the stop to \`${px(opts.lockStop)}\` (+${opts.lockToR}R). You will get a message when it does.`,
      `Entry: ${opts.why}`,
      `Trend: 1-hour structure ${up ? "bullish (higher highs)" : "bearish (lower lows)"}, daily ${up ? "above" : "below"} its ${opts.trendDays}-day average`,
      sizeLine(risk, opts.accountBalance, opts.riskPct),
      `Close the trade at market if neither level is hit within ${opts.holdHours} hours. ${STRATEGIES.trend.tested}`,
      OTHERS_NOTE,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}

/** The profit lock has been reached: the stop of the open trade is to be moved into profit. */
export async function sendStopMoved(opts: { strategy: StrategyId; pair: string; direction: "long" | "short"; entry: number; stop: number; takeProfit: number; lockedR: number }): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  await sendTelegramMessage(
    [
      `🔒 *MOVE YOUR STOP: ${pairLabel(opts.pair)} ${opts.direction === "long" ? "BUY" : "SELL"}* from \`${px(opts.entry)}\` — ${STRATEGIES[opts.strategy].name}`,
      `*New stop loss:* \`${px(opts.stop)}\` — ${px(Math.abs(opts.stop - opts.entry))} in profit (+${opts.lockedR}R)`,
      `Take profit stays at \`${px(opts.takeProfit)}\`.`,
      `If price is already back beyond the new stop, close the trade at market.`,
    ].join("\n")
  );
}

/**
 * A signal of supply and demand or of the trendline strategy: the same layout as
 * the trend scalp's — entry, stop loss and take profit one per line — then
 * what the entry was, how the trade is managed and what the strategy did in
 * its five-year test.
 */
export async function sendStrategySignal(opts: {
  strategy: StrategyId;
  /** the entry in a few words, e.g. "1-hour trendline bounce" */
  headline: string;
  pair: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  targetR: number;
  why: string;
  stopWhy: string;
  /** how the trade is managed once it is open */
  manage: string;
  /** the profit lock, for a strategy that has one: when price reaches `trigger`, the stop is moved to `stop` */
  lock?: { trigger: number; stop: number; atR: number; toR: number };
  accountBalance: number;
  riskPct: number;
}): Promise<void> {
  const px = (n: number) => n.toFixed(2);
  const risk = Math.abs(opts.entry - opts.stopLoss);
  const reward = Math.abs(opts.takeProfit - opts.entry);
  const info = STRATEGIES[opts.strategy];
  await sendTelegramMessage(
    [
      `🚨 *SIGNAL: ${pairLabel(opts.pair)} ${dirLabel(opts.direction)}* — ${info.name} (${opts.headline})`,
      `*Entry:* \`${px(opts.entry)}\` (at market)`,
      `*Stop loss:* \`${px(opts.stopLoss)}\` — ${px(risk)} away, ${opts.stopWhy}`,
      `*Take profit:* \`${px(opts.takeProfit)}\` — ${px(reward)} away (1:${opts.targetR})`,
      ...(opts.lock ? [`*Profit lock:* when price reaches \`${px(opts.lock.trigger)}\` (+${opts.lock.atR}R), move the stop to \`${px(opts.lock.stop)}\` (+${opts.lock.toR}R). You will get a message when it does.`] : []),
      `Entry: ${opts.why}`,
      sizeLine(risk, opts.accountBalance, opts.riskPct),
      opts.manage,
      info.tested,
      OTHERS_NOTE,
      `_Signal only — review and execute manually._`,
    ].join("\n")
  );
}
