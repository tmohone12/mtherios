-- Gameplay effect receipts: one row per typed consequence a turn's narration proposed
-- (damage, healing, conditions, item use and movement) and what the server did with it.
-- Additive. The state itself stays where it lives: HP and resources in a character's
-- `state.playerSheet`, conditions in `state.conditions`, items as item entities
-- (`state.ownerId`, `state.quantity`, `state.equipped`), campaign meters in
-- `stories.metadata.meters`. Existing campaigns are not re-extracted; their first
-- receipt is written by the next turn that changes one of these.
--
-- An applied effect is unique per (story, effect key), so a retried or re-run
-- extraction of the same passage reports `already_applied` instead of applying twice.
--
-- Rollback: drop table gameplay_effects;

create table gameplay_effects (
	id text primary key,
	story_id text not null references stories(id) on delete cascade,
	effect_key text not null,
	run_id text not null,
	source_entry_id text not null,
	source_position integer not null,
	op text not null,
	status text not null check (status in ('applied','already_applied','rejected','unresolved','no_change')),
	target_kind text check (target_kind in ('character','item','campaign')),
	target_id text,
	subject text,
	requested jsonb not null default '{}'::jsonb,
	before jsonb,
	after jsonb,
	revision integer,
	reason text,
	evidence jsonb not null default '{}'::jsonb,
	metadata jsonb not null default '{}'::jsonb,
	server_version integer not null,
	created_at timestamptz not null default now()
);
create unique index gameplay_effects_applied_key on gameplay_effects(story_id, effect_key) where status = 'applied';
create index gameplay_effects_source_idx on gameplay_effects(story_id, source_entry_id);
create index gameplay_effects_target_idx on gameplay_effects(story_id, target_id, subject, source_position) where status = 'applied';
