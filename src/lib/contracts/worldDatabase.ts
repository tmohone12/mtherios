import { z } from 'zod';

export const worldDatabaseJsonRecordSchema = z.record(z.string(), z.unknown());

export const worldDatabaseTablesSchema = z.object({
	story: worldDatabaseJsonRecordSchema.optional(),
	stories: z.array(worldDatabaseJsonRecordSchema).optional(),
	entries: z.array(worldDatabaseJsonRecordSchema).optional(),
	storyEntries: z.array(worldDatabaseJsonRecordSchema).optional(),
	entities: z.array(worldDatabaseJsonRecordSchema).optional(),
	entityAliases: z.array(worldDatabaseJsonRecordSchema).optional(),
	relationships: z.array(worldDatabaseJsonRecordSchema).optional(),
	factions: z.array(worldDatabaseJsonRecordSchema).optional(),
	factionMemberships: z.array(worldDatabaseJsonRecordSchema).optional(),
	factionResources: z.array(worldDatabaseJsonRecordSchema).optional(),
	factionGoals: z.array(worldDatabaseJsonRecordSchema).optional(),
	factionProjects: z.array(worldDatabaseJsonRecordSchema).optional(),
	npcBeliefs: z.array(worldDatabaseJsonRecordSchema).optional(),
	agreements: z.array(worldDatabaseJsonRecordSchema).optional(),
	threads: z.array(worldDatabaseJsonRecordSchema).optional(),
	storyThreads: z.array(worldDatabaseJsonRecordSchema).optional(),
	events: z.array(worldDatabaseJsonRecordSchema).optional(),
	storyEvents: z.array(worldDatabaseJsonRecordSchema).optional(),
	npcEventLinks: z.array(worldDatabaseJsonRecordSchema).optional(),
	npc_event_links: z.array(worldDatabaseJsonRecordSchema).optional(),
	statePatches: z.array(worldDatabaseJsonRecordSchema).optional(),
	facts: z.array(worldDatabaseJsonRecordSchema).optional(),
	sourceRefs: z.array(worldDatabaseJsonRecordSchema).optional(),
	patchProposals: z.array(worldDatabaseJsonRecordSchema).optional(),
	continuityWarnings: z.array(worldDatabaseJsonRecordSchema).optional(),
	memoryNodes: z.array(worldDatabaseJsonRecordSchema).optional(),
	chapters: z.array(worldDatabaseJsonRecordSchema).optional(),
	arcs: z.array(worldDatabaseJsonRecordSchema).optional(),
	sagas: z.array(worldDatabaseJsonRecordSchema).optional(),
}).passthrough();

export const worldDatabaseBundleSchema = z.object({
	schemaVersion: z.number().int().positive().optional(),
	exportedAt: z.union([z.number(), z.string()]).optional(),
	source: z.string().optional(),
	worldDatabase: worldDatabaseTablesSchema.optional(),
	backendCanon: worldDatabaseTablesSchema.optional(),
}).passthrough();

export const worldDatabaseImportRequestSchema = z.object({
	bundle: worldDatabaseBundleSchema,
	options: z.object({
		preserveIds: z.boolean().default(true),
		replaceExisting: z.boolean().default(false),
		syncWiki: z.boolean().default(true),
		source: z.string().optional(),
	}).default({
		preserveIds: true,
		replaceExisting: false,
		syncWiki: true,
	}),
});

export const worldDatabaseImportResponseSchema = z.object({
	ok: z.literal(true),
	storyId: z.string(),
	serverVersion: z.number().int().nonnegative(),
	counts: z.record(z.string(), z.number().int().nonnegative()),
	jobIds: z.array(z.string()),
	importedAt: z.string(),
});

export type WorldDatabaseImportRequest = z.infer<typeof worldDatabaseImportRequestSchema>;
export type WorldDatabaseImportResponse = z.infer<typeof worldDatabaseImportResponseSchema>;
