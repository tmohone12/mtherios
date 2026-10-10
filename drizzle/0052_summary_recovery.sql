-- Independent summary-only recovery receipts. No existing rows or queue changes.
create table summary_recovery_runs (
  id text primary key,
  story_id text not null references stories(id) on delete cascade,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
