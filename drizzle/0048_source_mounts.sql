-- Local path grants stay outside portable campaign/project settings and exports.
create table if not exists source_mounts (
  id text primary key,
  project_id text not null references shelves(id) on delete cascade,
  name text not null,
  root_path text not null,
  roles jsonb not null default '["gm","assistant"]'::jsonb,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, root_path),
  check(jsonb_typeof(roles) = 'array' and jsonb_array_length(roles) between 1 and 3 and roles <@ '["gm","assistant","research"]'::jsonb)
);
create index if not exists source_mounts_project_idx on source_mounts(project_id);
