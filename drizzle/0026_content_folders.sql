create table content_folders (
  id text primary key,project_id text not null references shelves(id) on delete cascade,game_id text,
  path text not null check(length(path)>0 and length(path)<=500),revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(project_id,game_id) references stories(shelf_id,id) on delete cascade
);
create unique index content_folders_path_unique on content_folders(project_id,coalesce(game_id,''),path);
alter table content_revisions drop constraint content_revisions_target_kind_check;
alter table content_revisions add constraint content_revisions_target_kind_check check(target_kind in ('type','item','folder'));
