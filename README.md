# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system on **30-minute candles**. It follows gold's trend
with eleven entry types; every trade has a **stop loss, a take-profit and a trailing stop**. The scanner looks at the chart every 15 minutes; when an entry fires on a candle
close it is sent to Telegram. The user reviews each signal and executes manually — the system
never places trades.

Expect about two signals a day, with **several positions open at the same time and all
pointing the same way**, and about 3 winners in 10 trades. Read
[the backtest results](#backtesting) before trusting it.

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
| Daily trend | the last closed daily close is on the same side of its 20-day **and** its 50-day average — above both: buys only, below both: sells only, otherwise nothing |
| Chart trend | price is on that same side of its own 400-candle average (EMA) — no buying under it, no selling above it |

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
| Stop loss | 3 ATR from the entry — this distance is 1R |
| Trailing stop | 6 ATR (the ATR at entry, a fixed distance) behind the best price — the broker's own trailing stop can run it |
| Take profit | 8 × the risk (8R, `TREND_TARGET_R`) — the trailing stop usually closes the trade first |
| Time limit | closed at market after 360 candles of trading time (7.5 trading days) |
| Positions | entries that fire on the **same candle are one trade** (same entry, stop and target) and one signal; an entry type holds one position; positions opened on different candles may run side by side — **always on one side**: no buy is sent while a sell is still open, and no sell while a buy is |
| Costs | a trade is refused when spread + slippage exceed 10% of its risk |
| Size | 0.1% of the account per trade (`TREND_RISK_PCT`) |

### Why these rules

The approach comes from a test on fifteen years of gold on 4-hour candles, chosen on the
first ten years (2011–2021) and checked on the last five:

- **Fixed targets earned nothing** in the ten design years, for every entry tried. With a
  trailing stop the same entries were all positive: losses are cut short and the occasional
  trend pays several R.
- **Mean reversion lost**: buying RSI dips, fading Bollinger bands and holding through the
  Asian session were all negative after costs.
- Of 52 big swings in the design years, 49 were traded. The three missed all ran against the
  daily trend. Entries are late by design: typically after about half the move.

The numbers for the 30-minute chart come from a search over 1,536 parameter sets (daily-trend
lengths, ADX cap, stop, trailing distance, the 400-candle filter, time limit, and which
entries to keep), again chosen on 2011–2021 only:

- **The trailing stop was the setting that mattered.** At 3 ATR it was far too tight for this
  chart — flat over the ten design years — and each step wider did better (2 → −203R,
  3 → 0R, 4 → +111R, 6 → +290R, 9 → +333R, 12 → +421R, other settings unchanged). Wider also
  means fewer trades; 6 ATR is the widest that keeps about three a day.
- **The 400-candle average helped; the ADX cap did not.** The cap that improved the 4-hour
  version made no difference here and is off.
- **The take-profit has to be far away.** With the trailing stop still running, a full
  take-profit was tested from 1R to 20R on the design years: 1R −384R, 2R −204R, 3R +40R,
  4R +130R, 6R +314R, **8R +457R**, 12R +423R, none +398R. A near target cuts off the winners
  that pay for everything; 8R banks an exceptional run and is otherwise out of the way.
  Taking half off at a first target was worse at every level tried.
- **The stop stays at 3 ATR.** Stops placed just beyond the swing of the last 5, 10, 20 or 40
  candles were all worse in the design years (−70R, +197R, +278R, +303R against +398R).
- Systems were only accepted if they were still positive with costs doubled and in at least 7
  of the 10 design years. 1,534 of 4,006 passed; **only one of them trades three times a day**
  — this one. The most consistent ones trade about twice a day with a 9–12 ATR trailing stop.

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
- Entries that fire on the same candle are sent as **one signal** naming all of them — they
  share the entry price, the stop and the target, so they are one trade, not several.
- An entry type that already has a position open does not send again until that position has
  been stopped out.
- A signal against the positions that are open is never sent. When the daily trend turns, the
  open positions have to be stopped out before the system trades the other way. (In fifteen
  years this held back 15 trades out of 12,332.)
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
a candle the stop is tested first, then the take-profit, then the stop trails. Candles are cached
in `.cache/` (the first run of a day downloads fifteen years of M15 history). The `/backtests`
page shows stored runs and its **Quick run** button backtests the last ~5 months on the server.

XAU/USD on M30, 15 years to 2026-11-20:

| Period | Trades | Result |
| --- | --- | --- |
| 2011-11 → 2021-11 (the years the settings were chosen on) | 5,373 | +101R |
| 2021-11 → 2023-11 | 1,155 | +86R |
| 2023-11 → 2026-11 | 1,663 | +708R |
| **All 15 years** | **8,191 (2.1 a day)** | **+896R** |

31% of trades win. 11 of the 15 years were positive (the losing ones: −69R, −24R, −93R,
−26R). With costs doubled the total is +511R, all of it from 2023–2026.

These figures count each trade once. Earlier versions booked every entry of a candle as its
own trade — up to seven identical trades for one move — which made the record look larger
(12,381 trades, +1,562R) without being a different system.

**Read this before trusting it.**

- **The evidence is modest.** The ten design years made +101R on 5,373 trades — close to
  flat — and the settings were picked from thousands of candidates, in a search that still
  counted identical trades separately. Most of the profit is still in 2023–2026, when gold rallied.
  Expect live results to be weaker.
- **Large drawdowns.** The worst was 210R (381R with costs doubled), and single years had
  drawdowns of 60–140R. At 0.1% risk per trade that is about 21% of the account; at 1%
  the account would not have survived.
- **Long losing runs.** Seven trades in ten lose. The profit comes from a minority of large
  winners, so weeks of small losses are normal.
- **Positions overlap and point the same way.** Up to ten are open at once and are stopped
  together when the trend turns.

The same rules **with the earlier settings** (50/100-day trend, ADX below 27, 3-ATR trailing
stop) on other charts, same fifteen years:

| Chart | Trades a day | 2011–2021 | 2021–2023 | 2023–2026 | Costs doubled, 15 years | Worst drawdown |
| --- | --- | --- | --- | --- | --- | --- |
| 4-hour | 0.6 | +274R | +7R | +271R | +516R | 60R |
| 1-hour | 2.1 | +265R | +55R | +536R | +590R | 180R |
| 30-minute | 4.0 | +16R | −127R | +730R | −67R | 272R |
| 15-minute | 6.4 | −785R | −298R | +706R | −1,751R | 1,178R |

The slower the chart, the more reliable the result; the 30-minute chart was chosen for the
number of trades, and the search above is what made it hold up at all.

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
