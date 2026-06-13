CREATE TABLE IF NOT EXISTS campaign_files (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	path text NOT NULL,
	kind text NOT NULL,
	content_hash text NOT NULL,
	byte_length integer NOT NULL DEFAULT 0,
	server_version integer NOT NULL DEFAULT 1,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_files_story_path_idx
	ON campaign_files(story_id, path);

CREATE INDEX IF NOT EXISTS campaign_files_story_kind_idx
	ON campaign_files(story_id, kind);

CREATE INDEX IF NOT EXISTS campaign_files_content_hash_idx
	ON campaign_files(content_hash);

CREATE TABLE IF NOT EXISTS engine_cache_entries (
	id text PRIMARY KEY,
	story_id text REFERENCES stories(id) ON DELETE CASCADE,
	cache_key text NOT NULL,
	kind text NOT NULL,
	content_hash text NOT NULL,
	value text NOT NULL DEFAULT '',
	token_estimate integer NOT NULL DEFAULT 0,
	hit_count integer NOT NULL DEFAULT 0,
	miss_count integer NOT NULL DEFAULT 0,
	dependency_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	last_hit_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS engine_cache_entries_story_kind_idx
	ON engine_cache_entries(story_id, kind);

CREATE INDEX IF NOT EXISTS engine_cache_entries_cache_key_idx
	ON engine_cache_entries(cache_key);

CREATE INDEX IF NOT EXISTS engine_cache_entries_content_hash_idx
	ON engine_cache_entries(content_hash);
