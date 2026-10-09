create table assistant_tool_calls (
  run_id text not null references assistant_runs(id) on delete cascade,
  call_id text not null,
  tool text not null,
  args_hash text not null,
  args jsonb not null,
  status text not null check (status in ('reserved', 'completed', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, call_id)
);
create index assistant_tool_calls_run_time on assistant_tool_calls(run_id, created_at, call_id);
