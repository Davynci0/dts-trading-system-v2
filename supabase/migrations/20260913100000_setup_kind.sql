-- Allow the scanner to persist live setup state (confirmation tracker) in market_state.
alter table public.market_state drop constraint if exists market_state_kind_check;
alter table public.market_state
  add constraint market_state_kind_check
  check (kind in ('trendline', 'zone', 'pivot', 'fib', 'setup'));
