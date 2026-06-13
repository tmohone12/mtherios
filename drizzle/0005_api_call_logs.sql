CREATE TABLE IF NOT EXISTS "api_call_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text REFERENCES "stories"("id") ON DELETE cascade,
	"service_id" text,
	"operation" text NOT NULL,
	"provider_type" text,
	"provider_name" text,
	"profile_id" text,
	"model" text,
	"endpoint" text,
	"status" text DEFAULT 'success' NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_tokens" integer,
	"response_tokens" integer,
	"total_tokens" integer,
	"prompt_chars" integer,
	"response_chars" integer,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "api_call_logs_story_created_idx"
	ON "api_call_logs" ("story_id","created_at");
CREATE INDEX IF NOT EXISTS "api_call_logs_service_created_idx"
	ON "api_call_logs" ("service_id","created_at");
CREATE INDEX IF NOT EXISTS "api_call_logs_status_created_idx"
	ON "api_call_logs" ("status","created_at");
