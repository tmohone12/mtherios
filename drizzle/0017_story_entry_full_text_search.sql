CREATE INDEX IF NOT EXISTS story_entries_content_fts_idx
ON story_entries USING gin (to_tsvector('english', coalesce(content, '')));
