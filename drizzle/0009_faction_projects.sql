CREATE TABLE IF NOT EXISTS "faction_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"faction_id" text NOT NULL REFERENCES "factions"("id") ON DELETE cascade,
	"project" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"due_turn" integer,
	"world_time" text,
	"costs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gains" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "faction_projects_faction_idx" ON "faction_projects" ("story_id","faction_id");
CREATE INDEX IF NOT EXISTS "faction_projects_status_idx" ON "faction_projects" ("story_id","status");
CREATE INDEX IF NOT EXISTS "faction_projects_due_turn_idx" ON "faction_projects" ("story_id","due_turn");
