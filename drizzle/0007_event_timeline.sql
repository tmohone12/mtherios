ALTER TABLE "stories"
	ADD COLUMN IF NOT EXISTS "current_turn" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "current_world_time" text;

ALTER TABLE "story_events"
	ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'committed' NOT NULL,
	ADD COLUMN IF NOT EXISTS "location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN IF NOT EXISTS "faction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN IF NOT EXISTS "created_turn" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "occurred_turn" integer,
	ADD COLUMN IF NOT EXISTS "scheduled_turn" integer,
	ADD COLUMN IF NOT EXISTS "world_time" text,
	ADD COLUMN IF NOT EXISTS "memory_impact" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "story_events"
	SET "status" = 'committed'
	WHERE "status" IS NULL;

UPDATE "story_events"
	SET "occurred_turn" = COALESCE("occurred_turn", "created_turn", 0)
	WHERE "status" = 'committed' AND "occurred_turn" IS NULL;

UPDATE "story_events"
	SET "location_ids" = jsonb_build_array("location_id")
	WHERE "location_id" IS NOT NULL
		AND jsonb_array_length("location_ids") = 0;

CREATE TABLE IF NOT EXISTS "npc_event_links" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"event_id" text NOT NULL REFERENCES "story_events"("id") ON DELETE cascade,
	"npc_entity_id" text NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
	"role" text DEFAULT 'affected' NOT NULL,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"evidence_strength" real DEFAULT 0.75 NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "story_events_story_status_turn_idx"
	ON "story_events" ("story_id","status","scheduled_turn");
CREATE INDEX IF NOT EXISTS "story_events_story_occurred_turn_idx"
	ON "story_events" ("story_id","occurred_turn");
CREATE INDEX IF NOT EXISTS "npc_event_links_story_event_idx"
	ON "npc_event_links" ("story_id","event_id");
CREATE INDEX IF NOT EXISTS "npc_event_links_story_npc_idx"
	ON "npc_event_links" ("story_id","npc_entity_id");
