CREATE TABLE IF NOT EXISTS context_checkpoints (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE cascade,
	label text NOT NULL,
	reason text,
	entry_position integer NOT NULL DEFAULT -1,
	current_turn integer NOT NULL DEFAULT 0,
	snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_checkpoints_story_updated_idx ON context_checkpoints(story_id, updated_at);
CREATE INDEX IF NOT EXISTS context_checkpoints_story_entry_idx ON context_checkpoints(story_id, entry_position);
