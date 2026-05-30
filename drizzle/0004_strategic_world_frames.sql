CREATE TABLE IF NOT EXISTS "strategic_world_frames" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"arc_id" text REFERENCES "arcs"("id") ON DELETE set null,
	"arc_number" integer DEFAULT 0 NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"public_summary" text DEFAULT '' NOT NULL,
	"hidden_strategic_summary" text DEFAULT '' NOT NULL,
	"narrator_prompt_card" text DEFAULT '' NOT NULL,
	"fast_world_sim_instructions" text DEFAULT '' NOT NULL,
	"world_mood" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"continuity_assessment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"main_plots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subplots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"faction_goal_updates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheme_directives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategic_clocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rumor_seeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"world_event_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"canon_patch_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "strategic_world_frames_story_arc_idx" ON "strategic_world_frames" ("story_id","arc_number");
CREATE INDEX IF NOT EXISTS "strategic_world_frames_story_created_idx" ON "strategic_world_frames" ("story_id","created_at");
