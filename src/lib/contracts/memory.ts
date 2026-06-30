import { z } from 'zod';

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(jsonValueSchema),
	z.record(z.string(), jsonValueSchema),
]));

export const sourceRefsSchema = z.object({
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
});

export const sourceRefSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	sourceType: z.string().min(1),
	sourceId: z.string().min(1),
	targetTable: z.string().min(1),
	targetRecordId: z.string().min(1),
	targetRecordField: z.string().nullable().default(null),
	sourceField: z.string().nullable().default(null),
	confidence: z.number().min(0).max(1).default(1),
	rationale: z.string().nullable().default(null),
	notes: z.string().nullable().default(null),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const memoryVisibilitySchema = z.enum(['public', 'player_known', 'secret']);

export const factTypeSchema = z.enum([
	'observation',
	'event',
	'belief',
	'relationship',
	'warning',
	'identity',
	'proposal',
]);

export const factSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	type: factTypeSchema.default('observation'),
	subjectEntityId: z.string().nullable().default(null),
	targetEntityId: z.string().nullable().default(null),
	title: z.string(),
	statement: z.string(),
	confidence: z.number().min(0).max(1).default(1),
	status: z.enum(['active', 'superseded', 'rejected']).default('active'),
	visibility: memoryVisibilitySchema.default('player_known'),
	firstSeenEntryId: z.string().nullable().default(null),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.optional().default({}),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const jsonPatchOperationSchema = z.object({
	op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test', 'upsert', 'create', 'update', 'break', 'fulfill', 'expire']),
	path: z.string().min(1),
	from: z.string().optional(),
	value: z.unknown().optional(),
});

export const patchProposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'applied', 'needs_review']);

export const patchProposalSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	proposalType: z.string().min(1),
	targetTable: z.string().min(1),
	targetRecordId: z.string().min(1),
	proposedBy: z.string().min(1).default('llm'),
	operations: z.array(jsonPatchOperationSchema).default([]),
	reason: z.string().default(''),
	suggestion: z.string().default(''),
	status: patchProposalStatusSchema.default('pending'),
	decision: z.string().nullable().default(null),
	validatedBy: z.string().nullable().default(null),
	affectedEntityIds: z.array(z.string()).default([]),
	confidence: z.number().min(0).max(1).default(0.75),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.optional().default({}),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const continuityWarningSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	warningType: z.string().min(1),
	level: z.enum(['info', 'warning', 'error']).default('warning'),
	title: z.string(),
	status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
	details: z.string(),
	entityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	actorIds: z.array(z.string()).default([]),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	resolutionNotes: z.string().nullable().default(null),
	resolvedBy: z.string().nullable().default(null),
	resolvedAt: z.string().nullable().default(null),
	metadata: jsonObjectSchema.optional().default({}),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const syncMetaSchema = z.object({
	serverVersion: z.number().int().nonnegative(),
	updatedAt: z.string(),
});

const storyEventTypeEnumSchema = z.enum([
	'promise',
	'betrayal',
	'reveal',
	'faction_move',
	'injury',
	'death',
	'relationship_shift',
	'agreement',
	'scene_transition',
	'clue_discovery',
	'correction',
	'imported_memory',
	'world_tick',
	'scheme',
	'rumor',
	'marriage',
	'alliance',
]);

export const storyEventTypeSchema = z.preprocess(
	(value) => value === 'imported_lore_event' ? 'imported_memory' : value,
	storyEventTypeEnumSchema,
);

const memoryNodeTypeEnumSchema = z.enum([
	'hot',
	'canonical',
	'episodic',
	'plot_ledger',
	'npc_belief',
	'faction',
	'procedural',
]);

const importedLoreMemoryNodeTypes = new Set(['seed_index', 'source_attribution', 'source_digest']);
const importedLoreProceduralMemoryNodeTypes = new Set(['seed_policy']);

export const memoryNodeTypeSchema = z.preprocess(
	(value) => typeof value === 'string' && importedLoreProceduralMemoryNodeTypes.has(value)
		? 'procedural'
		: typeof value === 'string' && importedLoreMemoryNodeTypes.has(value) ? 'canonical' : value,
	memoryNodeTypeEnumSchema,
);

export const storyEventStatusSchema = z.enum(['proposed', 'scheduled', 'due', 'committed', 'cancelled']);

export const statePatchSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	operations: z.array(jsonPatchOperationSchema),
	reason: z.string().default(''),
	status: z.enum(['proposed', 'applied', 'rejected', 'needs_repair']),
	validationWarnings: z.array(z.string()).default([]),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const storyEventSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	type: storyEventTypeSchema,
	status: storyEventStatusSchema.default('committed'),
	title: z.string(),
	body: z.string(),
	actorEntityIds: z.array(z.string()).default([]),
	targetEntityIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().default(null),
	locationIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema.default('player_known'),
	createdTurn: z.number().int().nonnegative().default(0),
	occurredTurn: z.number().int().nonnegative().nullable().default(null),
	scheduledTurn: z.number().int().nonnegative().nullable().default(null),
	worldTime: z.string().nullable().default(null),
	memoryImpact: jsonObjectSchema.default({}),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.optional(),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const npcEventLinkRoleSchema = z.enum(['actor', 'target', 'witness', 'affected', 'knower']);

export const npcEventLinkSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	eventId: z.string(),
	npcEntityId: z.string(),
	role: npcEventLinkRoleSchema.default('affected'),
	visibility: memoryVisibilitySchema.default('player_known'),
	evidenceStrength: z.number().min(0).max(1).default(0.75),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const gmTimelineBriefEventSchema = z.object({
	id: z.string(),
	type: storyEventTypeSchema,
	status: storyEventStatusSchema,
	title: z.string(),
	body: z.string(),
	turnsUntilDue: z.number().int().nullable().default(null),
	worldTime: z.string().nullable().default(null),
	npcEntityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	locationIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema.default('player_known'),
});

export const gmTimelineNpcEventSchema = z.object({
	npcEntityId: z.string(),
	eventIds: z.array(z.string()).default([]),
	summary: z.string(),
	visibility: memoryVisibilitySchema,
});

export const gmTimelineBriefSchema = z.object({
	storyId: z.string(),
	currentTurn: z.number().int().nonnegative().default(0),
	currentWorldTime: z.string().nullable().default(null),
	dueEvents: z.array(gmTimelineBriefEventSchema).default([]),
	recentEvents: z.array(gmTimelineBriefEventSchema).default([]),
	scheduledEvents: z.array(gmTimelineBriefEventSchema).default([]),
	npcEvents: z.array(gmTimelineNpcEventSchema).default([]),
});

export const memoryNodeSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	type: memoryNodeTypeSchema,
	title: z.string(),
	content: z.string(),
	summary: z.string().nullable().default(null),
	keywords: z.array(z.string()).default([]),
	entityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().default(null),
	visibility: memoryVisibilitySchema.default('player_known'),
	importance: z.number().min(0).max(1).default(0.5),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonValueSchema.optional(),
	score: z.number().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const memoryRetrievalTraceItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	type: memoryNodeTypeSchema,
	rank: z.number().int().nonnegative(),
	score: z.number(),
	included: z.boolean(),
	reason: z.string(),
	tokenEstimate: z.number().int().nonnegative(),
	ageDays: z.number().int().nonnegative().nullable().default(null),
	importance: z.number().min(0).max(1),
	visibility: memoryVisibilitySchema.default('player_known'),
	entityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	signals: z.array(z.string()).default([]),
});

export const retrievedMemoryPacketSchema = z.object({
	storyId: z.string(),
	query: z.string(),
	packet: z.string(),
	nodes: z.array(memoryNodeSchema),
	tokenEstimate: z.number().int().nonnegative(),
	retrievalDebug: z.array(z.string()).default([]),
	retrievalTrace: z.array(memoryRetrievalTraceItemSchema).default([]),
});

export const storyStartWorkflowSchema = z.object({
	sourceMode: z.enum(['blank', 'lorebook', 'character_card', 'import', 'transcript', 'source_notes']).default('blank'),
	sourceCount: z.number().int().nonnegative().default(0),
	requiresCanonReview: z.boolean().default(true),
	startingSceneReady: z.boolean().default(false),
	notes: z.string().trim().max(2000).nullable().optional(),
});

export const createStoryRequestSchema = z.object({
	title: z.string().min(1),
	description: z.string().nullable().optional(),
	genre: z.string().nullable().optional(),
	mode: z.enum(['adventure', 'creative-writing']).default('adventure'),
	settings: jsonObjectSchema.nullable().optional(),
	headerPrompt: z.string().nullable().optional(),
	playerReputation: z.string().nullable().optional(),
	clientStoryId: z.string().optional(),
	startWorkflow: storyStartWorkflowSchema.optional(),
});

export const createStoryResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
});

export const storyDeleteRequestSchema = z.object({
	mode: z.enum(['archive', 'purge']).default('purge'),
	exportBeforeDelete: z.boolean().default(false),
});

export const storyDeleteResponseSchema = z.object({
	ok: z.boolean(),
	storyId: z.string(),
	mode: z.enum(['archive', 'purge']).default('purge'),
	canonDeleted: z.boolean().default(false),
	artifactCleanup: jsonObjectSchema.nullable().default(null),
	warnings: z.array(z.string()).default([]),
});

export const bootstrapResponseSchema = z.object({
	story: jsonObjectSchema,
	serverVersion: z.number().int().nonnegative(),
	entries: z.array(jsonObjectSchema),
	entryCount: z.number().int().nonnegative().default(0),
	entities: z.array(jsonObjectSchema),
	relationships: z.array(jsonObjectSchema).default([]),
	factions: z.array(jsonObjectSchema),
	factionMemberships: z.array(jsonObjectSchema).default([]),
	factionResources: z.array(jsonObjectSchema).default([]),
	factionGoals: z.array(jsonObjectSchema).default([]),
	factionProjects: z.array(jsonObjectSchema).default([]),
	agreements: z.array(jsonObjectSchema),
	npcBeliefs: z.array(jsonObjectSchema).default([]),
	threads: z.array(jsonObjectSchema),
	chapters: z.array(jsonObjectSchema).default([]),
	arcs: z.array(jsonObjectSchema).default([]),
	sagas: z.array(jsonObjectSchema).default([]),
	recentEvents: z.array(storyEventSchema),
	recentPatches: z.array(statePatchSchema),
	memoryNodes: z.array(memoryNodeSchema),
	projection: z.object({
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
		vault: z.object({
			vaultPath: z.string(),
			fileCount: z.number().int().nonnegative().default(0),
			lastIndexedVersion: z.number().int().nonnegative().default(0),
			manifestHash: z.string().nullable().optional(),
			updatedAt: z.string().nullable().optional(),
		}),
		cache: z.object({
			storyId: z.string().nullable().default(null),
			entryCount: z.number().int().nonnegative().default(0),
			hitCount: z.number().int().nonnegative().default(0),
			missCount: z.number().int().nonnegative().default(0),
			tokenEstimate: z.number().int().nonnegative().default(0),
			byKind: z.array(z.object({
				kind: z.string(),
				entryCount: z.number().int().nonnegative().default(0),
				hitCount: z.number().int().nonnegative().default(0),
				missCount: z.number().int().nonnegative().default(0),
				invalidatedCount: z.number().int().nonnegative().default(0),
				tokenEstimate: z.number().int().nonnegative().default(0),
			})).default([]),
			segments: z.array(z.object({
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
			})).default([]),
		}),
	}).optional(),
});

export const storyEntriesPageResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	entries: z.array(jsonObjectSchema),
	entryCount: z.number().int().nonnegative().default(0),
	hasMore: z.boolean().default(false),
	nextBeforePosition: z.number().int().nullable().default(null),
});

export const entityUpsertRequestSchema = z.object({
	entry: jsonObjectSchema,
});

export const entityCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	entity: jsonObjectSchema,
	resolvedCharacterReferences: z.array(z.object({
		proposalId: z.string(),
		name: z.string(),
		entityId: z.string(),
	})).optional(),
});

export const entityDeleteResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	entityId: z.string(),
	deleted: z.boolean(),
});

export const chapterUpsertRequestSchema = z.object({
	chapter: jsonObjectSchema,
});

export const chapterCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	chapter: jsonObjectSchema,
});

export const chapterDeleteRequestSchema = z.object({
	chapterId: z.string().min(1),
});

export const chapterDeleteResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	chapterId: z.string(),
	deleted: z.boolean(),
	unwrappedArcIds: z.array(z.string()).default([]),
	unwrappedArcs: z.array(jsonObjectSchema).default([]),
});

export const arcUpsertRequestSchema = z.object({
	arc: jsonObjectSchema,
});

export const arcCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	arc: jsonObjectSchema,
});

export const arcDeleteRequestSchema = z.object({
	arcId: z.string().min(1),
});

export const arcDeleteResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	arcId: z.string(),
	deleted: z.boolean(),
});

export const contextCheckpointCreateRequestSchema = z.object({
	label: z.string().trim().min(1).max(120).optional(),
	reason: z.string().trim().max(2000).nullable().optional(),
});

export const contextCheckpointRevertRequestSchema = z.object({
	checkpointId: z.string().min(1),
	reason: z.string().trim().max(2000).nullable().optional(),
});

export const contextCheckpointCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	checkpoint: jsonObjectSchema,
});

export const contextCheckpointListResponseSchema = z.object({
	storyId: z.string(),
	checkpoints: z.array(jsonObjectSchema),
});

export const contextCheckpointRevertResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	checkpoint: jsonObjectSchema,
	restoredCounts: jsonObjectSchema.default({}),
});

export const sagaUpsertRequestSchema = z.object({
	saga: jsonObjectSchema,
});

export const sagaCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	saga: jsonObjectSchema,
});

export const livingMemoryKindSchema = z.enum([
	'conversationMemory',
	'worldEvent',
	'factionAction',
	'rumor',
	'scheme',
]);

export const livingMemoryUpsertRequestSchema = z.object({
	kind: livingMemoryKindSchema,
	record: jsonObjectSchema.optional(),
	records: z.array(jsonObjectSchema).default([]),
});

export const livingMemoryCommandResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	kind: livingMemoryKindSchema,
	recordIds: z.array(z.string()),
	counts: jsonObjectSchema,
});

export const memoryRetrieveRequestSchema = z.object({
	storyId: z.string(),
	query: z.string().default(''),
	sceneEntityIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().optional(),
	threadIds: z.array(z.string()).default([]),
	currentFactionId: z.string().nullable().optional(),
	presentNpcIds: z.array(z.string()).default([]),
	sourceTypes: z.array(memoryNodeTypeSchema).optional(),
	includeSecret: z.boolean().default(false),
	tokenBudget: z.number().int().min(160).max(2400).default(1200),
});

export const syncOperationTypeSchema = z.enum([
	'create_entry',
	'delete_entry',
	'turn_command',
	'state_correction',
	'pin_memory',
	'merge_memory',
	'archive_memory',
	'import_bundle',
]);

export const syncOperationSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	type: syncOperationTypeSchema,
	payload: jsonObjectSchema,
	clientVersion: z.number().int().nonnegative().default(0),
	clientCreatedAt: z.string(),
});

export const syncPushRequestSchema = z.object({
	storyId: z.string(),
	localVersion: z.number().int().nonnegative().default(0),
	ops: z.array(syncOperationSchema),
});

export const syncChangeSchema = z.object({
	table: z.string(),
	id: z.string(),
	version: z.number().int().nonnegative(),
	op: z.enum(['upsert', 'delete']),
	row: z.unknown().nullable(),
});

export const syncPushResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	appliedOpIds: z.array(z.string()),
	rejected: z.array(z.object({ opId: z.string(), reason: z.string() })),
	repairItems: z.array(z.object({ opId: z.string(), reason: z.string(), payload: z.unknown() })),
	changes: z.array(syncChangeSchema),
});

export const syncPullRequestSchema = z.object({
	storyId: z.string(),
	since: z.number().int().nonnegative().default(0),
});

export const syncPullResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	changes: z.array(syncChangeSchema),
});

export const indexedDbImportRequestSchema = z.object({
	bundle: jsonObjectSchema,
	options: z.object({
		preserveIds: z.boolean().default(true),
		rebuildMemoryNodes: z.boolean().default(true),
	}).default({ preserveIds: true, rebuildMemoryNodes: true }),
});

export const indexedDbImportResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	counts: z.record(z.string(), z.number().int().nonnegative()),
	skipped: z.array(z.object({ table: z.string(), id: z.string().optional(), reason: z.string() })),
	merged: z.array(z.object({ table: z.string(), sourceId: z.string(), targetId: z.string() })),
});

export const turnRequestSchema = z.object({
	storyId: z.string(),
	clientTurnId: z.string(),
	playerText: z.string().min(1),
	localVersion: z.number().int().nonnegative().default(0),
	providerProfile: z.object({
		id: z.string().optional(),
		name: z.string().optional(),
		providerType: z.string(),
		baseUrl: z.string().optional(),
		apiKey: z.string().default(''),
		customModels: z.array(z.string()).optional().default([]),
		fetchedModels: z.array(z.string()).optional().default([]),
		reasoningModels: z.array(z.string()).optional().default([]),
		hiddenModels: z.array(z.string()).optional().default([]),
		favoriteModels: z.array(z.string()).optional().default([]),
		createdAt: z.number().optional(),
	}).optional(),
	generation: z.object({
		model: z.string().optional(),
		temperature: z.number().min(0).max(2).default(1),
		maxTokens: z.number().int().min(128).max(65536).default(4096),
	}).optional(),
	clientContext: z.object({
		locationId: z.string().nullable().optional(),
		sceneEntityIds: z.array(z.string()).default([]),
		presentNpcIds: z.array(z.string()).default([]),
		threadIds: z.array(z.string()).default([]),
		currentFactionId: z.string().nullable().optional(),
		memoryTokenBudget: z.number().int().min(160).max(2400).optional(),
		contextBudget: z.number().int().min(0).max(200000).optional(),
		chapterThreshold: z.number().int().min(5).max(200).optional(),
		postChapterBuffer: z.number().int().min(0).max(100).optional(),
		chaptersPerArc: z.number().int().min(2).max(50).optional(),
		deferStateExtraction: z.boolean().optional(),
	}).optional(),
});

export const turnPerformanceSummarySchema = z.object({
	preparedCacheHit: z.boolean().default(false),
	prompt: z.object({
		tokenEstimate: z.number().int().nonnegative().default(0),
		totalChars: z.number().int().nonnegative().default(0),
		messageCount: z.number().int().nonnegative().default(0),
	}),
	cache: z.object({
		hitCount: z.number().int().nonnegative().default(0),
		missCount: z.number().int().nonnegative().default(0),
		tokenEstimate: z.number().int().nonnegative().default(0),
		segmentCount: z.number().int().nonnegative().default(0),
	}).nullable().default(null),
	generation: z.object({
		operationCount: z.number().int().nonnegative().default(0),
		durationMs: z.number().int().nonnegative().default(0),
		requestTokens: z.number().int().nonnegative().nullable().default(null),
		responseTokens: z.number().int().nonnegative().nullable().default(null),
		totalTokens: z.number().int().nonnegative().nullable().default(null),
	}),
	waterfall: z.object({
		turnId: z.string().nullable().default(null),
		storyId: z.string().nullable().default(null),
		model: z.string().nullable().default(null),
		profile: z.string().nullable().default(null),
		totalMs: z.number().int().nonnegative().default(0),
		frontendOutboxFlushMs: z.number().int().nonnegative().nullable().default(null),
		commandRouterMs: z.number().int().nonnegative().nullable().default(null),
		resolveNarrativeMs: z.number().int().nonnegative().default(0),
		retrieveMemoryPacketMs: z.number().int().nonnegative().default(0),
		loadDbContextMs: z.number().int().nonnegative().default(0),
		loadTimelineBriefMs: z.number().int().nonnegative().default(0),
		loadWikiContextMs: z.number().int().nonnegative().default(0),
		buildPromptMs: z.number().int().nonnegative().default(0),
		inputTokens: z.number().int().nonnegative().nullable().default(null),
		outputTokens: z.number().int().nonnegative().nullable().default(null),
		promptBytes: z.number().int().nonnegative().default(0),
		recentMessageCount: z.number().int().nonnegative().default(0),
		wikiChunkCount: z.number().int().nonnegative().default(0),
		memoryItemCount: z.number().int().nonnegative().default(0),
		providerTimeToFirstTokenMs: z.number().int().nonnegative().nullable().default(null),
		providerTotalMs: z.number().int().nonnegative().default(0),
		providerRetries: z.number().int().nonnegative().default(0),
		providerTimeoutHit: z.boolean().default(false),
		persistMs: z.number().int().nonnegative().default(0),
		stateExtractionMode: z.enum(['deferred', 'sync', 'none']).default('none'),
		stateExtractionMs: z.number().int().nonnegative().default(0),
		vaultAppendMs: z.number().int().nonnegative().default(0),
		projectionBuildMs: z.number().int().nonnegative().default(0),
		cacheHit: z.boolean().default(false),
		stablePromptHash: z.string().nullable().default(null),
		dynamicContextHash: z.string().nullable().default(null),
	}).partial().default({}),
	topSpans: z.array(z.object({
		operation: z.string(),
		durationMs: z.number().int().nonnegative(),
	})).default([]),
	slowTimings: z.array(z.object({
		operation: z.string(),
		durationMs: z.number().int().nonnegative(),
	})).default([]),
});

export const turnContextReceiptSchema = z.object({
	turnId: z.string(),
	storyId: z.string(),
	truncated: z.boolean().default(false),
	included: z.object({
		recentEntries: z.number().int().nonnegative().default(0),
		memoryNodes: z.number().int().nonnegative().default(0),
		wikiChunks: z.number().int().nonnegative().default(0),
		timelineEvents: z.number().int().nonnegative().default(0),
		chapters: z.number().int().nonnegative().default(0),
		arcs: z.number().int().nonnegative().default(0),
		chaptersSuppressedByArcs: z.number().int().nonnegative().default(0),
		chaptersSent: z.number().int().nonnegative().default(0),
		arcsSent: z.number().int().nonnegative().default(0),
		chaptersSuppressedByArc: z.number().int().nonnegative().default(0),
		memoryNodesSent: z.number().int().nonnegative().default(0),
		totalChars: z.number().int().nonnegative().default(0),
		totalTokens: z.number().int().nonnegative().nullable().default(null),
		facts: z.number().int().nonnegative().default(0),
		patchProposals: z.number().int().nonnegative().default(0),
		unresolvedCharacterReferences: z.number().int().nonnegative().default(0),
		continuityWarnings: z.number().int().nonnegative().default(0),
		factionSheets: z.array(z.string()).default([]),
	}),
	skipped: z.array(z.object({
		source: z.string(),
		reason: z.string(),
	})).default([]),
	unresolvedCharacterReferences: z.array(z.object({
		proposalId: z.string(),
		name: z.string(),
		contextLabel: z.string().default(''),
		reason: z.string().default(''),
		sourceEntryIds: z.array(z.string()).default([]),
	})).default([]),
	continuityLedger: z.object({
		facts: z.array(z.object({
			id: z.string(),
			statement: z.string(),
			sourceEntryIds: z.array(z.string()).default([]),
			sourcePatchIds: z.array(z.string()).default([]),
		})).default([]),
		patchProposals: z.array(z.object({
			id: z.string(),
			status: z.string(),
			proposalType: z.string(),
			targetTable: z.string(),
			targetRecordId: z.string(),
			reason: z.string().default(''),
			sourceEntryIds: z.array(z.string()).default([]),
			sourcePatchIds: z.array(z.string()).default([]),
		})).default([]),
		warnings: z.array(z.object({
			id: z.string(),
			level: z.string(),
			status: z.string(),
			title: z.string(),
			sourceEntryIds: z.array(z.string()).default([]),
			sourcePatchIds: z.array(z.string()).default([]),
		})).default([]),
	}).default({ facts: [], patchProposals: [], warnings: [] }),
	cacheSegments: z.array(z.object({
		kind: z.string(),
		cacheKey: z.string(),
		contentHash: z.string(),
		hit: z.boolean().default(false),
		invalidated: z.boolean().default(false),
		tokenEstimate: z.number().int().nonnegative().default(0),
		dependencyCount: z.number().int().nonnegative().default(0),
	})).default([]),
	budgets: z.object({
		memoryTokensUsed: z.number().int().nonnegative().default(0),
		memoryTokensMax: z.number().int().nonnegative().default(0),
		wikiCharsUsed: z.number().int().nonnegative().default(0),
		wikiCharsMax: z.number().int().nonnegative().default(0),
	}),
});

export const turnResponseSchema = z.object({
	narration: z.string(),
	entries: z.array(jsonObjectSchema).default([]),
	playerEntryId: z.string().nullable().default(null),
	assistantEntryId: z.string().nullable().default(null),
	statePatchIds: z.array(z.string()),
	eventIds: z.array(z.string()),
	retrievedMemoryIds: z.array(z.string()),
	memoryNodeIds: z.array(z.string()).default([]),
	serverVersion: z.number().int().nonnegative(),
	syncChanges: z.array(syncChangeSchema),
	warnings: z.array(z.string()).default([]),
	campaignVault: z.object({
		files: z.array(z.object({
			relativePath: z.string(),
			kind: z.string(),
			contentHash: z.string(),
			byteLength: z.number().int().nonnegative(),
		})).default([]),
	}).nullable().optional(),
	projection: z.object({
		mode: z.literal('control_surface'),
		entryLimit: z.number().int().positive(),
		counts: z.object({
			entries: z.number().int().nonnegative().default(0),
			entities: z.number().int().nonnegative().default(0),
			events: z.number().int().nonnegative().default(0),
			memoryNodes: z.number().int().nonnegative().default(0),
			chapters: z.number().int().nonnegative().default(0),
			arcs: z.number().int().nonnegative().default(0),
			sagas: z.number().int().nonnegative().default(0),
		}),
		cache: z.object({
			hitCount: z.number().int().nonnegative().default(0),
			missCount: z.number().int().nonnegative().default(0),
			tokenEstimate: z.number().int().nonnegative().default(0),
		}).nullable().default(null),
	}).nullable().optional(),
	generationTimings: z.array(z.object({
		operation: z.string(),
		serviceId: z.string().nullable().default(null),
		model: z.string().nullable().default(null),
		status: z.enum(['success', 'error']).default('success'),
		durationMs: z.number().int().nonnegative(),
		timeToFirstTokenMs: z.number().int().nonnegative().nullable().default(null),
		retryCount: z.number().int().nonnegative().default(0),
		finishReason: z.string().nullable().optional(),
		requestTokens: z.number().int().nonnegative().nullable().default(null),
		responseTokens: z.number().int().nonnegative().nullable().default(null),
		totalTokens: z.number().int().nonnegative().nullable().default(null),
	})).default([]),
	performance: turnPerformanceSummarySchema.nullable().default(null),
	contextReceipt: turnContextReceiptSchema.nullable().default(null),
});

export type StoryEventType = z.infer<typeof storyEventTypeSchema>;
export type MemoryNodeType = z.infer<typeof memoryNodeTypeSchema>;
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;
export type StoryEventStatus = z.infer<typeof storyEventStatusSchema>;
export type StatePatch = z.infer<typeof statePatchSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type FactType = z.infer<typeof factTypeSchema>;
export type Fact = z.infer<typeof factSchema>;
export type PatchProposalStatus = z.infer<typeof patchProposalStatusSchema>;
export type PatchProposal = z.infer<typeof patchProposalSchema>;
export type ContinuityWarning = z.infer<typeof continuityWarningSchema>;
export type StoryEvent = z.infer<typeof storyEventSchema>;
export type NpcEventLinkRole = z.infer<typeof npcEventLinkRoleSchema>;
export type NpcEventLink = z.infer<typeof npcEventLinkSchema>;
export type GmTimelineBriefEvent = z.infer<typeof gmTimelineBriefEventSchema>;
export type GmTimelineNpcEvent = z.infer<typeof gmTimelineNpcEventSchema>;
export type GmTimelineBrief = z.infer<typeof gmTimelineBriefSchema>;
export type MemoryNode = z.infer<typeof memoryNodeSchema>;
export type MemoryRetrievalTraceItem = z.infer<typeof memoryRetrievalTraceItemSchema>;
export type RetrievedMemoryPacket = z.infer<typeof retrievedMemoryPacketSchema>;
export type TurnContextReceipt = z.infer<typeof turnContextReceiptSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type StoryEntriesPageResponse = z.infer<typeof storyEntriesPageResponseSchema>;
export type EntityCommandResponse = z.infer<typeof entityCommandResponseSchema>;
export type EntityDeleteResponse = z.infer<typeof entityDeleteResponseSchema>;
export type ChapterCommandResponse = z.infer<typeof chapterCommandResponseSchema>;
export type ChapterDeleteResponse = z.infer<typeof chapterDeleteResponseSchema>;
export type ArcCommandResponse = z.infer<typeof arcCommandResponseSchema>;
export type ArcDeleteResponse = z.infer<typeof arcDeleteResponseSchema>;
export type ContextCheckpointCommandResponse = z.infer<typeof contextCheckpointCommandResponseSchema>;
export type ContextCheckpointListResponse = z.infer<typeof contextCheckpointListResponseSchema>;
export type ContextCheckpointRevertResponse = z.infer<typeof contextCheckpointRevertResponseSchema>;
export type SagaCommandResponse = z.infer<typeof sagaCommandResponseSchema>;
export type LivingMemoryCommandResponse = z.infer<typeof livingMemoryCommandResponseSchema>;
export type MemoryRetrieveRequest = z.infer<typeof memoryRetrieveRequestSchema>;
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncChange = z.infer<typeof syncChangeSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type TurnPerformanceSummary = z.infer<typeof turnPerformanceSummarySchema>;
export type TurnResponse = z.infer<typeof turnResponseSchema>;
