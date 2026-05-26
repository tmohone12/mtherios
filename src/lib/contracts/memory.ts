import { z } from 'zod';

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const sourceRefsSchema = z.object({
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
});

export const syncMetaSchema = z.object({
	serverVersion: z.number().int().nonnegative(),
	updatedAt: z.string(),
});

export const storyEventTypeSchema = z.enum([
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
]);

export const memoryNodeTypeSchema = z.enum([
	'hot',
	'canonical',
	'episodic',
	'plot_ledger',
	'npc_belief',
	'faction',
	'procedural',
]);

export const memoryVisibilitySchema = z.enum(['public', 'player_known', 'secret']);

export const jsonPatchOperationSchema = z.object({
	op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test', 'upsert', 'create', 'update', 'break', 'fulfill', 'expire']),
	path: z.string().min(1),
	from: z.string().optional(),
	value: z.unknown().optional(),
});

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
	title: z.string(),
	body: z.string(),
	actorEntityIds: z.array(z.string()).default([]),
	targetEntityIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().default(null),
	threadIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema.default('player_known'),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
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
	score: z.number().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const retrievedMemoryPacketSchema = z.object({
	storyId: z.string(),
	query: z.string(),
	packet: z.string(),
	nodes: z.array(memoryNodeSchema),
	tokenEstimate: z.number().int().nonnegative(),
	retrievalDebug: z.array(z.string()).default([]),
});

export const createStoryRequestSchema = z.object({
	title: z.string().min(1),
	description: z.string().nullable().optional(),
	playerReputation: z.string().nullable().optional(),
	playerLedger: z.string().nullable().optional(),
	clientStoryId: z.string().optional(),
});

export const createStoryResponseSchema = z.object({
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
});

export const bootstrapResponseSchema = z.object({
	story: jsonObjectSchema,
	serverVersion: z.number().int().nonnegative(),
	entries: z.array(jsonObjectSchema),
	entities: z.array(jsonObjectSchema),
	factions: z.array(jsonObjectSchema),
	factionMemberships: z.array(jsonObjectSchema).default([]),
	factionResources: z.array(jsonObjectSchema).default([]),
	factionGoals: z.array(jsonObjectSchema).default([]),
	agreements: z.array(jsonObjectSchema),
	threads: z.array(jsonObjectSchema),
	recentEvents: z.array(storyEventSchema),
	recentPatches: z.array(statePatchSchema),
	memoryNodes: z.array(memoryNodeSchema),
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
		playerReputation: z.string().nullable().optional(),
		playerLedger: z.string().nullable().optional(),
	}).optional(),
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
});

export type StoryEventType = z.infer<typeof storyEventTypeSchema>;
export type MemoryNodeType = z.infer<typeof memoryNodeTypeSchema>;
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;
export type StatePatch = z.infer<typeof statePatchSchema>;
export type StoryEvent = z.infer<typeof storyEventSchema>;
export type MemoryNode = z.infer<typeof memoryNodeSchema>;
export type RetrievedMemoryPacket = z.infer<typeof retrievedMemoryPacketSchema>;
export type MemoryRetrieveRequest = z.infer<typeof memoryRetrieveRequestSchema>;
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncChange = z.infer<typeof syncChangeSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type TurnResponse = z.infer<typeof turnResponseSchema>;
