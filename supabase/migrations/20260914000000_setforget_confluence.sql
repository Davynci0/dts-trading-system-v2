-- Fifth strategy (Alex G set & forget) + confluence tracking.
alter table public.signals drop constraint if exists signals_strategy_check;
alter table public.signals
  add constraint signals_strategy_check
  check (strategy in ('trendline', 'structure', 'zones', 'setforget', 'fibonacci'));

-- Strategies that agreed on this signal's direction (confluence bonus).
alter table public.signals
  add column if not exists confluence_strategies text[] not null default '{}';
