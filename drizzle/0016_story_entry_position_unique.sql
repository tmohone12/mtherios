-- Remove legacy runtime-error artifacts that collided with real transcript rows.
-- All known duplicate positions have one of these system rows and one canonical row.
DELETE FROM story_entries AS duplicate
USING story_entries AS canonical
WHERE duplicate.story_id = canonical.story_id
  AND duplicate.position = canonical.position
  AND duplicate.id <> canonical.id
  AND duplicate.type = 'system'
  AND duplicate.content LIKE 'Terminal agent runtime required:%'
  AND canonical.type <> 'system';

DROP INDEX IF EXISTS story_entries_story_position_idx;
CREATE UNIQUE INDEX IF NOT EXISTS story_entries_story_position_unique_idx
  ON story_entries(story_id, position);
