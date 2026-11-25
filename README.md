# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system with **three strategies, each working on its own**:

| Strategy | Chart | A trade ends at | How often | Alone, 5 years |
| --- | --- | --- | --- | --- |
| **Trend scalp** — the market-structure scalp described under [The rules](#the-rules) | 15-minute | 1:3 target, profit lock at +0.4R, five-hour limit | about 1.6 a day | 870 trades, 68% won, +155.9R |
| **[Set and Forget](#set-and-forget)** — Alex G's swing method | 4-hour | 1:2 target or the stop, never moved | about one every three months | 18 trades, 56% won, +11.2R |
| **[Trendline](#the-trendline-strategy)** — bounces off and breaks of trendlines, with the daily trend | 1-hour | 1:3 target or the stop, never moved; five-day limit | about three in two weeks | 289 trades, 31% won, +59.4R |

Each strategy holds **one trade of its own**, so up to three can be open at once — but **never in
opposite directions**: a signal against another strategy's open trade is not sent, and signals
that come at the same moment and point opposite ways cancel each other
([the rule between them](#three-strategies-side-by-side)).

The scanner reads the charts every 15 minutes; when a candle completes an entry, the trade —
entry, stop loss and take profit, labelled with its strategy — is sent to Telegram. The user reviews each signal and
executes manually — the system never places trades.

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
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the entries, the stop and the candles the open trade is followed on |

A higher-timeframe candle is only read once it has closed.

## The rules

These are the rules of the **trend scalp**. The other two strategies have their own, further down.

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
| 5 | Not the London morning | no new trade on a candle that closes between 07:00 and 12:00 UTC |
| 6 | The right half of the range | a buy only in the upper half of the last 24 hours' range, a sell only in the lower half |
| 7 | Costs | spread + slippage at most 6% of the trade's risk |
| 8 | Not through a zone | no trade on a candle that has just closed through a support/resistance zone — price usually comes back to test it |
| 9 | Not an oversized candle | no trade on a signal candle 2.5 ATR long or longer |
| 10 | Not into fresh supply/demand | no buy with a fresh 1-hour supply zone less than 1R ahead, no sell with fresh demand less than 1R ahead |
| 11 | Entry, on a 15-minute close, with the trend | **break of structure**: price pulls back, then closes beyond the last swing — in a downtrend it comes up a little, makes a lower high and closes below the last swing low · **breakout**: the first close beyond the high/low of the last 3, 6, 12 or 24 hours · **momentum candle**: a candle at least 1.2 × ATR long that closes in the outer quarter of its range |

Conditions 3 to 6 and 9 come from the losing trades, 8 from the support and resistance study and 10 from the supply and demand study — see below.

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | just beyond the support (buy) or resistance (sell) zone behind the entry, plus 0.2 ATR, when there is one and that puts the stop between 0.75 and 2 ATR away. Otherwise just beyond the high of the last two candles for a sell (their low for a buy) — the small pullback the trade is leaving behind — plus 0.2 ATR, never closer than 0.75 ATR or further than 2 ATR. The distance is 1R |
| Take profit | 3 × the risk (1:3) |
| Profit lock | once price has gone 0.4R the trade's way, the stop is moved to 0.2R in profit. It applies from the next 15-minute candle; a second Telegram message says when to move it |
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

## Set and Forget

Alex G's swing method (fxalexg, Swing Trading Lab), as he teaches it — `lib/analysis/setforget.ts`:

1. The **weekly, daily and 4-hour** structure agree on a direction (a timeframe only turns when a
   candle body closes beyond its last structure point).
2. Price pulls back into an **area of interest**: a weekly or daily level it has turned at three
   times or more in the last three years.
3. On the **4-hour chart** the structure shifts back with the trend and an **engulfing candle**
   confirms it — that close is the entry.
4. The stop goes beyond the high or low the pullback made; the target is 1:2. **Nothing is moved**
   and there is no time limit: the trade ends at its stop or at its target, which can take weeks.

On gold the method only holds up with the 4-hour chart as the entry chart: over five years the
30-minute entry made −16.8R (70 trades) and the 1-hour −3.8R (32), the 2-hour +7.3R (16) and the
4-hour **+11.2R (18 trades, 10 winners)**. It is rare by nature on a single market — he trades it
across many pairs. Eighteen trades is too few to prove anything; it is run because the owner asked
for it, at the version that did not lose.

## The trendline strategy

Trendlines drawn the way Tori Trades teaches them — a falling line from a swing high to a lower
swing high (a rising line from a swing low to a higher swing low), never crossed by price between
the two, every later swing that returns to it a touch, dropped once a candle closes through it —
read on the **1-hour chart** and traded **with the daily trend** (the last close against its
50-day average). `lib/analysis/trendline.ts`:

- **Bounce:** in an uptrend, a 1-hour candle comes back to a rising line (two touches or more, a
  week of data) and closes up, away from it — buy. The stop goes just beyond the line.
- **Break:** in an uptrend, a full-bodied 1-hour candle closes up through a falling line with
  three touches or more — the pullback is over — buy. The stop goes beyond the *safety line* (the
  rising line on the other side), or beyond the break candle when none can be drawn.
- Mirrored for sells. The stop is never closer than 0.5 ATR, and a setup whose stop would be more
  than 3 ATR away is left alone. Target 1:3. Nothing is moved; closed at market after five
  trading days.

Five years of gold: **289 trades, 31% won, +59.4R** (+47.1R with the costs doubled; last three
years 194 trades, +35.2R), worst drawdown 18R, **13 losses in a row** at worst, one losing year in
five (−7R). It makes its money from few, large winners: with the trend scalp's profit lock it won
60% of its trades and *lost* money (−3R), and closed after five hours it made +14R instead of +59R.
So it does not meet the 60% win rate or the five-hour limit of SOUL.md, and cannot without losing
its edge. Every neighbouring setting tested (touches, line age, stop limits, targets from 1:2.5
to 1:4) was also profitable. The lines it trades are drawn on the chart.

## Three strategies side by side

`lib/strategies.ts`. Each strategy takes a signal only when it holds no trade of its own. Between
them there is one rule: **no contradicting trades** —

- a signal that is opposite to another strategy's open trade is not sent;
- signals found on the same scan that point in opposite directions are all dropped.

All three trade with the larger trend, so this is rare: in the five-year replay it stopped 3
signals. Replayed together (the [backtest](#backtesting)): **1,174 trades, 59% won, +226.5R**,
against 870 trades, 68% and +155.9R for the trend scalp alone — more profit and more trades (1.9
a day in the last year against 1.6), but a **lower win rate**, a **deeper worst drawdown (16.6R
against 9.5R)** and a **longer losing run (13 against 5)**, because the trendline strategy loses
two trades in three. Three trades open at once risk three times the stake of one; that happened
less than 1% of the time, two at once 2%.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trade on 15-minute
  candles, then reads the last closed 15-minute candle.
- **A missed scan.** Each scan also reads the candle before the newest one. A signal that candle
  gave and that was never sent is recovered while it is under 20 minutes old, marked ⏰ LATE: the
  original stop, the entry at the current price, the target re-worked to 1:3 from there — unless
  its stop or target has been reached. The send rules are applied as they stood when its own
  candle closed, so a trade that was open then still blocks it. Over five years, entering one
  candle late made +0.11R a trade (68% won) against +0.18R on time. Two missed scans in a row
  still lose a signal.
- **A slow candle.** If the candle that has just closed is not there yet, the scan asks again
  (twice, four seconds apart) instead of reading the old one.
- **The scan log.** Every scan writes a row to `market_state` (`scan:schedule:<slot>`) when it
  starts and when it is done, with the candle it read and what it did; a week is kept.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- One trade a strategy: a strategy sends nothing while its own trade is open, and a signal candle
  that has been traded once is not traded again. For the trend scalp, within 60 minutes of the
  last entry a signal on the same side within 1R of that entry's price is not sent. Nothing is
  sent against another strategy's open trade, and opposite signals of the same scan cancel each
  other (the scan says why).
- The trendline strategy is read when a 1-hour candle has just closed, Set and Forget when a
  4-hour candle has; a scan 15 minutes late still finds them, entered at the price then.
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
```

The window is always the same — **five years, with the last three shown next to them** — and
so are the costs and the measures. The backtest uses the scanner's own detection: a signal on a
closed 15-minute candle fills at the next candle's open, the full spread + slippage ($0.35 per
ounce) is charged once, and the open trade is followed candle by candle — stop first, then the
target, then the time limit. Candles are cached in `.cache/`. The `/backtests` page shows the
stored runs of the live rules and its **Quick run** button backtests the last six months on
the server.

XAU/USD, to 2026-11-24, in R (1R = the risk of one trade). The three strategies side by side:

| | Trades | A day | Win rate | Total | Costs doubled | Worst drawdown | Longest losing run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **5 years** | **1,174** | **0.91** | **59%** | **+226.5R** | **+182.8R** | **16.6R** | **13** |
| **Last 3 years** | 972 | 1.25 | 60% | +184.9R | +152.7R | 16.6R | 13 |
| of which Trend scalp (5 years) | 868 | 0.67 | 68% | +154.8R | | 9.5R | 5 |
| of which Set and Forget | 18 | 0.01 | 56% | +11.2R | | 2.1R | 2 |
| of which Trendline | 288 | 0.22 | 32% | +60.5R | | 18.0R | 13 |

By year, oldest first: +25.1R (53% won), +16.5R (54%), +15.9R (53%), +71.4R (62%), +97.7R (61%).
The last twelve months: 495 trades, 1.91 a trading day. The worst day was −3.4R.

The trend scalp on its own, which the rest of this section is about:

| | Trades | A week | Win rate | Total | Costs doubled | Worst drawdown | Longest losing run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **5 years** | **870** | **3.3** | **68%** | **+155.9R** | **+125.2R** | **9.5R** | **5** |
| **Last 3 years** | 774 | 5.0 | 67% | +144.9R | +119.1R | 9.5R | 5 |

| Year from | Trades | A week | Win rate | Total |
| --- | --- | --- | --- | --- |
| Nov 2021 | 53 | 1.0 | 74% | +8.9R |
| Nov 2022 | 43 | 0.8 | 70% | +2.1R |
| Nov 2023 | 103 | 2.0 | 70% | +23.9R |
| Nov 2024 | 256 | 4.9 | 67% | +38.3R |
| Nov 2025 | 415 | 8.0 | 67% | +82.7R |

- **How trades end:** 195 at the first stop (a full loss), 508 at the moved stop (a small gain,
  or a little less after a gap), 65 at the 1:3 target, 102 at the five-hour limit (85 of those
  in profit, +1.1R on average).
- **What a win and a loss are worth:** the average win is 0.65R, the average loss 0.81R.
- **How long they last:** 57% are over within an hour, 25% last 1 to 3 hours, 18% last 3 to 5.
  None is held longer than five.
- **Where the stop came from:** 427 trades beyond the last two candles (70% won, +101.7R), 202
  beyond a support/resistance zone (66%, +22.6R), 241 at the 2-ATR limit (66%, +31.5R).
- **By entry:** momentum candles +73.2R (386 trades, 68% won), breakouts +42.1R (228, 70%),
  breaks of structure +40.6R (256, 66%). Buys +110.4R (68%), sells +45.5R (67%).
- **The last twelve months:** 415 trades — 1.60 a trading day, on 165 of about 260 trading
  days, usually two on a day that has any; 67% closed in profit.

**Read this before trusting it.**

- **A high win rate is not a high profit.** Most wins are the moved stop at +0.2R; the losses
  are mostly a full 1R. It averages 0.18R a trade — 0.14R with costs doubled — and the same
  entries without the lock make about twice as much. Five losses in a row have happened.
- **The lock needs you to act.** The backtest moves the stop from the 15-minute candle after
  price reaches +0.4R. Live, that is a second Telegram message; if the stop is moved late, or
  not at all, the result is not the one in the table.
- **It trades often only while gold is this active.** The cost limit keeps it out when
  15-minute candles are small: about one trade a week in the first two years, eight a week in
  the last. If gold goes quiet, it will too.
- **Most of the evidence is two years old or less.** 671 of the 870 trades, and three-quarters of
  the profit, are from the last two years. The filters and the lock were chosen by looking
  at these same five years, so expect less than the table.
- **Check the spread you actually pay.** Everything above assumes $0.35 an ounce a trade. At
  twice that the five-year result falls from +156R to +125R.
- **Size.** In the last twelve months the stop was $6 to $74 an ounce, $15 in the middle. The
  usual minimum trade (0.01 lot = 1 oz) then risks about 3% of a $500 account per trade — six
  times the 0.5% the system assumes. At 0.5% a trade, $500 became $1,076 over the five years with
  a worst drop of 5%; at 1% it became $2,260 with a worst drop of 9%. The Telegram message
  gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # swings, structure, filters, support/resistance, supply/demand, oversized candles, entries, stop, profit lock, the trendline strategy, the rule between the three strategies, backtest, settlement, send rules, duplicates
```

## Routes

- **On the chart:** the 15-minute market structure the entries are read from — each swing labelled HH, HL, LH or LL, and each close beyond a swing drawn as BOS (the structure continues) or CHoCH (it turns) — yesterday's high and low, and a shaded band over the hours in which no new trade is taken. Each is a layer that can be switched off. The chart can also show the **1-hour** candles (with the 1-hour structure the trend is read from) and the **4-hour** candles (where Set and Forget takes its entries); the read of the strategies and their signals are the same whichever is shown. The 1-hour trendlines the trendline strategy trades are drawn on all three.
- `/` — dashboard: the 15-minute chart with the levels an entry has to close beyond, the level a stop would go beyond, the open trades, each labelled with its strategy (with its stop once the profit lock has moved it) and past results; the panels show each condition of the trend scalp and what is missing, and for all three strategies what each holds and what it is waiting for. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs of the live rules and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
