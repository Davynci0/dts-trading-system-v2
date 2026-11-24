# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system: a **market-structure scalp on the 15-minute chart**.
One trade at a time, a **1:3** target with a **profit lock**, every trade closed within **five
hours**, and no duplicate entries. About **two trades in three close in profit**, at about **two
trades a trading day**.

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

**Seven conditions, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily bias | close of the last day on one side of its 50-day average |
| 2 | 1-hour structure | bullish for buys, bearish for sells |
| 3 | Trend not exhausted | the 1-hour ADX under 40 |
| 4 | A real daily trend | price at least 1% beyond the 50-day average, on the trend's side |
| 5 | Not the London morning | no new trade on a candle that closes between 07:00 and 12:00 UTC |
| 6 | The right half of the range | a buy only in the upper half of the last 24 hours' range, a sell only in the lower half |
| 7 | Costs | spread + slippage at most 6% of the trade's risk |
| 8 | Entry, on a 15-minute close, with the trend | **break of structure**: price pulls back, then closes beyond the last swing — in a downtrend it comes up a little, makes a lower high and closes below the last swing low · **breakout**: the first close beyond the high/low of the last 3, 6, 12 or 24 hours · **momentum candle**: a candle at least 1.2 × ATR long that closes in the outer quarter of its range |

Conditions 3 to 6 come from the losing trades — see below.

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | just beyond the high of the last two candles for a sell (their low for a buy) — the small pullback the trade is leaving behind — plus 0.2 ATR. Never closer than 0.75 ATR or further than 2 ATR. The distance is 1R |
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

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trade on 15-minute
  candles, then reads the last closed 15-minute candle.
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
| **5 years** | **1,186** | **4.6** | **65%** | **+118.7R** | **+77.2R** | **24.5R** | **6** |
| **Last 3 years** | 1,025 | 6.6 | 64% | +106.5R | +73.0R | 24.5R | 6 |

| Year from | Trades | A week | Win rate | Total |
| --- | --- | --- | --- | --- |
| Nov 2021 | 87 | 1.7 | 67% | +9.0R |
| Nov 2022 | 74 | 1.4 | 68% | +3.2R |
| Nov 2023 | 152 | 2.9 | 68% | +18.4R |
| Nov 2024 | 341 | 6.5 | 62% | +22.5R |
| Nov 2025 | 532 | 10.2 | 65% | +65.6R |

- **How trades end:** 292 at the first stop (a full loss), 688 at the moved stop (a small gain,
  or a little less after a gap), 76 at the 1:3 target, 130 at the five-hour limit (102 of those
  in profit, +1.0R on average).
- **What a win and a loss are worth:** the average win is 0.59R, the average loss 0.80R.
- **How long they last:** 56% are over within an hour, 27% last 1 to 3 hours, 17% last 3 to 5.
  None is held longer than five.
- **By entry:** momentum candles +52.6R (520 trades, 65% won), breakouts +37.0R (271, 67%),
  breaks of structure +29.1R (395, 63%). Buys +88.8R (65%), sells +29.9R (64%).
- **The last twelve months:** 532 trades — 2.05 a trading day, on 182 of about 260 trading
  days, usually two on a day that has any; 65% closed in profit.

**Read this before trusting it.**

- **A high win rate is not a high profit.** Most wins are the moved stop at +0.2R; the losses
  are mostly a full 1R. It averages 0.10R a trade — 0.07R with costs doubled — and the same
  entries without the lock make about twice as much. Six losses in a row have happened.
- **The lock needs you to act.** The backtest moves the stop from the 15-minute candle after
  price reaches +0.4R. Live, that is a second Telegram message; if the stop is moved late, or
  not at all, the result is not the one in the table.
- **It trades twice a day only while gold is this active.** The cost limit keeps it out when
  15-minute candles are small: under two trades a week in the first two years, eleven a week
  in the last. If gold goes quiet, it will too.
- **Most of the evidence is two years old or less.** 873 of the 1,186 trades, and three-quarters
  of the profit, are from the last two years. The filters and the lock were chosen by looking
  at these same five years, so expect less than the table.
- **Check the spread you actually pay.** Everything above assumes $0.35 an ounce a trade. At
  twice that the five-year result falls from +119R to +77R.
- **Size.** In the last twelve months the stop was $6 to $74 an ounce, $15 in the middle. The
  usual minimum trade (0.01 lot = 1 oz) then risks about 3% of a $500 account per trade — six
  times the 0.5% the system assumes. At 0.5% a trade, $500 became $891 over the five years with
  a worst drop of 12%; at 1% it became $1,539 with a worst drop of 22%. The Telegram message
  gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # swings, structure, filters, entries, stop, profit lock, backtest, settlement, send rules, duplicates
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
