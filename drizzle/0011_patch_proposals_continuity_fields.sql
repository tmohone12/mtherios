ALTER TABLE "patch_proposals"
ADD COLUMN IF NOT EXISTS "affected_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
ADD COLUMN IF NOT EXISTS "confidence" real DEFAULT 0.75 NOT NULL;
