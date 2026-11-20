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
Scanning runs via `/api/scan` (cron) or the dashboard's **Scan now** button. Signals are only
sent 12:00–21:00 UTC, so the scan must run during those hours — every 15 minutes to see each
M15 candle (`vercel.json` currently schedules it once a day at 00:00 UTC, which is outside the window).

## Signal rules

A setup is sent when **all** of these hold (`lib/engine/select.ts`, shared by the scanner and the backtest):

| Gate | Rule | Override |
| --- | --- | --- |
| Confirmations | zones ≥ 4/6, set & forget ≥ 4/6, fibonacci 6/6 | `ZONES_MIN_CONFIDENCE`, `SETFORGET_MIN_CONFIDENCE`, `FIB_MIN_CONFIDENCE` (+ `_PAIR` suffix) |
| Session | entry falls in 12:00–21:00 UTC (New York incl. London overlap) | `TRADING_HOURS_UTC=6-21` |
| Higher timeframe | the weekly swing structure does not oppose the trade | `REQUIRE_HTF_TREND=false`, `TREND_MODE_<PAIR>` |
| M15 trend | M15 swing structure (HH/HL or LH/LL) agrees | `REQUIRE_M15_TREND=false`, `TREND_MODE_<PAIR>` |
| Stop | beyond the setup's own invalidation (zone far edge / 78.6% retracement), ≥ 0.5 ATR, ≤ 3 ATR | — |
| Costs | spread + slippage ≤ 10% of the risk (a tighter stop is widened) | `MAX_COST_SHARE` |
| Reward | a structural target at ≥ 2R | `MIN_R_MULTIPLE` |

One trade per pair at a time; agreeing strategies collapse into one signal.

## Research

`npx tsx --env-file=.env.local scripts/research-validate.ts` backtests the live configuration on
12 months of M15 data for every pair (candles cached in `.cache/`), split into the first eight
and last four months, and repeats it with costs doubled. For the 365 days to 2026-11-20: 514 trades,
profit factor 1.12, +0.08R per trade (first 8 months PF 1.07, last 4 months PF 1.23); PF 1.02
with costs doubled. That is a small edge, not a statistically proven one — treat it as
"no longer losing", and judge it on live outcomes.

What the data showed (all measured with closed higher-timeframe bars only):

- The raw entries are a coin flip: 8,100 unfiltered trades averaged +0.01R before costs.
  None of rejection candle, RSI turn, zone freshness, H4/H1/daily trend or EMA position
  predicted the outcome.
- Costs were the loss. With stops a few pips from entry, spread + slippage averaged 13% of
  the risk per trade. Anchoring the stop to the setup's invalidation and capping costs at
  10% of risk roughly halved that.
- Two filters held up out-of-sample: trades against the weekly structure (−0.10R in-sample,
  −0.31R out-of-sample) and entries in the Asian session (−0.11 to −0.25R in both).
- Earlier results in this repo (set & forget PF 2.19, "HTF alignment is the strongest edge")
  came from a backtest that read still-forming weekly/daily/H4 candles and did not apply the
  live send gate. They do not reproduce.

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
