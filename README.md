# DTS — Forex Trading System

Signal-only forex system. Three deterministic M15 strategies — supply/demand zones,
Alex G "set & forget" AOIs and the Fibonacci golden zone — each score a 6-point
confirmation checklist. A setup becomes a signal only when it also passes the send gate
(below). Telegram is the single alert channel. The user reviews each signal and executes
manually — the system never places trades.

**Stack:** Next.js (App Router, single deployable on Vercel) · OANDA v20 (data) ·
Supabase (auth + persistence) · Telegram Bot API (alerts) · Gemini 3 Flash (vision checks, Stage 7).

## Setup

```bash
cp .env.local.example .env.local   # fill in OANDA / Supabase / Telegram / Gemini values
npm install
npm run dev                        # http://localhost:3000
```

Run `supabase/schema.sql` in the Supabase SQL editor once to create the tables.

## Build order (per project spec)

All stages built and verified:

1. ~~Scaffold, Supabase setup, OANDA data, basic chart, Telegram test message~~ ✅
2. ~~Dashboard UI, signal feed UI, backtest results UI~~ ✅
3. ~~Structure-based stop/TP + risk sanity check~~ ✅ (`lib/analysis/`, verify: `npx tsx scripts/verify-risk.ts`)
4. ~~Zone-box detection and invalidation~~ ✅ (`lib/analysis/zones.ts`)
5. ~~Strategy core-trigger engines~~ ✅ (`trendlines.ts`, `structure.ts`, `fibonacci.ts`)
6. ~~Confirmation scoring, 3/5 threshold, signal persistence~~ ✅ (`scoring.ts`, `lib/engine/scanner.ts`)
7. ~~Vision AI (Gemini 3 Flash, direct API): confirmation #5, Ask AI, rendering validation~~ ✅ (`lib/vision/`, model `gemini-3-flash-preview`)
8. ~~Telegram flow: watching / updates / signals / skipped-for-risk~~ ✅ (`lib/telegram.ts`)
9. ~~Backtesting engine~~ ✅ (`lib/backtest/engine.ts` — no lookahead, spread+slippage, conservative same-candle SL-first, 70/30 walk-forward)

Verification: `npx tsx scripts/verify-risk.ts` and `npx tsx scripts/verify-engine.ts` (140 checks total).
Scanning runs via `/api/scan` or the dashboard's **Scan now** button. Signals are only sent
12:00–21:00 UTC, so the scan has to run every 15 minutes inside those hours:

- `.github/workflows/scan.yml` calls `/api/scan` at :01/:16/:31/:46 from 12:00 to 20:59 UTC,
  Monday–Friday. It needs two repository secrets: `SCAN_URL` (the deployed origin) and
  `CRON_SECRET` (the same value as the `CRON_SECRET` env var on Vercel). GitHub may start
  scheduled runs several minutes late.
- `vercel.json` keeps one daily cron at 12:00 UTC as a fallback (Vercel's Hobby plan allows
  one run per day, some time within that hour).

Set `CRON_SECRET` on Vercel: without it `GET /api/scan` accepts requests from anyone.

## Signal rules

A setup is sent when **all** of these hold (`lib/engine/select.ts`, shared by the scanner and the backtest):

| Gate | Rule | Override |
| --- | --- | --- |
| Confirmations | zones ≥ 4/6, set & forget ≥ 4/6, fibonacci 6/6 | `ZONES_MIN_CONFIDENCE`, `SETFORGET_MIN_CONFIDENCE`, `FIB_MIN_CONFIDENCE` (+ `_PAIR` suffix) |
| Session | entry falls in 12:00–21:00 UTC (New York incl. London overlap) | `TRADING_HOURS_UTC=6-21` |
| Higher timeframe | the weekly swing structure does not oppose the trade | `REQUIRE_HTF_TREND=false`, `TREND_MODE_<PAIR>` |
| M15 trend | M15 swing structure (HH/HL or LH/LL) agrees | `REQUIRE_M15_TREND=false`, `TREND_MODE_<PAIR>` |
| Stop | beyond the setup's own invalidation (zone far edge / 78.6% retracement), ≥ 0.5 ATR, ≤ 3 ATR | — |
| Costs | full spread + slippage ≤ 10% of the risk (a tighter stop is widened) | `MAX_COST_SHARE` |
| Reward | a structural target at ≥ 2R | `MIN_R_MULTIPLE` |

One trade per pair at a time; agreeing strategies collapse into one signal.

## Research

Two scripts, both reading candles cached in `.cache/` (first run downloads three years):

```bash
npx tsx --env-file=.env.local scripts/research-validate.ts     # the live rules, year by year
npx tsx --env-file=.env.local scripts/research-strategies.ts   # 29 textbook strategies, design vs holdout
```

**Where the live rules stand** (three years to 2026-11-20, eight pairs, full spread + slippage):
1,168 trades, profit factor 1.02, +0.015R per trade, t = 0.3 — breakeven, not an edge. Year by
year: +0.12R, −0.11R, +0.03R. With costs doubled: PF 0.92. About 1.5 signals per trading day
across all eight pairs.

What the data showed (closed higher-timeframe bars only, costs included):

- **The raw setups lose their trading cost.** With no session, weekly or M15 filter the same
  three strategies made 8,135 trades at −0.076R each (t = −4.7). Before costs they are a coin
  flip; rejection candles, RSI turns, zone freshness, H4/H1/daily trend and EMA position
  predicted nothing.
- **Costs decide the result.** Candles are mid prices, so a round trip pays the whole spread.
  Stops a few pips from entry put that at 13% of the risk per trade; anchoring the stop to the
  setup's invalidation and capping costs at 10% of risk roughly halved it. On GBP/AUD and
  GBP/NZD the cap leaves few tradeable setups on M15 at all.
- **Asian-session entries lose in every year tested** (−0.04R, −0.07R, −0.09R), so the session
  gate stays. Restricting further to New York and vetoing trades against the weekly structure
  each helped in one or two years and did nothing in the others.
- **No textbook strategy survived.** `research-strategies.ts` tests 29 variants — Asian-range
  and New York opening-range breakouts, Asian-range and previous-day sweep reversals,
  previous-day breakouts, EMA50 pullbacks, RSI(2) and Bollinger mean reversion, Donchian
  breakouts, impulse continuation/fade, NR4 days, daily momentum/reversal, the London
  first-hour drive — on eleven instruments, first two years as design, last year as holdout.
  None is positive in both; most sit at minus their own cost. Hour-of-day return seasonality
  was tested too: nothing that held was larger than the spread.
- **Earlier results in this repo do not reproduce.** "Set & forget PF 2.19" and "HTF alignment
  is the strongest edge" came from a backtest that read still-forming weekly/daily/H4 candles.
  A first re-validation on one year (+0.08R) also faded when two more years were added.

What follows from that: this is a disciplined alerting tool at roughly breakeven. A target such
as "2R a day from 2–3 trades" would need about +0.8R per trade — at 2R targets, a 60% win rate —
and nothing measured here is within an order of magnitude of it. Lowering targets to 1R raises
the win rate to ~45% and leaves the expectancy where it was (−0.02R). Judge the system on live
outcomes (the signal feed scores every signal, including skipped ones) on a practice account
before trusting it with money.

## Routes

- `/` — dashboard: interactive chart (zoom/pan/crosshair, timeframe switcher), live confirmation tracker, signal feed, Ask AI, Scan now
- `/backtests` — combined + per-strategy + per-pair metrics, in-sample vs walk-forward OOS (live-parity: send gate, one trade per pair)
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/scan` — run the engine (GET = Vercel cron, POST = manual)
- `/api/signals`, `/api/setups` — live feed + confirmation state
- `/api/risk/preview` — Stage 3 risk engine check (SL/TP/sizing from live structure)
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — Gemini chart read from a browser-captured screenshot
- `/api/vision/validate` — rendering QA: Gemini verifies drawn overlays match engine coordinates
- `/api/telegram/test` — POST a wiring-test message
# dts
