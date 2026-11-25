# Standing rules for this trading system

These are the owner's requirements, stated on 23, 24 and 25 November 2026. They apply to every change to
the strategy, the backtest and the reports, until the owner says otherwise.

## What the system must be

1. **Three strategies, each working on its own, one trade each** (changed by the owner on
   25 November 2026; before that: one trade at a time). The three are the trend scalp, supply
   and demand zones (which replaced Set and Forget the same day, at the owner's request), and
   the trendline strategy (bounce and break). A strategy sends a new signal only
   when its own trade is closed — never several open trades on similar entries. **When
   strategies contradict each other, the trade is not sent**: nothing against another
   strategy's open trade, and nothing when two signals come at the same time and point
   opposite ways.
2. **A scalping system.** A trade should last between about 1 and 5 hours — not 8, not a day.
   If it has reached neither level by then, it is closed.
3. **The 15-minute chart**, with higher timeframes for confirmation.
4. **A modest target: about 1:3 risk to reward.** Do not aim for distant targets.
5. **About 2.5 trades a trading day; never fewer than 2.**
6. **Market structure decides the trade and its risk.** Read swing highs and swing lows. In a
   downtrend, expect price to come up a little and then continue down: sell the pullback, not
   the low. The stop goes where the structure says the idea is wrong (beyond the swing), not
   at an arbitrary distance.
7. **A win rate over 60%, consistently** — in the whole test and year by year, not only on
   average. When trades lose, go back to the losing trades, find out why they lost, and fix
   that; then test again.
8. **Use each method the way it is meant to be used.** Before building on a strategy, look up
   how traders actually apply it (search the web, read several sources) and implement that —
   do not invent a variant and call it by the method's name.

Rules 2 to 7 were written for the trend scalp and it meets them. The owner asked for the
trendline strategy and for supply and demand zones by name on 25 November 2026; both are run as
their methods are taught (rule 8), which means they hold trades for longer than five hours and win
fewer than 60% of them on their own (54% and 39%) — the three together win 61%. Report each
strategy's results next to the others', never blended in a way that hides this.

## How results are tested and reported

9. **Backtest on 5 years, and show the last 3 years next to it.** Nothing longer.
10. **Never show 15-year results** — not in answers, the README, the dashboard or the Backtests
   page.
11. **Be consistent**: the same window, the same costs and the same measures every time, so
    one result can be compared with the next.
