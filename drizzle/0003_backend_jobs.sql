CREATE TABLE IF NOT EXISTS "backend_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "backend_jobs_story_status_idx" ON "backend_jobs" ("story_id","status");
CREATE INDEX IF NOT EXISTS "backend_jobs_type_status_idx" ON "backend_jobs" ("type","status");
CREATE INDEX IF NOT EXISTS "backend_jobs_run_after_idx" ON "backend_jobs" ("status","run_after");
