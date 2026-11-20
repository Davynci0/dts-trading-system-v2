# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system on **4-hour candles**. Five strategies send
signals: the **trend breakout**, the **support/resistance retest** and three **trend
pullbacks** — supply/demand zones, Alex G "set & forget" AOIs and the Fibonacci golden zone.
All five trade with the daily trend only. Telegram is the single alert channel. The user
reviews each signal and executes manually — the system never places trades.

Expect about two signals a month, each held for days to weeks. **Read
[the backtest results](#backtesting) before trusting it:** over fifteen years almost all the
profit came from the last three.

**Stack:** Next.js (App Router, single deployable on Vercel) · OANDA v20 (data) ·
Supabase (auth + persistence) · Telegram Bot API (alerts) · OpenRouter vision model (a note on
each signal; it can only reject when `VISION_CAN_VETO=true`).

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
| Execution | H4 (`EXECUTION_TIMEFRAME`) | the chart, every setup, entries, the ATR for stops |
| Higher timeframe | Daily (`EXECUTION_HTF`) | the daily trend, support/resistance levels |
| Context | Weekly | a weekly structure that opposes a trade vetoes it |

A signal is entered at the **close** of the H4 candle that produced it. OANDA's H4 candles
close at 02:00, 06:00, 10:00, 14:00, 18:00 and 22:00 UTC (an hour earlier during US summer
time). All of it is set in `lib/analysis/execution.ts`.

## The trend breakout

Gold tends to keep going when it breaks a level in the direction of its daily trend. The
strategy (`lib/analysis/breakout.ts`) enters on the H4 candle that first **closes** beyond the
one-week channel:

| | Rule |
| --- | --- |
| Level | highest high / lowest low of the previous 30 H4 bars (five trading days) |
| Daily trend | last closed daily close above the average of the last 50 → upside breaks only; below → downside only |
| Stop | 3 ATR from the close |
| Target | 2 × the risk (`BREAKOUT_TARGET_R`) |

The rule was positive on fifteen years for every channel length tried (30 to 480 bars), which
is why the plain one-week channel is used rather than the best-scoring one. A small target
wins often and earns nothing, so the target stays at 2R.

## The trend pullbacks and the retest

Zones, set & forget and Fibonacci each find their own setup (a return to a supply/demand zone,
the first touch of a 50–61.8% area of interest, price inside the 61.8–78.6% golden zone), and
the retest strategy finds old resistance holding as support (or the reverse). A setup becomes
a trade under one shared rule (`lib/analysis/pullback.ts`):

| | Rule | Override |
| --- | --- | --- |
| Daily trend | last closed daily close above the average of the last 100 → buys only; below → sells only | — |
| Weekly structure | must not oppose the trade | — |
| Stop | 3 ATR from the entry | `PULLBACK_STOP_ATR` |
| Target | 3 × the risk | `PULLBACK_TARGET_R` |
| Costs | spread + slippage ≤ 10% of the risk | `MAX_COST_SHARE` |

Each setup is traded once, on the first candle where the rule holds. The checklist on the
tracker (rejection candle, RSI turn, confluence, …) is context for the trader; it is not a
gate — requiring more of it made every strategy worse in testing.

Every H4 close is tradeable. Limiting entries to London/New York hours was tested and was
worse; `TRADING_HOURS_UTC="7-20"` restores it.

## Support and resistance

`lib/analysis/levels.ts` finds the prices gold has turned at more than once: daily swing highs
and lows within half an ATR of each other form a level, counted by separate visits. A level
that has been both a ceiling and a floor is **flipped**. The chart draws the three nearest
levels on each side of price (flipped ones solid). A signal with a flipped level just behind
its entry is **grade A**, the rest grade B — a label, not a filter.

## One trade at a time

Only one trade is open at a time. When several setups are ready on the same candle the
breakout goes first, then set & forget, zones, the retest and Fibonacci; others in the same
direction are recorded as confluence. `SIGNAL_STRATEGIES` (default: all five) decides which
strategies may send — one left out is still scanned and shown on the tracker.

A trade that has reached neither its stop nor its target after six weeks is closed as expired.

## Scanning

- A scheduler (cron-job.org) calls `/api/scan` every 15 minutes with
  `Authorization: Bearer $CRON_SECRET`. Only the first scan after an H4 close can find a new
  setup; the others re-check the same candle and track open trades.
- A signal is only sent within 60 minutes of its candle's close (`MAX_ENTRY_AGE_MIN`). A scan
  that runs later — after an outage, or at the weekend — still tracks the setup but does not
  send a trade at a price that is no longer there.
- `vercel.json` keeps one daily cron as a fallback (Vercel's Hobby plan allows one run per
  day). `.github/workflows/scan.yml` is a second scheduler, currently disabled.
- The dashboard's **Scan now** button runs a scan on demand.

`/api/scan` requires the bearer secret when `CRON_SECRET` is set on the server.

## Backtesting

The backtest replays whatever is allowed to send (`SIGNAL_STRATEGIES`): the same detection and
send rules, one trade at a time, higher timeframes from closed bars only, full spread +
slippage on every trade, and a loss whenever one candle touches both stop and target.

```bash
npx tsx --env-file=.env.local scripts/backtest.ts --years=15          # the long run — judge the rules on this
npx tsx --env-file=.env.local scripts/backtest.ts --years=15 --save   # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts                     # the last 3 years
```

Settings come from the environment, so prefix any override to test it
(`BREAKOUT_TARGET_R=1 npx tsx …`). Candles are cached in `.cache/`; the first run downloads them.
The `/backtests` page shows stored runs — whole run, per year, per strategy — and its
**Quick run** button backtests the last ~3 years on the server.

Read the **t** column before the profit factor: inside ±2 an average is not distinguishable
from zero.

XAU/USD on H4, 15 years to 2026-11-20, all five strategies, one trade at a time:

| Period | Trades | Win rate | Total R |
| --- | --- | --- | --- |
| 2011-11 → 2016-11 | 139 | 32% | +8 |
| 2016-11 → 2021-11 | 125 | 33% | −4 |
| 2021-11 → 2023-11 | 55 | 33% | +4 |
| 2023-11 → 2026-11 | 64 | 59% | +58 |
| **All 15 years** | **383 (about 2 a month)** | **37%** | **+67** |

By strategy: breakout 191 trades +49R, retest 67 trades +22R, zones 27 trades +9R, Fibonacci
74 trades −5R, set & forget 24 trades −8R. Ten of the fifteen years were positive.

**Read this before trusting the system.** Almost all the profit comes from the last three
years, when gold rose from about $2,000 to over $3,500. Over the twelve years before that the
system made +8R on 319 trades, which is not distinguishable from zero (t = 0.3). The worst
drawdown was 22R, the longest losing streak 12 trades, and equity once spent about ten years
below an earlier high. This is a trend-following system: it earns in a strong gold trend and
roughly breaks even otherwise, and nothing tested here predicts which kind of year is coming.
Run it on a practice account, and if you risk money, risk a small fraction of a percent per
trade.

What H4 does give: costs stop mattering. A 3-ATR stop on H4 is tens of dollars, so spread and
slippage average 1.5% of the risk, and doubling them moves the 15-year total only from +67R to
+60R. The earlier M15 version of this system made +158R over the same fifteen years on 2,899
trades, but fell to +22R with costs doubled and had a 94R drawdown.

`scripts/research-strategies.ts` is an M15 lab for intraday ideas from the earlier version; it
tests entry rules on three years of M15 data before anything is built into the scanner.

## Verification

```bash
npx tsx scripts/verify-engine.ts   # detection, scoring, send gate, backtest
npx tsx scripts/verify-risk.ts     # stops, targets, sizing, cost cap
```

## Routes

- `/` — dashboard: H4 chart with the strategies drawn in their own colours (breakout amber, set & forget blue, zones green/red, Fibonacci violet; a setup against the trend is drawn muted), key levels, optional structure/trendlines, the open trade plan and past results; a legend says what each strategy is waiting on. `/?asOf=2026-11-19T06:00Z` shows the chart as it stood at that moment
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same engine the scanner uses (`&to=<ISO time>` for a past moment)
- `/api/scan` — run the engine (GET = scheduled, POST = dashboard)
- `/api/signals`, `/api/setups` — live feed + confirmation state
- `/api/risk/preview` — stop / target / sizing check from live structure
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai`, `/api/vision/validate` — vision model chart read and rendering QA
- `/api/telegram/test` — POST a wiring-test message
