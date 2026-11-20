# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system on **30-minute candles**. It follows gold's trend
with eleven entry types and manages every trade with a **trailing stop** — there is no
take-profit. The scanner looks at the chart every 15 minutes; when an entry fires on a candle
close it is sent to Telegram. The user reviews each signal and executes manually — the system
never places trades.

Expect about four signals a day, each held for a few hours, with **several positions open at
the same time and all pointing the same way**. **Read [the backtest results](#backtesting)
before trusting it: on 30-minute candles this system only made money in the last three years.**

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

| Role | Timeframe | Used for |
| --- | --- | --- |
| Execution | M30 (`EXECUTION_TIMEFRAME`) | the chart, every entry, the ATR for stops |
| Higher timeframe | Daily (`EXECUTION_HTF`) | the 50-day and 100-day trend, yesterday's high/low |

A signal is entered at the **close** of the 30-minute candle that produced it (on the hour and
the half hour). The chart timeframe is one setting — three lines in
`lib/analysis/execution.ts` and `TRADE_TIMEFRAMES` in `lib/types.ts` — and the same rules can
be run on any of them (see the comparison under Backtesting).

## The trend system

All of it is in `lib/analysis/trend.ts`, shared by the scanner, the backtest and the chart.

**Two filters decide whether anything may be traded on a candle:**

| Filter | Rule |
| --- | --- |
| Daily trend | the last closed daily close is on the same side of its 50-day **and** its 100-day average — above both: buys only, below both: sells only, otherwise nothing |
| Not stretched | the chart's ADX is below 27 — the system does not join a move that has already run |

**Eleven entries, each on the close of a candle, in the trend's direction:**

| Entry | Fires when |
| --- | --- |
| 20-, 30-, 60-, 120-, 240-candle breakout | the candle is the first to close beyond the high/low of the last 20 / 30 / 60 / 120 / 240 candles |
| Pullback to the 20 EMA, to the 50 EMA | price dips to the EMA and the candle closes back beyond it, in its own direction |
| 20/50 EMA cross | the 20 EMA crosses the 50 EMA |
| Previous-day break | the candle closes beyond yesterday's high/low |
| Momentum candle | the candle closes more than 1 ATR beyond the previous close |
| Inside-bar breakout | the candle closes beyond the candle that contained an inside bar |

**One way of managing every trade:**

| | Rule |
| --- | --- |
| Stop | 3 ATR from the entry |
| Exit | a trailing stop 3 ATR (the ATR at entry, a fixed distance) behind the best price — the broker's own trailing stop can run it |
| Target | none |
| Time limit | closed at market after 360 candles of trading time (7.5 trading days) |
| Positions | one per entry type; different entry types may be open side by side (up to eleven) |
| Costs | a trade is refused when spread + slippage exceed 10% of its risk |
| Size | 0.1% of the account per trade (`TREND_RISK_PCT`) |

### Why these rules

They come from a test on fifteen years of gold **on 4-hour candles**, in which everything was
chosen on the first ten years (2011–2021) and then checked on the last five:

- **Fixed targets earned nothing** in the ten design years, for every entry tried. With a
  trailing stop the same entries were all positive: losses are cut at about −0.6R on average
  and the occasional trend pays several R.
- **Mean reversion lost**: buying RSI dips, fading Bollinger bands and holding through the
  Asian session were all negative after costs.
- **Trades against the 100-day trend** made nothing in the design years and lost afterwards —
  hence the requirement that both trends agree.
- **Trades that joined a stretched move** (ADX above 27) lost in the design years and were
  the weakest group afterwards — hence the ADX cap, which roughly doubled the quality.
- Of 52 big swings in the design years, 49 were traded. The three missed all ran against the
  daily trend. Entries are late by design: typically after about half the move.

### The pattern strategies

Supply/demand zones, set & forget, Fibonacci, the support/resistance retest and the 30-candle
range are still scanned, drawn on the chart (layers off by default) and shown under "Pattern
setups" — as context. They do not send: with fixed targets they made about nothing before
2023. `SIGNAL_STRATEGIES=zones,…` switches any of them back on.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Candles close on the hour and the half hour, so every
  second scan can find a new entry; every scan also follows the open trades' trailing stops on
  M15 candles and records where each stop stands.
- A signal is only sent within 20 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — does not send a trade at a price that
  is no longer there.
- An entry type that already has a position open does not send again until that position has
  been stopped out.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

```bash
npx tsx --env-file=.env.local scripts/backtest.ts            # 15 years, printed year by year and by entry type
npx tsx --env-file=.env.local scripts/backtest.ts --save     # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=3  # a shorter window
```

The backtest uses the scanner's own detection: a signal on a closed candle fills at the next
candle's open plus the full spread + slippage, each entry type holds one position, and within
a candle the stop is tested before that candle's own extreme may move it. Candles are cached
in `.cache/` (the first run of a day downloads fifteen years of M15 history). The `/backtests`
page shows stored runs and its **Quick run** button backtests the last ~5 months on the server.

XAU/USD on M30, 15 years to 2026-11-20:

| Period | Trades | Result |
| --- | --- | --- |
| 2011-11 → 2021-11 | 9,730 | +16R |
| 2021-11 → 2023-11 | 2,271 | −127R |
| 2023-11 → 2026-11 | 3,442 | +730R |
| **All 15 years** | **15,443 (3.9 a day)** | **+619R** |

38% of trades win and a trade typically lasts about 8 hours.

**Read this before trusting it.**

- **All the profit is in the last three years.** Over the twelve years before November 2023
  this version lost 111R on about 12,000 trades; 8 of the 15 years were positive. It made
  money while gold rallied and nothing before.
- **It does not survive higher costs.** With spread and slippage doubled the 15-year total is
  −67R. Thirty-minute stops are small, so the spread is a real share of every trade.
- **Very large drawdowns.** The worst was 272R (and 794R with costs doubled). At 0.1% risk per
  trade that is about 27% of the account; at 1% the account would not have survived.
- **Positions overlap and point the same way.** Up to eleven are open at once and are stopped
  together when the trend turns.
- **It is a backtest, found by searching.** Around a hundred variants were tried on the way
  here; expect live results to be weaker.

The same rules on other charts, same fifteen years:

| Chart | Trades a day | 2011–2021 | 2021–2023 | 2023–2026 | Costs doubled, 15 years | Worst drawdown |
| --- | --- | --- | --- | --- | --- | --- |
| 4-hour | 0.6 | +274R | +7R | +271R | +516R | 60R |
| 1-hour | 2.1 | +265R | +55R | +536R | +590R | 180R |
| **30-minute (live)** | 4.0 | +16R | −127R | +730R | −67R | 272R |
| 15-minute | 6.4 | −785R | −298R | +706R | −1,751R | 1,178R |

The slower the chart, the more reliable the result. The 4-hour version is the one the rules
were chosen on and the only one that barely moves when costs double; the 30-minute chart was
chosen for the number of trades, not for its record.

`scripts/research-strategies.ts` is an M15 lab for intraday ideas from an earlier version.

## Verification

```bash
npx tsx scripts/verify-trend.ts    # trend filters, entries, trailing stop, settlement, backtest
npx tsx scripts/verify-engine.ts   # pattern detection, scoring, send gate
npx tsx scripts/verify-risk.ts     # stops, targets, sizing, cost cap
```

## Routes

- `/` — dashboard: M30 chart with the 20 and 50 EMA, the levels the breakout entries wait on, open positions with their trailing stops, key levels and past results; the Trend system panel shows the three filters and what each entry is waiting for. `/?asOf=2026-11-19T06:30Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same engine the scanner uses (`&to=<ISO time>` for a past moment)
- `/api/scan` — run the engine (GET = scheduled, POST = dashboard)
- `/api/signals`, `/api/setups` — live feed + pattern-setup state
- `/api/risk/preview` — stop / target / sizing check from live structure
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai`, `/api/vision/validate` — vision model chart read and rendering QA
- `/api/telegram/test` — POST a wiring-test message
