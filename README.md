# DTS — Gold Trading System

Signal-only gold (XAU/USD) trading system on M15 candles. Four strategies send signals: the
**trend breakout** and three **trend pullbacks** — supply/demand zones, Alex G "set & forget"
AOIs and the Fibonacci golden zone. All four trade with the daily trend only, and every
signal is graded by the support/resistance behind it. Telegram is the
single alert channel. The user reviews each signal and executes manually — the system never
places trades.

**Stack:** Next.js (App Router, single deployable on Vercel) · OANDA v20 (data) ·
Supabase (auth + persistence) · Telegram Bot API (alerts) · OpenRouter vision model (final
check on each signal; it can only reject).

## Setup

```bash
cp .env.local.example .env.local   # fill in OANDA / Supabase / Telegram values
npm install
npm run dev                        # http://localhost:3000
```

Run `supabase/schema.sql` in the Supabase SQL editor once to create the tables (an existing
database needs the files in `supabase/migrations/` that it has not had yet).

## The trend breakout

Gold tends to keep going when it breaks a level in the direction of its daily trend. The
strategy (`lib/analysis/breakout.ts`) enters on the M15 candle that first **closes** beyond a level:

| | Asian-range break | One-week channel break |
| --- | --- | --- |
| Level | high/low of 22:00–07:00 UTC | highest high / lowest low of the previous 480 M15 bars |
| Entry window | 07:00–11:00 UTC, first break of the day only | 07:00–20:00 UTC |
| Stop | middle of the Asian range | 3 ATR from the close |
| Target | 0.75 × the risk (`BREAKOUT_TARGET_R`) | 0.75 × the risk |

Both require the **daily trend** to agree: the last closed daily close above the average of the
last 50 means buys only, below means sells only. A trade is refused when spread + slippage
would exceed 10% of its risk (`MAX_COST_SHARE`). One trade at a time.

The modest target against a wide stop is deliberate — it is where the high win rate comes
from. `BREAKOUT_TARGET_R=0.5` wins more often for a little less profit; `1` does the opposite.

## The trend pullbacks

Zones, set & forget and Fibonacci each find their own setup (a return to a supply/demand zone,
the first touch of a 50–61.8% area of interest, price inside the 61.8–78.6% golden zone). A
setup becomes a trade under one shared rule (`lib/analysis/pullback.ts`):

| | Rule | Override |
| --- | --- | --- |
| Daily trend | last closed daily close above the average of the last 100 → buys only; below → sells only | — |
| Weekly structure | must not oppose the trade | — |
| Session | entry between 07:00 and 20:00 UTC | `TRADING_HOURS_UTC` |
| Stop | 3 ATR from the entry | `PULLBACK_STOP_ATR` |
| Target | 2 × the risk | `PULLBACK_TARGET_R` |
| Costs | spread + slippage ≤ 10% of the risk | `MAX_COST_SHARE` |

Each setup is traded once, on the first candle where the rule holds. The 6-point checklist
(rejection candle, RSI turn, confluence, …) is shown on the tracker and in the signal as
context; it is not a gate — requiring more of it made every strategy worse in testing. The AI
vision read is likewise attached as a note and only holds a signal back if `VISION_CAN_VETO=true`.

## Support and resistance

`lib/analysis/levels.ts` finds the prices gold has turned at more than once: H1 swing highs
and lows within half an ATR of each other form a level, counted by separate visits. A level
that has been both a ceiling and a floor is **flipped**. The chart draws the three nearest
levels on each side of price (flipped ones solid), and the engine uses them two ways:

- **Signal grade.** A signal with a flipped level just behind its entry (under a long, above a
  short, within one H1 ATR) is **grade A**; the rest are grade B. It is the one checklist item
  that separated better trades in testing — it grades a signal, it does not block one.
- **Retest strategy** (`sr`). Old resistance holding as support (or the reverse), with the
  daily trend, under the pullback rule. It is profitable on its own but adds nothing once
  combined with the other four — it finds the same pullbacks — so it is tracked, not sent.
  Add `sr` to `SIGNAL_STRATEGIES` to send it.

## One trade at a time

Only one trade is open at a time. When several setups are ready on the same candle the
breakout goes first, then set & forget, zones, the retest and Fibonacci; others in the same
direction are recorded as confluence. `SIGNAL_STRATEGIES` (default: breakout, set & forget,
zones, Fibonacci) decides which strategies may send — one left out is still scanned and shown
on the tracker.

## Scanning

A setup is traded on the candle where it appears, so the scan has to run after every M15
close inside the trading hours:

- `.github/workflows/scan.yml` calls `/api/scan` at :01/:16/:31/:46 from 07:00 to 20:59 UTC,
  Monday–Friday, using the `SCAN_URL` and `CRON_SECRET` repository secrets. GitHub can start
  scheduled runs late; a run more than ~14 minutes late can miss a breakout candle.
- `vercel.json` keeps one daily cron at 08:00 UTC as a fallback (Vercel's Hobby plan allows
  one run per day).
- The dashboard's **Scan now** button runs it on demand.

`/api/scan` requires `Authorization: Bearer $CRON_SECRET` when that env var is set on the server.

## Backtesting

The backtest replays whatever is allowed to send (`SIGNAL_STRATEGIES`): the same detection and
send rules, one trade at a time, higher timeframes from closed bars only, full spread +
slippage on every trade, and a loss whenever one candle touches both stop and target.

```bash
npx tsx --env-file=.env.local scripts/backtest.ts                # XAU/USD, 3 years, printed year by year
npx tsx --env-file=.env.local scripts/backtest.ts --save         # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=1      # a shorter window
```

Settings come from the environment, so prefix any override to test it
(`BREAKOUT_TARGET_R=0.5 npx tsx …`). Candles are cached in `.cache/`; the first run downloads them.
The `/backtests` page shows stored runs — whole run, per year, per strategy — and its
**Quick run** button backtests the last ~7 weeks on the server.

Read the **t** column before the profit factor: inside ±2 an average is not distinguishable
from zero.

XAU/USD, 3 years to 2026-11-20, all four strategies, one trade at a time:

| | Trades | Win rate | Profit factor | Avg R | Total R |
| --- | --- | --- | --- | --- | --- |
| All four | 958 (1.2 a day) | 49% | 1.26 | +0.134 | +128 |
| — breakout | 334 | 69% | 1.56 | +0.175 | +58 |
| — fibonacci | 441 | 37% | 1.14 | +0.086 | +38 |
| — zones | 109 | 39% | 1.25 | +0.153 | +17 |
| — set & forget | 74 | 39% | 1.35 | +0.210 | +16 |

Each year is positive (+0.15R, +0.14R, +0.12R per trade), t = 3.3, and the profit factor is
1.21 with costs doubled. Grade A signals (314 trades) averaged +0.21R against +0.10R for
grade B (644 trades), and were ahead in two of the three years. The breakout alone (`SIGNAL_STRATEGIES=breakout`) makes fewer trades
at a higher win rate: 458 trades, 67% wins, +61R. These are past results on one instrument,
found by searching, in three years when gold trended strongly — a trend-following system like
this gives back in a sideways market. Treat it as a hypothesis to confirm on a practice
account, not a promise.

`scripts/research-strategies.ts` is a faster lab for new ideas: it tests entry rules on three
years of M15 data (first two years to design, last year held out) before anything is built
into the scanner.

## Verification

```bash
npx tsx scripts/verify-engine.ts   # detection, scoring, send gate, backtest
npx tsx scripts/verify-risk.ts     # stops, targets, sizing, cost cap
```

## Routes

- `/` — dashboard: M15 chart with the four strategies drawn in their own colours (breakout amber, set & forget blue, zones green/red, Fibonacci violet; a setup against the trend is drawn muted), key levels, optional structure/trendlines, the open trade plan and past results; a legend says what each strategy is waiting on. `/?asOf=2026-11-19T07:15Z` shows the chart as it stood at that moment
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
