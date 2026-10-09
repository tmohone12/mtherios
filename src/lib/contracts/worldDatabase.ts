import { contentBundleSchema } from './content';
import { locationMapBodySchema } from './locationMap';
import { z } from 'zod';

export const TERMINAL_WORLD_DATABASE_SCHEMA_VERSION = 3;

export const worldDatabaseJsonRecordSchema = z.record(z.string(), z.unknown());

export const worldDatabaseTablesSchema = z.object({
	canonicalContent: z.array(worldDatabaseJsonRecordSchema).optional(),
	story: worldDatabaseJsonRecordSchema.optional(),
	stories: z.array(worldDatabaseJsonRecordSchema).optional(),
	entries: z.array(worldDatabaseJsonRecordSchema).optional(),
	storyEntries: z.array(worldDatabaseJsonRecordSchema).optional(),
	entities: z.array(worldDatabaseJsonRecordSchema).optional(),
	locationMaps: z.array(worldDatabaseJsonRecordSchema).optional(),
	locationMapRevisions: z.array(worldDatabaseJsonRecordSchema).optional(),
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

const exportedStorySchema = z.object({ id: z.string().min(1), title: z.string() }).passthrough();
const exportRowsSchema = z.array(worldDatabaseJsonRecordSchema);
export const storyImageExportSchema = z.object({
	clientTurnId: z.string().min(1).max(200), callId: z.string().min(1).max(200),
	tool: z.enum(['generateImage', 'generateFileImage']), applied: z.boolean(),
	asset: z.object({ id: z.string().min(1).max(200), visibility: z.literal('public'), mediaType: z.enum(['image/png','image/jpeg','image/webp']), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytesBase64: z.string().min(1).max(13_333_336) }).strict(),
}).strict();
export const locationMapAssetExportSchema = z.object({ id: z.string().min(1).max(200), visibility: z.literal('public'),
	mediaType: z.enum(['image/png','image/jpeg','image/webp']), sha256: z.string().regex(/^[a-f0-9]{64}$/),
	bytesBase64: z.string().min(1).max(13_333_336) }).strict();
export const locationMapExportSchema = z.object({ locationId: z.string().min(1).max(200), revision: z.number().int().positive(), map: locationMapBodySchema }).strict();
const storyExportFieldsSchema = z.object({
	shelf: worldDatabaseJsonRecordSchema.optional(),
	authoredContent: contentBundleSchema.optional(),
	storyImages: z.array(storyImageExportSchema).max(5000).optional(),
	locationMapAssets: z.array(locationMapAssetExportSchema).max(500).optional(),
	portraitAssets: z.array(locationMapAssetExportSchema).max(500).optional(),
	exportedAt: z.number(),
	story: exportedStorySchema,
	storyEntries: exportRowsSchema,
	characters: exportRowsSchema,
	locations: exportRowsSchema,
	items: exportRowsSchema,
	storyBeats: exportRowsSchema,
	chapters: exportRowsSchema,
	lorebookEntries: exportRowsSchema,
	arcs: exportRowsSchema,
	sagas: exportRowsSchema.optional(),
	entryRelationships: exportRowsSchema.optional(),
	conversationMemory: exportRowsSchema.optional(),
	worldEvents: exportRowsSchema.optional(),
	agreements: exportRowsSchema.optional(),
	factionActions: exportRowsSchema.optional(),
	rumors: exportRowsSchema.optional(),
	schemes: exportRowsSchema.optional(),
	storyThreads: exportRowsSchema.optional(),
	worldDatabase: worldDatabaseTablesSchema.optional(),
	backendCanon: worldDatabaseTablesSchema.optional(),
}).passthrough();

// Keep the legacy browser format separate from the current canonical snapshot.
// Passthrough preserves canonical metadata and tables unknown to this client.
export const storyExportBundleSchema = z.discriminatedUnion('version', [
	storyExportFieldsSchema.extend({ version: z.literal(1), schemaVersion: z.literal(1).optional() }),
	storyExportFieldsSchema.extend({
		version: z.literal(TERMINAL_WORLD_DATABASE_SCHEMA_VERSION),
		schemaVersion: z.literal(TERMINAL_WORLD_DATABASE_SCHEMA_VERSION),
		worldDatabase: worldDatabaseTablesSchema.extend({
			story: exportedStorySchema,
			entries: exportRowsSchema,
		}),
	}),
]);

export function parseStoryExportBundle(value: unknown) {
	if (value && typeof value === 'object' && 'version' in value
		&& value.version !== 1 && value.version !== TERMINAL_WORLD_DATABASE_SCHEMA_VERSION) {
		throw new Error(`Unsupported export version: ${String(value.version)}`);
	}
	const result = storyExportBundleSchema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		throw new Error(`Invalid story bundle — ${issue.path.join('.') || 'bundle'}: ${issue.message}`);
	}
	return result.data;
}

export const worldDatabaseBundleSchema = z.object({
	shelf: worldDatabaseJsonRecordSchema.optional(),
	authoredContent: contentBundleSchema.optional(),
	storyImages: z.array(storyImageExportSchema).max(5000).optional(),
	locationMapAssets: z.array(locationMapAssetExportSchema).max(500).optional(),
	portraitAssets: z.array(locationMapAssetExportSchema).max(500).optional(),
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
		sourceProjectId: z.string().min(1).max(200).optional(),
		destinationProjectId: z.string().min(1).max(200).optional(),
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
	projectId: z.string().optional(),
	serverVersion: z.number().int().nonnegative(),
	counts: z.record(z.string(), z.number().int().nonnegative()),
	jobIds: z.array(z.string()),
	importedAt: z.string(),
});

export type WorldDatabaseImportRequest = z.infer<typeof worldDatabaseImportRequestSchema>;
export type WorldDatabaseImportResponse = z.infer<typeof worldDatabaseImportResponseSchema>;
