CREATE TABLE IF NOT EXISTS "llm_service_settings" (
	"service_id" text PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"base_url" text,
	"model" text,
	"temperature" real DEFAULT 1 NOT NULL,
	"max_tokens" integer DEFAULT 4096 NOT NULL,
	"top_p" real,
	"frequency_penalty" real,
	"presence_penalty" real,
	"reasoning_effort" text,
	"context_budget" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"system_prompt_override" text,
	"api_key_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "search_index_records" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"qdrant_point_id" text,
	"collection" text NOT NULL,
	"content_hash" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"indexed_at" timestamp with time zone,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "search_index_records_story_record_idx"
	ON "search_index_records" ("story_id","record_type","record_id","collection");
CREATE INDEX IF NOT EXISTS "search_index_records_story_status_idx"
	ON "search_index_records" ("story_id","status");
CREATE INDEX IF NOT EXISTS "search_index_records_type_idx"
	ON "search_index_records" ("record_type","status");
