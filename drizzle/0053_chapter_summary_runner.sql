-- Explicit story-scoped summary-only activation, separate from backend_jobs.
create table chapter_summary_runners (
 story_id text primary key references stories(id) on delete cascade,
 document jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
