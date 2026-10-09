alter table assistant_runs drop constraint assistant_runs_status_check;
alter table assistant_runs add constraint assistant_runs_status_check
  check (status in ('running', 'awaiting_input', 'committing', 'completed', 'failed', 'cancelled'));

drop index assistant_runs_one_active_conversation;
create unique index assistant_runs_one_active_conversation on assistant_runs(conversation_id)
  where status in ('running', 'awaiting_input', 'committing');

create table assistant_questions (
  id text primary key,
  run_id text not null references assistant_runs(id) on delete cascade,
  call_id text not null,
  prompt text not null,
  options jsonb not null,
  allow_custom boolean not null default false,
  status text not null check (status in ('pending', 'answered', 'cancelled')),
  response jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, call_id)
);
create unique index assistant_questions_one_pending_run on assistant_questions(run_id) where status='pending';
