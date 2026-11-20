-- The trend system: eleven entry types managed with a trailing stop.
--  - strategy 'trend'; `variant` says which entry type (don30, ema20pb, …)
--  - no take-profit: `trail_distance` is the fixed trailing distance in price,
--    `trail_stop` the stop as it stands now, `trail_checked_at` how far the
--    M15 candles have been followed.
alter table public.signals drop constraint if exists signals_strategy_check;
alter table public.signals
  add constraint signals_strategy_check
  check (strategy in ('trendline', 'structure', 'zones', 'setforget', 'fibonacci', 'breakout', 'sr', 'trend'));

-- confirmations counts no longer fit the original 3–5 range
alter table public.signals drop constraint if exists signals_confidence_check;
alter table public.signals
  add constraint signals_confidence_check check (confidence between 0 and 20);

alter table public.signals add column if not exists variant text;
alter table public.signals add column if not exists trail_distance double precision;
alter table public.signals add column if not exists trail_stop double precision;
alter table public.signals add column if not exists trail_checked_at timestamptz;

create index if not exists signals_open_trend_idx
  on public.signals (pair, variant)
  where outcome is null and strategy = 'trend';
