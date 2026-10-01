-- DTS — Forex Trading System schema
-- Run this in the Supabase SQL editor once per project.
-- Auth users are managed by Supabase Auth; these tables hang off that.

-- Final signals (and skipped-for-risk records), one row per event (Section 8).
create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  pair text not null,
  direction text not null check (direction in ('long', 'short')),
  strategy text not null check (strategy in ('trendline', 'structure', 'fibonacci')),
  entry double precision not null,
  stop_loss double precision not null,
  take_profit double precision not null,
  r_multiple double precision,
  confidence int not null check (confidence between 3 and 5),
  confirmations jsonb not null default '{}'::jsonb,
  vision_note text,
  status text not null default 'active' check (status in ('active', 'closed', 'skipped')),
  skip_reason text
);

-- One row per backtest execution (Section 7).
create table if not exists public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  range_start timestamptz,
  range_end timestamptz,
  pairs text[] not null default '{}',
  timeframes text[] not null default '{}',
  config jsonb not null default '{}'::jsonb,
  notes text
);

-- Metrics rows per run: scope like 'combined', 'strategy:trendline', or 'pair:EUR_USD'.
create table if not exists public.backtest_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  scope text not null,
  metrics jsonb not null,
  unique (run_id, scope)
);

-- Persisted detector state between runs: trendlines, zones, pivots, fib setups (Section 1).
create table if not exists public.market_state (
  id uuid primary key default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  pair text not null,
  timeframe text not null,
  kind text not null check (kind in ('trendline', 'zone', 'pivot', 'fib')),
  dedupe_key text not null,
  payload jsonb not null,
  unique (pair, timeframe, kind, dedupe_key)
);

alter table public.signals enable row level security;
alter table public.backtest_runs enable row level security;
alter table public.backtest_results enable row level security;
alter table public.market_state enable row level security;

-- Any authenticated user can read/write their workspace data.
-- Tighten to per-user rows when multi-user scoping is added.
create policy "authenticated read/write signals"
  on public.signals for all to authenticated using (true) with check (true);
create policy "authenticated read/write backtest_runs"
  on public.backtest_runs for all to authenticated using (true) with check (true);
create policy "authenticated read/write backtest_results"
  on public.backtest_results for all to authenticated using (true) with check (true);
create policy "authenticated read/write market_state"
  on public.market_state for all to authenticated using (true) with check (true);
