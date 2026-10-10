-- Authoritative World Clock: numeric fictional time per story branch plus an
-- auditable change log. Additive. Existing `stories.current_world_time` labels are
-- not rewritten here; a story's clock row is created from its label on the first
-- recorded change (a turn, a classifier duration, or an operator command), and that
-- change keeps the label it started from. Scheduled events may carry
-- `metadata.dueWorldMinutes` for world-time scheduling.
--
-- Rollback: drop table world_time_changes; drop table world_clocks;
-- (stories.current_world_time keeps the last label the clock wrote).

create table world_clocks (
	story_id text not null references stories(id) on delete cascade,
	branch text not null default 'primary',
	minutes integer not null default 0 check (minutes >= 0),
	precision text not null check (precision in ('minute','approximate','day','unknown')),
	calendar jsonb not null default '{}'::jsonb,
	anchor jsonb not null,
	label text,
	revision integer not null default 1,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (story_id, branch)
);

create table world_time_changes (
	id text primary key,
	story_id text not null references stories(id) on delete cascade,
	branch text not null default 'primary',
	op_key text not null,
	status text not null check (status in ('applied','rejected')),
	kind text not null check (kind in ('advance','anchor','set')),
	proposer text not null,
	source_entry_id text,
	source_turn integer,
	reason text not null,
	requested_minutes integer,
	applied_minutes integer,
	before_minutes integer,
	after_minutes integer,
	before_label text,
	after_label text,
	clock_revision integer,
	interrupted_by jsonb not null default '[]'::jsonb,
	metadata jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);
create unique index world_time_changes_op on world_time_changes(story_id, branch, op_key);
create index world_time_changes_story_created_idx on world_time_changes(story_id, created_at);
