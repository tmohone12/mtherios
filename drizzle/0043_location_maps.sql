CREATE TABLE location_maps (
  location_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  map jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_maps_story_idx ON location_maps(story_id);

CREATE TABLE location_map_revisions (
  location_id text NOT NULL REFERENCES location_maps(location_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  actor jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, revision)
);
