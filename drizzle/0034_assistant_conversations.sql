create table assistant_conversations (
  id text primary key,
  project_id text not null references shelves(id) on delete cascade,
  game_id text,
  title text not null default 'New conversation',
  summary text not null default '',
  summary_sources jsonb not null default '[]'::jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, game_id) references stories(shelf_id, id) on delete cascade
);
create index assistant_conversations_scope on assistant_conversations(project_id, game_id, updated_at desc);

create table assistant_messages (
  id text primary key,
  conversation_id text not null references assistant_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  status text not null check (status in ('committed', 'pending', 'failed')),
  source_refs jsonb not null default '[]'::jsonb,
  usage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(conversation_id, id)
);
create index assistant_messages_conversation_time on assistant_messages(conversation_id, created_at, id);

create table assistant_runs (
  id text primary key,
  conversation_id text not null references assistant_conversations(id) on delete cascade,
  user_message_id text not null unique,
  status text not null check (status in ('running', 'committing', 'completed', 'failed', 'cancelled')),
  request_fingerprint text not null,
  result jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, user_message_id) references assistant_messages(conversation_id, id) on delete cascade
);
create unique index assistant_runs_one_active_conversation on assistant_runs(conversation_id) where status in ('running', 'committing');
