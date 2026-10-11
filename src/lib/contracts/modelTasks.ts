import { z } from 'zod';

/**
 * Model roles and task definitions shared by the server resolver and the settings UI.
 * A role names the profile most tasks inherit; a task is one operation that may run a
 * model. Task IDs are the persisted service IDs, so saved settings, receipts and API
 * call logs written before roles existed stay readable.
 */
export const modelRoleIds = ['gameMaster', 'classifier', 'summaries', 'decisions', 'authoring', 'image'] as const;
export type ModelRoleId = typeof modelRoleIds[number];

export interface ModelRoleDefinition {
	id: ModelRoleId;
	label: string;
	description: string;
	/** One of the four primary model controls. */
	primary: boolean;
	/** Task whose legacy settings row seeded this role during migration. */
	primaryTaskId: string;
	/** Never falls back to an environment default or another role. */
	requiresExplicitProfile: boolean;
	/** A profile must declare or imply this capability before tasks can run. */
	capability?: 'decisions' | 'image';
}

export const MODEL_ROLES: Record<ModelRoleId, ModelRoleDefinition> = {
	gameMaster: { id: 'gameMaster', label: 'GameMaster', description: 'Narrates turns, runs NPCs and the world, and answers on-demand research.', primary: true, primaryTaskId: 'narrative', requiresExplicitProfile: false },
	classifier: { id: 'classifier', label: 'Classifier', description: 'Extracts established changes from accepted narration and maintains continuity records.', primary: true, primaryTaskId: 'classifier', requiresExplicitProfile: false },
	summaries: { id: 'summaries', label: 'Summaries', description: 'Writes chapter and arc histories from source transcript; never establishes new events.', primary: true, primaryTaskId: 'memory', requiresExplicitProfile: false },
	decisions: { id: 'decisions', label: 'Decisions', description: 'Optional bounded NPC and faction choices through a supported decision model.', primary: true, primaryTaskId: 'actorDecision', requiresExplicitProfile: true, capability: 'decisions' },
	authoring: { id: 'authoring', label: 'Authoring', description: 'Optional authoring Assistant and bounded batch helpers.', primary: false, primaryTaskId: 'assistant', requiresExplicitProfile: true },
	image: { id: 'image', label: 'Image generation', description: 'Optional scene, portrait and cover images outside the turn workflow.', primary: false, primaryTaskId: 'imageGeneration', requiresExplicitProfile: true, capability: 'image' },
};

export type ModelTaskTrigger = 'every_turn' | 'turn_when_warranted' | 'background_job' | 'on_demand' | 'explicit_tool';

export interface ModelTaskDefinition {
	id: string;
	label: string;
	description: string;
	role: ModelRoleId;
	/** Server (or browser compatibility) owner of the handler. */
	owner: string;
	trigger: ModelTaskTrigger;
	contract: { input: string; output: string };
	defaultEnabled: boolean;
	/** Narration and classification continue when this task is disabled or unavailable. */
	optional: boolean;
	/** Task-specific generation bounds layered over the profile; omitted values come from the profile. */
	parameterDefaults: { temperature?: number; maxTokens?: number };
	/** Upper bound on provider requests for one invocation, including repairs and fallbacks. */
	budget: { maxRequests: number };
	status: 'active' | 'retired';
}

const task = (definition: ModelTaskDefinition) => definition;

export const MODEL_TASKS: Record<string, ModelTaskDefinition> = Object.fromEntries([
	task({ id: 'narrative', label: 'GameMaster narration', description: 'Main story generation and turn authority.', role: 'gameMaster', owner: 'server/turn/orchestrator', trigger: 'every_turn',
		contract: { input: 'server turn prompt packet', output: 'narration' }, defaultEnabled: true, optional: false, parameterDefaults: {}, budget: { maxRequests: 3 }, status: 'active' }),
	task({ id: 'classifier', label: 'Turn extraction', description: 'Extracts world-state changes established by accepted narration.', role: 'classifier', owner: 'server/jobs/processor extract_turn_state', trigger: 'every_turn',
		contract: { input: 'player action + accepted narration', output: 'WorldStateUpdate' }, defaultEnabled: true, optional: false, parameterDefaults: {}, budget: { maxRequests: 2 }, status: 'active' }),
	task({ id: 'gmToolPlanner', label: 'GameMaster tool planner', description: 'Plans bounded GM tool reads before narration when the turn needs them.', role: 'classifier', owner: 'server/engine/agentRuns', trigger: 'turn_when_warranted',
		contract: { input: 'turn context + tool catalog', output: 'tool calls' }, defaultEnabled: true, optional: true, parameterDefaults: {}, budget: { maxRequests: 6 }, status: 'active' }),
	task({ id: 'nameGeneration', label: 'Name candidates', description: 'Validated name candidates for the GM tool; never creates canon.', role: 'classifier', owner: 'server/engine/agentRuns generateNames', trigger: 'on_demand',
		contract: { input: 'naming request', output: 'name candidates' }, defaultEnabled: true, optional: true, parameterDefaults: {}, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'sceneImagePrompt', label: 'Scene image prompt', description: 'Composes the cast and visual prompt for an explicit scene image request.', role: 'classifier', owner: 'server/engine/sceneImagePrompt', trigger: 'explicit_tool',
		contract: { input: 'scene snapshot', output: 'image prompt' }, defaultEnabled: true, optional: true, parameterDefaults: {}, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'memory', label: 'Chapter summaries', description: 'Chronological chapter history from a frozen source window.', role: 'summaries', owner: 'server/jobs/summaryGeneration', trigger: 'background_job',
		contract: { input: 'source accounts window', output: 'chronological memory' }, defaultEnabled: true, optional: false, parameterDefaults: {}, budget: { maxRequests: 8 }, status: 'active' }),
	task({ id: 'arcCondensation', label: 'Arc summaries', description: 'Condenses ten validated chapters into an arc history.', role: 'summaries', owner: 'server/jobs/summaryGeneration', trigger: 'background_job',
		contract: { input: 'chapter accounts', output: 'chronological memory' }, defaultEnabled: true, optional: false, parameterDefaults: { temperature: 0.3, maxTokens: 4096 }, budget: { maxRequests: 8 }, status: 'active' }),
	task({ id: 'sagaCondensation', label: 'Saga summaries (retired)', description: 'Retired browser condensation; server saga rollups are deterministic.', role: 'summaries', owner: 'retired', trigger: 'background_job',
		contract: { input: 'none', output: 'none' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 0 }, status: 'retired' }),
	task({ id: 'characterUpdate', label: 'Character continuity', description: 'Typed continuity maintenance for chapter character proposals.', role: 'classifier', owner: 'server/engine/characterDrafts', trigger: 'background_job',
		contract: { input: 'chapter evidence + current character', output: 'character continuity proposals' }, defaultEnabled: true, optional: true, parameterDefaults: { temperature: 0.2, maxTokens: 4096 }, budget: { maxRequests: 2 }, status: 'active' }),
	task({ id: 'loreManagement', label: 'Lore management (retired)', description: 'Retired browser lorebook curation.', role: 'classifier', owner: 'retired', trigger: 'explicit_tool',
		contract: { input: 'none', output: 'none' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 0 }, status: 'retired' }),
	task({ id: 'entryRefinement', label: 'Entry refinement (retired)', description: 'Retired browser entry refinement.', role: 'classifier', owner: 'retired', trigger: 'explicit_tool',
		contract: { input: 'none', output: 'none' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 0 }, status: 'retired' }),
	task({ id: 'smallBrain', label: 'Lore Master research', description: 'On-demand read-only cited synthesis and canon review.', role: 'gameMaster', owner: 'server/engine/smallBrain', trigger: 'on_demand',
		contract: { input: 'question + scoped evidence', output: 'cited synthesis' }, defaultEnabled: true, optional: true, parameterDefaults: { temperature: 0.3, maxTokens: 1200 }, budget: { maxRequests: 2 }, status: 'active' }),
	task({ id: 'activeRecall', label: 'Adaptive GM research', description: 'Optional research pass when deterministic reads leave an open question (legacy ID).', role: 'gameMaster', owner: 'server/turn/orchestrator', trigger: 'turn_when_warranted',
		contract: { input: 'open question + read observations', output: 'research plan' }, defaultEnabled: false, optional: true, parameterDefaults: { temperature: 0.1, maxTokens: 900 }, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'strategicWorldBrain', label: 'World planning', description: 'Optional Director and faction planning with their own domain rules and cadence.', role: 'gameMaster', owner: 'server/factions/workflow, server/plotBrain/planner', trigger: 'background_job',
		contract: { input: 'world snapshot', output: 'bounded plans/forecasts' }, defaultEnabled: true, optional: true, parameterDefaults: { temperature: 0.45, maxTokens: 8192 }, budget: { maxRequests: 2 }, status: 'active' }),
	task({ id: 'dialogue', label: 'NPC dialogue pass', description: 'Optional second pass that revises quoted NPC speech; the GameMaster normally handles speech.', role: 'gameMaster', owner: 'server/turn/dialoguePass', trigger: 'turn_when_warranted',
		contract: { input: 'GM draft + speaker cards', output: 'replacement lines' }, defaultEnabled: false, optional: true, parameterDefaults: { temperature: 0.7, maxTokens: 2048 }, budget: { maxRequests: 4 }, status: 'active' }),
	task({ id: 'continuityReview', label: 'Continuity audit', description: 'Optional shadow review of saved narration; deterministic checks always run.', role: 'gameMaster', owner: 'server/jobs/processor continuity_audit', trigger: 'background_job',
		contract: { input: 'narration + committed events', output: 'span-cited warnings' }, defaultEnabled: false, optional: true, parameterDefaults: { temperature: 0.1, maxTokens: 900 }, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'storySetupAssist', label: 'Story setup assist', description: 'Explicit new-story drafting help.', role: 'gameMaster', owner: 'browser/components/wizard', trigger: 'explicit_tool',
		contract: { input: 'setup fields', output: 'draft fields' }, defaultEnabled: true, optional: true, parameterDefaults: { temperature: 0.8, maxTokens: 2048 }, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'suggestions', label: 'Player suggestions', description: 'Optional player-visible action suggestions; never submits a turn.', role: 'gameMaster', owner: 'browser/services/ai/generation/SuggestionsService', trigger: 'explicit_tool',
		contract: { input: 'recent visible transcript', output: 'suggestions' }, defaultEnabled: true, optional: true, parameterDefaults: { temperature: 0.8, maxTokens: 2048 }, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'actorDecision', label: 'Decisions', description: 'Bounded NPC intentions and faction choices; never an applied outcome.', role: 'decisions', owner: 'server/turn/jev', trigger: 'turn_when_warranted',
		contract: { input: 'actor-scoped evidence + options', output: 'abstention or proposed choice' }, defaultEnabled: false, optional: true, parameterDefaults: { maxTokens: 700 }, budget: { maxRequests: 4 }, status: 'active' }),
	task({ id: 'assistant', label: 'Authoring Assistant', description: 'Project and game authoring conversations.', role: 'authoring', owner: 'server/engine/assistantConversations', trigger: 'explicit_tool',
		contract: { input: 'conversation + scoped tools', output: 'reply + tool calls' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 12 }, status: 'active' }),
	task({ id: 'batchAuthoring', label: 'Batch authoring', description: 'Bounded batch helpers with a saved spend ceiling.', role: 'authoring', owner: 'server/engine/assistantBatchWorker', trigger: 'explicit_tool',
		contract: { input: 'assigned record snapshots', output: 'validated decisions' }, defaultEnabled: false, optional: true, parameterDefaults: { temperature: 0.3, maxTokens: 4096 }, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'imageGeneration', label: 'Image generation', description: 'Scene, portrait and cover images.', role: 'image', owner: 'server/engine/imageJobs', trigger: 'explicit_tool',
		contract: { input: 'image prompt', output: 'image asset' }, defaultEnabled: true, optional: true, parameterDefaults: {}, budget: { maxRequests: 1 }, status: 'active' }),
	task({ id: 'worldSimulation', label: 'World simulation (retired)', description: 'Retired browser world simulation.', role: 'gameMaster', owner: 'retired', trigger: 'background_job',
		contract: { input: 'none', output: 'none' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 0 }, status: 'retired' }),
	task({ id: 'styleReviewer', label: 'Style review (retired)', description: 'Retired style review service.', role: 'gameMaster', owner: 'retired', trigger: 'background_job',
		contract: { input: 'none', output: 'none' }, defaultEnabled: false, optional: true, parameterDefaults: {}, budget: { maxRequests: 0 }, status: 'retired' }),
].map(definition => [definition.id, definition]));

export function modelTaskDefinition(taskId: string): ModelTaskDefinition | null {
	return Object.hasOwn(MODEL_TASKS, taskId) ? MODEL_TASKS[taskId] : null;
}

export function activeModelTasks(role?: ModelRoleId): ModelTaskDefinition[] {
	return Object.values(MODEL_TASKS).filter(task => task.status === 'active' && (!role || task.role === role));
}

export function isRolePrimaryTask(taskId: string): boolean {
	return Object.values(MODEL_ROLES).some(role => role.primaryTaskId === taskId);
}

// ── Persisted documents ──

const generationSchema = z.object({
	temperature: z.number().min(0).max(2).nullable().optional(),
	maxTokens: z.number().int().min(128).max(65536).nullable().optional(),
	topP: z.number().min(0).max(1).nullable().optional(),
	frequencyPenalty: z.number().min(-2).max(2).nullable().optional(),
	presencePenalty: z.number().min(-2).max(2).nullable().optional(),
	reasoningEffort: z.string().min(1).nullable().optional(),
	contextBudget: z.number().int().positive().nullable().optional(),
}).strict();
export type ModelGenerationParameters = z.infer<typeof generationSchema>;
export const modelGenerationParametersSchema = generationSchema;

export const modelProfileSchema = z.object({
	id: z.string().min(1).max(120),
	name: z.string().trim().min(1).max(160),
	providerType: z.string().min(1),
	baseUrl: z.string().nullable().default(null),
	apiKeyRef: z.string().nullable().default(null),
	model: z.string().min(1),
	contextWindowTokens: z.number().int().min(1024).max(10_000_000).nullable().default(null),
	capabilities: z.object({ decisions: z.boolean().optional(), image: z.boolean().optional(), tools: z.boolean().optional() }).default({}),
	generation: generationSchema.default({}),
	metadata: z.record(z.string(), z.unknown()).default({}),
	revision: z.number().int().positive().default(1),
	updatedAt: z.string().optional(),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const modelRoleSettingSchema = z.object({
	role: z.enum(modelRoleIds),
	profileId: z.string().nullable().default(null),
	fallbackProfileIds: z.array(z.string()).default([]),
	metadata: z.record(z.string(), z.unknown()).default({}),
	revision: z.number().int().positive().default(1),
	updatedAt: z.string().optional(),
});
export type ModelRoleSetting = z.infer<typeof modelRoleSettingSchema>;

export const modelTaskOverrideSchema = z.object({
	taskId: z.string().min(1),
	/** Null inherits the role profile. */
	profileId: z.string().nullable().default(null),
	/** Null uses the task definition default. */
	enabled: z.boolean().nullable().default(null),
	parameters: generationSchema.default({}),
	systemPromptOverride: z.string().nullable().default(null),
	fallbackProfileIds: z.array(z.string()).default([]),
	budget: z.object({ maxRequests: z.number().int().min(0).max(100).optional() }).strict().default({}),
	metadata: z.record(z.string(), z.unknown()).default({}),
	revision: z.number().int().positive().default(1),
	updatedAt: z.string().optional(),
});
export type ModelTaskOverride = z.infer<typeof modelTaskOverrideSchema>;

export type ModelResolutionSource = 'task_override' | 'role' | 'environment' | 'none';

/** What actually resolved for a task: the effective profile and where each part came from. */
export interface ModelTaskProvenance {
	taskId: string;
	role: ModelRoleId;
	source: ModelResolutionSource;
	profileId: string | null;
	profileRevision: number | null;
	providerType: string | null;
	model: string | null;
	enabled: boolean;
	enabledSource: 'task_override' | 'task_default';
	overriddenParameters: string[];
	fallbackProfileIds: string[];
	limits: { maxTokens: number | null; contextWindowTokens: number | null; maxRequests: number };
	settingsRevision: string;
	status: 'ready' | 'disabled' | 'needs_configuration' | 'retired';
	reason: string | null;
}

/** Receipt form of ModelTaskProvenance; old receipts without it remain valid. */
export const modelTaskProvenanceSchema = z.object({
	taskId: z.string(),
	role: z.enum(modelRoleIds),
	source: z.enum(['task_override', 'role', 'environment', 'none']),
	profileId: z.string().nullable(),
	profileRevision: z.number().int().nullable(),
	providerType: z.string().nullable(),
	model: z.string().nullable(),
	enabled: z.boolean(),
	enabledSource: z.enum(['task_override', 'task_default']),
	overriddenParameters: z.array(z.string()),
	fallbackProfileIds: z.array(z.string()),
	limits: z.object({ maxTokens: z.number().nullable(), contextWindowTokens: z.number().nullable(), maxRequests: z.number() }),
	settingsRevision: z.string(),
	status: z.enum(['ready', 'disabled', 'needs_configuration', 'retired']),
	reason: z.string().nullable(),
});

export const modelSettingsSaveSchema = z.object({
	expectedRevision: z.string().min(1).optional(),
	profiles: z.array(modelProfileSchema.omit({ revision: true, updatedAt: true })).default([]),
	deleteProfileIds: z.array(z.string()).default([]),
	roles: z.array(modelRoleSettingSchema.omit({ revision: true, updatedAt: true })).default([]),
	/** A task listed here replaces its override; clearTaskIds returns tasks to full inheritance. */
	tasks: z.array(modelTaskOverrideSchema.omit({ revision: true, updatedAt: true })).default([]),
	clearTaskIds: z.array(z.string()).default([]),
	secrets: z.array(z.object({ ref: z.string().min(1), value: z.string().min(1) })).default([]),
}).strict();
export type ModelSettingsSave = z.infer<typeof modelSettingsSaveSchema>;
