CREATE TABLE IF NOT EXISTS "sagas" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"arc_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_faction_shifts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"major_power_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lingering_threads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_tone" text DEFAULT '' NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_thread_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sagas_story_number_idx"
	ON "sagas" ("story_id","number");
