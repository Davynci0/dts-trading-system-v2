# Standing rules for this trading system

These are the owner's requirements, stated on 23, 24, 25, 26 and 27 November 2026. They apply to every change to
the strategy, the backtest and the reports, until the owner says otherwise.

## What the system must be

1. **One trade at a time, one strategy: the trend scalp.** Never several open trades on similar
   entries with different stops and targets. A new signal is only sent when nothing is open.
   (For a few hours on 25 November 2026 the owner had three strategies run side by side — the
   trend scalp, then Set and Forget, a trendline strategy and supply and demand zones — and the
   same day asked for all but the trend scalp to be removed.)
2. **A scalping system.** A trade should last between about 1 and 5 hours — not 8, not a day.
   If it has reached neither level by then, it is closed.
3. **The 15-minute chart**, with higher timeframes for confirmation.
4. **A modest target: about 1:3 risk to reward.** Do not aim for distant targets.
   (On 26 November 2026 the owner said 1:2 is enough "as long as there are good results". It was
   tested: with the profit lock a 1:2 target makes less than 1:3 on both systems, so 1:3 stayed.)
5. **About 2.5 trades a trading day; never fewer than 2.**
   (On 24 and 25 November 2026 the owner chose fewer, better trades over this number more than
   once — losing three to five in a row matters more to them than how many trades there are.
   On 27 November 2026 they asked for at least 0.5 a day. The system makes about 1.5 a day over
   the last year, 0.6 over five years. Say so plainly whenever a change lowers it.)
6. **Market structure decides the trade and its risk.** Read swing highs and swing lows. In a
   downtrend, expect price to come up a little and then continue down: sell the pullback, not
   the low. The stop goes where the structure says the idea is wrong (beyond the swing), not
   at an arbitrary distance.
   (Since 25 November 2026 one of the entries is exactly this: after a break of structure,
   price comes back to the swing it broke and closes back beyond it; the stop goes beyond the
   pullback. A rule that stopped trading for the day after a full loss was tried on 25 November
   and removed by the owner on 26 November 2026.)
7. **A win rate over 60%, consistently** — in the whole test and year by year, not only on
   average. When trades lose, go back to the losing trades, find out why they lost, and fix
   that; then test again. (27 November 2026: the owner asked for 70% or more, week by week. The
   stop moved within minutes of +0.4R — live since that day — gives 76% over five years.)
8. **Use each method the way it is meant to be used.** Before building on a strategy, look up
   how traders actually apply it (search the web, read several sources) and implement that —
   do not invent a variant and call it by the method's name.

## How results are tested and reported

9. **Live backtesting** (since 27 November 2026): every test is run as if live. Whatever a
   system chooses — a strategy, a setting, a filter — it chooses only from the candles before
   the day it trades, and chooses again as time moves on; nothing from later is ever used.
   Older candles may serve as the past a choice is learned from, but are not reported.
10. **The windows: 5 years, 1 year, 3 months, 2 weeks and 1 week** (27 November 2026) — nothing
    longer, not 10, 15, 20 or 25 years. (The Backtests page also shows the last 3 years next
    to the five.) From 26 to 27 November the owner had asked for 15 and 10 years as well; that
    was withdrawn.
11. **Be consistent**: the same window, the same costs and the same measures every time, so
    one result can be compared with the next.
12. **No sugarcoating, and nothing goes live unless it beats what is live** (26 November 2026):
    report the real numbers, the bad years included; a new system or rule is deployed only if
    its results beat the current one's on those windows, and it has to be something that can
    perform live as it was backtested.
13. **Nothing is deployed until the owner says so** (27 November 2026): "Don't deploy it
    without asking me, and don't deploy it until I tell you to deploy it." On 27 November the
    owner told it to deploy two changes to the gold scalp — one confirmation instead of five,
    and the stop moved within minutes of +0.4R (structure-scalp-v10).
