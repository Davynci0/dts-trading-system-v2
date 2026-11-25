# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system: a **market-structure scalp on the 15-minute chart**.
One trade at a time, a **1:3** target with a **profit lock**, every trade closed within **five
hours**, with **support and resistance zones** deciding where not to enter and where the stop
goes, **supply and demand zones** it will not trade into, and no duplicate entries. About **two
trades in three close in profit**, at about **1.6 trades a trading day**.

The scanner reads the chart every 15 minutes; when a candle completes an entry, the trade —
entry, stop loss and take profit — is sent to Telegram. The user reviews each signal and
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

## Tori Trades' trendlines (alerts only)

The chart also shows **Tori Trades' trendlines** on the 4-hour chart, drawn the way she teaches
them in her own threads and her TradeZella playbook: a down line from a swing high to a lower
swing high (an up line from a swing low to a higher swing low), never crossed by price between
the two, counting every later swing that returns to it as a touch, and dropped once a candle
closes through it. Her **break** setup — a full-bodied 4-hour close through a line with three or
more touches and at least a week of data, a broken down line being a buy idea and a broken up line
a sell idea, with the stop beyond the opposing trendline (her *safety line*) — is sent to Telegram
as a 💜 alert, once, within 30 minutes of the candle's close. Her **bounce** (the third touch of a
line) is shown in the panel only. On gold that is about three break alerts a month.

These are alerts for your own judgment, **not signals of the system**: they are recorded in
`market_state`, never in `signals`, so they do not count as the open trade and do not block one.
Backtested on five years of gold, her break was about break-even (22 trades, +1R on the 4-hour
chart; +18R on the 1-hour) and her bounce won fewer than one trade in four, so they were not made
part of the rules. The code is in `lib/analysis/tori.ts`.

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
```

The window is always the same — **five years, with the last three shown next to them** — and
so are the costs and the measures. The backtest uses the scanner's own detection: a signal on a
closed 15-minute candle fills at the next candle's open, the full spread + slippage ($0.35 per
ounce) is charged once, and the open trade is followed candle by candle — stop first, then the
target, then the time limit. Candles are cached in `.cache/`. The `/backtests` page shows the
stored runs of the live rules and its **Quick run** button backtests the last six months on
the server.

XAU/USD, to 2026-11-24, in R (1R = the risk of one trade):

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
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # swings, structure, filters, support/resistance, supply/demand, oversized candles, entries, stop, profit lock, Tori trendlines, backtest, settlement, send rules, duplicates
```

## Routes

- `/` — dashboard: the 15-minute chart with the levels an entry has to close beyond, the level a stop would go beyond, the open trade (with its stop once the profit lock has moved it) and past results; the panel shows each condition and what is missing. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs of the live rules and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
