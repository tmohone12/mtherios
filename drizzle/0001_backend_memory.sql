CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS stories (
	id text PRIMARY KEY,
	client_story_id text,
	title text NOT NULL,
	description text,
	genre text,
	mode text NOT NULL DEFAULT 'adventure',
	settings jsonb DEFAULT NULL,
	header_prompt text,
	current_location_id text,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_entries (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	type text NOT NULL,
	content text NOT NULL,
	position integer NOT NULL,
	parent_id text,
	branch_id text,
	metadata jsonb DEFAULT NULL,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entities (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	type text NOT NULL,
	name text NOT NULL,
	description text,
	status text NOT NULL DEFAULT 'active',
	visibility text NOT NULL DEFAULT 'player_known',
	state jsonb NOT NULL DEFAULT '{}'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entity_aliases (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
	alias text NOT NULL,
	normalized_alias text NOT NULL,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relationships (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	source_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
	target_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
	type text NOT NULL,
	label text,
	strength real NOT NULL DEFAULT 0.5,
	bidirectional boolean NOT NULL DEFAULT false,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS factions (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	entity_id text REFERENCES entities(id) ON DELETE CASCADE,
	name text NOT NULL,
	goals jsonb NOT NULL DEFAULT '[]'::jsonb,
	resources jsonb NOT NULL DEFAULT '{}'::jsonb,
	member_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	territory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	allies jsonb NOT NULL DEFAULT '[]'::jsonb,
	enemies jsonb NOT NULL DEFAULT '[]'::jsonb,
	pressure integer NOT NULL DEFAULT 0,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS npc_beliefs (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	believer_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
	subject_entity_id text,
	belief text NOT NULL,
	confidence real NOT NULL DEFAULT 0.5,
	visibility text NOT NULL DEFAULT 'secret',
	evidence_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agreements (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	parties jsonb NOT NULL DEFAULT '[]'::jsonb,
	category text NOT NULL,
	terms text NOT NULL,
	status text NOT NULL DEFAULT 'active',
	secrecy text NOT NULL DEFAULT 'known',
	consequences jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_threads (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	description text NOT NULL,
	status text NOT NULL DEFAULT 'open',
	significance text NOT NULL DEFAULT 'moderate',
	related_faction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	related_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	closed_at timestamptz,
	closure_reason text,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_events (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	type text NOT NULL,
	title text NOT NULL,
	body text NOT NULL,
	actor_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	target_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	location_id text,
	thread_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	visibility text NOT NULL DEFAULT 'player_known',
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS state_patches (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	operations jsonb NOT NULL DEFAULT '[]'::jsonb,
	reason text NOT NULL DEFAULT '',
	status text NOT NULL DEFAULT 'proposed',
	validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_nodes (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	type text NOT NULL,
	title text NOT NULL,
	content text NOT NULL,
	summary text,
	keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
	entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	faction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	thread_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	location_id text,
	visibility text NOT NULL DEFAULT 'player_known',
	importance real NOT NULL DEFAULT 0.5,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_patch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	embedding vector,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapters (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	number integer NOT NULL,
	title text,
	scene_outcome text NOT NULL DEFAULT '',
	irreversible_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
	npc_knowledge_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
	promises_debts_oaths jsonb NOT NULL DEFAULT '[]'::jsonb,
	discovered_clues jsonb NOT NULL DEFAULT '[]'::jsonb,
	relationship_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
	faction_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
	open_threads jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arcs (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	number integer NOT NULL,
	title text NOT NULL,
	summary text NOT NULL,
	chapter_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	open_thread_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	server_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_ops (
	id text PRIMARY KEY,
	story_id text NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
	type text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	client_version integer NOT NULL DEFAULT 0,
	status text NOT NULL DEFAULT 'applied',
	error text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stories_client_story_id_idx ON stories(client_story_id);
CREATE INDEX IF NOT EXISTS stories_updated_at_idx ON stories(updated_at);
CREATE INDEX IF NOT EXISTS story_entries_story_position_idx ON story_entries(story_id, position);
CREATE INDEX IF NOT EXISTS entities_story_type_idx ON entities(story_id, type);
CREATE INDEX IF NOT EXISTS entities_story_name_idx ON entities(story_id, name);
CREATE INDEX IF NOT EXISTS entity_aliases_story_alias_idx ON entity_aliases(story_id, normalized_alias);
CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships(story_id, source_entity_id);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships(story_id, target_entity_id);
CREATE INDEX IF NOT EXISTS factions_story_idx ON factions(story_id);
CREATE INDEX IF NOT EXISTS factions_entity_idx ON factions(entity_id);
CREATE INDEX IF NOT EXISTS npc_beliefs_believer_idx ON npc_beliefs(story_id, believer_entity_id);
CREATE INDEX IF NOT EXISTS agreements_story_status_idx ON agreements(story_id, status);
CREATE INDEX IF NOT EXISTS story_threads_story_status_idx ON story_threads(story_id, status);
CREATE INDEX IF NOT EXISTS story_events_story_type_idx ON story_events(story_id, type);
CREATE INDEX IF NOT EXISTS story_events_updated_at_idx ON story_events(updated_at);
CREATE INDEX IF NOT EXISTS state_patches_story_status_idx ON state_patches(story_id, status);
CREATE INDEX IF NOT EXISTS memory_nodes_story_type_idx ON memory_nodes(story_id, type);
CREATE INDEX IF NOT EXISTS memory_nodes_story_location_idx ON memory_nodes(story_id, location_id);
CREATE INDEX IF NOT EXISTS memory_nodes_fts_idx ON memory_nodes USING gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(summary, '')));
CREATE INDEX IF NOT EXISTS memory_nodes_title_trgm_idx ON memory_nodes USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS chapters_story_number_idx ON chapters(story_id, number);
CREATE INDEX IF NOT EXISTS arcs_story_number_idx ON arcs(story_id, number);
