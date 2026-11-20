-- Allow the support/resistance retest strategy in the signals table.
alter table public.signals drop constraint if exists signals_strategy_check;

alter table public.signals
  add constraint signals_strategy_check
  check (strategy in ('trendline', 'structure', 'zones', 'setforget', 'fibonacci', 'breakout', 'sr'));
