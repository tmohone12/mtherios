create table assistant_restore_approvals (
  id text primary key,
  run_id text not null references assistant_runs(id) on delete cascade,
  call_id text not null,
  request jsonb not null,
  preview jsonb not null,
  status text not null check (status in ('pending', 'approved', 'declined', 'cancelled')),
  result jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, call_id)
);
create unique index assistant_restore_approvals_one_pending_run on assistant_restore_approvals(run_id) where status='pending';
