-- Shared lifecycle for archival chapter memory windows (live worker, reviewed
-- chapter-only runner, historical rebuild). Additive: no chapter, summary
-- checkpoint, recovery ledger or transcript row is read-modified here. Existing
-- chapters stay authoritative for committed history; windows are tracked from
-- the first attempt after this migration.
--
-- Rollback: drop table chapter_window_attempts; drop table chapter_windows;
-- (no other table references them; chapter metadata keeps its own completion receipt).

create table chapter_windows (
	id text primary key,
	story_id text not null references stories(id) on delete cascade,
	scope text not null default 'primary',
	number integer not null check (number > 0),
	-- Latest frozen attempt; the attempt row owns the lifecycle state.
	revision integer not null check (revision > 0),
	chapter_id text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create unique index chapter_windows_slot on chapter_windows(story_id, scope, number);

-- One frozen revision of a window. Source IDs, transcript fingerprint and
-- generation inputs never change after freezing; a source edit invalidates the
-- revision and a new one is frozen deliberately.
create table chapter_window_attempts (
	window_id text not null references chapter_windows(id) on delete cascade,
	revision integer not null check (revision > 0),
	story_id text not null references stories(id) on delete cascade,
	policy text not null,
	state text not null,
	after_chapter_id text,
	start_position integer not null,
	end_position integer not null,
	source_entry_ids jsonb not null,
	source_fingerprint text not null,
	scope text not null default 'primary',
	pov text not null default 'primary',
	compiler text not null,
	summarizer_revision text not null,
	inputs jsonb,
	draft jsonb,
	draft_hash text,
	owner_job_id text,
	lease_until timestamptz,
	extraction jsonb not null default '{}'::jsonb,
	failure jsonb,
	invalidation jsonb,
	reconciliations jsonb not null default '[]'::jsonb,
	reference jsonb not null default '{}'::jsonb,
	chapter_id text,
	committed_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (window_id, revision),
	constraint chapter_window_attempts_policy_check check (policy in ('live','reviewed','historical')),
	constraint chapter_window_attempts_state_check check (state in ('waiting','ready','generating','validated','committed','retryable_failure','needs_configuration','uncertain_dispatch','invalidated')),
	constraint chapter_window_attempts_committed check ((state = 'committed') = (chapter_id is not null and committed_at is not null))
);
create index chapter_window_attempts_story_state_idx on chapter_window_attempts(story_id, state);
