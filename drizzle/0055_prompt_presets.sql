-- Named, versioned narrative prompt presets and explicit per-story selection.
create table prompt_presets (
	id text primary key,
	kind text not null default 'narrative' check (kind = 'narrative'),
	name text not null,
	description text not null default '',
	current_revision integer not null,
	-- Revision used by stories without a selection; changes only by an explicit default choice.
	default_revision integer,
	is_default boolean not null default false,
	archived_at timestamptz,
	metadata jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	check (not is_default or default_revision is not null)
);
create unique index prompt_presets_single_default on prompt_presets(kind) where is_default;

-- Immutable: an edit creates a new revision, so a pinned campaign never changes silently.
create table prompt_preset_revisions (
	preset_id text not null references prompt_presets(id) on delete restrict,
	revision integer not null check (revision > 0),
	document jsonb not null,
	note text not null default '',
	created_at timestamptz not null default now(),
	primary key (preset_id, revision)
);

-- A story's explicit choice; stories without a row use the default preset's default revision.
create table story_prompt_presets (
	story_id text primary key references stories(id) on delete cascade,
	preset_id text not null,
	revision integer not null,
	selected_at timestamptz not null default now(),
	metadata jsonb not null default '{}'::jsonb,
	foreign key (preset_id, revision) references prompt_preset_revisions(preset_id, revision) on delete restrict
);

-- BEGIN BUILT-IN NARRATIVE PRESET (frozen copy of BUILT_IN_NARRATIVE_PRESET at this migration)
insert into prompt_presets (id, name, description, current_revision, default_revision, is_default, metadata)
values ('narrative-builtin', 'Built-in narrator', 'The engine''s standard narrator instructions with the story''s preamble and genre pack.', 1, 1, false,
	jsonb_build_object('source', 'migration_0055'));
insert into prompt_preset_revisions (preset_id, revision, document, note)
values ('narrative-builtin', 1, $preset${"schemaVersion":1,"sections":[{"kind":"engine","id":"roleplay-authority","label":"Roleplay authority","engineBlock":"roleplayAuthority","enabled":true},{"kind":"engine","id":"context-priority","label":"Source priority and continuity","engineBlock":"contextPriority","enabled":true},{"kind":"text","id":"story-preamble","label":"Story preamble","template":"Story-specific preamble:\n{{story.preamble}}","literal":false,"enabled":true},{"kind":"text","id":"genre-pack","label":"Genre pack","template":"GM GENRE/PRESET PROMPT PACK: {{story.genrePackLabel}}\n{{story.genrePack}}","literal":false,"enabled":true},{"kind":"text","id":"gm-role","label":"GameMaster role","template":"You are the server-side GameMaster agent. Run the world and NPCs; render the turn in-world.","literal":false,"enabled":true},{"kind":"text","id":"prose","label":"Prose","template":"Keep prose concrete and clear; show consequences and room for the player to act.","literal":false,"enabled":true},{"kind":"text","id":"point-of-view","label":"Point of view","template":"Use hybrid POV: third-person limited for NPCs, world, and environment; second-person \"you\" only for direct sensory experience aimed at the player character. Never write the player character's actions, dialogue, decisions, thoughts, feelings, or internal monologue.","literal":false,"enabled":true},{"kind":"engine","id":"turn-header","label":"Turn header","engineBlock":"turnHeader","enabled":true},{"kind":"text","id":"in-world","label":"Stay in-world","template":"Stay in-world; do not explain craft choices.","literal":false,"enabled":true},{"kind":"text","id":"adjudication","label":"Adjudication","template":"Adjudicate the immediate player attempt against established canon, show consequences, and keep the player able to act next.","literal":false,"enabled":true},{"kind":"text","id":"pacing","label":"Pacing","template":"For travel, repairs, waiting, and off-screen reports, stop at the next actionable scene boundary. Do not roll weeks, multiple POVs, and arrival into one response unless explicitly asked.","literal":false,"enabled":true},{"kind":"text","id":"endings","label":"Endings","template":"Do not append ending choices, numbered options, menus, \"What do you do?\", or OOC prompts. End on an observable in-world situation with room for the player to act.","literal":false,"enabled":true},{"kind":"engine","id":"turn-workflow","label":"GameMaster workflow","engineBlock":"turnWorkflow","enabled":true},{"kind":"engine","id":"turn-boundary","label":"Turn boundary","engineBlock":"turnBoundary","enabled":true},{"kind":"engine","id":"npc-knowledge","label":"NPC knowledge","engineBlock":"npcKnowledge","enabled":true},{"kind":"engine","id":"npc-agency","label":"NPC agency","engineBlock":"npcAgency","enabled":true},{"kind":"engine","id":"npc-source-rule","label":"Secrets need a source","engineBlock":"npcSourceRule","enabled":true},{"kind":"engine","id":"economy-scale","label":"Economy scale (feudal pack)","engineBlock":"economyScale","enabled":true},{"kind":"engine","id":"world-scale","label":"World scale (feudal pack)","engineBlock":"worldScale","enabled":true},{"kind":"engine","id":"dice-rolls","label":"Dice rolls","engineBlock":"diceRolls","enabled":true}]}$preset$::jsonb, 'Reproduces the narrator instructions in use before presets.');
-- END BUILT-IN NARRATIVE PRESET

-- A saved global GameMaster prompt override replaced the built-in instructions for every story.
-- It becomes its own preset, reproducing that composition exactly, and the default.
insert into prompt_presets (id, name, description, current_revision, default_revision, is_default, metadata)
select 'narrative-migrated-override', 'Migrated custom narrator',
	'Your saved GameMaster prompt override, kept verbatim ahead of the locked core authority blocks.', 1, 1, true,
	jsonb_build_object('source', 'migration_0055', 'migratedFrom', 'model_task_overrides.narrative.system_prompt_override')
from model_task_overrides
where task_id = 'narrative' and system_prompt_override is not null and system_prompt_override ~ '\S';
insert into prompt_preset_revisions (preset_id, revision, document, note)
select 'narrative-migrated-override', 1, jsonb_build_object('schemaVersion', 1, 'sections', jsonb_build_array(
		jsonb_build_object('kind', 'text', 'id', 'custom-instructions', 'label', 'Custom instructions (migrated)',
			'template', regexp_replace(system_prompt_override, '^\s+|\s+$', '', 'g'), 'literal', true, 'enabled', true),
		jsonb_build_object('kind', 'engine', 'id', 'core-header', 'label', 'Core authority header', 'engineBlock', 'immutableCoreHeader', 'enabled', true),
		jsonb_build_object('kind', 'engine', 'id', 'outcome-authority', 'label', 'Player and GM authority', 'engineBlock', 'outcomeAuthority', 'enabled', true),
		jsonb_build_object('kind', 'engine', 'id', 'npc-agency', 'label', 'NPC agency', 'engineBlock', 'npcAgency', 'enabled', true),
		jsonb_build_object('kind', 'engine', 'id', 'turn-workflow', 'label', 'GameMaster workflow', 'engineBlock', 'turnWorkflow', 'enabled', true),
		jsonb_build_object('kind', 'engine', 'id', 'turn-boundary', 'label', 'Turn boundary', 'engineBlock', 'turnBoundary', 'enabled', true))),
	'Reproduces the saved global override composition.'
from model_task_overrides
where task_id = 'narrative' and system_prompt_override is not null and system_prompt_override ~ '\S';

update prompt_presets set is_default = true
where id = 'narrative-builtin' and not exists (select 1 from prompt_presets where id = 'narrative-migrated-override');
