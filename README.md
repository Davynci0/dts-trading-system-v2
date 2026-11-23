# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system built on one strategy: **Fibonacci retracement**,
entered on **15-minute candles** and confirmed on three higher timeframes. The scanner reads
the chart every 15 minutes; when a 15-minute candle completes a setup, the trade — entry, stop
loss and take profit — is sent to Telegram. The user reviews each signal and executes
manually — the system never places trades.

Expect about **two signals a month**, one trade open at a time, about half of them winning.
Read [the backtest results](#backtesting) before trusting it: the edge is small and most of it
comes from buying pullbacks while gold was rising.

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
| 4-hour | the trend must agree: price above a rising 50 EMA for buys, below a falling one for sells |
| 1-hour | the swing the retracement is measured on |
| 15-minute (`EXECUTION_TIMEFRAME`) | the chart, the entry candle, the settlement of open trades |

A higher-timeframe candle is only read once it has closed.

## The Fibonacci system

All of it is in `lib/analysis/fibonacci.ts`, shared by the scanner, the backtest and the chart.

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
| Positions | one trade per swing, one trade at a time |
| Refused when | the target is closer than the stop, the stop is inside 1.5 fifteen-minute ATR, or spread + slippage exceed 10% of the risk |
| Size | 1% of the account (`FIB_RISK_PCT`, `ACCOUNT_BALANCE`, default $500) |

The stop and the target follow the market's own structure, so their distance changes from
trade to trade. In the last twelve months the stop was between $50 and $757 per ounce, $125 in
the middle — at the usual minimum trade (0.01 lot = 1 oz) that is far more than 1% of a small
account, and the Telegram message says so.

### Where the rules come from

How traders describe using the tool (broker education pages and trading communities): take the
trend from a higher timeframe, draw the retracement on a clear recent swing, wait for price to
reach the 38.2–61.8% area, enter only on a confirming candle, stop beyond the swing, target the
previous extreme or the 127.2% / 161.8% extension. None of those sources shows that it is
profitable, and the few independent tests found online say the levels do no better than chance.

So every choice was tested on fifteen years of gold, picked on 2011–2021 only, with costs doubled:

- **Most versions lose.** Of 23,520 rule sets (trend filter, swing size, zone, entry candle,
  stop, target, session), 80% lost money in 2011–2021 and none stood out statistically.
- **Small swings and tight stops lose most.** Swings confirmed by a 2–3 ATR turn, stops behind
  the entry candle or the 78.6% level, and entries without the trend were all negative on
  average. Measuring the swing on the 15-minute chart itself was worse than on the 1-hour chart.
- **Large swings with both trends were the only consistently positive corner**: 72% of the
  4,800 rule sets there were positive in 2011–2021. The live rules sit in the middle of that
  corner; their neighbours (zone 50–61.8%, engulfing only, a 3R target, a 4- or 6-ATR swing) give
  similar results.
- **The five-day time limit matters.** Without it the result drops by a third.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trades on 15-minute
  candles, then reads the last closed 15-minute candle.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- No signal is sent while a Fibonacci trade is open, and a swing that has been traded once is
  not traded again.
- Trades left open by the trend system that this strategy replaced are still followed to their
  stop; they do not block new signals.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

```bash
npx tsx --env-file=.env.local scripts/backtest.ts            # 15 years, printed year by year
npx tsx --env-file=.env.local scripts/backtest.ts --save     # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=3  # a shorter window
```

The backtest uses the scanner's own detection: a signal on a closed 15-minute candle fills at
the next candle's open, the full spread + slippage ($0.35 per ounce) is charged once, and
within a candle the stop is tested before the target. Candles are cached in `.cache/` (the
first run of a day downloads fifteen years of history). The `/backtests` page shows stored
runs and its **Quick run** button backtests the last six months on the server.

XAU/USD, 15 years to 2026-11-23:

| Period | Trades | Win rate | Result | Worst drawdown |
| --- | --- | --- | --- | --- |
| 2011-11 → 2021-11 (the years the rules were chosen on) | 244 | 46% | +16.5R | 10.5R |
| 2021-11 → 2026-11 | 117 | 52% | +26.7R | 5.1R |
| **All 15 years** | **361 (about 2 a month)** | **48%** | **+43.2R** | **10.5R** |

With costs doubled the total is +38.3R. 11 of the 15 years were positive (the losing ones:
−6.2R, −0.3R, −0.6R, −4.2R). 63 trades reached the target, 106 the stop and 192 the five-day
time limit. The longest losing run was 6 trades.

**Read this before trusting it.**

- **The edge is small.** About +3R a year. Ten years of design data made +16.5R, which is not
  distinguishable from luck, and the rules were the best corner of tens of thousands tried.
- **Almost all of it is buying.** Buys made +40.3R, sells +2.9R. Gold rose for most of these
  years; in a long falling market the system has shown nothing.
- **Few trades.** Two a month means months without a signal and a year decided by a handful
  of trades.
- **Wide stops.** The stop sits beyond a multi-day swing — $125 an ounce in the middle of the
  last year. With a 1-ounce minimum that is 25% of a $500 account on one trade; sized at 1%
  (a few hundredths of an ounce, which needs a micro or cent account) the last twelve months made about $43.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-fib.ts   # trends, swing, zone, entry candle, levels, refusals, backtest, settlement
```

## Routes

- `/` — dashboard: the 15-minute chart with the 1-hour swing, its retracement levels, the entry zone, the open trade and past results; the Fibonacci panel shows the five conditions and the levels. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
