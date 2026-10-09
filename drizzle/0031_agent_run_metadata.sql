alter table agent_runs add column role text not null default 'gm' check (role in ('gm','assistant','research','batch'));
alter table agent_runs add column usage jsonb not null default '[]'::jsonb;
alter table agent_interactions add column answered_by text;
