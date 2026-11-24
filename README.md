# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system. It trades **breakouts with the trend on the 15-minute
chart**, with a fixed **1:3** risk-to-reward target, about **2.5 times a trading day**.

| Entry | In one line |
| --- | --- |
| **Breakout** | the first 15-minute close beyond the high/low of the last 3, 6, 12 or 24 hours, with the trend |
| **Momentum candle** | a 15-minute candle of 1.5 ATR or more that closes in the outer quarter of its range, with the trend |

The scanner reads the chart every 15 minutes; when a candle completes an entry, the trade —
entry, stop loss and take profit — is sent to Telegram. The user reviews each signal and
executes manually — the system never places trades.

Expect about **13 signals a week**, in bursts: none on days when the trend readings disagree,
about four on days when they agree. Up to four trades are open together. One trade in three
wins. **Read [the backtest results](#backtesting) before trusting it** — on fifteen years of
data this system lost for the first twelve and made money in the last three.

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
| Daily | the trend: last closed day above its 50-day average → buys only; below → sells only |
| 1-hour | the trend again: the 50 EMA against the 200 EMA, and +DI against −DI |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the entries, the stop (from its ATR) and the candles every open trade is followed on |

A higher-timeframe candle is only read once it has closed.

## The rules

All of it is in `lib/analysis/trend.ts`, shared by the scanner, the backtest and the chart.

**Three trend readings, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily trend | close of the last day on one side of its 50-day average |
| 2 | Moving averages | the 1-hour 50 EMA on the same side of the 200 EMA |
| 3 | Directional movement | the 1-hour +DI above −DI for buys, below for sells (14 periods) |
| 4 | Entry | **breakout**: the first 15-minute close beyond the high/low of the previous 12, 24, 48 or 96 candles — or **momentum candle**: a candle at least 1.5 × ATR long, closing in the top quarter of its range for a buy (bottom quarter for a sell) |

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | 2.5 × the 15-minute ATR from the entry — this distance is 1R |
| Take profit | 3 × the risk (1:3) |
| Time limit | closed at market after 96 fifteen-minute candles (24 hours of trading) if neither is hit |
| Positions | up to four open together, one per signal candle, never a buy and a sell at once |
| Refused when | spread + slippage exceed 10% of the risk |
| Size | 0.25% of the account per trade (`RISK_PCT`, `ACCOUNT_BALANCE`, default $500) — four open trades risk 1% between them |

### Where the rules come from

The brief was: the 15-minute chart, a 1:3 target, at least 2.5 trades a day. About 94,000 rule
sets were run on fifteen years of gold to find what fits it.

- **The more often a 15-minute rule trades, the less each trade makes.** 44,928 rule sets held
  one trade at a time: breakouts of 2 to 24 hours, RSI and moving-average pullbacks, engulfing
  and pin candles, momentum candles, with and without each trend filter. Before costs, the
  best tenth of those trading under twice a week made 0.13R a trade or more; the best tenth of
  those trading 12 times a week or more, 0.01R. **Of the 714 that traded 2.5 times a day, none
  made twice today's cost per trade in 2011–2021.**
- **What reaches 2.5 a day is taking every trend breakout and holding several at once.**
  Breakouts of several lengths combined, in the direction of all three trend readings, with up
  to four trades open: about 13 trades a week, 0.11R a trade before costs in 2011–2021 and
  0.16R in 2021–2026, positive before costs in 14 of 15 years. A second pass of 49,152
  variations put the live settings in the middle of that group: a stop of 2.5 ATR (tighter
  stops lost to costs), no ADX filter (it hurt), no break-even move (it made no difference).
- **Costs decide it.** One trade costs about $0.35 an ounce. With gold near $1,300 a 15-minute
  candle was $1.30 long, the stop $3, and the cost a tenth of the risk — as much as the edge.
  With gold near $4,000 the candle is $10 long, the stop $25, and the cost under 2% of the
  risk. The same rules that lost for twelve years have made money for three.

### What was removed

The 1-hour trend entries (a 240-candle breakout and an RSI pullback with a trailing stop, three
trades a month) ran until 23 November 2026. On the same fifteen years they made +175R on 504
trades, with 13 of 15 years positive — a far stronger record per trade than this system's.
They were removed because they trade too rarely for the brief. Before them: a Fibonacci
retracement entry, a 30-minute trend system and several pattern strategies. Their signals stay
in the feed, marked as removed.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trades on 15-minute
  candles, then reads the last closed 15-minute candle.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- Up to four trades are open together; a signal candle that has been traded once is not traded
  again; **never a buy and a sell at the same time**.
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
| 2011–2021 (ten years) | 3,709 | 7.1 | 32% | **−66.9R** | −318.4R | 180R |
| 2021–2023 (two years) | 1,201 | 11.5 | 29% | **−48.8R** | −126.3R | 168R |
| 2023–2026 (three years) | 2,018 | 12.9 | 35% | **+492.5R** | +421.9R | 73R |
| **All 15 years** | **6,928** | **8.9** | **32%** | **+376.8R** | **−22.9R** | **198R** |

Eight of the 15 years lost. 4,525 trades ended at the stop, 1,528 at the take-profit and 875
at the time limit. Breakouts made +284R and momentum candles +93R; buys +331R and sells +46R.
In the last twelve months: 663 trades (2.55 a trading day), 39% won, +253R.

**Read this before trusting it.**

- **Over its first twelve years it lost 116R.** Everything it has made came after November
  2023, when gold went from $2,000 to over $4,000 in one of the strongest trends in its
  history. That is the kind of market a breakout system is built for, and the kind that ends.
- **The case for it is the cost, not the record.** Before costs the rules made about a tenth
  of the risk per trade in the first ten years and more since. What changed is that the cost
  fell from a tenth of the risk to a fiftieth as gold's price and its candles grew. If gold
  goes quiet again — or the broker's spread is wider than $0.35 — the edge goes with it. Check
  the spread you actually pay.
- **Two losses for every win, in long runs.** The longest losing run was 37 trades (18 in the
  last twelve months). The worst drawdown was 198 times the risk of one trade: at 0.25% a
  trade that is half the account; at 1% it is all of it.
- **Trades come in bursts and are not independent.** Up to four are open in the same
  direction at the same time, and they tend to win or lose together. Four trading days in ten
  have no trade; the others have about four.
- **A $500 account cannot size it on a standard account.** In the last twelve months the stop
  was $7 to $123 an ounce, $22 in the middle. The usual minimum trade (0.01 lot = 1 oz) then
  risks about 4% of $500 per trade and up to 18% with four open — a normal losing run ends
  the account. At 0.25% a trade is a few hundredths of an ounce, which needs a micro or cent
  account. The Telegram message gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # indicators, trend readings, entries, backtest, settlement, send rules
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
