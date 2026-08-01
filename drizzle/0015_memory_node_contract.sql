create temporary table _mtherios_0015_repair_versions on commit drop as
with affected_stories as (
	select story.id
	from stories as story
	where exists (
		select 1
		from memory_nodes as memory
		where memory.story_id = story.id
			and (
				memory.type not in ('hot', 'canonical', 'episodic', 'plot_ledger', 'npc_belief', 'faction', 'procedural')
				or memory.importance < 0
				or memory.importance > 1
			)
	) or exists (
		select 1
		from continuity_warnings as warning
		where warning.story_id = story.id
			and (
				warning.level not in ('info', 'warning', 'error')
				or warning.status not in ('open', 'resolved', 'dismissed')
			)
	) or exists (
		select 1
		from entity_aliases as alias
		where alias.story_id = story.id
			and alias.normalized_alias <> trim(regexp_replace(lower(alias.alias), '[^a-z0-9]+', ' ', 'g'))
	)
), bumped_stories as (
	update stories as story
	set server_version = story.server_version + 1,
		updated_at = now()
	from affected_stories as affected
	where story.id = affected.id
	returning story.id, story.server_version
)
select id, server_version from bumped_stories;

update memory_nodes as memory
set type = case
		when lower(trim(memory.type)) in ('seed_policy', 'canon_policy', 'policy', 'rules') then 'procedural'
		when lower(trim(memory.type)) in ('event', 'scene') then 'episodic'
		when lower(trim(memory.type)) in ('plot', 'plot_thread') then 'plot_ledger'
		when lower(trim(memory.type)) in ('belief', 'npc_memory') then 'npc_belief'
		when lower(trim(memory.type)) = 'faction_memory' then 'faction'
		when lower(trim(memory.type)) in ('recent', 'working') then 'hot'
		else 'canonical'
	end,
	importance = greatest(0, least(1, case when memory.importance > 1 then memory.importance / 10 else memory.importance end)),
	metadata = case
		when memory.type in ('hot', 'canonical', 'episodic', 'plot_ledger', 'npc_belief', 'faction', 'procedural') then memory.metadata
		else jsonb_set(coalesce(memory.metadata, '{}'::jsonb), '{normalizedMemoryTypeFrom}', to_jsonb(memory.type), true)
	end,
	server_version = version.server_version,
	updated_at = now()
from _mtherios_0015_repair_versions as version
where memory.story_id = version.id
	and (
		memory.type not in ('hot', 'canonical', 'episodic', 'plot_ledger', 'npc_belief', 'faction', 'procedural')
		or memory.importance < 0
		or memory.importance > 1
	);

update continuity_warnings as warning
set level = case lower(trim(warning.level))
		when 'low' then 'info'
		when 'critical' then 'error'
		else 'warning'
	end,
	status = case when warning.status in ('open', 'resolved', 'dismissed') then warning.status else 'open' end,
	metadata = coalesce(warning.metadata, '{}'::jsonb)
		|| case when warning.level not in ('info', 'warning', 'error')
			then jsonb_build_object('normalizedContinuityLevelFrom', warning.level)
			else '{}'::jsonb end
		|| case when warning.status not in ('open', 'resolved', 'dismissed')
			then jsonb_build_object('normalizedContinuityStatusFrom', warning.status)
			else '{}'::jsonb end,
	server_version = version.server_version,
	updated_at = now()
from _mtherios_0015_repair_versions as version
where warning.story_id = version.id
	and (
		warning.level not in ('info', 'warning', 'error')
		or warning.status not in ('open', 'resolved', 'dismissed')
	);

update entity_aliases as alias
set normalized_alias = trim(regexp_replace(lower(alias.alias), '[^a-z0-9]+', ' ', 'g')),
	server_version = version.server_version,
	updated_at = now()
from _mtherios_0015_repair_versions as version
where alias.story_id = version.id
	and alias.normalized_alias <> trim(regexp_replace(lower(alias.alias), '[^a-z0-9]+', ' ', 'g'));

alter table memory_nodes
	add constraint memory_nodes_type_check
	check (type in ('hot', 'canonical', 'episodic', 'plot_ledger', 'npc_belief', 'faction', 'procedural'));

alter table memory_nodes
	add constraint memory_nodes_importance_check
	check (importance >= 0 and importance <= 1);

alter table continuity_warnings
	add constraint continuity_warnings_level_check
	check (level in ('info', 'warning', 'error'));

alter table continuity_warnings
	add constraint continuity_warnings_status_check
	check (status in ('open', 'resolved', 'dismissed'));

alter table entity_aliases
	add constraint entity_aliases_normalized_alias_check
	check (normalized_alias = trim(regexp_replace(lower(alias), '[^a-z0-9]+', ' ', 'g')));
