CREATE TABLE story_image_cards (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  game_id text NOT NULL,
  client_turn_id text NOT NULL,
  call_id text NOT NULL,
  tool text NOT NULL CHECK (tool IN ('generateImage', 'generateFileImage')),
  asset_id text NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_image_cards_origin_unique UNIQUE (game_id, client_turn_id, call_id),
  CONSTRAINT story_image_cards_game_project_fk FOREIGN KEY (project_id, game_id)
    REFERENCES stories(shelf_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT story_image_cards_asset_project_fk FOREIGN KEY (project_id, asset_id)
    REFERENCES assets(project_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX story_image_cards_turn_idx ON story_image_cards(game_id, client_turn_id, created_at);

INSERT INTO story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied,created_at)
SELECT 'story_image_' || md5(r.id || ':' || t.call_id),r.project_id,r.game_id,r.client_turn_id,
  t.call_id,t.tool,a.id,coalesce((j.metadata->'imageResult'->>'applied')::boolean,false),t.created_at
FROM agent_tool_calls t
JOIN agent_runs r ON r.id=t.run_id
JOIN backend_jobs j ON j.id=t.result->>'jobId' AND j.project_id=r.project_id AND j.story_id=r.game_id
JOIN assets a ON a.origin_job_id=j.id AND a.project_id=r.project_id AND a.game_id=r.game_id
WHERE r.status='completed' AND t.status='completed' AND t.tool IN ('generateImage','generateFileImage')
  AND j.status='complete' AND a.visibility='public'
  AND j.payload->'origin'->>'runId'=r.id AND j.payload->'origin'->>'callId'=t.call_id
ON CONFLICT (game_id,client_turn_id,call_id) DO NOTHING;
