create table agent_runs (
  id text primary key,
  project_id text not null references shelves(id) on delete cascade,
  game_id text not null references stories(id) on delete cascade,
  client_turn_id text not null,
  status text not null check (status in ('running','awaiting_input','committing','completed','failed','cancelled')),
  request jsonb not null,
  observations jsonb not null default '[]'::jsonb,
  context_fingerprint text,
  settings_fingerprint text,
  result jsonb,
  error text,
  revision integer not null default 1,
  lease_until timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game_id, client_turn_id)
);
create unique index agent_runs_one_pending_game on agent_runs(game_id) where status in ('running','awaiting_input','committing');
create index agent_runs_project_status on agent_runs(project_id, status, updated_at desc);

create table agent_tool_calls (
  run_id text not null references agent_runs(id) on delete cascade,
  call_id text not null,
  tool text not null,
  args_hash text not null,
  args jsonb not null,
  status text not null check (status in ('reserved','completed','failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(run_id, call_id)
);

create table agent_interactions (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  call_id text not null,
  kind text not null check (kind in ('question')),
  prompt text not null,
  options jsonb not null,
  options_meta jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending','answered','cancelled','expired')),
  response jsonb,
  revision integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,call_id)
);

create table agent_run_events (
  seq bigserial primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  event_type text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index agent_run_events_run_seq on agent_run_events(run_id,seq);
