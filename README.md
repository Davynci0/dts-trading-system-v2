# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system. It trades **breakouts with the trend on the 15-minute
chart**, with a fixed **1:3** risk-to-reward target — about **2.5 times a trading day** while
gold is as active as it is now.

| Entry | In one line |
| --- | --- |
| **Breakout** | the first 15-minute close beyond the high/low of the last 3, 6, 12 or 24 hours, with the trend |
| **Momentum candle** | a 15-minute candle of 1.2 ATR or more that closes in the outer quarter of its range, with the trend |

The scanner reads the chart every 15 minutes; when a candle completes an entry, the trade —
entry, stop loss and take profit — is sent to Telegram. The user reviews each signal and
executes manually — the system never places trades.

Expect about **13 signals a week**, in bursts: none on about half of all days, five or so on
the others. Up to eight trades are open together. Four trades in ten win. **Read
[the backtest results](#backtesting) before trusting it** — most of what it made, it made in
the last three years.

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
| Daily | the trend: the 50-day average, and the 20-, 60- and 250-day returns (time-series momentum) |
| 1-hour | the trend again — the 50 EMA against the 200 EMA, +DI against −DI — and whether it is exhausted (ADX) |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the entries, the stop (from its ATR) and the candles every open trade is followed on |

A higher-timeframe candle is only read once it has closed.

## The rules

All of it is in `lib/analysis/trend.ts`, shared by the scanner, the backtest and the chart.

**Six conditions, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily trend | close of the last day on one side of its 50-day average |
| 2 | Daily momentum | at least two of the 20-, 60- and 250-day returns point the same way |
| 3 | Moving averages | the 1-hour 50 EMA on the same side of the 200 EMA |
| 4 | Directional movement | the 1-hour +DI above −DI for buys, below for sells (14 periods) |
| 5 | Trend not exhausted | the 1-hour ADX under 40 |
| 6 | Costs | spread + slippage at most 6% of the trade's risk |
| 7 | Entry | **breakout**: the first 15-minute close beyond the high/low of the previous 12, 24, 48 or 96 candles — or **momentum candle**: a candle at least 1.2 × ATR long, closing in the top quarter of its range for a buy (bottom quarter for a sell) |

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | 2.5 × the 15-minute ATR from the entry — this distance is 1R |
| Take profit | 3 × the risk (1:3) |
| Time limit | closed at market after 96 fifteen-minute candles (24 hours of trading) if neither is hit |
| Positions | up to eight open together, one per signal candle, never a buy and a sell at once |
| Size | 0.125% of the account per trade (`RISK_PCT`, `ACCOUNT_BALANCE`, default $500) — eight open trades risk 1% between them |

### Where the rules come from

The brief: the 15-minute chart, a 1:3 target, at least 2.5 trades a day.

**1. What can trade that often.** 44,928 rule sets holding one trade at a time (breakouts,
RSI and moving-average pullbacks, engulfing and pin candles, momentum candles): the more often
a rule traded, the less each trade made, and none of the 714 that traded 2.5 times a day beat
its costs. What does reach that frequency is taking every breakout in the trend's direction
and holding several at once.

**2. Why its trades lost.** The first version of that (three trend readings, up to four trades
open) lost 116R in its first twelve years. Its 6,928 trades were sorted by what the market
looked like at each entry — session, weekday, cost, ADX, extension, daily momentum, volatility,
the dollar, bonds, how long the trend had lasted, how many trades were open. Before costs it
made 0.05R a trade in 2011–2021 and paid 0.07R in costs. Three conditions lost in the first
ten years *and* in the last five:

| Condition | R per trade before costs, 2011–2021 / 2021–2026 |
| --- | --- |
| Costs above 8% of the risk (against under 4%) | 0.03 / 0.01 (against 0.11 / 0.29) |
| 1-hour ADX 40 or more — an exhausted trend | −0.06 / −0.13 |
| Fewer than two of the 20/60/250-day returns with the trade | −0.06 / −0.06 |

**3. The fixes, checked as a family.** With those three removed (and +DI/−DI kept — without
it 97% of variations lose), 2,520 variations of trend definition, entries, stop and number of
open trades were run: **99% made money in 2011–2021 after costs, 82% with costs doubled.** The
live rules are one of the members that trade 2.5 times a day at today's volatility.

**4. The losing trades again.** Sorted the same way, the new version's trades show no
condition that loses in both periods, so no further filter was added — each extra one would
only fit the past.

**What was tested and not used:**

- **A dollar and bond-yield filter** (a dollar index from six pairs and the US 10-year note,
  each against its 50-day average). In 2011–2021 trades with neither on their side lost 0.11R
  and trades with both made 0.11R; in 2021–2026 it reversed (0.23R against 0.12R) — gold rose
  against a firm dollar and rising yields. Not robust enough to trade on.
- **Position sizing.** Larger size on later trades of a run, smaller size as more are open,
  size by cost, and a volatility target on the system's own results: none improved on the same
  risk for every trade in every period. The stop is already a multiple of ATR, so each trade's
  size is scaled to volatility.
- **Time-series momentum instead of the 50-day average** works about as well; the two together
  were the most consistent.

### What was removed

The 1-hour trend entries (a 240-candle breakout and an RSI pullback with a trailing stop, three
trades a month) ran until 23 November 2026: +175R on 504 trades in fifteen years, 13 of 15
years positive. They were removed because they trade too rarely for the brief. Before them: a
Fibonacci retracement entry, a 30-minute trend system and several pattern strategies. Their
signals stay in the feed, marked as removed.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trades on 15-minute
  candles, then reads the last closed 15-minute candle.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- Up to eight trades are open together; a signal candle that has been traded once is not
  traded again; **never a buy and a sell at the same time**.
- Trades left open by a removed strategy are still followed to their stop, target or time
  limit; they do not block new signals.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

```bash
npx tsx --env-file=.env.local scripts/backtest.ts            # 15 years: totals, year by year, by entry and side
npx tsx --env-file=.env.local scripts/backtest.ts --save     # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=3  # a shorter window
```

The backtest uses the scanner's own detection: a signal on a closed 15-minute candle fills at
the next candle's open, the full spread + slippage ($0.35 per ounce) is charged once, and each
open trade is followed candle by candle — stop first, then the target, then the time limit.
Candles are cached in `.cache/` (the first run of a day downloads fifteen years of history).
The `/backtests` page shows stored runs and its **Quick run** button backtests the last six
months on the server.

XAU/USD, 15 years to 2026-11-24, in R (1R = the risk of one trade):

| | Trades | A week | Win rate | Total | Costs doubled | Worst drawdown |
| --- | --- | --- | --- | --- | --- | --- |
| 2011–2021 (ten years) | 1,203 | 2.3 | 37% | **+162.3R** | +105.8R | 55R |
| 2021–2023 (two years) | 559 | 5.4 | 33% | **+22.0R** | −3.6R | 39R |
| 2023–2026 (three years) | 1,977 | 12.6 | 41% | **+925.3R** | +865.6R | 49R |
| **All 15 years** | **3,739** | **4.8** | **39%** | **+1,109.6R** | **+967.8R** | **55R** |

Eleven of the 15 years made money; the four that lost, lost 0.3R, 6.5R, 8.6R and 19.2R. 2,198
trades ended at the stop, 985 at the take-profit and 556 at the time limit. Breakouts made
+632R and momentum candles +478R; buys +900R and sells +210R. In the last twelve months: 717
trades (2.76 a trading day), 44% won, +406R.

**Read this before trusting it.**

- **It trades 2.5 times a day only while gold is this active.** The cost limit keeps it out
  when 15-minute candles are small: 2.3 trades a week in 2011–2021 (five trades in the twelve
  months from November 2017), 12.6 a week in the last three years. If gold goes quiet it will go quiet too —
  that is the limit doing its job, not a fault.
- **Five-sixths of the profit came in the last three years**, while gold went from $2,000 to
  over $4,000. The ten years before made 162R, the two after them 22R. Plan on those, not on
  the last three.
- **No part of the data is untouched any more.** The three filters were found by looking at
  the losing trades of all fifteen years. They are few, they lost in both halves, and nearly
  every variation of them works — but a rule chosen with the answers in view always looks
  better than it trades. Expect less than the table.
- **Six losses for every four wins, in long runs.** The longest losing run was 27 trades (24
  in the last twelve months). The worst drawdown was 55 times the risk of one trade: at
  0.125% a trade that is 7% of the account, at 1% it is more than half.
- **Trades come in bursts and are not independent.** Up to eight are open in the same
  direction at once and they tend to win or lose together. Sells did far worse than buys
  (+210R with a 122R drawdown).
- **A $500 account cannot size it on a standard account.** In the last twelve months the stop
  was $7 to $85 an ounce, $21 in the middle. The usual minimum trade (0.01 lot = 1 oz) then
  risks about 4% of $500 per trade and a third of the account with eight open. At 0.125% a
  trade is a few hundredths of an ounce, which needs a micro or cent account. The Telegram
  message gives the size for both.
- **Check the spread you actually pay.** Everything above assumes $0.35 an ounce a trade.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # indicators, trend readings, filters, entries, backtest, settlement, send rules
```

## Routes

- `/` — dashboard: the 15-minute chart with the levels a breakout has to close beyond, the open trades and past results; the panel shows each condition and what is missing. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
