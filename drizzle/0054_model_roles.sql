-- Model profiles, role assignments and explicit task overrides.
-- llm_service_settings is retained unchanged as the rollback source; the server no longer reads or writes it.
create table model_profiles (
	id text primary key,
	name text not null,
	provider_type text not null,
	base_url text,
	api_key_ref text,
	model text not null,
	context_window_tokens integer,
	capabilities jsonb not null default '{}'::jsonb,
	generation jsonb not null default '{}'::jsonb,
	metadata jsonb not null default '{}'::jsonb,
	revision integer not null default 1,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table model_roles (
	role text primary key check (role in ('gameMaster', 'classifier', 'summaries', 'decisions', 'authoring', 'image')),
	profile_id text references model_profiles(id) on delete restrict,
	fallback_profile_ids jsonb not null default '[]'::jsonb,
	metadata jsonb not null default '{}'::jsonb,
	revision integer not null default 1,
	updated_at timestamptz not null default now()
);

create table model_task_overrides (
	task_id text primary key,
	profile_id text references model_profiles(id) on delete restrict,
	enabled boolean,
	parameters jsonb not null default '{}'::jsonb,
	system_prompt_override text,
	fallback_profile_ids jsonb not null default '[]'::jsonb,
	budget jsonb not null default '{}'::jsonb,
	metadata jsonb not null default '{}'::jsonb,
	revision integer not null default 1,
	updated_at timestamptz not null default now()
);

-- Frozen task catalog as of this migration (src/lib/contracts/modelTasks.ts may change later).
create temporary table _model_task_catalog (
	task_id text primary key, role text not null, default_enabled boolean not null,
	explicit_role boolean not null, default_temperature real, default_max_tokens integer
) on commit drop;
insert into _model_task_catalog values
	('narrative', 'gameMaster', true, false, null, null),
	('classifier', 'classifier', true, false, null, null),
	('memory', 'summaries', true, false, null, null),
	('arcCondensation', 'summaries', true, false, 0.3, 4096),
	('sagaCondensation', 'summaries', true, false, 0.25, 4096),
	('characterUpdate', 'classifier', true, false, 0.2, 4096),
	('loreManagement', 'classifier', true, false, 0.3, 4096),
	('entryRefinement', 'classifier', true, false, 0.4, 4096),
	('smallBrain', 'gameMaster', true, false, 0.3, 1200),
	('activeRecall', 'gameMaster', false, false, 0.1, 900),
	('strategicWorldBrain', 'gameMaster', true, false, 0.45, 8192),
	('dialogue', 'gameMaster', false, false, 0.7, 2048),
	('continuityReview', 'gameMaster', false, false, 0.1, 900),
	('storySetupAssist', 'gameMaster', true, false, 0.8, 2048),
	('suggestions', 'gameMaster', true, false, 0.8, 2048),
	('actorDecision', 'decisions', false, true, null, 700),
	('assistant', 'authoring', false, true, null, null),
	('batchAuthoring', 'authoring', false, true, 0.3, 4096),
	('imageGeneration', 'image', true, true, null, null);

-- Rows a user never saved: the old resolver inserted an enabled row for an optional
-- service merely by checking it. Those do not become settings. Retired IDs are not migrated.
create temporary table _legacy_model_rows on commit drop as
select l.*, c.role, c.default_enabled, c.explicit_role, c.default_temperature, c.default_max_tokens,
	-- Temperature and output size are usually task-specific; they become task parameters
	-- rather than splitting one model connection into several profiles.
	'profile_' || substr(md5(jsonb_build_array(l.provider_type, l.base_url, l.api_key_ref, l.model, l.context_window_tokens,
		l.top_p, l.frequency_penalty, l.presence_penalty, l.reasoning_effort)::text), 1, 16) as identity_id
from llm_service_settings l
join _model_task_catalog c on c.task_id = l.service_id
where l.model is not null and btrim(l.model) <> ''
	and not (coalesce(l.metadata->>'source', '') = 'terminal_default' and (c.explicit_role or not c.default_enabled));

-- A role is seeded from its primary task. Summaries previously fell back to the classifier
-- and then the GameMaster at run time; that effective choice is recorded explicitly here.
create temporary table _role_seeds on commit drop as
select r.role, seed.service_id as seed_task, seed.identity_id as profile_id
from (values
	('gameMaster', array['narrative']), ('classifier', array['classifier']), ('summaries', array['memory', 'classifier', 'narrative']),
	('decisions', array['actorDecision']), ('authoring', array['assistant']), ('image', array['imageGeneration'])
) as r(role, candidates)
cross join lateral (
	select lr.service_id, lr.identity_id
	from unnest(r.candidates) with ordinality as candidate(task_id, position)
	join _legacy_model_rows lr on lr.service_id = candidate.task_id
	order by candidate.position limit 1
) seed;

-- A task inherits its role when its connection and model match the role profile's.
create temporary table _task_profiles on commit drop as
select lr.service_id,
	case when seed.profile_id is not null
		and (lr.provider_type, coalesce(lr.base_url, ''), coalesce(lr.api_key_ref, ''), lr.model, coalesce(lr.context_window_tokens, -1))
			= (rp.provider_type, coalesce(rp.base_url, ''), coalesce(rp.api_key_ref, ''), rp.model, coalesce(rp.context_window_tokens, -1))
		then null else lr.identity_id end as override_profile_id,
	seed.profile_id as role_profile_id
from _legacy_model_rows lr
left join _role_seeds seed on seed.role = lr.role
left join _legacy_model_rows rp on rp.service_id = seed.seed_task;

insert into model_profiles (id, name, provider_type, base_url, api_key_ref, model, context_window_tokens, generation, metadata)
select distinct on (lr.identity_id) lr.identity_id,
	lr.model || ' · ' || lr.provider_type || coalesce(' · reasoning ' || lr.reasoning_effort, ''),
	lr.provider_type, lr.base_url, lr.api_key_ref, lr.model, lr.context_window_tokens,
	jsonb_strip_nulls(jsonb_build_object('temperature', lr.temperature, 'maxTokens', lr.max_tokens, 'topP', lr.top_p,
		'frequencyPenalty', lr.frequency_penalty, 'presencePenalty', lr.presence_penalty, 'reasoningEffort', lr.reasoning_effort)),
	jsonb_build_object('migratedFrom', 'llm_service_settings', 'firstTaskId', lr.service_id)
from _legacy_model_rows lr
where lr.identity_id in (select profile_id from _role_seeds union select override_profile_id from _task_profiles where override_profile_id is not null)
-- A role seed supplies its profile's generation defaults; other tasks diff against them.
order by lr.identity_id, (lr.service_id in (select seed_task from _role_seeds)) desc, lr.service_id;

insert into model_roles (role, profile_id, metadata)
select role, profile_id, jsonb_build_object('migratedFrom', 'llm_service_settings', 'seedTaskId', seed_task)
from _role_seeds;

-- Store only differences from what the task would inherit, so effective settings are
-- unchanged at migration time and identical copies become true inheritance.
insert into model_task_overrides (task_id, profile_id, enabled, parameters, system_prompt_override, metadata)
select diff.task_id, diff.profile_id, diff.enabled, diff.parameters, diff.system_prompt_override, diff.metadata
from (
	select lr.service_id as task_id, tp.override_profile_id as profile_id,
		case when lr.enabled is distinct from lr.default_enabled then lr.enabled end as enabled,
		'{}'::jsonb
			|| case when lr.temperature is distinct from coalesce(lr.default_temperature, (p.generation->>'temperature')::real) then jsonb_build_object('temperature', lr.temperature) else '{}'::jsonb end
			|| case when lr.max_tokens is distinct from coalesce(lr.default_max_tokens, (p.generation->>'maxTokens')::integer) then jsonb_build_object('maxTokens', lr.max_tokens) else '{}'::jsonb end
			|| case when lr.reasoning_effort is distinct from p.generation->>'reasoningEffort' then jsonb_build_object('reasoningEffort', lr.reasoning_effort) else '{}'::jsonb end
			|| case when lr.top_p is distinct from (p.generation->>'topP')::real then jsonb_build_object('topP', lr.top_p) else '{}'::jsonb end
			|| case when lr.frequency_penalty is distinct from (p.generation->>'frequencyPenalty')::real then jsonb_build_object('frequencyPenalty', lr.frequency_penalty) else '{}'::jsonb end
			|| case when lr.presence_penalty is distinct from (p.generation->>'presencePenalty')::real then jsonb_build_object('presencePenalty', lr.presence_penalty) else '{}'::jsonb end
			|| case when lr.context_budget is not null then jsonb_build_object('contextBudget', lr.context_budget) else '{}'::jsonb end
			as parameters,
		lr.system_prompt_override,
		jsonb_build_object('migratedFrom', 'llm_service_settings', 'legacyUpdatedAt', lr.updated_at)
			|| case when lr.metadata ? 'dialogueMode' then jsonb_build_object('dialogueMode', lr.metadata->'dialogueMode') else '{}'::jsonb end
			|| case when lr.metadata ? 'batchBudget' then jsonb_build_object('batchBudget', lr.metadata->'batchBudget') else '{}'::jsonb end
			|| case when lr.metadata ? 'agentBudget' then jsonb_build_object('agentBudget', lr.metadata->'agentBudget') else '{}'::jsonb end
			as metadata,
		lr.metadata ?| array['dialogueMode', 'batchBudget', 'agentBudget'] as has_task_metadata
	from _legacy_model_rows lr
	join _task_profiles tp on tp.service_id = lr.service_id
	left join model_profiles p on p.id = coalesce(tp.override_profile_id, tp.role_profile_id)
) diff
where diff.profile_id is not null or diff.enabled is not null or diff.parameters <> '{}'::jsonb
	or diff.system_prompt_override is not null or diff.has_task_metadata;
