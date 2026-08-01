CREATE TABLE IF NOT EXISTS shelves (
	id text PRIMARY KEY,
	name text NOT NULL,
	slug text NOT NULL,
	description text,
	genre text,
	cover_image_url text,
	settings jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shelves_slug_idx ON shelves(slug);
CREATE INDEX IF NOT EXISTS shelves_name_idx ON shelves(name);
CREATE INDEX IF NOT EXISTS shelves_updated_at_idx ON shelves(updated_at);

INSERT INTO shelves (id, name, slug, description, genre, settings, metadata)
VALUES (
	'shelf_default',
	'Default Shelf',
	'default_shelf',
	'Migrated shelf for existing Mtherios stories.',
	NULL,
	'{}'::jsonb,
	'{"createdByMigration": true}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE stories ADD COLUMN IF NOT EXISTS shelf_id text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'playable';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS timeline_mode text NOT NULL DEFAULT 'overlay';

UPDATE stories SET shelf_id = 'shelf_default' WHERE shelf_id IS NULL;
ALTER TABLE stories ALTER COLUMN shelf_id SET DEFAULT 'shelf_default';
ALTER TABLE stories ALTER COLUMN shelf_id SET NOT NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'stories_shelf_id_shelves_id_fk'
	) THEN
		ALTER TABLE stories
			ADD CONSTRAINT stories_shelf_id_shelves_id_fk
			FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS stories_shelf_idx ON stories(shelf_id);
CREATE INDEX IF NOT EXISTS stories_shelf_updated_idx ON stories(shelf_id, updated_at);
