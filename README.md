# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system. It trades **with the trend**, on the 1-hour chart,
and has two entries:

| Entry | In one line |
| --- | --- |
| **Breakout** | the first 1-hour close beyond the high/low of the last 240 candles, in a confirmed trend |
| **RSI pullback** | RSI comes back through 50 after a dip against a confirmed trend |

The scanner reads the chart every 15 minutes; when a 1-hour candle completes an entry, the
trade — entry, stop loss, take profit and trailing stop — is sent to Telegram. The user reviews
each signal and executes manually — the system never places trades.

Expect about **three signals a month**, one trade open at a time. One trade in three wins; the
system lives on a few large winners. Read [the backtest results](#backtesting) before trusting
it.

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
| 1-hour | the entries: moving averages, ADX, ±DI, RSI, the 240-candle channel |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, and the candles every open trade is followed on |

A higher-timeframe candle is only read once it has closed.

## The trend entries

All of it is in `lib/analysis/trend.ts`, shared by the scanner, the backtest and the chart.
These are the textbook trend-trading tools — moving averages, ADX with +DI/−DI, RSI, breakouts
and retracements — with every number tested on gold.

**Four conditions, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily trend | close of the last day on one side of its 50-day average |
| 2 | Moving averages | the 1-hour 50 EMA on the same side of the 200 EMA |
| 3 | Directional movement | +DI above −DI for buys, below for sells (14 periods) |
| 4 | Trend strength | the 1-hour ADX at 25 or more |
| 5 | Entry | **breakout**: the first 1-hour close beyond the high/low of the previous 240 candles (ten trading days) — or **RSI pullback**: the 14-period RSI closing back above 50 (buys) / below 50 (sells) after being on the other side |

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 1-hour candle |
| Stop loss | 2.5 × the 1-hour ATR from the entry — this distance is 1R |
| Trailing stop | 6 × ATR (the ATR at entry, a fixed distance) behind the best price. It passes the stop loss once price has moved 3.5 ATR in favour, and it closes most winners |
| Take profit | 8 × the risk — only an exceptional run gets there |
| Positions | one trade at a time — so never a buy and a sell together |
| Refused when | spread + slippage exceed 10% of the risk |
| Size | 1% of the account (`RISK_PCT`, `ACCOUNT_BALANCE`, default $500) |

### Where the rules come from

Trend-trading guides list five strategies (breakout, retracement, range, news, price action) and
three indicators (moving averages, ADX, RSI). None of them shows numbers. So each was written
as a rule and run on fifteen years of gold, chosen on 2011–2021 only, with costs doubled:

- **21,504 rule sets** — every combination of trend filter (moving-average order, ADX 20/25,
  ±DI, daily average), entry (20- to 240-candle breakout, RSI pullback at 30/40/50, pullback to
  an EMA, EMA cross, DI cross) and exit, on four charts.
- **The slower the chart, the better.** Share of rule sets that made money in 2011–2021 with
  costs doubled: 15-minute 14%, 30-minute 25%, 1-hour 51%, 4-hour 74%. On 15-minute candles
  only the 240-candle breakout was profitable in even half of its variations.
- **Fixed targets lose, a wide trailing stop works.** A 2R target was profitable in 18% of rule
  sets, 3R in 26%, a 3-ATR trailing stop in 33%, a 6-ATR trailing stop in 57%.
- **Long breakouts and the RSI-50 pullback were the entries that held up.** Short breakouts,
  the EMA cross and the DI cross did not.
- **Range trading earned nothing.** Buying RSI 30 and selling RSI 70 while ADX is low: 288 rule
  sets, flat on every chart. It is not in the system. News trading cannot be tested on price
  data and is not in it either.
- **On the 1-hour chart the result is a plateau, not a lucky setting.** A second pass of 64,512
  variations (EMA pairs, ADX 0–30, daily average 20–100 days, stop 2–3 ATR, trailing stop 4–10
  ATR): 88% were profitable in 2011–2021 with costs doubled, and 97% of all of them were
  profitable in 2021–2026. The live settings sit in the middle. They were among the better
  ones in the design years, so expect the plateau's average — roughly half the backtest — not
  the backtest itself.

### What was removed

A Fibonacci retracement entry on the 15-minute chart ran alongside these until 23 November
2026. On the same fifteen years it made +43R on 361 trades against the trend entries' +175R on
504, and of 23,520 Fibonacci rule sets 80% lost in the design years. The 30-minute trend system
and the pattern strategies before it are gone too. Their signals stay in the feed, marked as
removed.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trades on 15-minute
  candles (and moves the trailing stops), then reads the last closed 1-hour candle. Three scans
  in four see a candle that has already been read and send nothing new.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- One trade at a time; a signal candle that has been traded once is not traded again.
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

The backtest uses the scanner's own detection: a signal on a closed candle fills at the next
15-minute candle's open, the full spread + slippage ($0.35 per ounce) is charged once, and the
open trade is followed on 15-minute candles — stop first, then the target, then the trailing
stop moves. Candles are cached in `.cache/` (the first run of a day downloads fifteen years of
history). The `/backtests` page shows stored runs and its **Quick run** button backtests the
last six months on the server.

XAU/USD, 15 years to 2026-11-24, in R (1R = the risk of one trade):

| | Trades | Win rate | Total | Worst drawdown |
| --- | --- | --- | --- | --- |
| **All 15 years** | **504 (3 a month)** | **33%** | **+174.5R** | **15.7R** |
| …with costs doubled | 504 | 32% | +156.4R | 17.4R |
| 2011–2021 (rules chosen) | 331 | 31% | +118.2R | 12.3R |
| 2021–2026 (left alone) | 173 | 36% | +56.3R | 15.7R |
| Breakout entry | 267 | 33% | +62.6R | 17.2R |
| RSI pullback entry | 237 | 32% | +111.9R | 10.4R |

Thirteen of the 15 years were positive; the two losing years were −6.3R (November 2016 to
November 2017) and −2.6R (November 2021 to November 2022), and three more made under 5R. 264
trades ended at the first stop, 214 at the trailing stop and 26 at the take-profit.

**Read this before trusting it.**

- **It is a backtest of rules chosen with hindsight.** The settings were picked among the
  better ones of the design years. The honest expectation is the average of their neighbours —
  about half of the figures above — and a live year can be negative.
- **Two losses for every win.** The system loses 67% of the time; the longest losing run
  was 12 trades. The profit is a minority of trades that run for several R, and missing those
  few — by skipping signals or closing early — removes the edge. The ten best trades made
  80R of the 175R.
- **2021–2023 made nothing** (+2.7R on 77 trades, with a 15.7R drawdown). Two flat years
  in a row have happened and will happen again.
- **Buys did better than sells** (+117R against +57R, and the sells' worst drawdown was 26R).
  Gold rose for most of these years.
- **Stops are wide for a small account.** In the last twelve months a trade's stop was $28 to
  $215 an ounce, $51 in the middle. With the usual minimum trade (0.01 lot = 1 oz) one trade
  risks about 10% of a $500 account — a losing run of 12 would end it. Sized at 1% (a few
  hundredths of an ounce, which needs a micro or cent account) the system made +23.6R,
  $500 → about $627, in the last twelve months. The Telegram message gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # indicators, trend rules, entries, backtest, settlement, send rules
```

## Routes

- `/` — dashboard: the 15-minute chart with the level the breakout entry waits on, the open trade (with its trailing stop) and past results; the Trend panel shows each condition and what is missing. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
