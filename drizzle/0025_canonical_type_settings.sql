create table canonical_type_settings (
  project_id text not null references shelves(id) on delete cascade,
  kind text not null check(kind in ('characters','locations','items','factions')),
  definition jsonb not null, revision integer not null default 0 check(revision >= 0),
  updated_at timestamptz not null default now(), primary key(project_id,kind)
);
create table canonical_type_history (
  project_id text not null, kind text not null, revision integer not null,
  definition jsonb not null, actor jsonb not null, reason text not null,
  created_at timestamptz not null default now(), primary key(project_id,kind,revision),
  foreign key(project_id,kind) references canonical_type_settings(project_id,kind) on delete cascade
);
