CREATE TABLE IF NOT EXISTS "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"type" text DEFAULT 'observation' NOT NULL,
	"subject_entity_id" text REFERENCES "entities"("id") ON DELETE set null,
	"target_entity_id" text REFERENCES "entities"("id") ON DELETE set null,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"first_seen_entry_id" text,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "facts_story_type_idx" ON "facts" ("story_id","type");
CREATE INDEX IF NOT EXISTS "facts_subject_entity_idx" ON "facts" ("story_id","subject_entity_id");
CREATE INDEX IF NOT EXISTS "facts_target_entity_idx" ON "facts" ("story_id","target_entity_id");
CREATE INDEX IF NOT EXISTS "facts_story_status_idx" ON "facts" ("story_id","status");

CREATE TABLE IF NOT EXISTS "source_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"target_table" text NOT NULL,
	"target_record_id" text NOT NULL,
	"target_record_field" text,
	"source_field" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"rationale" text,
	"notes" text,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "source_refs_story_source_idx" ON "source_refs" ("story_id","source_type","source_id");
CREATE INDEX IF NOT EXISTS "source_refs_story_target_idx" ON "source_refs" ("story_id","target_table","target_record_id");
CREATE INDEX IF NOT EXISTS "source_refs_target_table_idx" ON "source_refs" ("story_id","target_table");

CREATE TABLE IF NOT EXISTS "patch_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"proposal_type" text NOT NULL,
	"target_table" text NOT NULL,
	"target_record_id" text NOT NULL,
	"proposed_by" text DEFAULT 'llm' NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"suggestion" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"validated_by" text,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "patch_proposals_story_status_idx" ON "patch_proposals" ("story_id","status");
CREATE INDEX IF NOT EXISTS "patch_proposals_target_idx" ON "patch_proposals" ("story_id","target_table","target_record_id");

CREATE TABLE IF NOT EXISTS "continuity_warnings" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"warning_type" text NOT NULL,
	"level" text DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" text NOT NULL,
	"entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"faction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution_notes" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "continuity_warnings_story_status_idx" ON "continuity_warnings" ("story_id","status");
CREATE INDEX IF NOT EXISTS "continuity_warnings_story_level_idx" ON "continuity_warnings" ("story_id","level");
