alter table backend_jobs add column project_id text;
update backend_jobs j set project_id = s.shelf_id from stories s where s.id = j.story_id;
alter table backend_jobs alter column project_id set not null;
alter table backend_jobs alter column story_id drop not null;
alter table backend_jobs add constraint backend_jobs_project_fk foreign key (project_id) references shelves(id) on delete cascade;
create index backend_jobs_project_status_idx on backend_jobs(project_id, status);
alter table stories add constraint stories_project_identity unique (shelf_id, id);
alter table backend_jobs add constraint backend_jobs_game_project_fk foreign key (project_id, story_id) references stories(shelf_id, id) on delete cascade;
alter table backend_jobs add constraint backend_jobs_scope_check check (
  (type = 'validate_agent_settings' and story_id is null) or
  (type <> 'validate_agent_settings' and story_id is not null)
);
