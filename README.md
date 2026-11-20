# DTS — Forex Trading System

Signal-only forex system. Three deterministic M15 strategies — supply/demand zones,
Alex G "set & forget" AOIs and the Fibonacci golden zone — each score a 6-point
confirmation checklist. A setup becomes a signal only when it also passes the send gate
below. Telegram is the single alert channel. The user reviews each signal and executes
manually — the system never places trades.

**Stack:** Next.js (App Router, single deployable on Vercel) · OANDA v20 (data) ·
Supabase (auth + persistence) · Telegram Bot API (alerts) · OpenRouter vision model (final
check on each signal; it can only reject).

## Setup

```bash
cp .env.local.example .env.local   # fill in OANDA / Supabase / Telegram values
npm install
npm run dev                        # http://localhost:3000
```

Run `supabase/schema.sql` in the Supabase SQL editor once to create the tables.

## Signal rules

A setup is sent when **all** of these hold (`lib/engine/select.ts`, shared by the scanner and the backtest):

| Gate | Rule | Override |
| --- | --- | --- |
| Confirmations | zones ≥ 4/6, set & forget ≥ 4/6, fibonacci 6/6 | `ZONES_MIN_CONFIDENCE`, `SETFORGET_MIN_CONFIDENCE`, `FIB_MIN_CONFIDENCE`; per pair `<STRATEGY>_MIN_CONFIDENCE_<PAIR>` |
| Session | entry falls in 12:00–21:00 UTC (New York incl. London overlap) | `TRADING_HOURS_UTC=6-21` |
| Higher timeframe | the weekly swing structure does not oppose the trade | `REQUIRE_HTF_TREND=false`, `TREND_MODE_<PAIR>` |
| M15 trend | M15 swing structure (HH/HL or LH/LL) agrees | `REQUIRE_M15_TREND=false`, `TREND_MODE_<PAIR>` |
| Stop | beyond the setup's own invalidation (zone far edge / 78.6% retracement), ≥ 0.5 ATR, ≤ 3 ATR | — |
| Costs | full spread + slippage ≤ 10% of the risk (a tighter stop is widened) | `MAX_COST_SHARE` |
| Reward | a structural target at ≥ 2R | `MIN_R_MULTIPLE` |
| Pair | the pair is allowed to send (default XAU/USD and GBP/AUD); others are tracked only | `SIGNAL_PAIRS` |

One trade per pair at a time; agreeing strategies collapse into one signal.

## Scanning

Signals are only sent 12:00–21:00 UTC, so the scan has to run every 15 minutes inside those hours:

- `.github/workflows/scan.yml` calls `/api/scan` at :01/:16/:31/:46 from 12:00 to 20:59 UTC,
  Monday–Friday, using the `SCAN_URL` and `CRON_SECRET` repository secrets. GitHub may start
  scheduled runs several minutes late.
- `vercel.json` keeps one daily cron at 12:00 UTC as a fallback (Vercel's Hobby plan allows
  one run per day).
- The dashboard's **Scan now** button runs it on demand.

`/api/scan` requires `Authorization: Bearer $CRON_SECRET` when that env var is set on the server.

## Backtesting

The backtest replays the live rules: the same send gate and checklist, one trade per pair,
higher timeframes from closed bars only, full spread + slippage on every trade, and a loss
whenever one candle touches both stop and target. The AI vision check is not replayed.

```bash
npx tsx --env-file=.env.local scripts/backtest.ts                # 3 years, all pairs, printed year by year
npx tsx --env-file=.env.local scripts/backtest.ts --save         # …and stored for the Backtests page
npx tsx --env-file=.env.local scripts/backtest.ts --years=1 XAU_USD GBP_AUD
```

Gate settings come from the environment, so prefix any override to test it
(`ZONES_MIN_CONFIDENCE=5 npx tsx …`). Candles are cached in `.cache/`; the first run downloads them.
The `/backtests` page shows stored runs — whole run, per year, per strategy, per pair — and its
**Quick run** button backtests the signal pairs over the last ~7 weeks on the server.

Read the **t** column before the profit factor: inside ±2 an average is not distinguishable
from zero. Current result at the production settings (3 years to 2026-11-20, 8 pairs):
1,427 trades, profit factor 1.01, +0.005R per trade, t = 0.1 — breakeven.

`scripts/research-strategies.ts` is a faster lab for new ideas: it tests entry rules on three
years of M15 data (first two years to design, last year held out) before anything is built
into the scanner.

## Verification

```bash
npx tsx scripts/verify-engine.ts   # detection, scoring, send gate, backtest
npx tsx scripts/verify-risk.ts     # stops, targets, sizing, cost cap
```

## Routes

- `/` — dashboard: M15 chart with the engine's overlays (zones, fib, AOI, trendlines, S/R, structure, trade plan), send-gate status, live confirmation tracker, signal feed, Ask AI, Scan now
- `/backtests` — stored backtest runs and the quick run
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/analysis` — everything the chart draws, from the same engine the scanner uses
- `/api/scan` — run the engine (GET = scheduled, POST = dashboard)
- `/api/signals`, `/api/setups` — live feed + confirmation state
- `/api/risk/preview` — stop / target / sizing check from live structure
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai`, `/api/vision/validate` — vision model chart read and rendering QA
- `/api/telegram/test` — POST a wiring-test message
