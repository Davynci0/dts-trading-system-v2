# DTS — Forex Trading System

Signal-only forex system. Three deterministic strategies (trendline bounce, market
structure, fibonacci golden zone) score a 5-point confirmation checklist; a signal
fires at 3/5+. Telegram is the single alert channel. The user reviews each signal
and executes manually — the system never places trades.

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

Verification: `npx tsx scripts/verify-risk.ts` and `npx tsx scripts/verify-engine.ts` (37 checks total).
Scanning runs via Vercel cron (`/api/scan` every 15 min) or the dashboard's **Scan now** button.

## Routes

- `/` — dashboard: interactive chart (zoom/pan/crosshair, timeframe switcher), live confirmation tracker, signal feed, Ask AI, Scan now
- `/backtests` — combined + per-strategy + per-pair metrics, in-sample vs walk-forward OOS
- `/login` — Supabase auth
- `/api/candles` — OANDA candle proxy (key stays server-side)
- `/api/scan` — run the engine (GET = Vercel cron, POST = manual)
- `/api/signals`, `/api/setups` — live feed + confirmation state
- `/api/risk/preview` — Stage 3 risk engine check (SL/TP/sizing from live structure)
- `/api/backtest/run`, `/api/backtests/latest` — backtesting
- `/api/ask-ai` — Gemini chart read from a browser-captured screenshot
- `/api/vision/validate` — rendering QA: Gemini verifies drawn overlays match engine coordinates
- `/api/telegram/test` — POST a wiring-test message
