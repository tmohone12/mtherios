CREATE TABLE IF NOT EXISTS "faction_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"faction_id" text NOT NULL REFERENCES "factions"("id") ON DELETE cascade,
	"entity_id" text REFERENCES "entities"("id") ON DELETE set null,
	"role" text DEFAULT 'member' NOT NULL,
	"rank" text,
	"status" text DEFAULT 'active' NOT NULL,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "faction_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"faction_id" text NOT NULL REFERENCES "factions"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"amount" real,
	"status" text DEFAULT 'available' NOT NULL,
	"location_id" text,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "faction_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"faction_id" text NOT NULL REFERENCES "factions"("id") ON DELETE cascade,
	"goal" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"secrecy" text DEFAULT 'player_known' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "faction_memberships_faction_idx" ON "faction_memberships" ("story_id","faction_id");
CREATE INDEX IF NOT EXISTS "faction_memberships_entity_idx" ON "faction_memberships" ("story_id","entity_id");
CREATE INDEX IF NOT EXISTS "faction_resources_faction_idx" ON "faction_resources" ("story_id","faction_id");
CREATE INDEX IF NOT EXISTS "faction_resources_kind_idx" ON "faction_resources" ("story_id","kind");
CREATE INDEX IF NOT EXISTS "faction_goals_faction_idx" ON "faction_goals" ("story_id","faction_id");
CREATE INDEX IF NOT EXISTS "faction_goals_status_idx" ON "faction_goals" ("story_id","status");
