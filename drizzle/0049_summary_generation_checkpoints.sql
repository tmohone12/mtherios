CREATE TABLE summary_generation_checkpoints (
    fingerprint text PRIMARY KEY,
    failure_fingerprint text NOT NULL,
    story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    kind text NOT NULL,
    stage text NOT NULL,
    dispatches_provider boolean NOT NULL DEFAULT true,
    status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    lease_owner text,
    lease_until timestamptz,
    result jsonb,
    failure jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT summary_checkpoint_state CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND result IS NULL)
      OR (status = 'complete' AND lease_owner IS NULL AND lease_until IS NULL AND result IS NOT NULL AND failure IS NULL)
      OR (status = 'failed' AND lease_owner IS NULL AND lease_until IS NULL AND result IS NULL AND failure IS NOT NULL)
    )
);
CREATE INDEX summary_generation_checkpoints_story_idx ON summary_generation_checkpoints(story_id, updated_at);
CREATE INDEX summary_generation_checkpoints_failure_idx ON summary_generation_checkpoints(story_id, failure_fingerprint);
