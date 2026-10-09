alter table agent_runs add column continuation jsonb not null default '[]'::jsonb;
alter table agent_runs add column pending_decision jsonb;
