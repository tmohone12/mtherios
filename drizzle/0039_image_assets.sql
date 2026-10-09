CREATE TABLE assets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  game_id text,
  storage_key text NOT NULL UNIQUE,
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10000000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  visibility text NOT NULL DEFAULT 'gm' CHECK (visibility IN ('public', 'gm')),
  origin_job_id text,
  provider text,
  model text,
  prompt_style_revision integer,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_project_identity UNIQUE (project_id, id),
  CONSTRAINT assets_game_project_fk FOREIGN KEY (project_id, game_id) REFERENCES stories(shelf_id, id) ON DELETE CASCADE
);
CREATE INDEX assets_scope_idx ON assets(project_id, game_id, created_at DESC);

ALTER TABLE content_items ADD COLUMN cover_asset_id text;
ALTER TABLE content_items ADD COLUMN cover_revision integer NOT NULL DEFAULT 0 CHECK (cover_revision >= 0);
ALTER TABLE content_items ADD CONSTRAINT content_items_cover_asset_project_fk FOREIGN KEY (project_id, cover_asset_id) REFERENCES assets(project_id, id);

ALTER TABLE backend_jobs DROP CONSTRAINT backend_jobs_scope_check;
ALTER TABLE backend_jobs ADD CONSTRAINT backend_jobs_scope_check CHECK (
  (type IN ('validate_agent_settings', 'generate_image') AND story_id IS NULL)
  OR (type <> 'validate_agent_settings' AND story_id IS NOT NULL)
);
