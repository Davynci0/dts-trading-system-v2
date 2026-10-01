-- Outcome scoring for signals (skipped + active): records whether price
-- later hit the structural TP (win) or SL (loss), so the feed can show the
-- success rate of each strategy's setups — including the ones we skipped.
alter table public.signals
  add column if not exists outcome text check (outcome in ('win', 'loss', 'expired')),
  add column if not exists outcome_r double precision,
  add column if not exists outcome_at timestamptz;

create index if not exists signals_outcome_null_idx
  on public.signals (created_at)
  where outcome is null;

alter table public.signals
  add column if not exists outcome_price double precision,
  add column if not exists sl_basis text,
  add column if not exists tp_basis text;
