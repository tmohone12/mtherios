import { z } from 'zod';
import { jsonObjectSchema, memoryVisibilitySchema, storyEventTypeSchema } from './memory';
import { smallBrainModeSchema, smallBrainResultSchema } from '../services/ai/sdk/schemas/smallBrain';

export const llmServiceSettingSchema = z.object({
	serviceId: z.string().min(1),
	providerType: z.string().min(1),
	baseUrl: z.string().nullable().default(null),
	model: z.string().nullable().default(null),
	temperature: z.number().min(0).max(2).default(1),
	maxTokens: z.number().int().min(128).max(65536).default(4096),
	topP: z.number().min(0).max(1).nullable().default(null),
	frequencyPenalty: z.number().min(-2).max(2).nullable().default(null),
	presencePenalty: z.number().min(-2).max(2).nullable().default(null),
	reasoningEffort: z.string().nullable().default(null),
	contextBudget: z.number().int().positive().nullable().default(null),
	enabled: z.boolean().default(true),
	systemPromptOverride: z.string().nullable().default(null),
	apiKeyRef: z.string().nullable().default(null),
	metadata: jsonObjectSchema.default({}),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

export const llmServiceSettingPatchSchema = z.object({
	serviceId: z.string().min(1),
	providerType: z.string().min(1).optional(),
	baseUrl: z.string().nullable().optional(),
	model: z.string().nullable().optional(),
	temperature: z.number().min(0).max(2).optional(),
	maxTokens: z.number().int().min(128).max(65536).optional(),
	topP: z.number().min(0).max(1).nullable().optional(),
	frequencyPenalty: z.number().min(-2).max(2).nullable().optional(),
	presencePenalty: z.number().min(-2).max(2).nullable().optional(),
	reasoningEffort: z.string().nullable().optional(),
	contextBudget: z.number().int().positive().nullable().optional(),
	enabled: z.boolean().optional(),
	systemPromptOverride: z.string().nullable().optional(),
	apiKeyRef: z.string().nullable().optional(),
	metadata: jsonObjectSchema.optional(),
});

export const llmSecretRefSchema = z.object({
	ref: z.string().min(1),
	value: z.string().min(1),
});

export const llmSettingsPatchSchema = z.object({
	settings: z.array(llmServiceSettingPatchSchema).default([]),
	secrets: z.array(llmSecretRefSchema).default([]),
});

export const recordPatchRequestSchema = z.object({
	updates: jsonObjectSchema,
	reason: z.string().default('Manual explorer edit.'),
});

export const engineWorldRecordDetailArgsSchema = z.object({
	type: z.string().min(1),
	recordId: z.string().min(1),
});

export const engineWorldRecordPatchArgsSchema = engineWorldRecordDetailArgsSchema.extend({
	updates: jsonObjectSchema,
	reason: z.string().default('Manual explorer edit.'),
});

export const engineCharacterDraftUpdateArgsSchema = z.object({
	recordId: z.string().min(1),
	instructions: z.string().default('Update this NPC from recent story context.'),
	recentLimit: z.number().int().min(1).max(80).default(30),
});

export const worldRecordsQuerySchema = z.object({
	type: z.string().default('entities'),
	q: z.string().default(''),
	cursor: z.string().nullable().default(null),
	limit: z.number().int().min(1).max(200).default(50),
});

export const searchQuerySchema = z.object({
	q: z.string().default(''),
	type: z.string().nullable().default(null),
	limit: z.number().int().min(1).max(50).default(12),
	includeSemantic: z.boolean().default(true),
});

export const reindexStoryRequestSchema = z.object({
	storyId: z.string().min(1),
	runNow: z.boolean().default(false),
	recordTypes: z.array(z.string()).default([]),
	recreate: z.boolean().default(false),
	provider: z.string().nullable().default(null),
	model: z.string().nullable().default(null),
});

export const smallBrainRunRequestSchema = z.object({
	storyId: z.string().min(1),
	mode: smallBrainModeSchema,
	entryId: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
	dryRun: z.boolean().optional(),
}).strict();

export const smallBrainRunResponseSchema = z.object({
	ok: z.boolean(),
	storyId: z.string(),
	mode: smallBrainModeSchema,
	model: z.string(),
	result: smallBrainResultSchema.nullable(),
	warnings: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
	if (value.ok && value.result === null) {
		ctx.addIssue({
			code: 'custom',
			path: ['result'],
			message: 'Successful small-brain responses must include a result.',
		});
	}
	if (value.result !== null && value.mode !== value.result.mode) {
		ctx.addIssue({
			code: 'custom',
			path: ['mode'],
			message: 'Small-brain response mode must match result mode.',
		});
	}
});

export const engineRunDueJobsArgsSchema = z.object({
	workerId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).default(10),
	allStories: z.boolean().default(false),
});

export const engineRollupArcJobArgsSchema = z.object({
	workerId: z.string().min(1).optional(),
	runNow: z.boolean().default(true),
	chaptersPerArc: z.number().int().min(1).max(50).optional(),
});

export const engineJobStatusArgsSchema = z.object({
	limit: z.number().int().min(1).max(200).default(80),
	allStories: z.boolean().default(false),
});

export const engineStoryVaultSyncJobArgsSchema = z.object({
	workerId: z.string().min(1).optional(),
	runNow: z.boolean().optional(),
	allStories: z.boolean().default(false),
	includeFresh: z.boolean().default(false),
	index: z.boolean().default(false),
	recreate: z.boolean().default(false),
	dryRun: z.boolean().default(false),
	clean: z.boolean().default(true),
	lint: z.boolean().default(false),
	thinChars: z.number().nullable().default(null),
	orphanLayer: z.enum(['derived', 'all']).default('derived'),
	provider: z.string().nullable().default(null),
	model: z.string().nullable().default(null),
	limit: z.number().int().min(1).max(1000).default(500),
});

export const enginePromptPacketDebugArgsSchema = z.object({
	query: z.string().default('current scene'),
	tokenBudget: z.number().int().min(1).max(100000).default(1200),
});

export const apiCallLogCreateSchema = z.object({
	storyId: z.string().min(1).nullable().optional(),
	serviceId: z.string().min(1).nullable().optional(),
	operation: z.string().min(1),
	providerType: z.string().nullable().optional(),
	providerName: z.string().nullable().optional(),
	profileId: z.string().nullable().optional(),
	model: z.string().nullable().optional(),
	endpoint: z.string().nullable().optional(),
	status: z.enum(['success', 'error']).default('success'),
	durationMs: z.number().int().nonnegative(),
	requestTokens: z.number().int().nonnegative().nullable().optional(),
	responseTokens: z.number().int().nonnegative().nullable().optional(),
	totalTokens: z.number().int().nonnegative().nullable().optional(),
	promptChars: z.number().int().nonnegative().nullable().optional(),
	responseChars: z.number().int().nonnegative().nullable().optional(),
	error: z.string().nullable().optional(),
	metadata: jsonObjectSchema.default({}),
});

export const apiCallLogListArgsSchema = z.object({
	storyId: z.string().min(1).nullable().optional(),
	status: z.string().min(1).nullable().optional(),
	serviceId: z.string().min(1).nullable().optional(),
	limit: z.number().int().min(1).max(200).default(100),
});

export const campaignVaultStatusSchema = z.object({
	vaultPath: z.string(),
	fileCount: z.number().int().nonnegative().default(0),
	lastIndexedVersion: z.number().int().nonnegative().default(0),
	manifestHash: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});

export const engineCacheKindStatusSchema = z.object({
	kind: z.string(),
	entryCount: z.number().int().nonnegative().default(0),
	hitCount: z.number().int().nonnegative().default(0),
	missCount: z.number().int().nonnegative().default(0),
	invalidatedCount: z.number().int().nonnegative().default(0),
	tokenEstimate: z.number().int().nonnegative().default(0),
});

export const engineCacheSegmentDiagnosticsSchema = z.object({
	kind: z.string(),
	cacheKey: z.string(),
	contentHash: z.string(),
	tokenEstimate: z.number().int().nonnegative().default(0),
	hitCount: z.number().int().nonnegative().default(0),
	missCount: z.number().int().nonnegative().default(0),
	invalidatedCount: z.number().int().nonnegative().default(0),
	dependencyHashes: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.default({}),
	lastHitAt: z.string().nullable().default(null),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const engineCacheStatusSchema = z.object({
	storyId: z.string().nullable().default(null),
	entryCount: z.number().int().nonnegative().default(0),
	hitCount: z.number().int().nonnegative().default(0),
	missCount: z.number().int().nonnegative().default(0),
	tokenEstimate: z.number().int().nonnegative().default(0),
	byKind: z.array(engineCacheKindStatusSchema).default([]),
	segments: z.array(engineCacheSegmentDiagnosticsSchema).default([]),
});

export const campaignProjectionSchema = z.object({
	mode: z.literal('control_surface'),
	story: jsonObjectSchema,
	entries: z.array(jsonObjectSchema).default([]),
	entities: z.array(jsonObjectSchema).default([]),
	chapters: z.array(jsonObjectSchema).default([]),
	arcs: z.array(jsonObjectSchema).default([]),
	sagas: z.array(jsonObjectSchema).default([]),
	counts: z.object({
		entries: z.number().int().nonnegative().default(0),
		entities: z.number().int().nonnegative().default(0),
		events: z.number().int().nonnegative().default(0),
		memoryNodes: z.number().int().nonnegative().default(0),
		chapters: z.number().int().nonnegative().default(0),
		arcs: z.number().int().nonnegative().default(0),
		sagas: z.number().int().nonnegative().default(0),
	}),
	vault: campaignVaultStatusSchema,
	cache: engineCacheStatusSchema,
});

export const engineCommandRequestSchema = z.object({
	storyId: z.string().min(1),
	command: z.string().min(1),
	args: jsonObjectSchema.default({}),
	clientCommandId: z.string().min(1).optional(),
});

export const engineCampaignStatusArgsSchema = z.object({
	entryLimit: z.number().int().min(1).max(200).optional(),
	entityLimit: z.number().int().min(0).max(200).optional(),
	chapterLimit: z.number().int().min(1).max(200).optional(),
	arcLimit: z.number().int().min(1).max(200).optional(),
	sagaLimit: z.number().int().min(1).max(200).optional(),
});

export const engineCacheStatusArgsSchema = z.object({
	includeSegments: z.boolean().default(false),
	segmentLimit: z.number().int().min(1).max(100).default(25),
	kind: z.string().min(1).optional(),
});

export const engineCampaignPageReadArgsSchema = z.object({
	kind: z.string().min(1),
	name: z.string().min(1).nullable().optional(),
	path: z.string().min(1).nullable().optional(),
	missingOk: z.boolean().default(false),
});

export const engineCampaignPageWriteArgsSchema = z.object({
	kind: z.string().min(1),
	name: z.string().min(1),
	title: z.string().nullable().optional(),
	body: z.string().default(''),
	tags: z.array(z.string()).default([]),
	entityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	path: z.string().min(1).nullable().optional(),
	metadata: jsonObjectSchema.default({}),
	serverVersion: z.number().int().positive().optional(),
});

export const engineCampaignBootstrapArgsSchema = z.object({
	entryLimit: z.number().int().min(1).max(200).optional(),
	entityLimit: z.number().int().min(0).max(200).optional(),
	relationshipLimit: z.number().int().min(0).max(400).optional(),
	factionLimit: z.number().int().min(0).max(200).optional(),
	factionMembershipLimit: z.number().int().min(0).max(400).optional(),
	factionResourceLimit: z.number().int().min(0).max(400).optional(),
	factionGoalLimit: z.number().int().min(0).max(400).optional(),
	factionProjectLimit: z.number().int().min(0).max(400).optional(),
	agreementLimit: z.number().int().min(0).max(200).optional(),
	npcBeliefLimit: z.number().int().min(0).max(200).optional(),
	threadLimit: z.number().int().min(0).max(200).optional(),
	chapterLimit: z.number().int().min(0).max(200).optional(),
	arcLimit: z.number().int().min(0).max(200).optional(),
	sagaLimit: z.number().int().min(0).max(100).optional(),
	eventLimit: z.number().int().min(0).max(200).optional(),
	patchLimit: z.number().int().min(0).max(200).optional(),
	memoryNodeLimit: z.number().int().min(0).max(200).optional(),
});

export const engineTranscriptPageArgsSchema = z.object({
	beforePosition: z.number().int().nullable().optional(),
	cursor: z.number().int().nullable().optional(),
	limit: z.number().int().min(1).max(200).optional(),
	branchId: z.string().nullable().optional(),
});

export const engineEntriesAroundArgsSchema = z.object({
	position: z.number().int(),
	radius: z.number().int().min(0).max(100).default(40),
});

export const engineEntityDeleteArgsSchema = z.object({
	entityId: z.string().min(1),
});

const timelineLimitSchema = z.number().int().min(0).max(200).optional();

export const engineTimelineBriefArgsSchema = z.object({
	currentTurn: z.number().int().nonnegative().optional(),
	presentNpcIds: z.array(z.string()).default([]),
	sceneEntityIds: z.array(z.string()).default([]),
	includeSecret: z.boolean().default(false),
	recentLimit: timelineLimitSchema,
	scheduledLimit: timelineLimitSchema,
	dueLimit: timelineLimitSchema,
	npcLimit: timelineLimitSchema,
	npcEventLimit: timelineLimitSchema,
});

export const engineTimelineScheduleArgsSchema = z.object({
	type: storyEventTypeSchema,
	title: z.string().min(1),
	body: z.string().min(1),
	delayTurns: z.number().int().nonnegative().default(0),
	currentTurn: z.number().int().nonnegative().optional(),
	currentWorldTime: z.string().nullable().optional(),
	worldTime: z.string().nullable().optional(),
	actorEntityIds: z.array(z.string()).default([]),
	targetEntityIds: z.array(z.string()).default([]),
	actorNpcEntityIds: z.array(z.string()).default([]),
	targetNpcEntityIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().optional(),
	locationIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema.default('player_known'),
	memoryImpact: jsonObjectSchema.default({}),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.default({}),
	serverVersion: z.number().int().positive().optional(),
});

export const engineTimelineAdvanceArgsSchema = z.object({
	delta: z.number().int().nonnegative().default(1),
	presentNpcIds: z.array(z.string()).default([]),
	sceneEntityIds: z.array(z.string()).default([]),
	includeSecret: z.boolean().default(false),
	recentLimit: timelineLimitSchema,
	scheduledLimit: timelineLimitSchema,
	dueLimit: timelineLimitSchema,
	npcLimit: timelineLimitSchema,
	npcEventLimit: timelineLimitSchema,
	serverVersion: z.number().int().positive().optional(),
});

export const engineOrchestratorAgentRoleSchema = z.enum([
	'dm_narrator',
	'rules_referee',
	'state_scribe',
	'lorekeeper',
	'lore_curator',
	'faction_simulator',
	'npc_memory',
	'continuity_auditor',
]);

export const engineOrchestratorModeSchema = z.enum([
	'turn',
	'world_tick',
	'audit',
	'memory',
	'lore_curation',
	'custom',
]);

export const engineOrchestratorContextSchema = z.object({
	locationId: z.string().nullable().optional(),
	sceneEntityIds: z.array(z.string()).default([]),
	presentNpcIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	currentFactionId: z.string().nullable().optional(),
	memoryTokenBudget: z.number().int().min(0).max(100000).optional(),
	contextBudget: z.number().int().min(1).max(1000000).optional(),
	includeSecret: z.boolean().default(false),
	currentTurn: z.number().int().nonnegative().optional(),
	entryLimit: z.number().int().min(1).max(200).optional(),
});

export const engineOrchestratorRunArgsSchema = z.object({
	mode: engineOrchestratorModeSchema.default('turn'),
	goal: z.string().min(1),
	playerText: z.string().min(1).optional(),
	clientTurnId: z.string().min(1).optional(),
	context: engineOrchestratorContextSchema.default({
		sceneEntityIds: [],
		presentNpcIds: [],
		threadIds: [],
		includeSecret: false,
	}),
	roles: z.array(engineOrchestratorAgentRoleSchema).optional(),
	execute: z.boolean().default(false),
	maxToolCalls: z.number().int().min(1).max(20).default(8),
});

export const engineCommandResponseSchema = z.object({
	commandId: z.string(),
	clientCommandId: z.string().nullable().default(null),
	storyId: z.string(),
	command: z.string(),
	status: z.enum(['queued', 'running', 'succeeded', 'failed']),
	result: z.unknown().nullable().default(null),
	projectionChanges: jsonObjectSchema.default({}),
	error: z.string().nullable().default(null),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type LlmServiceSetting = z.infer<typeof llmServiceSettingSchema>;
export type LlmServiceSettingPatch = z.infer<typeof llmServiceSettingPatchSchema>;
export type RecordPatchRequest = z.infer<typeof recordPatchRequestSchema>;
export type SmallBrainRunRequest = z.infer<typeof smallBrainRunRequestSchema>;
export type SmallBrainRunResponse = z.infer<typeof smallBrainRunResponseSchema>;
export type EngineWorldRecordDetailArgs = z.infer<typeof engineWorldRecordDetailArgsSchema>;
export type EngineWorldRecordPatchArgs = z.infer<typeof engineWorldRecordPatchArgsSchema>;
export type ApiCallLogCreate = z.infer<typeof apiCallLogCreateSchema>;
export type ApiCallLogListArgs = z.infer<typeof apiCallLogListArgsSchema>;
export type CampaignProjection = z.infer<typeof campaignProjectionSchema>;
export type CampaignVaultStatus = z.infer<typeof campaignVaultStatusSchema>;
export type EngineCacheSegmentDiagnostics = z.infer<typeof engineCacheSegmentDiagnosticsSchema>;
export type EngineCacheStatus = z.infer<typeof engineCacheStatusSchema>;
export type EngineCommandRequest = z.infer<typeof engineCommandRequestSchema>;
export type EngineCommandResponse = z.infer<typeof engineCommandResponseSchema>;
export type EngineCampaignStatusArgs = z.infer<typeof engineCampaignStatusArgsSchema>;
export type EngineCacheStatusArgs = z.infer<typeof engineCacheStatusArgsSchema>;
export type EngineCampaignPageReadArgs = z.infer<typeof engineCampaignPageReadArgsSchema>;
export type EngineCampaignPageWriteArgs = z.infer<typeof engineCampaignPageWriteArgsSchema>;
export type EngineCampaignBootstrapArgs = z.infer<typeof engineCampaignBootstrapArgsSchema>;
export type EngineTranscriptPageArgs = z.infer<typeof engineTranscriptPageArgsSchema>;
export type EngineEntityDeleteArgs = z.infer<typeof engineEntityDeleteArgsSchema>;
export type EngineTimelineBriefArgs = z.infer<typeof engineTimelineBriefArgsSchema>;
export type EngineTimelineScheduleArgs = z.infer<typeof engineTimelineScheduleArgsSchema>;
export type EngineTimelineAdvanceArgs = z.infer<typeof engineTimelineAdvanceArgsSchema>;
export type EngineOrchestratorAgentRole = z.infer<typeof engineOrchestratorAgentRoleSchema>;
export type EngineOrchestratorMode = z.infer<typeof engineOrchestratorModeSchema>;
export type EngineOrchestratorContext = z.infer<typeof engineOrchestratorContextSchema>;
export type EngineOrchestratorRunArgs = z.infer<typeof engineOrchestratorRunArgsSchema>;
export type EngineRunDueJobsArgs = z.infer<typeof engineRunDueJobsArgsSchema>;
export type EngineRollupArcJobArgs = z.infer<typeof engineRollupArcJobArgsSchema>;
export type EngineJobStatusArgs = z.infer<typeof engineJobStatusArgsSchema>;
export type EngineStoryVaultSyncJobArgs = z.infer<typeof engineStoryVaultSyncJobArgsSchema>;
export type EnginePromptPacketDebugArgs = z.infer<typeof enginePromptPacketDebugArgsSchema>;
