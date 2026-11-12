alter table public.signals
  add column if not exists vision_verdict text check (vision_verdict in ('supports', 'rejects', 'skipped', 'error'));
