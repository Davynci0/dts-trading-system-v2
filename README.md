# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system. It trades **with the trend** and has three entries:

| Entry | Chart | In one line |
| --- | --- | --- |
| **Trend — breakout** | 1-hour | the first close beyond the high/low of the last 240 candles, in a confirmed trend |
| **Trend — RSI pullback** | 1-hour | RSI comes back through 50 after a dip against a confirmed trend |
| **Fibonacci retracement** | 15-minute | a rejection candle in the 38.2%–61.8% zone of a 1-hour swing |

The scanner reads the chart every 15 minutes; when a candle completes a setup, the trade —
entry, stop loss and take profit — is sent to Telegram. The user reviews each signal and
executes manually — the system never places trades.

Expect about **one signal a week**: roughly three trend trades and two Fibonacci trades a
month, at most one of each open at a time and never a buy and a sell together. About four
trades in ten win; the trend trades win one time in three and live on a few large winners.
Read [the backtest results](#backtesting) before trusting it.

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
| Daily | the trend for every entry: last closed day above its 50-day average → buys only; below → sells only |
| 4-hour | Fibonacci only: the trend must agree (price above a rising 50 EMA for buys, below a falling one for sells) |
| 1-hour | the trend entries (moving averages, ADX, ±DI, RSI, the 240-candle channel) and the swing the Fibonacci retracement is measured on |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the Fibonacci entry candle, the settlement of every open trade |

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
| Positions | one trend trade at a time |
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

## The Fibonacci retracement

All of it is in `lib/analysis/fibonacci.ts`.

**Five conditions, in order:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily trend | close of the last day on one side of its 50-day average |
| 2 | 4-hour trend | agrees with the daily trend (price and slope of the 50 EMA) |
| 3 | 1-hour swing | a leg in the trend's direction, 8 to 80 ATR long. A swing point only counts once price has turned 5 ATR away from it, so the leg is an impulse, not noise. The leg is finished once price trades through its start or beyond its end |
| 4 | Pullback | a 15-minute candle trades into the **38.2%–61.8%** retracement zone and does not close through its deep edge |
| 5 | Rejection | that candle is an engulfing candle (closes beyond the previous candle's far side) or a pin bar (a wick at least twice the body) |

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the rejection candle |
| Stop loss | beyond the start of the swing (the 100% level) by a quarter of a 1-hour ATR |
| Take profit | the **161.8% extension** of the swing — about 1.7 × the risk on average |
| Time limit | closed at market after 480 fifteen-minute candles (five trading days) |
| Positions | one trade per swing, one Fibonacci trade at a time |
| Refused when | the target is closer than the stop, the stop is inside 1.5 fifteen-minute ATR, or spread + slippage exceed 10% of the risk |

It needs a completed swing and a pullback, so a move that runs without one — gold fell 9% in the
week of 16 November 2026 without a 5-ATR bounce — gives it nothing. The trend entries are there
for those moves.

Of 23,520 Fibonacci rule sets tested the same way, 80% lost in 2011–2021; large swings with both
trends were the only consistently positive corner, and the live rules sit in the middle of it.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trades on 15-minute
  candles (and moves the trailing stops), then reads the last closed 15-minute candle for the
  Fibonacci entry and the last closed 1-hour candle for the trend entries.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- Each of the two strategies holds one trade at a time; a swing or a signal candle that has been
  traded once is not traded again.
- **Never a buy and a sell at the same time**: a signal against an open trade of the other
  strategy is not sent. (In fifteen years this would have held back 17 of 865 trades.)
- Trades left open by the 30-minute trend system that was removed are still followed to their
  stop; they do not block new signals.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

```bash
npx tsx --env-file=.env.local scripts/backtest.ts            # 15 years, the system and each strategy, year by year
npx tsx --env-file=.env.local scripts/backtest.ts --save     # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=3  # a shorter window
```

The backtest uses the scanner's own detection: a signal on a closed candle fills at the next
15-minute candle's open, the full spread + slippage ($0.35 per ounce) is charged once, and the
open trade is followed on 15-minute candles — stop first, then the target, then the trailing
stop moves. Candles are cached in `.cache/` (the first run of a day downloads fifteen years of
history). The `/backtests` page shows stored runs and its **Quick run** button backtests the
last six months on the server.

XAU/USD, 15 years to 2026-11-23, in R (1R = the risk of one trade):

| | Trades | Win rate | 2011–2021 (rules chosen) | 2021–2026 | All 15 years | Costs doubled | Worst drawdown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Trend entries | 504 (3 a month) | 33% | +118.2R | +56.9R | +175.1R | +157.0R | 15.7R |
| Fibonacci retracement | 361 (2 a month) | 48% | +16.5R | +26.7R | +43.2R | +38.3R | 10.5R |
| **The system** | **865 (1.1 a week)** | **39%** | **+134.6R** | **+83.7R** | **+218.3R** | **+195.3R** | **17.3R** |

Every one of the 15 years was positive for the system (the weakest: +1.0R, +3.0R, +4.4R,
+4.4R). Of the trend trades, 263 ended at the first stop, 214 at the trailing stop and 26 at
the take-profit; the breakout made +63R and the RSI pullback +112R.

**Read this before trusting it.**

- **It is a backtest of rules chosen with hindsight.** The settings were picked among the
  better ones of the design years. The honest expectation is the average of their neighbours —
  about half of the figures above — and a live year can be negative.
- **Two losses for every win.** The trend entries lose 67% of the time; the longest losing run
  was 12 trades. The profit is a minority of trades that run for several R, and missing those
  few — by skipping signals or closing early — removes the edge. The ten best trend trades
  made 80R of the 175R.
- **2021–2023 made nothing** (+2.7R on 77 trend trades, with a 15.7R drawdown). Two flat years
  in a row have happened and will happen again.
- **Buys did better than sells** (+158R against +61R). Gold rose for most of these years.
- **Stops are wide for a small account.** In the last twelve months a trend trade's stop was
  $28 to $215 an ounce, $51 in the middle; a Fibonacci trade's $50 to $757, $125 in the middle.
  With the usual minimum trade (0.01 lot = 1 oz) one trend trade risks about 10% of a $500
  account — a losing run of 12 would end it. Sized at 1% (a few hundredths of an ounce, which
  needs a micro or cent account) the trend entries made about +24R, $500 → about $630, in the
  last twelve months. The Telegram message gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # indicators, trend rules, entries, backtest, settlement, send rules
npx tsx --tsconfig tsconfig.json scripts/verify-fib.ts     # trends, swing, zone, entry candle, levels, refusals, backtest, settlement
```

## Routes

- `/` — dashboard: the 15-minute chart with the 1-hour swing, its retracement levels, the entry zone, the level the breakout entry waits on, the open trades (with the trailing stop) and past results; the Trend and Fibonacci panels show each strategy's conditions. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
