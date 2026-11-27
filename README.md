# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system: a **market-structure scalp on the 15-minute chart**
("the trend scalp"). One trade at a time, a **1:3** target with a **profit lock**, every trade
closed within **five hours**, with **support and resistance zones** deciding where not to enter
and where the stop goes, **supply and demand zones** it will not trade into, no duplicate
entries, and at least **one of six trend confirmations** before any trade. The profit lock is
moved **within minutes**: a one-minute check says when. About **three trades in four close in
profit**, at about **one and a half trades a trading day** over the last year: 783 trades in five
years, 76% won, +170.1R, worst drawdown 5.1R, three losses in a row seven times and never four
([backtest](#backtesting)).

The scanner reads the chart every 15 minutes; when a candle completes an entry, the trade —
entry, stop loss and take profit — is sent to Telegram. While a trade is open, a one-minute
check follows it and sends "move your stop now" as soon as price touches +0.4R. The user
reviews each signal and executes manually — the system never places trades.

A second, separate system for **Bitcoin** is shown on its own page and does not send signals
([Bitcoin](#bitcoin-btcusd-a-separate-system-shown-on-its-own-page)).

The owner's standing requirements for the system and for how it is tested are in
[SOUL.md](SOUL.md). **Read [the backtest results](#backtesting) before trusting it.**

**Stack:** Next.js (App Router, single deployable on Vercel) · OANDA v20 (data) ·
Supabase (auth + persistence) · Telegram Bot API (alerts).

## Setup

```bash
cp .env.local.example .env.local   # fill in OANDA / Supabase / Telegram values
npm install
npm run dev                        # http://localhost:3000
```

Run `supabase/schema.sql` in the Supabase SQL editor once to create the tables (an existing
database needs the files in `supabase/migrations/` that it has not had yet).

## Timeframes

| Timeframe | Job |
| --- | --- |
| Daily | the bias: last closed day above its 50-day average → buys only; below → sells only |
| 1-hour | the trend: its market structure (bullish or bearish) has to agree with the daily bias |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the entries and the stop |
| 1-minute | the open trade is followed on it, so the stop is moved within minutes of +0.4R |

A higher-timeframe candle is only read once it has closed.

## The rules

All of it is in `lib/analysis/trend.ts`, shared by the scanner, the backtest and the chart.

**Market structure**, as it is usually taught: a *swing high* is a high with three lower highs
on each side, a *swing low* a low with three higher lows. A candle that **closes** below the
last swing low makes the structure bearish; a close above the last swing high makes it bullish.
It stays that way until the other side is broken. A wick through a swing is not a break.

**Support and resistance**, as traders usually draw them: a *zone* is a band where at least three
1-hour swing highs or lows of the last 30 days sit together, no taller than 0.15 of a day's
average range (the daily ATR).

**Supply and demand**, as traders usually define it: a *zone* is a base of one to three
small-bodied 1-hour candles that price left with a strong candle (a body at least 1.2 ATR and
60% of its range); a demand zone if it left upward, a supply zone if downward. It is *fresh*
until a closed 1-hour candle comes back to it, gone once a close is beyond its far edge, and
lapses after ten days.

**Ten conditions, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily bias | close of the last day on one side of its 50-day average |
| 2 | 1-hour structure | bullish for buys, bearish for sells |
| 3 | Trend not exhausted | the 1-hour ADX under 40 |
| 4 | A real daily trend | price at least 1% beyond the 50-day average, on the trend's side |
| 5 | Not the London morning or the US data hour | on a candle that closes between 07:00 and 14:00 UTC only the pullback entry is traded |
| 5b | One of six trend confirmations | on the 1-hour chart price, the 20-EMA and the 50-EMA lined up · the 1-hour 50-EMA beyond the 200-EMA with price beyond it · 1-hour +DI/−DI on the trade's side · on the 15-minute chart price and the 20-, 50- and 200-EMA lined up · price 2% or more beyond the 50-day average · the daily ADX at 25 or more. Five were needed until 27 November 2026 ([why five](#what-the-losing-trades-had-in-common), [why one](#one-confirmation-instead-of-five-27-november-2026)) |
| 6 | The right half of the range | a buy only in the upper half of the last 24 hours' range, a sell only in the lower half |
| 7 | Costs | spread + slippage at most 6% of the trade's risk |
| 8 | Not through a zone | no trade on a candle that has just closed through a support/resistance zone — price usually comes back to test it |
| 9 | Not an oversized candle | no trade on a signal candle 2.5 ATR long or longer |
| 10 | Not into fresh supply/demand | no buy with a fresh 1-hour supply zone less than 1R ahead, no sell with fresh demand less than 1R ahead |
| 11 | Entry, on a 15-minute close, with the trend | **break of structure**: price pulls back, then closes beyond the last swing — in a downtrend it comes up a little, makes a lower high and closes below the last swing low · **momentum candle**: a candle at least 1.2 × ATR long that closes in the outer quarter of its range · **breakout**: a momentum candle that is also the first close beyond the high/low of the last 3, 6, 12 or 24 hours (a breakout on an ordinary candle is not an entry — see [What the losing trades had in common](#what-the-losing-trades-had-in-common)) · **pullback**: after a break of structure with the trend, price comes back to within 0.25 ATR of the swing it broke, within four hours, and a candle closes back beyond it in the trend's direction — one entry a break, at any hour (see [Four ways gold is usually traded](#four-ways-gold-is-usually-traded-tested)) |

Conditions 3 to 6 and 9 come from the losing trades, 8 from the support and resistance study and 10 from the supply and demand study — see below.

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | just beyond the support (buy) or resistance (sell) zone behind the entry, plus 0.2 ATR, when there is one and that puts the stop between 0.75 and 2 ATR away. Otherwise just beyond the high of the last two candles for a sell (their low for a buy) — the small pullback the trade is leaving behind — plus 0.2 ATR, never closer than 0.75 ATR or further than 2 ATR. The distance is 1R. A pullback entry's stop goes 0.2 ATR beyond the pullback's own low (buy) or high (sell), never closer than 0.75 ATR; a pullback whose stop would be more than 2 ATR away is not traded |
| Take profit | 3 × the risk (1:3) |
| Profit lock | once price has gone 0.4R the trade's way, the stop is moved to 0.2R in profit, straight away: a one-minute check sends the Telegram message as soon as price touches the level. The backtest counts the moved stop from three minutes after the minute of the touch — one minute for the message, two to move it ([why](#the-stop-moved-within-minutes-27-november-2026)) |
| Time limit | closed at market at the close of the 20th candle — five hours |
| Positions | **one trade at a time**; no new signal until it has closed |
| No duplicates | within 60 minutes of the last trade's entry, no new trade on the same side within 1R of that entry's price |
| Size | 0.5% of the account per trade (`RISK_PCT`, `ACCOUNT_BALANCE`, default $500) |

### Where the rules come from

The brief (SOUL.md): the 15-minute chart, one trade at a time, 1 to 5 hours a trade, about 1:3,
about 2.5 trades a day, with market structure deciding the trade and its risk. Each method was
looked up first and built the way it is taught, then run on five years of gold — about 13,700
rule sets in four passes. Every result is judged on the first two and the last three years
separately, and again with costs doubled.

1. **The textbook pullback entry** — retrace 38%, 50% or 62% of the leg, confirmation candle,
   stop above the pullback or above the leg (5,184 variations). Weak: 13% made money in both
   parts, the best traded about four times a week, and none of the ten that traded 2.5 times a
   day made money in both.
2. **Entering on the continuation instead** — the break of structure after the pullback, and
   breakouts and momentum candles — with a trend filter (5,184 variations). Half made money in
   both parts. Without a trend filter, 6% did.
3. **The trend filter that keeps the frequency** is the 1-hour structure with the daily bias.
   Adding +DI/−DI and an ADX ceiling is better per trade (+216R, a 21R drawdown, 46% winners)
   but trades 1.8 times a day, under the brief.
4. **The stop.** Placed beyond the last full swing it was too far away: with a sensible cap,
   88% of stops landed on the cap, not on the swing, and with a wide cap the trades ran into
   the five-hour limit and two or three of the five years lost. Placed beyond the last two candles —
   the nearest piece of structure — 55% of stops are set by the candles and the rest by the
   2-ATR limit, the median trade lasts 3¼ hours, and no year loses more than half an R.
5. **Its neighbours.** Twenty-four variations of the final rules (swing size, limits, buffer,
   time limit, target, entries, sessions) all made money over the five years, and all of them
   with costs doubled as well — the weakest only just.

**Tried and not used:** a target of 2R (worse), a break-even stop (worse), London and New York
hours only (worse), structure breaks as the only entry (too few trades, +33R).

### Why the trades lost, and what was changed

The rules above made +141R in five years, but only 42% of their trades closed in profit. Every
one of the 1,636 trades was looked at again.

**How the losers lost.** Half of all trades reached the stop. Of those, 38% never went a
quarter of an R in the right direction — the entry was simply wrong — but 62% had been in profit
first. And the 1:3 target is far: 67% of all trades got 0.5R up and 48% got 1R up, but only
11% reached 3R.

**Where they lost.** Sorted by what the market looked like at the entry, four conditions did
badly in both the older and the newer half of the trades:

| Condition | Trades | Closed in profit | R a trade |
| --- | --- | --- | --- |
| 1-hour ADX 40 or more (an exhausted trend) | 296 | 34% | −0.18 |
| London morning, 07:00–12:00 UTC | 278 | 33% | −0.08 |
| Entry in the wrong half of the last 24 hours' range | 251 | 35% | −0.14 |
| Price within 1% of the 50-day average | 84 | 36% | −0.14 |

**What was tested** (about 3,000 more rule sets, judged on five years and on the last three):

- **Filters alone are not enough.** Removing those conditions lifts the result but leaves the
  win rate under 50%, because the stop is 1R away and the target 3R.
- **A nearer target wins more often and earns less.** With a target of two-thirds of the risk
  63% of trades win, but five years make about +60R to +75R, against more than +200R for the
  1:3 target with the same filters.
- **The profit lock does both jobs better.** The target stays at 1:3; once a trade is 0.4R up
  its stop moves to 0.2R in profit. Trades that used to come all the way back now close with a
  small gain: 64% close in profit, the win rate is 60% or more in every one of the five years,
  and it stays at 62% with costs doubled.
- **Its neighbours.** Nineteen variations — the lock (trigger 0.35R to 0.6R, stop 0.15R to
  0.3R), the stop, the time limit, the target and each filter on its own — keep the win rate
  between 62% and 64% and make money over five years, with costs doubled too. Taking all the
  filters away is the exception: the win rate stays at 62% but the profit goes (+18R, and
  −61R with costs doubled). The lock makes the win rate; the filters make the money.

**What it costs.** The same entries with the same filters and *no* lock make about twice as
much (+234R against +119R over five years) with 47% of trades winning. The lock gives up the
part of the move between 0.2R and wherever the trade would have ended, in exchange for winning
more often. It was chosen because the brief asks for a win rate over 60%.

### Duplicate entries

One trade at a time is not enough on its own: after a trade closes, the next 15-minute candle
often gives a new signal on the same side at almost the same price — the same trade again. Over
five years, the 201 trades entered within an hour of the trade before them made **0.0R** together
(60% won); the 151 of those within 1R of the earlier entry's price lost 8.8R.

So a new trade on the same side is not taken within 60 minutes of the last entry unless price is
more than 1R (the last trade's risk) away from it. A trade on the other side, a move of more than
1R, or an hour passing all free it again. Replayed over the five years, the rule keeps the profit
(+119R either way), raises it with costs doubled (+77R against +74R), lowers the worst drawdown
from 27R to 24.5R and the longest losing run from 7 to 6, and leaves about two trades a trading
day (2.05 in the last twelve months, from 2.2). Blocking every trade within an hour of the last
entry did a little better per trade (a 21R drawdown) but fell to 1.97 a day.

### Support and resistance

Zones were drawn the way traders commonly draw them — clusters of swing highs and lows, three or
more touches — and the usual ways of using them were each tested on the live rules over five
years: 1-hour zones, daily zones, the previous day's high and low, and round $50 numbers.

| Use | Trades a day | Win rate | 5 years | Worst drawdown |
| --- | --- | --- | --- | --- |
| Rules before the zones | 2.05 | 65% | +119R | 24.5R |
| Skip a trade with a zone less than 1R ahead | 1.04 | 66% | +91R | 11.7R |
| Take only trades whose candle broke through a zone | 0.73 | 59% | −5R | 25.2R |
| Target at the next zone instead of 3R | 2.07 | 65% | +118R | 25.6R |
| **A. No trade on a candle that has just closed through a zone** | 1.72 | 67% | +127R | 14.3R |
| **B. The stop beyond the zone behind the entry** | 2.09 | 63% | +129R | 12.9R |
| **A and B — the rules now** | 1.72 | 67% | +139R | 10.8R |

Breaking through a level on the signal candle is the trap: price usually comes back to test the
level it broke, and those entries lost money. A zone behind the entry is the natural place for
the stop — where the trade is wrong — and it is often closer than the last two candles' extreme.
Daily zones, the previous day's high and low and round numbers did less or nothing.

**It trades under two a day.** The brief asks for at least two trades a trading day; with the zones
it made 1.72 in the last twelve months. The owner chose this version on 24 November 2026 for its
better result and smaller drawdown. The improvement comes from the last three years — the first
two years made a little less than before — and the rules were picked from about fifty variations
on these same five years, so expect less than the table.

### Supply and demand, and oversized candles

Supply and demand zones were tested the same way — as a filter ahead of the entry, as the place
for the stop, as the target, and as entries of their own (a limit order at a fresh zone's first
return, the classic way to trade them). Only the filter helped: buying straight into a fresh
supply zone (or selling into fresh demand) is what lost. As entries of their own the zones did not
make money on gold. Looking again at the losing trades of two weeks in November, signal candles
2.5 ATR or longer lost in both halves of the five years (56 trades, 55% won, −9R).

| On the rules above | Trades a day | Win rate (worst year) | 5 years | Costs doubled | Worst drawdown |
| --- | --- | --- | --- | --- | --- |
| Before | 1.72 | 67% (66%) | +139R | +105R | 10.8R |
| No oversized candle | 1.68 | 67% (66%) | +148R | +116R | 11.1R |
| No trade into fresh supply/demand within 1R | 1.69 | 67% (67%) | +147R | +114R | 8.9R |
| **Both — the rules now** | **1.60** | **68% (67%)** | **+156R** | **+125R** | **9.5R** |

Both improve the first two years as well as the last three. The zones' first return is read only
from closed 1-hour candles, so the backtest knows no more than the scanner does.

## What the losing trades had in common

The trades were laid out with what the chart looked like at entry, and a group of losers was
only acted on when it lost in **both halves** of the five years and had a reason.

- **A breakout on an ordinary candle** — the first close beyond the high or low of the last 3 to
  24 hours, on a candle that was not a momentum candle: 120 trades, −7.4R, negative in both
  halves. Breakouts on a momentum candle won 76%. A breakout now only counts on a momentum
  candle. Before: 870 trades, 68% won, +155.9R, drawdown 9.5R. After: **785 trades, 69% won,
  +160.4R**, drawdown 9.9R.

### The confirmations: what the trades that made money had in common

The owner's brief: winning two and losing one is fine; losing three to five in a row is not. The
785 trades were laid out against every reading the scanner has. Two honest findings first:

- **No reading separates winners from losers by much.** Whatever was tried, between 62% and 76% of
  the trades in a group won. Changing the exit does not help either: every other profit lock and
  target made less money with the same losing runs.
- **Standing aside after a loss does not help.** The trade after a loss wins as often (69%) as the
  trade after a win, so a pause only removes trades.

What does help is trading less, in better conditions. Six readings each made more per trade in
both halves of the five years when present; a trade now needs **five of the six**:

| Confirmation | R a trade with it | without it |
| --- | --- | --- |
| 1-hour price, 20-EMA and 50-EMA lined up | 0.22 | 0.16 |
| 1-hour 50-EMA beyond the 200-EMA, price beyond it | 0.22 | 0.15 |
| 1-hour +DI/−DI on the trade's side | 0.22 | 0.14 |
| 15-minute price and 20-, 50-, 200-EMA lined up | 0.22 | 0.16 |
| Price 2% or more beyond the 50-day average | 0.22 | −0.01 |
| Daily ADX 25 or more | 0.23 | 0.17 |

And the **US data hour** (candles closing 12:00–14:00 UTC, 7 to 9 am in New York) joined the
no-trade hours: 162 trades, 62% won in both halves, 28% full losses — the worst hours of the day.

| | Before | With five of six confirmations, no trade 07:00–14:00 UTC |
| --- | --- | --- |
| Trades | 785 (1.4 a day) | 435 (0.8 a day) |
| Won | 69% | 71% |
| Total | +160.4R | +114.2R |
| A trade | 0.20R | 0.26R |
| Worst drawdown | 9.9R | 7.0R |
| Longest losing run | 5 | 4 |
| Three or more losses in a row | 18 times | 6 times |
| Four or more in a row | 4 times | 3 times |
| Days at −2R or worse | 7 | 3 |

Both halves of the five years give the same result (+56.1R and +58.1R, 71% won in each). The cost
is plain: 46R less profit over five years and about half the trades, and over the last 30 days it
made +4.5R from 24 trades where the rules before made +9.4R from 39. **Runs of three losses still
happen — about once a year instead of three or four times.** A system that wins seven in ten
cannot avoid them altogether.

These were chosen by looking at the same five years they are measured on, so this is the best
case, not a forecast — the test that counts is live trading.

### One confirmation instead of five (27 November 2026)

Five of six held back about a third of the trades without choosing better ones. The number was
changed on its own, over five years (the rules of 26 November, trades followed on 15-minute
candles):

| Confirmations needed | Trades | Won | Total | Longest losing run |
| --- | --- | --- | --- | --- |
| 0 of 6 | 771 | 70% | +189.5R | 4 |
| **1 of 6 (now)** | **766** | **70%** | **+190.0R** | **4** |
| 3 of 6 | 708 | 71% | +174.4R | 4 |
| 5 of 6 (until 27 November) | 515 | 72% | +146.0R | 4 |
| 6 of 6 | 287 | 71% | +81.2R | 5 |

As a [live backtest](#live-backtesting-27-november-2026) — the number chosen every three months
from the two to four years before — the past chose 0 or 1 almost every time, and the result was
+174R to +190R. One is kept so a trade still has something on the higher timeframes behind it.
The cost, on its own: a worst drawdown of 6.4R instead of 5.7R, and runs of three losses 14 times
instead of 8 — which the faster stop below takes back.

### The stop moved within minutes (27 November 2026)

The owner asked for the losing trades to be studied and turned into winners. Over five years the
rules of 26 November had 148 losing trades: 100 full stops, 37 small losses after the stop had
been moved, and 11 at the five-hour limit.

- **The full stops are fast and never get going:** 41% are stopped within half an hour, and 95%
  never reach +0.4R. No reading at the entry tells them apart — 18 were checked, and none lost in
  both halves of the five years.
- **The 37 small losses had reached +0.4R**, and fell back before the next 15-minute check moved
  the stop.
- **What did not help:** a wider, tighter or differently placed stop; waiting for a better price
  with a limit order; closing a trade that is not moving; a pause after a loss; entering again
  after a stop; a trailing stop. Each made less, and none was chosen when the choice was made
  from the past only.

**What did:** following every trade on 1-minute candles and moving the stop within minutes of the
touch. A one-minute check (`/api/watch`) sends the message; the backtest counts the moved stop
from three minutes after the minute of the touch. With one confirmation (the rules now), five
years:

| Stop moved | Trades | Won | Total | Costs doubled | Worst drawdown | Longest losing run | Three losses in a row |
| --- | --- | --- | --- | --- | --- | --- | --- |
| At the next 15-minute check (before) | 766 | 70.5% | +190.0R | +163.0R | 6.4R | 4 | 14 times |
| 1 minute after the touch | 787 | 78.4% | +164.2R | +136.4R | 5.6R | 3 | 5 times |
| **3 minutes after (the backtest)** | **783** | **75.9%** | **+170.1R** | **+142.4R** | **5.1R** | **3** | **7 times** |
| 5 minutes after | 780 | 73.3% | +165.9R | +138.3R | 5.2R | 3 | 9 times |
| 10 minutes after | 771 | 69.3% | +182.6R | +155.3R | 6.1R | 4 | 16 times |

**It trades profit for win rate.** A trade that touches +0.4R, dips back to +0.2R and then runs
to the target is now closed at +0.2R: 14 fewer full targets in five years and about 20R less than
moving the stop at the 15-minute check — for three trades in four won instead of seven in ten,
and no run of four losses in five years. It only works if the stop is moved: ten minutes late,
it is back where it was.

## Four ways gold is usually traded, tested

On 25 November 2026 the four methods gold traders most often describe were each looked up, built
the way they are described, and run on the same five years, with the same exits and costs and one
trade at a time. "With the rules" means with the trend scalp's own conditions: the daily bias and
1-hour structure, ADX under 40, 1% from the 50-day average, five of six confirmations.

| Method | As built | Five years | Outcome |
| --- | --- | --- | --- |
| **Trend pullback** | after a 15-minute break of structure with the trend, price back at the broken swing and a close back beyond it; stop beyond the pullback | with the rules: 223 trades, 67% won, +59.2R, both halves in profit, +50.9R with costs doubled | **Built in** as a fourth entry |
| Session breakout, London | the Asian range (00:00–07:00 UTC), the first 15-minute close beyond it from 07:00 to 10:00 | with the rules 56 trades, 57% won, −11.7R; without them 240 trades, −18.7R; a range-size filter and a stop at the far side of the range lose as well | Loses in every form |
| Session breakout, New York | the day's range to 12:00 UTC, the first close beyond it from 12:00 to 16:00 | with the rules 107 trades, 66% won, +4.6R — and +10.0R or −1.3R when the hours are moved by one | Too small, and the sign depends on the hours chosen |
| Liquidity sweep reversal | a spike through the previous day's high/low, the Asian range, the last 15-minute swing or the 24-hour range, and a close back inside; stop beyond the spike | with the trend only: 23 to 66 trades, between −11.7R and +2.1R; with all the rules 1 to 12 trades in five years; against the trend −4.7R to −12.6R | Too rare with the trend, loses against it |
| News continuation | a move of 2 ATR or more in the half hour after 8:30, 10:00 or 14:00 New York, a pullback of a quarter to three quarters of it, then a candle back in its direction | with the rules 23 trades, 70% won, +3.5R; in either direction 83 trades, +6.9R | Four or five trades a year — too few to matter |

Fixed retracement entries (38%, 50%, 62% of the leg) had been tried before and were weak (see
[Where the rules come from](#where-the-rules-come-from)); what works is the pullback **to the
level that was broken**, entered only once a candle has closed back beyond it.

**The pullback entry brings more trades, more profit and more losing runs.** A second rule was
tried with it for one day (25 November 2026): after a full loss, no new trade until the trading
day ends at 17:00 New York. It removed every run of four losses in the five years, but it gave up
a fifth of the profit, and in its first week it kept the system out of a trade that reached its
target. On 26 November 2026 the owner chose to trade without it.

| | Before the pullback entry | With the pullback entry (live) | With the day stop as well (tried, removed) |
| --- | --- | --- | --- |
| Trades | 435 (0.8 a day) | 505 (1.0 a day) | 441 (0.8 a day) |
| Won | 71% | 72% | 71% |
| Total | +114.2R | +144.5R | +116.7R |
| Costs doubled | +99.3R | +126.8R | +100.9R |
| Worst drawdown | 7.0R | 5.7R | 6.7R |
| Longest losing run | 4 | 4 | 3 |
| Three or more losses in a row | 6 times | 8 times | 5 times |
| Four or more in a row | 3 times | 3 times | never |
| Days at −2R or worse | 3 | 4 (the worst −3.1R) | 1 |
| The last 30 days | 24 trades, +4.5R | 32 trades, +4.1R | 27 trades, +7.0R |
| The last twelve months | 207 trades, +50.1R | 257 trades, +65.0R | 212 trades, +45.8R |

The 81 pullback entries won 75% and made +37.0R; 46 of them came in the London morning and the US
data hour, where the other entries are not traded, and made +23.1R. The first and second half of
the trades made +76.6R (73% won) and +67.9R (71%). What it costs: two more runs of three or more
losses than before, and a run of four losses in the last 30 days of the test. Like every rule
here the pullback entry was chosen on the same five years it is measured on.

Read first: [a 3.7-year backtest of the London breakout on gold](https://www.mql5.com/en/blogs/post/777540),
[how gold moves through the three sessions](https://www.mql5.com/en/blogs/post/772224), and
published trade plans for [break-and-retest](https://www.tradingview.com/chart/XAUUSD/XwRniHkD-Gold-Long-Setup-Break-and-Retest-of-Key-Level)
and [sweep-and-reverse](https://www.tradingview.com/chart/XAUUSD/VT9OCasT-ICT-Liquidity-Sweep-High-Probability-Reversal-Setup/) entries.

## Strategies that were tried next to it, and removed

On 25 November 2026 three other strategies ran beside the trend scalp for a few hours, each
holding a trade of its own, and were removed again at the owner's request. None had sent a live
signal. Their five-year tests, for the record:

| Strategy | Alone, 5 years | Why it went |
| --- | --- | --- |
| Set and Forget (Alex G's swing method, 4-hour entries) | 13 trades, 69% won, +13.3R | Two or three trades a year |
| Trendline bounces and retests (1-hour, with the daily trend) | 211 trades, 54% won, +66.8R | Lost a little over the last month while the trend scalp made +9.4R |
| Supply and demand zones (30-minute, with the daily trend) | 50 trades, 60% won, +60.3R | About ten trades a year; one trade last month, a loss |

With the last two the three together made 1,045 trades, 65% won, +287.3R with a worst drawdown of
11.4R, against 785 trades, 69% won, +160.4R and 9.9R for the trend scalp alone as it then was: more profit over
five years, but a lower win rate, a deeper drawdown and up to three trades open at once. The code
is in the git history (`lib/analysis/trendline.ts`, `lib/analysis/zones.ts`, `lib/strategies.ts`).

## Bitcoin (BTC/USD): a separate system, shown on its own page

The **Bitcoin** page (`/btc`, also the BTC/USD button on the dashboard) shows a second system
with its own rules. **It does not send signals**: the page reads the rules on live candles and
shows what they are waiting for, the trades they would have taken over the last weeks, and the
backtest.

**Why it is a different system.** The gold rules lose on Bitcoin (five years: −7.9R from 120 trades
at a $45 spread, −70.6R from 552 at $20). So do the usual intraday methods with the scalp's
five-hour exit. What works on Bitcoin is slower: **a 4-hour breakout with the trend.**

**Where these rules come from.** Each market was tuned on its own on the years up to November
2021 and the result run once on the five years after ([Each market tuned on its own](#each-market-tuned-on-its-own-then-examined-on-years-it-had-never-seen)).
On Bitcoin the rules below came out of that and held on the unseen years. On 26 November 2026
the owner chose them over the first rules (a close beyond the last 20 candles' range, with the
50-day trend), which they beat on five, three and one year and on three months, and trail
on the last month and week.

| | |
| --- | --- |
| Trend | the 4-hour close against the 200-EMA of the 4-hour chart: above it only buys, below it only sells |
| Entry | the first 4-hour candle of the day that closes above yesterday's high (buy) or below yesterday's low (sell); entered at market at that close. "Yesterday" is the last daily candle closed (17:00 New York). If that first close is against the trend, that side is not traded that day. 4-hour candles are built on the UTC clock (00:00, 04:00, …) |
| Stop loss | 0.2 ATR beyond the low (buy) / high (sell) of the last two 4-hour candles; never closer than 1.5 ATR and never further than 2 ATR (4-hour ATR) |
| Take profit | 3 × the risk (1:3) |
| Profit lock | once price has gone 0.6R the trade's way, the stop is moved to 0.2R in profit |
| Time limit | closed at market after 72 hours of trading |
| Positions | one trade at a time |
| No trade | when costs ($45 a coin) are more than 6% of the risk, or when the market is closed at the 4-hour close |

BTC/USD, to 2026-11-26, in R, after $45 a coin (the spread the data provider quoted in November 2026):

| | Trades | Win rate | Total | Costs doubled | Worst drawdown | Longest losing run |
| --- | --- | --- | --- | --- | --- | --- |
| **5 years** | **319** | **60%** | **+33.6R** | **+25.0R** | **8.8R** | **4** |
| **Last 3 years** | 230 | 60% | +32.5R | +27.2R | 8.8R | 4 |
| 1 year | 75 | 60% | +15.4R | | 6.4R | 4 |
| 3 months | 15 | 80% | +9.5R | | 2.9R | 2 |
| 1 month | 7 | 86% | +2.1R | | 1.0R | 1 |
| 1 week | 1 | | +0.2R | | | |

By calendar year: 2022 +2.0R (58 trades) · 2023 −1.2R (26) · 2024 +16.4R (84) · 2025 −4.0R (73)
· 2026 +17.9R (69). Over five years 116 trades ended at the first stop, 131 at the moved stop, 33
at the target and 39 at the time limit; the average win is 0.83R, the average loss 0.97R.

**Read this before trusting it.**

- **The edge is small** — 0.11R a trade against 0.22R for gold, a little over one trade a week.
  Two of the last five calendar years lost, 2025 among them.
- **It is the buys.** Over five years buys made +33.5R (157 trades, 62% won) and sells +0.2R
  (162 trades, 57% won). Bitcoin rose over the period.
- **Losing runs.** Three or more losses in a row twelve times in five years, four in a row three
  times. The win rate is 60%, lower than the first rules' 68%: the lock is later (+0.6R).
- **It is not a scalp.** Half the trades last a day (23 hours), some the full 72: this departs
  from the standing rules for gold (the 15-minute chart, one to five hours), because nothing
  faster had an edge on Bitcoin.
- **Chosen with some hindsight.** Two settings came out of the tuning years and held on the
  unseen ones; this is the one that did better there and on the recent windows.
- **The data has no weekends** (the provider's Bitcoin market is closed then) and the spread is
  the provider's; a broker's spread, its weekend trading and its overnight charges will differ.
- **The stop is wide in dollars:** $938 to $3,281 a coin in the last twelve months, $1,855 in
  the middle.

```bash
npx tsx --env-file=.env.local scripts/backtest-btc.ts          # five years, with the last three next to them
npx tsx --env-file=.env.local scripts/backtest-btc.ts --save   # …and written to lib/backtest/btc-results.json for the page
```

## 49 kinds of strategy (26 November 2026)

The owner asked for every well-known strategy to be tested on both markets, on long and short
windows, and for nothing to go live unless it beats what is live. **Nothing did, so the rules did
not change.** What the test showed is below, the bad parts included. (Since 27 November 2026
results are given on five years and shorter only — SOUL.md.)

**The gold scalp on every window** (to 2026-11-26, $0.35 an ounce):

| | Trades | Win rate | Total | Costs doubled | Worst drawdown | Longest losing run |
| --- | --- | --- | --- | --- | --- | --- |
| 5 years | 515 | 72% | +146.0R | +128.1R | 5.7R | 4 |
| 3 months | 55 | 71% | +12.5R | +10.8R | 4.1R | 4 |
| 1 month | 42 | 67% | +5.6R | +4.4R | 4.1R | 4 |
| 1 week | 17 | 71% | +4.7R | +4.2R | 2.0R | 2 |

By calendar year: 2022 +11.4R (39 trades) · 2023 −0.5R (24) · 2024 +19.5R (54) · 2025 +55.8R
(164) · 2026 +59.8R (234).

- **Almost all of the profit is from 2024 to 2026**, and the rules were tuned on these same five
  years. Before them they show no edge.
- **When gold is quiet the system does not trade** (the cost limit). It sits out; it does not lose.
- **The same is true of nearly every 15-minute method.** Of the 49 strategy types tested, almost
  all made money on gold in the last five years. The last two years have been a strong trend
  with large candles, and following it paid.

**What was tested.** 49 strategy types — breaks of structure, pullbacks, fair value gaps, order
blocks, liquidity sweeps, Donchian, Keltner and Bollinger breakouts, session and opening-range
breakouts, the 10–11 New York "silver bullet", moving-average, MACD, DI and Ichimoku crosses,
Supertrend, Parabolic SAR, Heikin-Ashi, EMA, VWAP, pivot and Fibonacci pullbacks, RSI(14),
RSI(2), Bollinger and stochastic reversion, range fades, engulfing, pin bar, inside bar, NR7,
three-bar reversal, double top/bottom — on the 15-minute, 1-hour and 4-hour charts, with five
trend filters and up to six exits (1:2 and 1:3, with and without the lock, 5 to 48 hours):
3,695 variants a market, each with costs and costs doubled.

**What held on gold:** only slow breakouts with the daily trend on the 4-hour chart (Donchian,
Keltner, Bollinger squeeze, Supertrend) — the Bitcoin page's first rule, which on gold had never
been fitted to anything. The 4-hour Donchian 20 with the daily trend, 1:2, the lock and 48 hours
made +41.1R over five years from 313 trades, about one a week, with a losing year (2023, about
−6R). It does not replace the scalp. **Taken one trade at a time with the scalp it does not beat
the scalp alone** on the recent windows (one year +60.6R against +68.4R, one week +1.7R against
+4.7R): its long trades keep scalps out. **Run side by side — one scalp and one breakout open at
once — the two together beat the scalp on every window** (5 years +184R, one year +93R, three
months +19.4R, one month +12.0R, one week +6.9R). That breaks the one-trade-at-a-time rule, so it
was not deployed.

**A 1:2 target** (asked for by the owner) with the profit lock makes less than 1:3: +112R
against +146R on gold over five years (the rules of 26 November), and less on Bitcoin too.
Without the lock the scalp makes more (+216R with 1:3) but wins only 54% of the time, with losing
runs of seven.

**Bitcoin:** the page's first rules made +22.8R over five years from 215 trades (68% won). One
variant in 3,695 beat them on every window, which is what chance gives. Nothing was changed.

### Each market tuned on its own, then examined on years it had never seen

The owner asked for a strategy and settings found separately for each market — gold, Bitcoin and
eight forex pairs (26 November 2026). Each market's best strategies and settings were chosen on
the years before the five-year window, their losing trades studied and filtered, and the
finished rules run once on the five years. **Of the 60 tuned systems, all 60 had made money where
they were chosen; on the five years 43 failed, 11 were near zero, 5 held at a lower level and 1
held.** Tuning a market until its backtest looks best mostly finds what happened to work in
those years; win rates of 67% to 85% on the forex pairs fell to 24% to 57%.

- **Forex:** nothing to trade — in a second, wider round as well (eight more strategy types that
  belong to currencies, the daily chart, and a raw-spread cost about half the standard one).
  **No forex system was added.**
- **Gold:** the 4-hour breakout again.
- **Bitcoin:** 4-hour breakouts held. At the real $45 a coin, the first 4-hour close beyond
  yesterday's high or low with the 200-EMA beat the page's first rules on five years (+33.6R
  against +22.8R), one year (+15.4R against +8.7R) and three months (+9.5R against +5.7R), with a
  smaller drawdown — and was behind on the last month (+2.1R against +4.8R, 7 trades) and week.
  Shown both, the owner chose to replace the page's rules with it (26 November 2026).

The owner then asked for every test to be run as if live (27 November 2026) — see
[Live backtesting](#live-backtesting-27-november-2026).

### Where the entry, the stop and the target go

The owner asked whether each system enters, stops and takes profit in the right place — a stop
not so near that a good trade is knocked out first, a target neither too far nor too short. Two
things were measured for the gold scalp, the gold 4-hour breakout and the Bitcoin rules.

**How far price goes against a trade before it works, and how far with it** (from the entry at
the close, in ATR of the signal chart, within the time limit):

| | Gold scalp | Gold 4-hour breakout | Bitcoin |
| --- | --- | --- | --- |
| Setups that reach +2 ATR | 52% | 45% | 51% |
| …before that, half went against by no more than | 0.55 ATR | 0.51 ATR | 0.43 ATR |
| …three in four by no more than | 0.99 ATR | 0.98 ATR | 0.98 ATR |
| …nine in ten by no more than | 1.71 ATR | 1.58 ATR | 1.59 ATR |
| A stop 1 ATR away keeps this share of them | 75% | 75% | 75% |
| A stop 1.5 ATR away | 86% | 89% | 89% |
| A stop 2 ATR away | 94% | 95% | 94% |
| Where the stop is now (middle case) | 1.77 ATR | 1.96 ATR | 1.83 ATR |
| Furthest with the trade: half reach / one in four / one in ten | 2.2 / 3.9 / 6.3 ATR | 1.7 / 3.3 / 5.0 ATR | 2.1 / 4.6 / 8.7 ATR |

The three markets say the same thing: a stop under 1 ATR throws away a third of the trades that
would have worked, and from about 2 ATR on little more is saved. The stops are where that puts
them. A 1:3 target is some 5 ATR away and only about one trade in ten gets there within the time
limit — which is why the profit lock, not the target, closes most winners.

**Every placement, chosen on the earlier years and run on the later ones.** Six ways to enter (at
the close; a limit order 0.25, 0.5 or 1 ATR back; a stop order 0.1 or 0.5 ATR beyond the signal
candle) × eight stops (the rule, beyond the last swing, 0.75 to 3 ATR) × nine targets (1:1 to
1:3, 1.5 to 6 ATR) × three locks: 1,296 combinations a system.

| | Now, on the later years | The 20 best of the earlier years, on the later years |
| --- | --- | --- |
| Gold scalp (split a year ago) | +70.5R, 70% won | middle +73.3R; 11 of 20 ahead, most by dropping the lock (50–60% won, losing runs of 7) |
| Gold 4-hour breakout (split five years ago) | +41.1R, 75% won | middle +13.6R; none ahead |
| Bitcoin (split five years ago) | +33.6R, 60% won | middle +15.9R; none ahead |

- **Entering at the close is the best entry on all three.** A limit order waiting for a pullback
  gets a better price but misses the trades that run; a stop order waiting for more movement
  enters late. Both made less on the later years.
- **Nothing was changed.** On the scalp the only way found to make more is to drop the lock,
  which the owner has turned down before for its losing runs.

**The challenge in one week** ($50,000, +$5,000 to pass, out at −$2,000 in a day or $3,000
under the peak), counted on the backtest's own trades from every starting day:

| Risk a trade | Passed within 1 week | Lost within 1 week | Passed in the end | Lost in the end |
| --- | --- | --- | --- | --- |
| $250, last 12 months | 0% | 0% | 60% (40% still open; median 82 days) | 0% |
| $500 | 0% | 0% | 93% (median 54 days) | 0% |
| $1,000 | 13% | 6% | 77% | 23% |
| $1,500 | 24% | 12% | 80% | 20% |
| $1,900 | 34% | 17% | 70% | 30% |
| $1,000, last 5 years | 4% | 2% | 88% | 12% |
| $1,900, last 5 years | 13% | 9% | 53% | 47% |

The last twelve months are the best the system has had. From any starting day before late 2023
it almost never passed at any size. A week of +5R or more happened 4 times in the last 54.

## Live backtesting (27 November 2026)

Since 27 November 2026 every result is a **live backtest**: whatever is chosen — a strategy, a
setting, a filter — is chosen only from the candles before the day it is traded, and chosen
again every three months from the three years before. Nothing from after the day of a choice is
used for it. Results are given on **five years, one year, three months, two weeks and one week**
(SOUL.md).

- **All ten markets** (gold, Bitcoin and the eight forex pairs), each re-choosing its own strategy
  every three months from 61 strategy types: +66.9R over five years from 756 trades on one
  account, 60% won, worst drawdown 10R — about +13R a year. Studying the losing trades inside
  the test (switching off conditions that had lost) made it worse every time. Not deployed.
- **Gold and Bitcoin, trading only when three strategies agree:** gold +45.7R over five years
  (about one trade a week), Bitcoin +20.7R, most of it in the last twelve months. Not deployed.
- **The two strategies of a gold trading guide** (LearnPriceAction): the 1-hour 50/200-EMA
  pullback made about +45R over five years at a 34–39% win rate with losing runs of up to 17;
  the 15-minute Fibonacci 50% scalp about broke even. Not deployed.
- **The gold scalp:** two changes held and went live on 27 November 2026 — [one confirmation
  instead of five](#one-confirmation-instead-of-five-27-november-2026) and [the stop moved within
  minutes](#the-stop-moved-within-minutes-27-november-2026).

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trade, then reads the
  last closed 15-minute candle.
- **The one-minute check.** While a trade is open, `/api/watch` follows it on 1-minute candles:
  as soon as price touches +0.4R the "move your stop now" message goes to Telegram, and a trade
  that reaches its stop, target or time limit is closed in the feed. The trade is scored with the
  moved stop from two minutes after that message, so the feed shows what moving it then gives.
  It needs a second scheduler job, **every minute**, with the same bearer secret; with no trade
  open it only reads the database. Without that job the check runs with each scan, and the
  message can come up to 15 minutes late. A trade whose stop was moved before 27 November 2026
  is followed on 15-minute candles, as it was.
- **A missed scan.** Each scan also reads the candle before the newest one. A signal that candle
  gave and that was never sent is recovered while it is under 20 minutes old, marked ⏰ LATE: the
  original stop, the entry at the current price, the target re-worked to 1:3 from there — unless
  its stop or target has been reached. The send rules are applied as they stood when its own
  candle closed, so a trade that was open then still blocks it. Over five years, entering one
  candle late made +0.11R a trade (68% won) against +0.18R on time. Two missed scans in a row
  still lose a signal.
- **A slow candle.** If the candle that has just closed is not there yet, the scan asks again
  (twice, four seconds apart) instead of reading the old one.
- **A refused request.** The data provider now and then answers a valid request with
  "401 Insufficient authorization" and accepts the same request a moment later (2 of 97 scans on
  25–26 November 2026). The request is asked again, up to four times, like a server error.
- **The scan log.** Every scan writes a row to `market_state` (`scan:schedule:<slot>`) when it
  starts and when it is done, with the candle it read and what it did. The slots cover a week;
  in practice rows older than about a day are being removed, most likely by the old site that
  still shares the database. Audited on 26 November 2026: 97 scans in 24 hours, no 15-minute
  slot missed, a scan starting 8 seconds after the candle close in the middle case (175 at
  worst) and taking 1.5 seconds.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- One trade at a time: nothing is sent while a trade is open. A signal candle that has been
  traded once is not traded again. Within 60 minutes of the last entry, a signal on the same
  side within 1R of that entry's price is not sent (the scan says why).
- Trades left open by a removed strategy are still followed to their stop, target or time
  limit; they do not block new signals.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

```bash
npx tsx --env-file=.env.local scripts/backtest.ts            # five years, with the last three next to them
npx tsx --env-file=.env.local scripts/backtest.ts --save     # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --15min    # trades followed on 15-minute candles, the stop moved at the next candle (as before 27 November 2026)
```

The window of the stored runs is always the same — **five years, with the last three shown next to them** (the shorter windows are below it) — and
so are the costs and the measures. The backtest uses the scanner's own detection: a signal on a
closed 15-minute candle fills at the next candle's open, the full spread + slippage ($0.35 per
ounce) is charged once, and the open trade is followed on 1-minute candles (fetched for every
setup and cached) — stop first, then the target, then the profit lock, then the time limit —
with the moved stop in force from three minutes after the minute price touched +0.4R. Candles are cached in `.cache/`. The `/backtests` page shows the
stored runs of the live rules and its **Quick run** button backtests the last six months on
the server.

XAU/USD, to 2026-11-27, in R (1R = the risk of one trade):

| | Trades | A week | Win rate | Total | Costs doubled | Worst drawdown | Longest losing run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **5 years** | **783** | **3.0** | **76%** | **+170.1R** | **+142.4R** | **5.1R** | **3** |
| Last 3 years | 700 | 4.5 | 76% | +159.2R | +135.7R | 5.1R | 3 |
| 1 year | 387 | 7.4 | 77% | +96.4R | +85.8R | 5.1R | 3 |
| 3 months | 91 | 7.0 | 74% | +17.7R | +14.9R | 4.4R | 3 |
| 2 weeks | 31 | 15.5 | 77% | +10.1R | +9.1R | 2.3R | 2 |
| 1 week | 10 | 10.0 | 70% | +1.7R | +1.5R | 1.7R | 1 |

| Year from | Trades | A week | Win rate | Total |
| --- | --- | --- | --- | --- |
| Nov 2021 | 47 | 0.9 | 79% | +8.1R |
| Nov 2022 | 36 | 0.7 | 72% | +2.9R |
| Nov 2023 | 78 | 1.5 | 74% | +23.3R |
| Nov 2024 | 235 | 4.5 | 74% | +39.5R |
| Nov 2025 | 387 | 7.4 | 77% | +96.4R |

- **How trades end:** 149 at the first stop (a full loss), 494 at the moved stop (a small gain,
  or a little less when price was already through it), 55 at the 1:3 target, 85 at the five-hour
  limit.
- **What a win and a loss are worth:** the average win is 0.57R, the average loss 0.88R.
- **How long they last:** half are over within 45 minutes. None is held longer than five hours.
- **By entry:** momentum candles +62.3R (312 trades, 77% won), pullbacks +45.4R (132, 83%),
  breaks of structure +33.4R (240, 70%), breakouts on a momentum candle +29.0R (99, 79%). Buys
  +106.0R (541 trades, 76%), sells +64.1R (242, 76%).
- **Weeks:** 178 of the 261 weeks had trades; in 119 of them 70% or more won, and 125 ended in
  profit.
- **Losing runs and bad days:** three losses in a row seven times in five years, never four. Five
  days lost 2R or more; the worst lost 2.4R.

**Read this before trusting it.**

- **A gap through the target is booked at the target.** When a candle opens beyond the
  take-profit (a weekend gap), a real order fills at the better opening price; the backtest and
  the trade record book the target itself. It happened once on gold and twice on Bitcoin in the
  whole history, and understates the result by about 2R and 0.4R.
- **A high win rate is not a high profit.** Most wins are the moved stop at +0.2R; the losses
  are mostly a full 1R. It averages 0.22R a trade — 0.18R with costs doubled. Without the lock
  the same entries make more, but only about half of them win.
- **The lock needs you to act, within minutes.** The table counts the moved stop from three
  minutes after price touched +0.4R. That needs the one-minute check running (a scheduler job
  every minute) and the stop moved within two minutes of the message. Moved ten minutes late,
  the win rate falls back to about 69%; not moved at all, the result is not the one in the table.
- **It trades often only while gold is this active.** The cost limit keeps it out when
  15-minute candles are small: about one trade a week in the first two years, seven a week in
  the last. If gold goes quiet, it will too.
- **Most of the evidence is two years old or less.** 622 of the 783 trades, and four-fifths of
  the profit, are from the last two years. The filters and the lock were chosen by looking at
  these same five years, so expect less than the table.
- **Check the spread you actually pay.** Everything above assumes $0.35 an ounce a trade. At
  twice that the five-year result falls from +170R to +142R.
- **Size.** In the last twelve months the stop was $6 to $74 an ounce, $14 in the middle. The
  usual minimum trade (0.01 lot = 1 oz) then risks about 3% of a $500 account per trade — six
  times the 0.5% the system assumes. At 0.5% a trade, $500 became $1,158 over the five years;
  at 1% it became $2,627. The Telegram message gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/audit-live.ts   # the LIVE site against the provider's raw candles and a calculation written from scratch: candles, swings and labels, breaks of structure, moving averages, day levels, entry and stop levels, the Bitcoin page (51 checks)
npx tsx --tsconfig tsconfig.json scripts/verify-btc.ts     # the Bitcoin system: the 4-hour chart, yesterday's levels, the trend line, entry, stop, exits, one trade at a time, and that the page reads what the backtest reads
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # swings, structure, filters, support/resistance, supply/demand, oversized candles, entries (the pullback among them), stop, profit lock, the stop moved within minutes, backtest, settlement, send rules, duplicates
```

## Routes

- **On the chart:** to begin with only the next entry (shown only while a trade is possible), the open trade and the closed trades. The other layers are switched on with a click and the choice is remembered in the browser: the 15-minute market structure the entries are read from — each swing labelled HH, HL, LH or LL, and each close beyond a swing drawn as BOS (the structure continues) or CHoCH (it turns) — support and resistance, supply and demand, the moving averages, yesterday's high and low, and a shaded band over the hours in which no new trade is taken. The chart can also show the **1-hour** candles (with the 1-hour structure the trend is read from) and the **4-hour** candles (context only); the system's read and its signals are the same whichever is shown.
- `/` — dashboard: the 15-minute chart with the nearest level an entry has to close beyond, the level a stop would go beyond, the open trade (with its stop once the profit lock has moved it) and past results; a line above the chart says which side is traded and why, and the panel says what the system is waiting for and which conditions are still missing (the ones already met, the levels and the rules are folded away). `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/btc` — the Bitcoin system: the 4-hour chart with its trend line, yesterday's high and low and the level the next trade needs, what the rules are waiting for, the trades they would have taken, and the backtest. Read only — no signals are sent
- `/backtests` — stored backtest runs of the live rules and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/btc` — everything the Bitcoin page shows, from the code its backtest runs
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/watch` — the one-minute check of the open trade (GET, scheduled every minute)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
