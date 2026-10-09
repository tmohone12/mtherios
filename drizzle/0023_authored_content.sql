create table content_types (
  id text primary key, project_id text not null references shelves(id) on delete cascade,
  key text not null, extension text not null, name text not null, definition jsonb not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint content_types_project_identity unique(project_id, id),
  constraint content_types_key_unique unique(project_id, key),
  constraint content_types_extension_unique unique(project_id, extension)
);
create table content_items (
  id text primary key, project_id text not null references shelves(id) on delete cascade,
  game_id text, type_id text not null, title text not null, description text not null default '',
  folder text not null default '', slug text not null, data jsonb not null,
  gm_context_mode text check(gm_context_mode in ('pinned','partial','searchable')),
  visibility text not null default 'gm' check(visibility in ('public','gm')),
  revision integer not null default 1 check(revision > 0), deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint content_items_type_project_fk foreign key(project_id,type_id) references content_types(project_id,id),
  constraint content_items_game_project_fk foreign key(project_id,game_id) references stories(shelf_id,id) on delete cascade,
  constraint content_items_project_identity unique(project_id,id)
);
create unique index content_items_path_unique on content_items(project_id,coalesce(game_id,''),folder,slug,type_id) where deleted_at is null;
create index content_items_scope_idx on content_items(project_id,game_id);
create table content_revisions (
  id text primary key, project_id text not null references shelves(id) on delete cascade,
  target_kind text not null check(target_kind in ('type','item')), target_id text not null,
  revision integer not null, prior_revision integer, type_revision integer,
  snapshot jsonb not null, actor jsonb not null, reason text not null,
  created_at timestamptz not null default now(),
  constraint content_revisions_identity unique(target_kind,target_id,revision)
);
