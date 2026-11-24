# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system: a **market-structure scalp on the 15-minute chart**.
One trade at a time, a **1:3** target, every trade closed within **five hours**, about **2.5
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

**Three conditions, then an entry:**

| # | Condition | Rule |
| --- | --- | --- |
| 1 | Daily bias | close of the last day on one side of its 50-day average |
| 2 | 1-hour structure | bullish for buys, bearish for sells |
| 3 | Costs | spread + slippage at most 6% of the trade's risk |
| 4 | Entry, on a 15-minute close, with the trend | **break of structure**: price pulls back, then closes beyond the last swing — in a downtrend it comes up a little, makes a lower high and closes below the last swing low · **breakout**: the first close beyond the high/low of the last 3, 6, 12 or 24 hours · **momentum candle**: a candle at least 1.2 × ATR long that closes in the outer quarter of its range |

**The trade:**

| | Rule |
| --- | --- |
| Entry | at market, at the close of the 15-minute candle |
| Stop loss | just beyond the high of the last two candles for a sell (their low for a buy) — the small pullback the trade is leaving behind — plus 0.2 ATR. Never closer than 0.75 ATR or further than 2 ATR. The distance is 1R |
| Take profit | 3 × the risk (1:3) |
| Time limit | closed at market at the close of the 20th candle — five hours |
| Positions | **one trade at a time**; no new signal until it has closed |
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

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Each scan first settles the open trade on 15-minute
  candles, then reads the last closed 15-minute candle.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- One trade at a time: nothing is sent while a trade is open. A signal candle that has been
  traded once is not traded again.
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
| **5 years** | **1,636** | **6.3** | **42%** | **+141.3R** | **+82.0R** | **40.6R** | **12** |
| **Last 3 years** | 1,430 | 9.1 | 41% | +130.4R | +81.5R | 40.6R | 12 |

| Year from | Trades | A week | Win rate | Total |
| --- | --- | --- | --- | --- |
| Nov 2021 | 107 | 2.1 | 47% | +11.3R |
| Nov 2022 | 99 | 1.9 | 46% | −0.5R |
| Nov 2023 | 217 | 4.2 | 43% | +18.9R |
| Nov 2024 | 531 | 10.2 | 42% | +43.0R |
| Nov 2025 | 682 | 13.1 | 40% | +68.5R |

- **How trades end:** 826 at the stop, 176 at the 1:3 target, 634 at the five-hour limit (510
  of those in profit, +0.76R on average).
- **How long they last:** a quarter are over within an hour, a quarter last 1 to 3 hours, half
  last 3 to 5 hours. None is held longer than five.
- **By entry:** breakouts +77.5R (295 trades), momentum candles +43.2R (859), breaks of
  structure +20.6R (482). Buys +92.6R, sells +48.7R.
- **The last twelve months:** 682 trades — 2.6 a trading day, on 215 of about 260 trading
  days, usually three on a day that has any.

**Read this before trusting it.**

- **The edge is thin.** It averages 0.09R a trade — 0.05R with costs doubled. Six trades in
  ten lose, the longest losing run was 12, and the worst drawdown was 41 times the risk of one
  trade. Most of the profit comes from the five-hour exits, not from the 1:3 target, which is
  reached about one trade in nine.
- **It trades 2.5 times a day only while gold is this active.** The cost limit keeps it out
  when 15-minute candles are small: two trades a week in the first two years, thirteen a week
  in the last. If gold goes quiet, it will too.
- **Most of the evidence is two years old or less.** 1,213 of the 1,636 trades, and four-fifths
  of the profit, are from the last two years. Five years is a short test for a system with an
  edge this small; expect less than the table.
- **Check the spread you actually pay.** Everything above assumes $0.35 an ounce a trade. At
  twice that the five-year result falls from +141R to +82R.
- **Size.** In the last twelve months the stop was $6 to $98 an ounce, $15 in the middle. The
  usual minimum trade (0.01 lot = 1 oz) then risks about 3% of a $500 account per trade — six
  times the 0.5% the system assumes. At 0.5% a trade, $500 became $973 over the five years with
  a worst drop of 19%; at 1% it became $1,748 with a worst drop of 34%. The Telegram message
  gives the size for both.

## Verification

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-trend.ts   # swings, structure, entries, stop, backtest, settlement, send rules
```

## Routes

- `/` — dashboard: the 15-minute chart with the levels an entry has to close beyond, the level a stop would go beyond, the open trade and past results; the panel shows each condition and what is missing. `/?asOf=2026-10-27T16:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs of the live rules and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same code the scanner runs (`&to=<ISO time>` for a past moment)
- `/api/scan` — run a scan (GET = scheduled, POST = dashboard)
- `/api/signals` — the signal feed
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — a vision model's read of the chart, on request
- `/api/telegram/test` — POST a wiring-test message
