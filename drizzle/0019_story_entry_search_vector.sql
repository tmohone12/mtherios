ALTER TABLE story_entries
ADD COLUMN IF NOT EXISTS content_search_vector tsvector
GENERATED ALWAYS AS (
	to_tsvector('english'::regconfig, coalesce(content, ''))
) STORED;

CREATE INDEX IF NOT EXISTS story_entries_content_search_vector_idx
ON story_entries USING gin (content_search_vector);
