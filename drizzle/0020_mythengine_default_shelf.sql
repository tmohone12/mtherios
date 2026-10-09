-- Only update the inherited generated label; preserve user-authored shelf text.
UPDATE shelves
SET description = 'Your MythEngine stories.',
    server_version = server_version + 1,
    updated_at = now()
WHERE id = 'shelf_default'
  AND description = 'Migrated shelf for existing Mtherios stories.';
