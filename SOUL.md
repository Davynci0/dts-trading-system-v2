# Standing rules for this trading system

These are the owner's requirements, stated on 23 and 24 November 2026. They apply to every change to
the strategy, the backtest and the reports, until the owner says otherwise.

## What the system must be

1. **One trade at a time.** Never several open trades on similar entries with different stops
   and targets. A new signal is only sent when nothing is open.
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

## How results are tested and reported

9. **Backtest on 5 years, and show the last 3 years next to it.** Nothing longer.
10. **Never show 15-year results** — not in answers, the README, the dashboard or the Backtests
   page.
11. **Be consistent**: the same window, the same costs and the same measures every time, so
    one result can be compared with the next.
