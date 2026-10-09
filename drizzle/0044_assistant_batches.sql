create table assistant_batches (
  id text primary key,
  run_id text not null references assistant_runs(id) on delete cascade,
  call_id text not null,
  project_id text not null references shelves(id) on delete cascade,
  game_id text,
  type_id text not null references content_types(id) on delete cascade,
  type_revision integer not null check (type_revision > 0),
  objective text not null,
  instructions text not null,
  allowed_fields jsonb not null,
  sample jsonb not null,
  model text not null,
  status text not null default 'planned' check (status in ('planned','running','completed','cancelled','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, call_id),
  foreign key (project_id, game_id) references stories(shelf_id, id) on delete cascade
);
create index assistant_batches_scope_status on assistant_batches(project_id, game_id, status, updated_at desc);

create table assistant_batch_children (
  id text primary key,
  batch_id text not null references assistant_batches(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  status text not null default 'pending' check (status in ('pending','running','completed','failed','cancelled')),
  usage jsonb,
  report jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, ordinal)
);
create index assistant_batch_children_status on assistant_batch_children(batch_id, status, ordinal);

create table assistant_batch_targets (
  batch_id text not null references assistant_batches(id) on delete cascade,
  item_id text not null,
  child_id text not null references assistant_batch_children(id) on delete cascade,
  expected_revision integer not null check (expected_revision > 0),
  status text not null default 'pending' check (status in ('pending','running','applied','conflict','failed','skipped','cancelled')),
  committed_revision integer,
  result jsonb,
  error text,
  updated_at timestamptz not null default now(),
  primary key(batch_id, item_id)
);
create index assistant_batch_targets_child_status on assistant_batch_targets(child_id, status, item_id);

alter table backend_jobs drop constraint backend_jobs_scope_check;
alter table backend_jobs add constraint backend_jobs_scope_check check
  ((story_id is null and type in ('validate_agent_settings','generate_image','assistant_batch_child'))
    or (story_id is not null and type not in ('validate_agent_settings','assistant_batch_child')));
