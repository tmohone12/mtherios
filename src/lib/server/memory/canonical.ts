import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	arcs,
	chapters,
	contextCheckpoints,
	continuityWarnings,
	entities,
	entityAliases,
	facts,
	factions,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	patchProposals,
	memoryNodes,
	npcBeliefs,
	npcEventLinks,
	sourceRefs,
	relationships,
	sagas,
	statePatches,
	shelves,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
	syncOps,
} from '$lib/server/db/schema';
import { TERMINAL_WORLD_DATABASE_SCHEMA_VERSION } from '$lib/server/db/worldDatabaseSchema';
import { getServerMemoryConfig } from '$lib/server/env';
import {
	createStoryRequestSchema,
	indexedDbImportRequestSchema,
	storyDeleteRequestSchema,
	syncOperationSchema,
	type SyncChange,
	type SyncOperation,
} from '$lib/contracts/memory';
import { createShelfRequestSchema, updateShelfRequestSchema } from '$lib/contracts/shelves';
import { enqueueImportProjectionJobs, enqueuePlotBrainJob, enqueueStoryVaultSyncJob, enqueueTurnProjectionJobs } from '$lib/server/jobs/outbox';
import { hasStrategicPlotContent } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { deleteStoryVaultArtifacts } from '$lib/server/wiki/storyVault';
import { getCampaignProjection } from '$lib/server/engine/projections';
import { entityResolutionSummary, isCharacterTitleOnlyName, resolveEntityIdentity, shouldReuseResolvedEntity } from './entityResolver';
import type { EngineCampaignBootstrapArgs } from '$lib/contracts/engine';

type JsonRecord = Record<string, unknown>;
type LivingMemoryKind = 'conversationMemory' | 'worldEvent' | 'factionAction' | 'rumor' | 'scheme';
type LivingMemoryWriteMode = 'ignore' | 'upsert';
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const DEFAULT_SHELF_ID = 'shelf_default';

export interface BootstrapProjectionLimits {
	entryLimit: number;
	entityLimit: number;
	relationshipLimit: number;
	factionLimit: number;
	factionMembershipLimit: number;
	factionResourceLimit: number;
	factionGoalLimit: number;
	factionProjectLimit: number;
	agreementLimit: number;
	npcBeliefLimit: number;
	threadLimit: number;
	chapterLimit: number;
	arcLimit: number;
	sagaLimit: number;
	eventLimit: number;
	patchLimit: number;
	memoryNodeLimit: number;
}

export const DEFAULT_BOOTSTRAP_LIMITS: BootstrapProjectionLimits = {
	entryLimit: 80,
	entityLimit: 120,
	relationshipLimit: 200,
	factionLimit: 80,
	factionMembershipLimit: 160,
	factionResourceLimit: 160,
	factionGoalLimit: 160,
	factionProjectLimit: 160,
	agreementLimit: 80,
	npcBeliefLimit: 80,
	threadLimit: 80,
	chapterLimit: 80,
	arcLimit: 80,
	sagaLimit: 40,
	eventLimit: 80,
	patchLimit: 80,
	memoryNodeLimit: 80,
};

const BOOTSTRAP_LIMIT_CAPS: BootstrapProjectionLimits = {
	entryLimit: 200,
	entityLimit: 200,
	relationshipLimit: 400,
	factionLimit: 200,
	factionMembershipLimit: 400,
	factionResourceLimit: 400,
	factionGoalLimit: 400,
	factionProjectLimit: 400,
	agreementLimit: 200,
	npcBeliefLimit: 200,
	threadLimit: 200,
	chapterLimit: 200,
	arcLimit: 200,
	sagaLimit: 100,
	eventLimit: 200,
	patchLimit: 200,
	memoryNodeLimit: 200,
};

function boundedInt(value: unknown, fallback: number, cap: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(cap, Math.trunc(value)));
}

export function normalizeBootstrapOptions(options: EngineCampaignBootstrapArgs = {}): BootstrapProjectionLimits {
	return {
		entryLimit: boundedInt(options.entryLimit, DEFAULT_BOOTSTRAP_LIMITS.entryLimit, BOOTSTRAP_LIMIT_CAPS.entryLimit),
		entityLimit: boundedInt(options.entityLimit, DEFAULT_BOOTSTRAP_LIMITS.entityLimit, BOOTSTRAP_LIMIT_CAPS.entityLimit),
		relationshipLimit: boundedInt(options.relationshipLimit, DEFAULT_BOOTSTRAP_LIMITS.relationshipLimit, BOOTSTRAP_LIMIT_CAPS.relationshipLimit),
		factionLimit: boundedInt(options.factionLimit, DEFAULT_BOOTSTRAP_LIMITS.factionLimit, BOOTSTRAP_LIMIT_CAPS.factionLimit),
		factionMembershipLimit: boundedInt(options.factionMembershipLimit, DEFAULT_BOOTSTRAP_LIMITS.factionMembershipLimit, BOOTSTRAP_LIMIT_CAPS.factionMembershipLimit),
		factionResourceLimit: boundedInt(options.factionResourceLimit, DEFAULT_BOOTSTRAP_LIMITS.factionResourceLimit, BOOTSTRAP_LIMIT_CAPS.factionResourceLimit),
		factionGoalLimit: boundedInt(options.factionGoalLimit, DEFAULT_BOOTSTRAP_LIMITS.factionGoalLimit, BOOTSTRAP_LIMIT_CAPS.factionGoalLimit),
		factionProjectLimit: boundedInt(options.factionProjectLimit, DEFAULT_BOOTSTRAP_LIMITS.factionProjectLimit, BOOTSTRAP_LIMIT_CAPS.factionProjectLimit),
		agreementLimit: boundedInt(options.agreementLimit, DEFAULT_BOOTSTRAP_LIMITS.agreementLimit, BOOTSTRAP_LIMIT_CAPS.agreementLimit),
		npcBeliefLimit: boundedInt(options.npcBeliefLimit, DEFAULT_BOOTSTRAP_LIMITS.npcBeliefLimit, BOOTSTRAP_LIMIT_CAPS.npcBeliefLimit),
		threadLimit: boundedInt(options.threadLimit, DEFAULT_BOOTSTRAP_LIMITS.threadLimit, BOOTSTRAP_LIMIT_CAPS.threadLimit),
		chapterLimit: boundedInt(options.chapterLimit, DEFAULT_BOOTSTRAP_LIMITS.chapterLimit, BOOTSTRAP_LIMIT_CAPS.chapterLimit),
		arcLimit: boundedInt(options.arcLimit, DEFAULT_BOOTSTRAP_LIMITS.arcLimit, BOOTSTRAP_LIMIT_CAPS.arcLimit),
		sagaLimit: boundedInt(options.sagaLimit, DEFAULT_BOOTSTRAP_LIMITS.sagaLimit, BOOTSTRAP_LIMIT_CAPS.sagaLimit),
		eventLimit: boundedInt(options.eventLimit, DEFAULT_BOOTSTRAP_LIMITS.eventLimit, BOOTSTRAP_LIMIT_CAPS.eventLimit),
		patchLimit: boundedInt(options.patchLimit, DEFAULT_BOOTSTRAP_LIMITS.patchLimit, BOOTSTRAP_LIMIT_CAPS.patchLimit),
		memoryNodeLimit: boundedInt(options.memoryNodeLimit, DEFAULT_BOOTSTRAP_LIMITS.memoryNodeLimit, BOOTSTRAP_LIMIT_CAPS.memoryNodeLimit),
	};
}
type LivingMemoryWriteOptions = {
	serverVersion?: number;
	timestamp?: string;
	mode?: LivingMemoryWriteMode;
};

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'srv'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asArray<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function asStringArray(value: unknown): string[] {
	return asArray(value).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function normalizeAlias(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stableIdSegment(value: string): string {
	return normalizeAlias(value).replace(/\s+/g, '_').slice(0, 96) || 'record';
}

function sourceEntries(...values: unknown[]): string[] {
	return [...new Set(values.map(asNullableString).filter((value): value is string => Boolean(value)))];
}

function stringList(...values: unknown[]): string[] {
	const items = values.flatMap((value) => {
		if (Array.isArray(value)) return asStringArray(value);
		const item = asNullableString(value);
		return item ? [item] : [];
	});
	return [...new Set(items)];
}

function namedProposalOperationValue(proposal: typeof patchProposals.$inferSelect): JsonRecord {
	return asArray<JsonRecord>(proposal.operations)
		.map((operation) => asRecord(asRecord(operation).value))
		.find((value) => asNullableString(value.name)) ?? {};
}

function characterReferenceProposalName(proposal: typeof patchProposals.$inferSelect): string {
	const metadata = asRecord(proposal.metadata);
	const operationValue = namedProposalOperationValue(proposal);
	return asString(metadata.sourceName, asString(operationValue.name, ''));
}

async function loadMatchingCharacterReferenceProposals(
	db: Db,
	storyId: string,
	names: string[],
): Promise<Array<typeof patchProposals.$inferSelect>> {
	const normalizedNames = new Set(names.map(normalizeAlias).filter(Boolean));
	if (normalizedNames.size === 0) return [];
	const rows = await db.select().from(patchProposals).where(and(
		eq(patchProposals.storyId, storyId),
		eq(patchProposals.proposalType, 'character_reference_review'),
		inArray(patchProposals.status, ['pending', 'needs_review']),
	)).limit(500);
	return rows.filter((proposal) => normalizedNames.has(normalizeAlias(characterReferenceProposalName(proposal))));
}

async function applyCharacterReferenceProposalResolutions(
	db: Db,
	input: {
		storyId: string;
		entityId: string;
		entityName: string;
		proposals: Array<typeof patchProposals.$inferSelect>;
		serverVersion: number;
		now: string;
	},
): Promise<Array<{ proposalId: string; name: string; entityId: string }>> {
	const resolved: Array<{ proposalId: string; name: string; entityId: string }> = [];
	for (const proposal of input.proposals) {
		const name = characterReferenceProposalName(proposal);
		const operation = {
			op: 'update',
			path: '/entities/character',
			table: 'entities',
			recordId: input.entityId,
			name: input.entityName,
		};
		const metadata = {
			...asRecord(proposal.metadata),
			resolvedByEntityUpsert: true,
			resolvedEntityId: input.entityId,
			resolvedEntityName: input.entityName,
			resolvedAt: input.now,
			appliedOperations: [...asArray(asRecord(proposal.metadata).appliedOperations), operation],
		};
		await db.update(patchProposals).set({
			status: 'applied',
			decision: 'approved',
			validatedBy: 'entity_upsert',
			affectedEntityIds: stringList(proposal.affectedEntityIds, input.entityId),
			metadata,
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		}).where(eq(patchProposals.id, proposal.id));
		await db.insert(sourceRefs).values({
			id: `source_ref_${stableIdSegment(`${proposal.id}_${input.entityId}`)}`,
			storyId: input.storyId,
			sourceType: 'patch_proposal',
			sourceId: proposal.id,
			targetTable: 'entities',
			targetRecordId: input.entityId,
			targetRecordField: 'state',
			sourceField: 'character_reference_review',
			confidence: proposal.confidence,
			rationale: proposal.reason,
			notes: 'Explicit character upsert resolved this unresolved character reference.',
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing();
		resolved.push({ proposalId: proposal.id, name, entityId: input.entityId });
	}
	return resolved;
}

async function nextStoryEntryPosition(storyId: string): Promise<number> {
	const [last] = await getDb()
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(1);
	return (last?.position ?? -1) + 1;
}

function extractFactionResources(state: JsonRecord): JsonRecord {
	const resources = asRecord(state.resources);
	if (Object.keys(resources).length > 0) return resources;
	return {
		wealth: state.wealth ?? null,
		food: state.food ?? null,
		army: state.army ?? null,
		ships: state.ships ?? null,
		spies: state.spies ?? null,
		influence: state.influence ?? null,
	};
}

function extractFactionMembers(state: JsonRecord): string[] {
	return [...new Set([
		...asStringArray(state.memberEntityIds),
		...asStringArray(state.knownMemberIds),
		...asStringArray(state.knownMembers),
		...asStringArray(state.members),
		...asStringArray(state.leaders),
	].filter(Boolean))];
}

export async function bumpStoryVersion(storyId: string): Promise<number> {
	const db = getDb();
	const [row] = await db
		.update(stories)
		.set({
			serverVersion: sql`${stories.serverVersion} + 1`,
			updatedAt: nowIso(),
		})
		.where(eq(stories.id, storyId))
		.returning({ serverVersion: stories.serverVersion });
	return row?.serverVersion ?? 1;
}

async function bumpStoryVersionTx(tx: Tx, storyId: string, now = nowIso()): Promise<number> {
	const [row] = await tx
		.update(stories)
		.set({
			serverVersion: sql`${stories.serverVersion} + 1`,
			updatedAt: now,
		})
		.where(eq(stories.id, storyId))
		.returning({ serverVersion: stories.serverVersion });
	if (!row) throw new Error(`Story not found: ${storyId}`);
	return row.serverVersion;
}

async function queueStoryVaultSync(
	storyId: string,
	serverVersion: number,
	reason: string,
	payload: Record<string, unknown> = {},
): Promise<string | null> {
	try {
		return await enqueueStoryVaultSyncJob({ storyId, serverVersion, reason, payload });
	} catch (error) {
		console.warn('[BackendMemory] Failed to queue story vault sync:', error);
		return null;
	}
}

export async function createBackendStory(input: unknown) {
	const request = createStoryRequestSchema.parse(input);
	const db = getDb();
	const createdAt = nowIso();
	const storyId = id('story');
	const shelfId = request.shelfId ?? DEFAULT_SHELF_ID;
	await ensureShelfExists(db, shelfId, request.genre ?? null, createdAt);

	const [story] = await db.insert(stories).values({
		id: storyId,
		shelfId,
		clientStoryId: request.clientStoryId ?? null,
		title: request.title,
		description: request.description ?? null,
		genre: request.genre ?? null,
		mode: request.mode,
		role: request.role,
		timelineMode: request.timelineMode,
		settings: request.settings ?? null,
		headerPrompt: request.headerPrompt ?? null,
		metadata: {
			playerReputation: request.playerReputation ?? null,
			...(request.startWorkflow ? { startWorkflow: request.startWorkflow } : {}),
		},
		createdAt,
		updatedAt: createdAt,
	}).returning();

	await queueStoryVaultSync(story.id, story.serverVersion, 'story-created');
	return {
		storyId: story.id,
		shelfId: story.shelfId,
		serverVersion: story.serverVersion,
		createdAt: story.createdAt,
	};
}

export async function listBackendStories(options: { shelfId?: string | null } = {}) {
	const shelfId = typeof options.shelfId === 'string' && options.shelfId.trim() ? options.shelfId.trim() : null;
	const rows = await getDb()
		.select()
		.from(stories)
		.where(shelfId ? eq(stories.shelfId, shelfId) : sql`true`)
		.orderBy(desc(stories.updatedAt))
		.limit(500);

	return rows.map((story) => ({
		id: story.id,
		shelfId: story.shelfId,
		clientStoryId: story.clientStoryId,
		title: story.title,
		description: story.description,
		genre: story.genre,
		mode: story.mode,
		role: story.role,
		timelineMode: story.timelineMode,
		settings: story.settings,
		headerPrompt: story.headerPrompt,
		metadata: story.metadata,
		serverVersion: story.serverVersion,
		createdAt: story.createdAt,
		updatedAt: story.updatedAt,
	}));
}

function slugifyShelf(value: string): string {
	const slug = value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80);
	return slug || 'shelf';
}

async function ensureShelfExists(db: Db, shelfId: string, genre: string | null, createdAt = nowIso()): Promise<void> {
	const [existing] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.id, shelfId)).limit(1);
	if (existing) return;
	if (shelfId !== DEFAULT_SHELF_ID) throw new Error(`Shelf not found: ${shelfId}`);
	await db.insert(shelves).values({
		id: DEFAULT_SHELF_ID,
		name: 'Default Shelf',
		slug: 'default_shelf',
		description: 'Migrated shelf for existing Mtherios stories.',
		genre,
		settings: {},
		metadata: { createdByCompatibilityPath: true },
		createdAt,
		updatedAt: createdAt,
	}).onConflictDoNothing();
}

function shelfSummary(row: typeof shelves.$inferSelect, storyCount = 0, canonRecordCount = 0, sourceCount = 0) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		genre: row.genre,
		coverImageUrl: row.coverImageUrl,
		settings: row.settings ?? {},
		metadata: row.metadata ?? {},
		storyCount,
		canonRecordCount,
		sourceCount,
		serverVersion: row.serverVersion,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function listBackendShelves() {
	const db = getDb();
	await ensureShelfExists(db, DEFAULT_SHELF_ID, null);
	const rows = await db.select().from(shelves).orderBy(desc(shelves.updatedAt)).limit(500);
	const storyCounts = await db
		.select({ shelfId: stories.shelfId, count: sql<number>`count(*)::int` })
		.from(stories)
		.groupBy(stories.shelfId);
	const storiesByShelf = new Map(storyCounts.map((row) => [row.shelfId, Number(row.count ?? 0)]));
	const summaries = [];
	for (const row of rows) {
		const shelfStoryIds = await db.select({ id: stories.id }).from(stories).where(eq(stories.shelfId, row.id));
		const ids = shelfStoryIds.map((story) => story.id);
		let canonRecordCount = 0;
		let sourceCount = 0;
		if (ids.length > 0) {
			const [entityCount] = await db.select({ count: sql<number>`count(*)::int` }).from(entities).where(inArray(entities.storyId, ids));
			const [entryCount] = await db.select({ count: sql<number>`count(*)::int` }).from(storyEntries).where(and(inArray(storyEntries.storyId, ids), eq(storyEntries.type, 'source_import')));
			canonRecordCount = Number(entityCount?.count ?? 0);
			sourceCount = Number(entryCount?.count ?? 0);
		}
		summaries.push(shelfSummary(row, storiesByShelf.get(row.id) ?? 0, canonRecordCount, sourceCount));
	}
	return summaries;
}

export async function getBackendShelf(shelfId: string) {
	const db = getDb();
	const [row] = await db.select().from(shelves).where(eq(shelves.id, shelfId)).limit(1);
	if (!row) throw new Error(`Shelf not found: ${shelfId}`);
	return shelfSummary(row);
}

export async function createBackendShelf(input: unknown) {
	const request = createShelfRequestSchema.parse(input);
	const db = getDb();
	const createdAt = nowIso();
	const baseSlug = slugifyShelf(request.name);
	let slug = baseSlug;
	let suffix = 2;
	while ((await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.slug, slug)).limit(1))[0]) {
		slug = `${baseSlug}_${suffix}`;
		suffix += 1;
	}
	const [shelf] = await db.insert(shelves).values({
		id: id('shelf'),
		name: request.name,
		slug,
		description: request.description ?? null,
		genre: request.genre ?? null,
		coverImageUrl: request.coverImageUrl ?? null,
		settings: request.settings ?? {},
		metadata: { tags: request.tags ?? [] },
		createdAt,
		updatedAt: createdAt,
	}).returning();
	return {
		shelfId: shelf.id,
		shelf: shelfSummary(shelf),
		serverVersion: shelf.serverVersion,
		createdAt: shelf.createdAt,
	};
}

export async function updateBackendShelf(shelfId: string, input: unknown) {
	const request = updateShelfRequestSchema.parse(input);
	const now = nowIso();
	const updates: Partial<typeof shelves.$inferInsert> = { updatedAt: now };
	const db = getDb();
	if (request.name !== undefined) updates.name = request.name;
	if (request.description !== undefined) updates.description = request.description ?? null;
	if (request.genre !== undefined) updates.genre = request.genre ?? null;
	if (request.coverImageUrl !== undefined) updates.coverImageUrl = request.coverImageUrl ?? null;
	if (request.settings !== undefined) updates.settings = request.settings;
	if (request.metadata !== undefined || request.tags !== undefined) {
		const [existing] = await db.select({ metadata: shelves.metadata }).from(shelves).where(eq(shelves.id, shelfId)).limit(1);
		if (!existing) throw new Error(`Shelf not found: ${shelfId}`);
		updates.metadata = {
			...asRecord(existing.metadata),
			...(request.metadata ?? {}),
			...(request.tags !== undefined ? { tags: request.tags } : {}),
		};
	}
	const [row] = await db.update(shelves).set(updates).where(eq(shelves.id, shelfId)).returning();
	if (!row) throw new Error(`Shelf not found: ${shelfId}`);
	return shelfSummary(row);
}

export async function deleteBackendShelf(shelfId: string) {
	if (shelfId === DEFAULT_SHELF_ID) throw new Error('Default Shelf cannot be deleted.');
	const [deleted] = await getDb().delete(shelves).where(eq(shelves.id, shelfId)).returning({ id: shelves.id });
	if (!deleted) throw new Error(`Shelf not found: ${shelfId}`);
	return { ok: true as const, shelfId };
}

export async function deleteBackendStory(storyId: string, input: unknown = {}) {
	const request = storyDeleteRequestSchema.parse(input);
	const db = getDb();
	const now = nowIso();
	const warnings: string[] = [];

	if (request.mode === 'archive') {
		const [archived] = await db.update(stories).set({
			metadata: sql`${stories.metadata} || ${JSON.stringify({
				archived: true,
				archivedAt: now,
				deleteMode: 'archive',
				exportBeforeDelete: request.exportBeforeDelete,
			})}::jsonb`,
			updatedAt: now,
			serverVersion: sql`${stories.serverVersion} + 1`,
		}).where(eq(stories.id, storyId)).returning({ id: stories.id, serverVersion: stories.serverVersion });
		if (!archived) throw new Error(`Story not found: ${storyId}`);
		return {
			ok: true,
			storyId,
			mode: 'archive' as const,
			canonDeleted: false,
			artifactCleanup: null,
			warnings,
		};
	}

	const [deleted] = await db
		.delete(stories)
		.where(eq(stories.id, storyId))
		.returning({ id: stories.id });

	if (!deleted) throw new Error(`Story not found: ${storyId}`);
	try {
		return {
			ok: true,
			storyId,
			mode: 'purge' as const,
			canonDeleted: true,
			artifactCleanup: await deleteStoryVaultArtifacts(storyId),
			warnings,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn('[BackendMemory] Failed to clean story vault artifacts:', error);
		warnings.push(`artifact_cleanup_failed: ${message}`);
		return {
			ok: true,
			storyId,
			mode: 'purge' as const,
			canonDeleted: true,
			artifactCleanup: null,
			warnings,
		};
	}
}

export async function getBootstrap(storyId: string, options: EngineCampaignBootstrapArgs = {}) {
	const db = getDb();
	const limits = normalizeBootstrapOptions(options);
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entriesRows,
		entryCountRows,
		entityRows,
		relationshipRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		agreementRows,
		npcBeliefRows,
		threadRows,
		chapterRows,
		arcRows,
		sagaRows,
		eventRows,
		patchRows,
		nodeRows,
		projection,
	] = await Promise.all([
		limits.entryLimit === 0 ? Promise.resolve([]) : db
			.select()
			.from(storyEntries)
			.where(eq(storyEntries.storyId, storyId))
			.orderBy(desc(storyEntries.position))
			.limit(limits.entryLimit),
		db.select({ count: sql<number>`count(*)::int` }).from(storyEntries).where(eq(storyEntries.storyId, storyId)),
		limits.entityLimit === 0 ? Promise.resolve([]) : db.select().from(entities).where(eq(entities.storyId, storyId)).limit(limits.entityLimit),
		limits.relationshipLimit === 0 ? Promise.resolve([]) : db.select().from(relationships).where(eq(relationships.storyId, storyId)).limit(limits.relationshipLimit),
		limits.factionLimit === 0 ? Promise.resolve([]) : db.select().from(factions).where(eq(factions.storyId, storyId)).limit(limits.factionLimit),
		limits.factionMembershipLimit === 0 ? Promise.resolve([]) : db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).limit(limits.factionMembershipLimit),
		limits.factionResourceLimit === 0 ? Promise.resolve([]) : db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).limit(limits.factionResourceLimit),
		limits.factionGoalLimit === 0 ? Promise.resolve([]) : db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).limit(limits.factionGoalLimit),
		limits.factionProjectLimit === 0 ? Promise.resolve([]) : db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).limit(limits.factionProjectLimit),
		limits.agreementLimit === 0 ? Promise.resolve([]) : db.select().from(agreements).where(eq(agreements.storyId, storyId)).limit(limits.agreementLimit),
		limits.npcBeliefLimit === 0 ? Promise.resolve([]) : db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)).orderBy(desc(npcBeliefs.updatedAt)).limit(limits.npcBeliefLimit),
		limits.threadLimit === 0 ? Promise.resolve([]) : db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)).limit(limits.threadLimit),
		limits.chapterLimit === 0 ? Promise.resolve([]) : db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(desc(chapters.number)).limit(limits.chapterLimit),
		limits.arcLimit === 0 ? Promise.resolve([]) : db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(desc(arcs.number)).limit(limits.arcLimit),
		limits.sagaLimit === 0 ? Promise.resolve([]) : db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(desc(sagas.number)).limit(limits.sagaLimit),
		limits.eventLimit === 0 ? Promise.resolve([]) : db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.createdAt)).limit(limits.eventLimit),
		limits.patchLimit === 0 ? Promise.resolve([]) : db.select().from(statePatches).where(eq(statePatches.storyId, storyId)).orderBy(desc(statePatches.createdAt)).limit(limits.patchLimit),
		limits.memoryNodeLimit === 0 ? Promise.resolve([]) : db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId)).orderBy(desc(memoryNodes.updatedAt)).limit(limits.memoryNodeLimit),
		getCampaignProjection(storyId, { entryLimit: limits.entryLimit }),
	]);
	const metadata = asRecord(story.metadata);
	const plotBrain = asRecord(metadata.plotBrain);
	const hasPlotFrame = hasStrategicPlotContent(plotBrain.lastFrame ?? metadata.strategicWorldFrame);
	const hasPendingPlotFrame = Boolean(plotBrain.pendingFrameId)
		|| Object.keys(asRecord(plotBrain.pendingFrame)).length > 0;
	const hasPlotEvidence = Number(entryCountRows[0]?.count ?? 0) > 0 || entityRows.length > 0 || factionRows.length > 0;
	if (!hasPlotFrame && !hasPendingPlotFrame && hasPlotEvidence) {
		await enqueuePlotBrainJob({
			storyId,
			trigger: 'scheduled_refresh',
			scopeId: storyId,
			skipIfPlanned: true,
		}).catch((error) => console.warn('[plot-brain] Failed to queue story bootstrap plan:', error));
	}

	return {
		story,
		serverVersion: story.serverVersion,
		entries: [...entriesRows].sort((a, b) => a.position - b.position),
		entryCount: Number(entryCountRows[0]?.count ?? entriesRows.length),
		entities: entityRows,
		relationships: relationshipRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		factionProjects: factionProjectRows,
		agreements: agreementRows,
		npcBeliefs: npcBeliefRows,
		threads: threadRows,
		chapters: [...chapterRows].sort((a, b) => a.number - b.number),
		arcs: [...arcRows].sort((a, b) => a.number - b.number),
		sagas: [...sagaRows].sort((a, b) => a.number - b.number),
		recentEvents: eventRows,
		recentPatches: patchRows,
		memoryNodes: nodeRows.map((row) => ({ ...row, embedding: undefined })),
		projection,
	};
}

export async function getStoryEntriesPage(
	storyId: string,
	options: { beforePosition?: number | null; limit?: number | null; branchId?: string | null } = {},
) {
	const db = getDb();
	const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 80)));
	const filters = [eq(storyEntries.storyId, storyId)];
	const countFilters = [eq(storyEntries.storyId, storyId)];
	if (options.branchId) {
		filters.push(eq(storyEntries.branchId, options.branchId));
		countFilters.push(eq(storyEntries.branchId, options.branchId));
	}
	if (typeof options.beforePosition === 'number' && Number.isFinite(options.beforePosition)) {
		filters.push(lt(storyEntries.position, Math.trunc(options.beforePosition)));
	}

	const [story] = await db
		.select({ id: stories.id, serverVersion: stories.serverVersion })
		.from(stories)
		.where(eq(stories.id, storyId))
		.limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [rows, entryCountRows] = await Promise.all([
		db
			.select()
			.from(storyEntries)
			.where(and(...filters))
			.orderBy(desc(storyEntries.position))
			.limit(limit + 1),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(storyEntries)
			.where(and(...countFilters)),
	]);
	const pageRows = rows.slice(0, limit);
	const entries = [...pageRows].sort((a, b) => a.position - b.position);

	await queueStoryVaultSync(story.id, story.serverVersion ?? 1, 'story-created');
	return {
		storyId: story.id,
		serverVersion: story.serverVersion,
		entries,
		entryCount: Number(entryCountRows[0]?.count ?? entries.length),
		hasMore: rows.length > limit,
		nextBeforePosition: entries[0]?.position ?? null,
	};
}

function entityStateFromEntry(entry: JsonRecord): JsonRecord {
	const state = asRecord(entry.state);
	return {
		...state,
		hiddenInfo: asNullableString(entry.hiddenInfo),
	};
}

function entityMetadataFromEntry(entry: JsonRecord, existing: JsonRecord = {}): JsonRecord {
	return {
		...existing,
		originalTable: asString(existing.originalTable, 'lorebookEntries'),
		originalMetadata: existing.originalMetadata ?? entry.metadata ?? null,
		localAliases: asStringArray(entry.aliases),
		localInjection: asRecord(entry.injection),
		localAdventureState: entry.adventureState ?? null,
		localCreativeState: entry.creativeState ?? null,
		localCreatedBy: asString(entry.createdBy, 'user'),
		localMentionCount: asNumber(entry.mentionCount, 0),
		loreManagementBlacklisted: asBoolean(entry.loreManagementBlacklisted),
		updatedBy: 'wiki-command',
	};
}

export async function upsertBackendEntityFromEntry(storyId: string, rawEntry: unknown) {
	const db = getDb();
	const entry = asRecord(rawEntry);
	const requestedEntityId = asNullableString(entry.id);
	const name = asString(entry.name).trim();
	if (!name) throw new Error('Wiki entry name is required.');
	const type = asString(entry.type, 'concept');
	const now = nowIso();
	const [story] = await db.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const sourceEntryIds = stringList(entry.sourceEntryIds, entry.firstMentioned, entry.lastMentioned);
	const description = asString(entry.description);
	const sourceEventIds = asStringArray(entry.sourceEventIds);
	const sourcePatchIds = asStringArray(entry.sourcePatchIds);
	const entryAliases = asStringArray(entry.aliases);
	if (type === 'character' && isCharacterTitleOnlyName(name) && entryAliases.length === 0 && !requestedEntityId) {
		throw new Error(`Character name "${name}" is a title or role. Add it as an alias/title on an existing character instead.`);
	}
	const resolution = await resolveEntityIdentity({
		storyId,
		db,
		candidate: {
			id: requestedEntityId,
			type,
			name,
			aliases: entryAliases,
			description,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
		},
	});
	const entityId = shouldReuseResolvedEntity(resolution) && resolution.entityId
		? resolution.entityId
		: requestedEntityId ?? id('entity');
	const [existing] = await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, entityId))).limit(1);
	const matchingCharacterReferences = type === 'character'
		? await loadMatchingCharacterReferenceProposals(db, storyId, [name, ...entryAliases])
		: [];
	const serverVersion = await bumpStoryVersion(storyId);
	const state = { ...asRecord(existing?.state), ...entityStateFromEntry(entry) };
	const mergedSourceEntryIds = stringList(
		existing?.sourceEntryIds,
		sourceEntryIds,
		...matchingCharacterReferences.map((proposal) => proposal.sourceEntryIds),
	);
	const mergedSourceEventIds = stringList(
		existing?.sourceEventIds,
		sourceEventIds,
		...matchingCharacterReferences.map((proposal) => proposal.sourceEventIds),
	);
	const mergedSourcePatchIds = stringList(
		existing?.sourcePatchIds,
		sourcePatchIds,
		...matchingCharacterReferences.flatMap((proposal) => [proposal.sourcePatchIds, proposal.id]),
	);
	const metadata = {
		...entityMetadataFromEntry(entry, asRecord(existing?.metadata)),
		entityResolver: entityResolutionSummary(resolution),
		...(matchingCharacterReferences.length > 0 ? {
			resolvedCharacterReferenceProposalIds: matchingCharacterReferences.map((proposal) => proposal.id),
		} : {}),
	};
	const canonicalName = existing && normalizeAlias(existing.name) !== normalizeAlias(name) && existing.name.length >= name.length
		? existing.name
		: name;
	const status = asString(entry.status, asString(state.status, existing?.status ?? 'active'));
	const visibility = asString(entry.visibility, existing?.visibility ?? 'player_known');

	const [entity] = await db.insert(entities).values({
		id: entityId,
		storyId,
		type,
		name: canonicalName,
		description,
		status,
		visibility,
		state,
		metadata,
		sourceEntryIds: mergedSourceEntryIds,
		sourceEventIds: mergedSourceEventIds,
		sourcePatchIds: mergedSourcePatchIds,
		serverVersion,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: entities.id,
		set: {
			type,
			name: canonicalName,
			description,
			status,
			visibility,
			state,
			metadata,
			sourceEntryIds: mergedSourceEntryIds,
			sourceEventIds: mergedSourceEventIds,
			sourcePatchIds: mergedSourcePatchIds,
			serverVersion,
			updatedAt: now,
		},
	}).returning();

	await db.delete(entityAliases).where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.entityId, entityId)));
	const matchedAliases = resolution.candidates.find((candidate) => candidate.entityId === entityId)?.aliases ?? [];
	const aliases = [...new Set([canonicalName, name, ...matchedAliases, ...asStringArray(entry.aliases)])]
		.map((alias) => ({ alias, normalizedAlias: normalizeAlias(alias) }))
		.filter((alias) => alias.normalizedAlias);
	for (const alias of aliases) {
		await db.insert(entityAliases).values({
			id: id('alias'),
			storyId,
			entityId,
			alias: alias.alias,
			normalizedAlias: alias.normalizedAlias,
			sourceEntryIds: mergedSourceEntryIds,
			serverVersion,
			createdAt: now,
			updatedAt: now,
		}).onConflictDoNothing();
	}

	const resolvedCharacterReferences = await applyCharacterReferenceProposalResolutions(db, {
		storyId,
		entityId,
		entityName: canonicalName,
		proposals: matchingCharacterReferences,
		serverVersion,
		now,
	});

	if (type === 'faction') {
		await importFactionFromEntry(storyId, { ...entry, id: entityId, name: canonicalName, state }, entityId, {}, serverVersion);
	} else {
		await db.delete(factions).where(and(eq(factions.storyId, storyId), eq(factions.entityId, entityId)));
	}

	await queueStoryVaultSync(storyId, serverVersion, 'entity-upsert', { entityId, type, name: canonicalName, resolution: resolution.decision });
	return { storyId, serverVersion, entity, resolution, resolvedCharacterReferences };
}

export async function deleteBackendEntity(storyId: string, entityId: string) {
	const db = getDb();
	const [existing] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.storyId, storyId), eq(entities.id, entityId)))
		.limit(1);
	if (!existing) throw new Error(`Entity not found: ${entityId}`);
	const serverVersion = await bumpStoryVersion(storyId);
	await db.delete(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, entityId)));
	await queueStoryVaultSync(storyId, serverVersion, 'entity-delete', { entityId });
	return { storyId, serverVersion, entityId, deleted: true };
}

function chapterMetadataFromLocal(chapter: JsonRecord, existing: JsonRecord = {}): JsonRecord {
	return {
		...existing,
		entryCount: asNumber(chapter.entryCount, asNumber(existing.entryCount, 0)),
		legacyKeywords: asStringArray(chapter.keywords ?? existing.legacyKeywords),
		legacyCharacters: asStringArray(chapter.characters ?? existing.legacyCharacters),
		legacyLocations: asStringArray(chapter.locations ?? existing.legacyLocations),
		emotionalTone: asNullableString(chapter.emotionalTone ?? existing.emotionalTone),
		startTime: chapter.startTime ?? existing.startTime ?? null,
		endTime: chapter.endTime ?? existing.endTime ?? null,
		branchId: asNullableString(chapter.branchId ?? existing.branchId),
		pinned: asBoolean(chapter.pinned ?? existing.pinned),
		updatedBy: 'chapter-command',
	};
}

function plausibleChapterCharacterName(value: string): boolean {
	const normalized = normalizeAlias(value);
	if (!normalized || normalized.length < 3) return false;
	if (isCharacterTitleOnlyName(value)) return false;
	if (['player', 'narrator', 'chapter', 'scene', 'unknown', 'someone', 'innkeep'].includes(normalized)) return false;
	return !/\b(house|court|empire|kingdom|city|quarter|market|fleet|army|bank|temple|palace)\b/.test(normalized);
}

async function createLocalChapterCharacterReferenceProposals(input: {
	storyId: string;
	chapterId: string;
	chapterNumber: number;
	summary: string;
	characterNames: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	serverVersion: number;
	now: string;
}): Promise<void> {
	const db = getDb();
	for (const name of stringList(input.characterNames)) {
		if (!plausibleChapterCharacterName(name)) continue;
		const resolution = await resolveEntityIdentity({
			storyId: input.storyId,
			candidate: {
				type: 'character',
				name,
				description: `${name} is listed as a chapter character.`,
				sourceEntryIds: input.sourceEntryIds,
				sourceEventIds: input.sourceEventIds,
			},
			includeSemantic: false,
		});
		if (shouldReuseResolvedEntity(resolution) || resolution.decision === 'ask') continue;

		const targetRecordId = `unresolved_character_${stableIdSegment(name)}`;
		const [existingProposal] = await db.select().from(patchProposals).where(and(
			eq(patchProposals.storyId, input.storyId),
			eq(patchProposals.proposalType, 'character_reference_review'),
			eq(patchProposals.targetRecordId, targetRecordId),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		)).limit(1);

		const proposalId = `proposal_chapter_character_${stableIdSegment(`${input.storyId}_${name}`)}`;
		if (existingProposal) {
			const metadata = asRecord(existingProposal.metadata);
			const chapterReferences = [
				...asArray<JsonRecord>(metadata.chapterReferences).filter((ref) => asNullableString(ref.chapterId) !== input.chapterId),
				{ chapterId: input.chapterId, chapterNumber: input.chapterNumber },
			].slice(-12);
			await db.update(patchProposals).set({
				sourceEntryIds: stringList(existingProposal.sourceEntryIds, input.sourceEntryIds),
				sourceEventIds: stringList(existingProposal.sourceEventIds, input.sourceEventIds),
				metadata: {
					...metadata,
					chapterReferences,
				},
				confidence: Math.max(existingProposal.confidence, input.summary.toLowerCase().includes(name.toLowerCase()) ? 0.72 : 0.62),
				serverVersion: input.serverVersion,
				updatedAt: input.now,
			}).where(and(eq(patchProposals.storyId, input.storyId), eq(patchProposals.id, existingProposal.id)));
			await db.insert(sourceRefs).values({
				id: `source_ref_${stableIdSegment(`${input.chapterId}_${name}`)}`,
				storyId: input.storyId,
				sourceType: 'chapter',
				sourceId: input.chapterId,
				targetTable: 'patch_proposals',
				targetRecordId: existingProposal.id,
				targetRecordField: 'operations',
				sourceField: 'characters',
				confidence: 0.72,
				rationale: `${name} was listed as a chapter character.`,
				notes: 'Chapter character list added evidence to an existing review-only character reference.',
				serverVersion: input.serverVersion,
				createdAt: input.now,
				updatedAt: input.now,
			}).onConflictDoNothing();
			continue;
		}

		await db.insert(patchProposals).values({
			id: proposalId,
			storyId: input.storyId,
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId,
			proposedBy: 'chapter_command',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					storyId: input.storyId,
					type: 'character',
					name,
					description: `${name} is important in chapter ${input.chapterNumber}.`,
					status: 'active',
					visibility: 'player_known',
					state: {
						type: 'character',
						firstSeenChapterId: input.chapterId,
						firstSeenChapterNumber: input.chapterNumber,
						eventMemory: { did: [], saw: [], knew: [], knows: [] },
					},
				},
			}],
			reason: `${name} is listed as a key character in chapter ${input.chapterNumber}.`,
			suggestion: 'Review this chapter-important character before creating canon.',
			status: 'pending',
			decision: null,
			validatedBy: null,
			affectedEntityIds: [],
			confidence: input.summary.toLowerCase().includes(name.toLowerCase()) ? 0.72 : 0.62,
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: input.sourceEventIds,
			sourcePatchIds: [],
			metadata: {
				sourceType: 'chapter_character_reference',
				sourceName: name,
				chapterId: input.chapterId,
				chapterNumber: input.chapterNumber,
			},
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing();
		await db.insert(sourceRefs).values({
			id: `source_ref_${stableIdSegment(`${input.chapterId}_${name}`)}`,
			storyId: input.storyId,
			sourceType: 'chapter',
			sourceId: input.chapterId,
			targetTable: 'patch_proposals',
			targetRecordId: proposalId,
			targetRecordField: 'operations',
			sourceField: 'characters',
			confidence: 0.72,
			rationale: `${name} was listed as a chapter character.`,
			notes: 'Chapter character list created a review-only character reference.',
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing();
	}
}

async function upsertChapterMemoryNode(
	storyId: string,
	chapterId: string,
	chapter: JsonRecord,
	serverVersion: number,
	now: string,
) {
	const summary = asString(chapter.summary, asString(chapter.sceneOutcome)).trim();
	const number = asNumber(chapter.number, 0);
	const title = asString(chapter.title, `Chapter ${number || ''}`).trim() || `Chapter ${number || '?'}`;
	const sourceEntryIds = stringList(chapter.sourceEntryIds, chapter.startEntryId, chapter.endEntryId);
	const sourceEventIds = asStringArray(chapter.sourceEventIds);
	await getDb().insert(memoryNodes).values({
		id: `mem_chapter_${chapterId}`,
		storyId,
		type: 'episodic',
		title,
		content: summary,
		summary,
		keywords: asStringArray(chapter.keywords),
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: 0.65,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds: [],
		metadata: { sourceType: 'chapter_command' },
		serverVersion,
		createdAt: now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title,
			content: summary,
			summary,
			keywords: asStringArray(chapter.keywords),
			sourceEntryIds,
			sourceEventIds,
			metadata: { sourceType: 'chapter_command' },
			serverVersion,
			updatedAt: now,
		},
	});
}

export async function upsertBackendChapterFromLocal(storyId: string, rawChapter: unknown) {
	const db = getDb();
	const chapter = asRecord(rawChapter);
	const chapterId = asNullableString(chapter.id) ?? id('chapter');
	const summary = asString(chapter.summary, asString(chapter.sceneOutcome)).trim();
	if (!summary) throw new Error('Chapter summary is required.');
	const now = nowIso();
	const [story] = await db.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const [existing] = await db.select().from(chapters).where(and(eq(chapters.storyId, storyId), eq(chapters.id, chapterId))).limit(1);
	const serverVersion = await bumpStoryVersion(storyId);
	const metadata = chapterMetadataFromLocal(chapter, asRecord(existing?.metadata));
	const sourceEntryIds = stringList(chapter.sourceEntryIds, chapter.startEntryId, chapter.endEntryId);
	const sourceEventIds = asStringArray(chapter.sourceEventIds ?? existing?.sourceEventIds);
	const number = asNumber(chapter.number, asNumber(existing?.number, 1));
	const title = asNullableString(chapter.title);
	const openThreads = asStringArray(chapter.plotThreads ?? chapter.openThreads ?? existing?.openThreads);
	const irreversibleChanges = asStringArray(chapter.irreversibleChanges ?? existing?.irreversibleChanges);
	const npcKnowledgeChanges = asArray<Record<string, unknown>>(chapter.npcKnowledgeChanges ?? existing?.npcKnowledgeChanges);
	const promisesDebtsOaths = asStringArray(chapter.promisesDebtsOaths ?? existing?.promisesDebtsOaths);
	const discoveredClues = asStringArray(chapter.discoveredClues ?? existing?.discoveredClues);
	const relationshipChanges = asStringArray(chapter.relationshipChanges ?? existing?.relationshipChanges);
	const factionChanges = asStringArray(chapter.factionChanges ?? existing?.factionChanges);

	const [savedChapter] = await db.insert(chapters).values({
		id: chapterId,
		storyId,
		number,
		title,
		sceneOutcome: summary,
		irreversibleChanges,
		npcKnowledgeChanges,
		promisesDebtsOaths,
		discoveredClues,
		relationshipChanges,
		factionChanges,
		openThreads,
		sourceEntryIds,
		sourceEventIds,
		metadata,
		serverVersion,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: chapters.id,
		set: {
			number,
			title,
			sceneOutcome: summary,
			irreversibleChanges,
			npcKnowledgeChanges,
			promisesDebtsOaths,
			discoveredClues,
			relationshipChanges,
			factionChanges,
			openThreads,
			sourceEntryIds,
			sourceEventIds,
			metadata,
			serverVersion,
			updatedAt: now,
		},
	}).returning();

	await upsertChapterMemoryNode(storyId, chapterId, {
		...chapter,
		number,
		title,
		summary,
		sourceEntryIds,
		sourceEventIds,
		keywords: metadata.legacyKeywords,
	}, serverVersion, now);

	await createLocalChapterCharacterReferenceProposals({
		storyId,
		chapterId,
		chapterNumber: number,
		summary,
		characterNames: metadata.legacyCharacters as string[],
		sourceEntryIds,
		sourceEventIds,
		serverVersion,
		now,
	});

	await queueStoryVaultSync(storyId, serverVersion, 'chapter-upsert', { chapterId, number, title });
	return { storyId, serverVersion, chapter: savedChapter };
}

function arcMetadataFromLocal(arc: JsonRecord, existing: JsonRecord = {}): JsonRecord {
	return {
		...existing,
		legacyRange: asString(arc.chapterRange, asString(existing.legacyRange)),
		keyPlotPoints: asStringArray(arc.keyPlotPoints ?? existing.keyPlotPoints),
		characterArcs: asArray<Record<string, unknown>>(arc.characterArcs ?? existing.characterArcs),
		unresolvedThreads: asStringArray(arc.unresolvedThreads ?? existing.unresolvedThreads),
		resolvedThreadIds: asStringArray(arc.resolvedThreadIds ?? existing.resolvedThreadIds),
		emotionalProgression: asString(arc.emotionalProgression, asString(existing.emotionalProgression)),
		branchId: asNullableString(arc.branchId ?? existing.branchId),
		updatedBy: 'arc-command',
	};
}

export async function upsertBackendArcFromLocal(storyId: string, rawArc: unknown) {
	const db = getDb();
	const arc = asRecord(rawArc);
	const arcId = asNullableString(arc.id) ?? id('arc');
	const title = asString(arc.title).trim();
	if (!title) throw new Error('Arc title is required.');
	const summary = asString(arc.summary).trim();
	if (!summary) throw new Error('Arc summary is required.');
	const now = nowIso();
	const [story] = await db.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const [existing] = await db.select().from(arcs).where(and(eq(arcs.storyId, storyId), eq(arcs.id, arcId))).limit(1);
	const serverVersion = await bumpStoryVersion(storyId);
	const number = asNumber(arc.arcNumber ?? arc.number, asNumber(existing?.number, 1));
	const metadata = arcMetadataFromLocal(arc, asRecord(existing?.metadata));
	const chapterIds = asStringArray(arc.chapterIds ?? existing?.chapterIds);
	const openThreadIds = asStringArray(arc.threadIds ?? arc.openThreadIds ?? existing?.openThreadIds);
	const sourceEventIds = asStringArray(arc.sourceEventIds ?? existing?.sourceEventIds);

	const [savedArc] = await db.insert(arcs).values({
		id: arcId,
		storyId,
		number,
		title,
		summary,
		chapterIds,
		sourceEventIds,
		openThreadIds,
		metadata,
		serverVersion,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: arcs.id,
		set: {
			number,
			title,
			summary,
			chapterIds,
			sourceEventIds,
			openThreadIds,
			metadata,
			serverVersion,
			updatedAt: now,
		},
	}).returning();

	await queueStoryVaultSync(storyId, serverVersion, 'arc-upsert', { arcId, number, title });
	return { storyId, serverVersion, arc: savedArc };
}

export async function deleteBackendChapter(storyId: string, chapterId: string) {
	const db = getDb();
	const [chapter] = await db.select().from(chapters).where(and(eq(chapters.storyId, storyId), eq(chapters.id, chapterId))).limit(1);
	if (!chapter) throw new Error(`Chapter not found: ${chapterId}`);
	const serverVersion = await bumpStoryVersion(storyId);
	await db.delete(chapters).where(and(eq(chapters.storyId, storyId), eq(chapters.id, chapterId)));
	await db.delete(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, `mem_chapter_${chapterId}`)));
	const arcRows = await db.select().from(arcs).where(eq(arcs.storyId, storyId));
	const now = nowIso();
	const unwrappedArcs: JsonRecord[] = [];
	for (const arc of arcRows) {
		if (!arc.chapterIds.includes(chapterId)) continue;
		const nextChapterIds = arc.chapterIds.filter((id) => id !== chapterId);
		await db.update(arcs).set({
			chapterIds: nextChapterIds,
			serverVersion,
			updatedAt: now,
		}).where(and(eq(arcs.storyId, storyId), eq(arcs.id, arc.id)));
		unwrappedArcs.push({
			...arc,
			chapterIds: nextChapterIds,
			serverVersion,
			updatedAt: now,
		});
	}
	await queueStoryVaultSync(storyId, serverVersion, 'chapter-delete', { chapterId });
	return {
		storyId,
		serverVersion,
		chapterId,
		deleted: true,
		unwrappedArcIds: unwrappedArcs.map((arc) => String(arc.id)).filter(Boolean),
		unwrappedArcs,
	};
}

export async function deleteBackendArc(storyId: string, arcId: string) {
	const db = getDb();
	const [arc] = await db.select().from(arcs).where(and(eq(arcs.storyId, storyId), eq(arcs.id, arcId))).limit(1);
	if (!arc) throw new Error(`Arc not found: ${arcId}`);
	const serverVersion = await bumpStoryVersion(storyId);
	await db.delete(arcs).where(and(eq(arcs.storyId, storyId), eq(arcs.id, arcId)));
	await db.delete(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, `mem_arc_${arcId}`)));
	await queueStoryVaultSync(storyId, serverVersion, 'arc-delete', { arcId });
	return { storyId, serverVersion, arcId, deleted: true };
}

async function selectStoryRows(tx: Tx, table: unknown, storyColumn: unknown, storyId: string): Promise<JsonRecord[]> {
	return await tx
		.select()
		.from(table as never)
		.where(eq(storyColumn as never, storyId)) as JsonRecord[];
}

async function clearStoryRows(tx: Tx, table: unknown, storyColumn: unknown, storyId: string): Promise<void> {
	await tx.delete(table as never).where(eq(storyColumn as never, storyId));
}

const CONTEXT_RESTORE_INSERT_BATCH_SIZE = 1000;

async function restoreStoryRows(tx: Tx, table: unknown, rows: JsonRecord[], serverVersion: number, now: string): Promise<number> {
	if (rows.length === 0) return 0;
	const stamped = rows.map((row) => ({
		...row,
		serverVersion,
		updatedAt: now,
	}));
	for (let index = 0; index < stamped.length; index += CONTEXT_RESTORE_INSERT_BATCH_SIZE) {
		await tx.insert(table as never).values(stamped.slice(index, index + CONTEXT_RESTORE_INSERT_BATCH_SIZE) as never);
	}
	return stamped.length;
}

const CONTEXT_SNAPSHOT_TABLES = [
	{ key: 'storyEntries', table: storyEntries, storyColumn: storyEntries.storyId },
	{ key: 'entities', table: entities, storyColumn: entities.storyId },
	{ key: 'entityAliases', table: entityAliases, storyColumn: entityAliases.storyId },
	{ key: 'relationships', table: relationships, storyColumn: relationships.storyId },
	{ key: 'factions', table: factions, storyColumn: factions.storyId },
	{ key: 'factionMemberships', table: factionMemberships, storyColumn: factionMemberships.storyId },
	{ key: 'factionResources', table: factionResources, storyColumn: factionResources.storyId },
	{ key: 'factionGoals', table: factionGoals, storyColumn: factionGoals.storyId },
	{ key: 'factionProjects', table: factionProjects, storyColumn: factionProjects.storyId },
	{ key: 'agreements', table: agreements, storyColumn: agreements.storyId },
	{ key: 'storyThreads', table: storyThreads, storyColumn: storyThreads.storyId },
	{ key: 'npcBeliefs', table: npcBeliefs, storyColumn: npcBeliefs.storyId },
	{ key: 'storyEvents', table: storyEvents, storyColumn: storyEvents.storyId },
	{ key: 'npcEventLinks', table: npcEventLinks, storyColumn: npcEventLinks.storyId },
	{ key: 'statePatches', table: statePatches, storyColumn: statePatches.storyId },
	{ key: 'facts', table: facts, storyColumn: facts.storyId },
	{ key: 'sourceRefs', table: sourceRefs, storyColumn: sourceRefs.storyId },
	{ key: 'patchProposals', table: patchProposals, storyColumn: patchProposals.storyId },
	{ key: 'continuityWarnings', table: continuityWarnings, storyColumn: continuityWarnings.storyId },
	{ key: 'memoryNodes', table: memoryNodes, storyColumn: memoryNodes.storyId },
	{ key: 'chapters', table: chapters, storyColumn: chapters.storyId },
	{ key: 'arcs', table: arcs, storyColumn: arcs.storyId },
	{ key: 'sagas', table: sagas, storyColumn: sagas.storyId },
] as const;

const CONTEXT_RESTORE_DELETE_ORDER = [
	'contextCheckpointsIgnored',
	'npcEventLinks',
	'sourceRefs',
	'entityAliases',
	'factionMemberships',
	'factionResources',
	'factionGoals',
	'factionProjects',
	'npcBeliefs',
	'relationships',
	'facts',
	'patchProposals',
	'continuityWarnings',
	'memoryNodes',
	'statePatches',
	'storyEvents',
	'storyThreads',
	'chapters',
	'arcs',
	'sagas',
	'agreements',
	'factions',
	'entities',
	'storyEntries',
] as const;

const CONTEXT_RESTORE_INSERT_ORDER = [
	'storyEntries',
	'entities',
	'factions',
	'agreements',
	'storyThreads',
	'storyEvents',
	'chapters',
	'arcs',
	'sagas',
	'entityAliases',
	'relationships',
	'factionMemberships',
	'factionResources',
	'factionGoals',
	'factionProjects',
	'npcBeliefs',
	'npcEventLinks',
	'statePatches',
	'facts',
	'patchProposals',
	'continuityWarnings',
	'memoryNodes',
	'sourceRefs',
] as const;

function snapshotTableByKey(key: string) {
	return CONTEXT_SNAPSHOT_TABLES.find((spec) => spec.key === key) ?? null;
}

function rowsForSnapshotKey(snapshotTables: JsonRecord, key: string): JsonRecord[] {
	const rows = snapshotTables[key];
	return Array.isArray(rows) ? rows.filter((row): row is JsonRecord => Boolean(row && typeof row === 'object' && !Array.isArray(row))) : [];
}

export async function createContextCheckpoint(storyId: string, input: unknown = {}) {
	const request = asRecord(input);
	const db = getDb();
	const now = nowIso();
	return await db.transaction(async (tx) => {
		const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).limit(1);
		if (!story) throw new Error(`Story not found: ${storyId}`);
		const [lastEntry] = await tx.select({ position: storyEntries.position })
			.from(storyEntries)
			.where(eq(storyEntries.storyId, storyId))
			.orderBy(desc(storyEntries.position))
			.limit(1);
		const snapshotTables: JsonRecord = {};
		for (const spec of CONTEXT_SNAPSHOT_TABLES) {
			snapshotTables[spec.key] = await selectStoryRows(tx, spec.table, spec.storyColumn, storyId);
		}
		const checkpointId = id('checkpoint');
		const label = asString(request.label, `Checkpoint turn ${story.currentTurn}`);
		const reason = asNullableString(request.reason);
		const snapshot = {
			version: 1,
			story: {
				id: story.id,
				currentLocationId: story.currentLocationId,
				currentTurn: story.currentTurn,
				currentWorldTime: story.currentWorldTime,
				metadata: story.metadata,
			},
			tables: snapshotTables,
		};
		const serverVersion = await bumpStoryVersionTx(tx, storyId, now);
		const [checkpoint] = await tx.insert(contextCheckpoints).values({
			id: checkpointId,
			storyId,
			label,
			reason,
			entryPosition: lastEntry?.position ?? -1,
			currentTurn: story.currentTurn,
			snapshot,
			metadata: {
				sourceType: 'manual_context_checkpoint',
				tableCount: CONTEXT_SNAPSHOT_TABLES.length,
			},
			serverVersion,
			createdAt: now,
			updatedAt: now,
		}).returning();
		return { storyId, serverVersion, checkpoint };
	});
}

export async function listContextCheckpoints(storyId: string, limit = 50) {
	const max = Math.max(1, Math.min(200, Math.trunc(limit)));
	const checkpoints = await getDb()
		.select({
			id: contextCheckpoints.id,
			storyId: contextCheckpoints.storyId,
			label: contextCheckpoints.label,
			reason: contextCheckpoints.reason,
			entryPosition: contextCheckpoints.entryPosition,
			currentTurn: contextCheckpoints.currentTurn,
			metadata: contextCheckpoints.metadata,
			serverVersion: contextCheckpoints.serverVersion,
			createdAt: contextCheckpoints.createdAt,
			updatedAt: contextCheckpoints.updatedAt,
		})
		.from(contextCheckpoints)
		.where(eq(contextCheckpoints.storyId, storyId))
		.orderBy(desc(contextCheckpoints.createdAt))
		.limit(max);
	return { storyId, checkpoints };
}

export async function revertToContextCheckpoint(storyId: string, input: unknown) {
	const request = asRecord(input);
	const checkpointId = asString(request.checkpointId).trim();
	if (!checkpointId) throw new Error('Checkpoint id is required.');
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [checkpoint] = await tx.select().from(contextCheckpoints).where(and(
			eq(contextCheckpoints.storyId, storyId),
			eq(contextCheckpoints.id, checkpointId),
		)).limit(1);
		if (!checkpoint) throw new Error(`Context checkpoint not found: ${checkpointId}`);
		const snapshot = asRecord(checkpoint.snapshot);
		const storySnapshot = asRecord(snapshot.story);
		const snapshotTables = asRecord(snapshot.tables);
		const serverVersion = await bumpStoryVersionTx(tx, storyId, now);
		const restoredCounts: JsonRecord = {};

		for (const key of CONTEXT_RESTORE_DELETE_ORDER) {
			const spec = snapshotTableByKey(key);
			if (!spec) continue;
			await clearStoryRows(tx, spec.table, spec.storyColumn, storyId);
		}
		for (const key of CONTEXT_RESTORE_INSERT_ORDER) {
			const spec = snapshotTableByKey(key);
			if (!spec) continue;
			restoredCounts[key] = await restoreStoryRows(tx, spec.table, rowsForSnapshotKey(snapshotTables, key), serverVersion, now);
		}
		await tx.update(stories).set({
			currentLocationId: asNullableString(storySnapshot.currentLocationId),
			currentTurn: asNumber(storySnapshot.currentTurn, checkpoint.currentTurn),
			currentWorldTime: asNullableString(storySnapshot.currentWorldTime),
			metadata: {
				...asRecord(storySnapshot.metadata),
				lastContextCheckpointRevert: {
					checkpointId,
					revertedAt: now,
					reason: asNullableString(request.reason),
				},
			},
			serverVersion,
			updatedAt: now,
		}).where(eq(stories.id, storyId));
		await tx.update(contextCheckpoints).set({
			metadata: {
				...asRecord(checkpoint.metadata),
				lastRevertedAt: now,
				lastRevertReason: asNullableString(request.reason),
			},
			serverVersion,
			updatedAt: now,
		}).where(eq(contextCheckpoints.id, checkpoint.id));
		return {
			storyId,
			serverVersion,
			checkpoint: {
				...checkpoint,
				metadata: {
					...asRecord(checkpoint.metadata),
					lastRevertedAt: now,
					lastRevertReason: asNullableString(request.reason),
				},
				serverVersion,
				updatedAt: now,
			},
			restoredCounts,
		};
	});
	await queueStoryVaultSync(storyId, result.serverVersion, 'context-checkpoint-revert', {
		checkpointId,
		reason: asNullableString(request.reason),
	});
	return result;
}

function sagaMetadataFromLocal(saga: JsonRecord, existing: JsonRecord = {}): JsonRecord {
	return {
		...existing,
		legacyRange: asString(saga.arcRange, asString(existing.legacyRange)),
		branchId: asNullableString(saga.branchId ?? existing.branchId),
		updatedBy: 'saga-command',
	};
}

export async function upsertBackendSagaFromLocal(storyId: string, rawSaga: unknown) {
	const db = getDb();
	const saga = asRecord(rawSaga);
	const sagaId = asNullableString(saga.id) ?? id('saga');
	const title = asString(saga.title).trim();
	if (!title) throw new Error('Saga title is required.');
	const summary = asString(saga.summary).trim();
	if (!summary) throw new Error('Saga summary is required.');
	const now = nowIso();
	const [story] = await db.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const [existing] = await db.select().from(sagas).where(and(eq(sagas.storyId, storyId), eq(sagas.id, sagaId))).limit(1);
	const serverVersion = await bumpStoryVersion(storyId);
	const number = asNumber(saga.sagaNumber ?? saga.number, asNumber(existing?.number, 1));
	const metadata = sagaMetadataFromLocal(saga, asRecord(existing?.metadata));
	const arcIds = asStringArray(saga.arcIds ?? existing?.arcIds);
	const keyFactionShifts = asStringArray(saga.keyFactionShifts ?? existing?.keyFactionShifts);
	const majorPowerChanges = asStringArray(saga.majorPowerChanges ?? existing?.majorPowerChanges);
	const lingeringThreads = asStringArray(saga.lingeringThreads ?? existing?.lingeringThreads);
	const overallTone = asString(saga.overallTone, existing?.overallTone ?? '');
	const sourceEventIds = asStringArray(saga.sourceEventIds ?? existing?.sourceEventIds);
	const openThreadIds = asStringArray(saga.threadIds ?? saga.openThreadIds ?? existing?.openThreadIds);

	const [savedSaga] = await db.insert(sagas).values({
		id: sagaId,
		storyId,
		number,
		title,
		summary,
		arcIds,
		keyFactionShifts,
		majorPowerChanges,
		lingeringThreads,
		overallTone,
		sourceEventIds,
		openThreadIds,
		metadata,
		serverVersion,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: sagas.id,
		set: {
			number,
			title,
			summary,
			arcIds,
			keyFactionShifts,
			majorPowerChanges,
			lingeringThreads,
			overallTone,
			sourceEventIds,
			openThreadIds,
			metadata,
			serverVersion,
			updatedAt: now,
		},
	}).returning();

	await db.insert(memoryNodes).values({
		id: `mem_saga_${sagaId}`,
		storyId,
		type: 'plot_ledger',
		title,
		content: summary,
		summary,
		keywords: ['saga', 'arc_rollup'],
		entityIds: [],
		factionIds: [],
		threadIds: openThreadIds,
		locationId: null,
		visibility: 'player_known',
		importance: 0.84,
		sourceEntryIds: [],
		sourceEventIds,
		sourcePatchIds: [],
		metadata: { sourceType: 'saga_command', sagaId, arcIds },
		serverVersion,
		createdAt: now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title,
			content: summary,
			summary,
			threadIds: openThreadIds,
			sourceEventIds,
			metadata: { sourceType: 'saga_command', sagaId, arcIds },
			serverVersion,
			updatedAt: now,
		},
	});

	await queueStoryVaultSync(storyId, serverVersion, 'saga-upsert', { sagaId, number, title });
	return { storyId, serverVersion, saga: savedSaga };
}

async function insertEntityFromObject(
	storyId: string,
	table: string,
	item: JsonRecord,
	type: string,
	counts: Record<string, number>,
	skipped: Array<{ table: string; id?: string; reason: string }>,
): Promise<string | null> {
	const name = asString(item.name).trim();
	if (!name) {
		skipped.push({ table, id: asNullableString(item.id) ?? undefined, reason: 'Missing name.' });
		return null;
	}

	const requestedEntityId = asNullableString(item.id);
	const state = asRecord(item.state);
	const sourceEntryIds = sourceEntries(item.firstMentioned, item.lastMentioned);
	const resolution = await resolveEntityIdentity({
		storyId,
		db: getDb(),
		includeSemantic: false,
		candidate: {
			id: requestedEntityId,
			type,
			name,
			aliases: asStringArray(item.aliases),
			description: asNullableString(item.description),
			sourceEntryIds,
		},
	});
	const entityId = shouldReuseResolvedEntity(resolution) && resolution.entityId
		? resolution.entityId
		: requestedEntityId ?? id('entity');
	const [existing] = await getDb().select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, entityId))).limit(1);
	const metadata = {
		...asRecord(existing?.metadata),
		originalTable: table,
		originalMetadata: item.metadata ?? null,
		entityResolver: entityResolutionSummary(resolution),
	};
	const canonicalName = existing && normalizeAlias(existing.name) !== normalizeAlias(name) && existing.name.length >= name.length
		? existing.name
		: name;
	const insertedAt = nowIso();
	await getDb().insert(entities).values({
		id: entityId,
		storyId,
		type,
		name: canonicalName,
		description: asNullableString(item.description) ?? existing?.description ?? null,
		status: asString(item.status, existing?.status ?? 'active'),
		visibility: asString(item.visibility, existing?.visibility ?? 'player_known'),
		state: { ...asRecord(existing?.state), ...state },
		metadata,
		sourceEntryIds: stringList(existing?.sourceEntryIds, sourceEntryIds),
		createdAt: existing?.createdAt ?? insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: entities.id,
		set: {
			name: canonicalName,
			description: asNullableString(item.description) ?? existing?.description ?? null,
			status: asString(item.status, existing?.status ?? 'active'),
			visibility: asString(item.visibility, existing?.visibility ?? 'player_known'),
			state: { ...asRecord(existing?.state), ...state },
			metadata,
			sourceEntryIds: stringList(existing?.sourceEntryIds, sourceEntryIds),
			updatedAt: insertedAt,
		},
	});

	await getDb().delete(entityAliases).where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.entityId, entityId)));
	const matchedAliases = resolution.candidates.find((candidate) => candidate.entityId === entityId)?.aliases ?? [];
	const aliases = [...new Set([canonicalName, name, ...matchedAliases, ...asStringArray(item.aliases)])]
		.map((alias) => ({ alias, normalizedAlias: normalizeAlias(alias) }))
		.filter((alias) => alias.normalizedAlias);
	for (const alias of aliases) {
		await getDb().insert(entityAliases).values({
			id: id('alias'),
			storyId,
			entityId,
			alias: alias.alias,
			normalizedAlias: alias.normalizedAlias,
			sourceEntryIds,
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
	}

	counts.entities = (counts.entities ?? 0) + 1;
	return entityId;
}

async function importFactionFromEntry(storyId: string, entry: JsonRecord, entityId: string, counts: Record<string, number>, serverVersion = 1) {
	const state = asRecord(entry.state);
	const insertedAt = nowIso();
	const factionId = `faction_${entityId}`;
	await getDb().insert(factions).values({
		id: factionId,
		storyId,
		entityId,
		name: asString(entry.name),
		goals: asStringArray(state.goals),
		resources: extractFactionResources(state),
		memberEntityIds: extractFactionMembers(state),
		territoryIds: asStringArray(state.territories ?? state.territoryIds),
		allies: asStringArray(state.allies),
		enemies: asStringArray(state.enemies),
		pressure: asNumber(state.pressure, 0),
		metadata: { originalState: state },
		sourceEntryIds: sourceEntries(entry.firstMentioned, entry.lastMentioned),
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: factions.id,
		set: {
			goals: asStringArray(state.goals),
			resources: extractFactionResources(state),
			memberEntityIds: extractFactionMembers(state),
			serverVersion,
			updatedAt: insertedAt,
		},
	});
	counts.factions = (counts.factions ?? 0) + 1;

	const sourceEntryIds = sourceEntries(entry.firstMentioned, entry.lastMentioned);
	for (const [idx, member] of extractFactionMembers(state).entries()) {
		await getDb().insert(factionMemberships).values({
			id: `${factionId}_member_${idx}`,
			storyId,
			factionId,
			entityId: null,
			role: idx === 0 ? 'leader-or-member' : 'member',
			rank: null,
			status: 'active',
			visibility: 'player_known',
			metadata: { memberNameOrId: member },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion,
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionMemberships = (counts.factionMemberships ?? 0) + 1;
	}

	for (const [kind, amount] of Object.entries(extractFactionResources(state))) {
		if (amount == null || amount === '') continue;
		await getDb().insert(factionResources).values({
			id: `${factionId}_resource_${normalizeAlias(kind)}`,
			storyId,
			factionId,
			kind,
			name: kind,
			amount: typeof amount === 'number' ? amount : null,
			status: 'available',
			locationId: null,
			visibility: 'player_known',
			metadata: { value: amount },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion,
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionResources = (counts.factionResources ?? 0) + 1;
	}

	for (const [idx, goal] of asStringArray(state.goals).entries()) {
		await getDb().insert(factionGoals).values({
			id: `${factionId}_goal_${idx}`,
			storyId,
			factionId,
			goal,
			status: 'active',
			priority: 5,
			secrecy: 'player_known',
			metadata: {},
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion,
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionGoals = (counts.factionGoals ?? 0) + 1;
	}
}

async function createMemoryNodeFromChapter(storyId: string, chapter: JsonRecord, counts: Record<string, number>) {
	const chapterId = asNullableString(chapter.id) ?? id('chapter');
	const insertedAt = nowIso();
	const sourceEntryIds = sourceEntries(chapter.startEntryId, chapter.endEntryId);
	const summary = asString(chapter.summary, asString(chapter.sceneOutcome));
	await getDb().insert(chapters).values({
		id: chapterId,
		storyId,
		number: asNumber(chapter.number, (counts.chapters ?? 0) + 1),
		title: asNullableString(chapter.title),
		sceneOutcome: summary,
		irreversibleChanges: asStringArray(chapter.irreversibleChanges),
		npcKnowledgeChanges: asArray<Record<string, unknown>>(chapter.npcKnowledgeChanges),
		promisesDebtsOaths: asStringArray(chapter.promisesDebtsOaths),
		discoveredClues: asStringArray(chapter.discoveredClues),
		relationshipChanges: asStringArray(chapter.relationshipChanges),
		factionChanges: asStringArray(chapter.factionChanges),
		openThreads: asStringArray(chapter.openThreads ?? chapter.plotThreads),
		sourceEntryIds,
		sourceEventIds: asStringArray(chapter.sourceEventIds),
		metadata: {
			legacyKeywords: asStringArray(chapter.keywords),
			legacyCharacters: asStringArray(chapter.characters),
			legacyLocations: asStringArray(chapter.locations),
		},
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.chapters = (counts.chapters ?? 0) + 1;

	await getDb().insert(memoryNodes).values({
		id: `mem_chapter_${chapterId}`,
		storyId,
		type: 'episodic',
		title: asString(chapter.title, `Chapter ${asNumber(chapter.number, counts.chapters)}`),
		content: summary,
		summary,
		keywords: asStringArray(chapter.keywords),
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: 0.65,
		sourceEntryIds,
		sourceEventIds: asStringArray(chapter.sourceEventIds),
		sourcePatchIds: [],
		metadata: { sourceType: 'chapter_import' },
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
}

async function createMemoryNodeFromThread(storyId: string, thread: JsonRecord, counts: Record<string, number>) {
	const threadId = asNullableString(thread.id) ?? id('thread');
	const insertedAt = nowIso();
	await getDb().insert(storyThreads).values({
		id: threadId,
		storyId,
		description: asString(thread.description),
		status: asString(thread.status, 'open'),
		significance: asString(thread.significance, 'moderate'),
		relatedFactionIds: asStringArray(thread.relatedFactionIds),
		relatedEntityIds: asStringArray(thread.relatedEntityIds ?? thread.relatedCharacterNames),
		sourceEntryIds: [],
		sourceEventIds: sourceEntries(thread.sourceEventIds, thread.sourceChapterId),
		sourcePatchIds: [],
		closedAt: asNullableString(thread.closedAt),
		closureReason: asNullableString(thread.closureReason),
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.threads = (counts.threads ?? 0) + 1;

	if (asString(thread.status, 'open') !== 'closed') {
		await getDb().insert(memoryNodes).values({
			id: `mem_thread_${threadId}`,
			storyId,
			type: 'plot_ledger',
			title: 'Open thread',
			content: asString(thread.description),
			summary: asString(thread.description),
			keywords: [],
			entityIds: asStringArray(thread.relatedEntityIds ?? thread.relatedCharacterNames),
			factionIds: asStringArray(thread.relatedFactionIds),
			threadIds: [threadId],
			locationId: null,
			visibility: 'player_known',
			importance: asString(thread.significance) === 'critical' ? 0.95 : 0.75,
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			metadata: { sourceType: 'thread_import' },
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	}
}

function compactText(...values: unknown[]): string {
	return values
		.flatMap((value) => Array.isArray(value) ? value : [value])
		.map((value) => typeof value === 'string' ? value.trim() : '')
		.filter(Boolean)
		.join('\n');
}

function mutableSyncFields<T extends { id: string; storyId: string; createdAt: string }>(
	row: T,
): Omit<T, 'id' | 'storyId' | 'createdAt'> {
	const { id: _id, storyId: _storyId, createdAt: _createdAt, ...mutable } = row;
	return mutable;
}

function eventTypeFromLegacy(value: unknown): string {
	const type = asString(value, 'imported_memory');
	if (type === 'death') return 'death';
	if (type === 'secret_revealed') return 'reveal';
	if (type === 'hostility_change') return 'relationship_shift';
	if (type === 'alliance_formed' || type === 'alliance_broken' || type === 'territory_change') return 'faction_move';
	if (type === 'item_destroyed' || type === 'location_blocked') return 'correction';
	return 'imported_memory';
}

function schemeThreadStatus(value: unknown): string {
	const status = asString(value, 'open');
	if (status === 'resolved' || status === 'foiled') return 'closed';
	if (status === 'abandoned') return 'abandoned';
	if (status === 'climaxing') return 'imminent';
	if (status === 'incubating') return 'stalled';
	return 'open';
}

function schemeSignificance(pressure: number): string {
	if (pressure >= 80) return 'critical';
	if (pressure >= 55) return 'major';
	if (pressure >= 25) return 'moderate';
	return 'minor';
}

async function importConversationMemory(
	storyId: string,
	memory: JsonRecord,
	counts: Record<string, number>,
	options: LivingMemoryWriteOptions = {},
): Promise<string[]> {
	const memoryId = asNullableString(memory.id) ?? id('conversation');
	const insertedAt = options.timestamp ?? nowIso();
	const serverVersion = options.serverVersion ?? 1;
	const npcName = asString(memory.npcName, 'Unknown NPC');
	const topic = asString(memory.topic, 'Conversation memory');
	const learned = asStringArray(memory.npcLearned);
	const content = compactText(
		`Topic: ${topic}`,
		asNullableString(memory.playerSaid) ? `Player said: ${asString(memory.playerSaid)}` : null,
		learned.length > 0 ? `NPC learned: ${learned.join('; ')}` : null,
		asNullableString(memory.emotionalImpact) ? `Emotional impact: ${asString(memory.emotionalImpact)}` : null,
	);
	const row = {
		id: `mem_conversation_${memoryId}`,
		storyId,
		type: 'npc_belief',
		title: `Conversation memory: ${npcName}`,
		content,
		summary: content,
		keywords: stringList(npcName, topic),
		entityIds: stringList(memory.npcEntryId),
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'secret',
		importance: asString(memory.importance) === 'critical' ? 0.9 : asString(memory.importance) === 'significant' ? 0.75 : 0.45,
		sourceEntryIds: stringList(memory.storyEntryId),
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: { sourceType: 'conversation_memory_import', legacyRecord: memory },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const insert = getDb().insert(memoryNodes).values(row);
	if (options.mode === 'upsert') {
		await insert.onConflictDoUpdate({
			target: memoryNodes.id,
			set: mutableSyncFields(row),
		});
	} else {
		await insert.onConflictDoNothing();
	}
	counts.conversationMemory = (counts.conversationMemory ?? 0) + 1;
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	return [row.id];
}

async function importWorldEvent(
	storyId: string,
	event: JsonRecord,
	counts: Record<string, number>,
	options: LivingMemoryWriteOptions = {},
): Promise<string[]> {
	const eventId = asNullableString(event.id) ?? id('event');
	const insertedAt = options.timestamp ?? nowIso();
	const serverVersion = options.serverVersion ?? 1;
	const consequences = asArray<JsonRecord>(event.consequences);
	const consequenceText = consequences
		.map((consequence) => asString(consequence.description))
		.filter(Boolean);
	const body = compactText(asString(event.description), consequenceText);
	const eventRow = {
		id: eventId,
		storyId,
		type: eventTypeFromLegacy(event.type),
		title: asString(event.name, 'Imported world event'),
		body,
		actorEntityIds: stringList(event.sourceEntityId),
		targetEntityIds: stringList(...consequences.map((consequence) => consequence.targetEntityId)),
		locationId: null,
		threadIds: [],
		visibility: 'player_known',
		sourceEntryIds: stringList(event.triggerEntryId),
		sourcePatchIds: [],
		metadata: {
			sourceType: 'world_event_import',
			legacyType: event.type ?? null,
			severity: event.severity ?? null,
			triggerPosition: event.triggerPosition ?? null,
			legacyRecord: event,
		},
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const eventInsert = getDb().insert(storyEvents).values(eventRow);
	if (options.mode === 'upsert') {
		await eventInsert.onConflictDoUpdate({
			target: storyEvents.id,
			set: mutableSyncFields(eventRow),
		});
	} else {
		await eventInsert.onConflictDoNothing();
	}
	counts.worldEvents = (counts.worldEvents ?? 0) + 1;
	counts.events = (counts.events ?? 0) + 1;

	const nodeRow = {
		id: `mem_world_event_${eventId}`,
		storyId,
		type: 'episodic',
		title: asString(event.name, 'Imported world event'),
		content: body,
		summary: body,
		keywords: stringList(event.type, event.severity),
		entityIds: stringList(event.sourceEntityId, ...consequences.map((consequence) => consequence.targetEntityId)),
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: asString(event.severity) === 'catastrophic' ? 0.95 : asString(event.severity) === 'major' ? 0.85 : 0.65,
		sourceEntryIds: stringList(event.triggerEntryId),
		sourceEventIds: [eventId],
		sourcePatchIds: [],
		metadata: { sourceType: 'world_event_import', legacyRecord: event },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const nodeInsert = getDb().insert(memoryNodes).values(nodeRow);
	if (options.mode === 'upsert') {
		await nodeInsert.onConflictDoUpdate({
			target: memoryNodes.id,
			set: mutableSyncFields(nodeRow),
		});
	} else {
		await nodeInsert.onConflictDoNothing();
	}
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	return [eventRow.id, nodeRow.id];
}

async function importFactionAction(
	storyId: string,
	action: JsonRecord,
	counts: Record<string, number>,
	options: LivingMemoryWriteOptions = {},
): Promise<string[]> {
	const actionId = asNullableString(action.id) ?? id('faction_action');
	const insertedAt = options.timestamp ?? nowIso();
	const serverVersion = options.serverVersion ?? 1;
	const title = `${asString(action.factionName, 'Faction')} ${asString(action.actionType, 'move')}`;
	const consequences = asStringArray(action.consequences);
	const body = compactText(asString(action.action), consequences.length > 0 ? `Consequences: ${consequences.join('; ')}` : null);
	const eventRow = {
		id: `event_${actionId}`,
		storyId,
		type: 'faction_move',
		title,
		body,
		actorEntityIds: [],
		targetEntityIds: [],
		locationId: null,
		threadIds: [],
		visibility: 'player_known',
		sourceEntryIds: [],
		sourcePatchIds: [],
		metadata: { sourceType: 'faction_action_import', legacyRecord: action },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const eventInsert = getDb().insert(storyEvents).values(eventRow);
	if (options.mode === 'upsert') {
		await eventInsert.onConflictDoUpdate({
			target: storyEvents.id,
			set: mutableSyncFields(eventRow),
		});
	} else {
		await eventInsert.onConflictDoNothing();
	}
	counts.factionActions = (counts.factionActions ?? 0) + 1;
	counts.events = (counts.events ?? 0) + 1;

	const nodeRow = {
		id: `mem_faction_action_${actionId}`,
		storyId,
		type: 'faction',
		title,
		content: body,
		summary: body,
		keywords: stringList(action.factionName, action.actionType, action.target, action.urgency),
		entityIds: [],
		factionIds: stringList(action.factionName),
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: asString(action.urgency) === 'critical' ? 0.9 : asString(action.urgency) === 'high' ? 0.75 : 0.55,
		sourceEntryIds: [],
		sourceEventIds: [`event_${actionId}`],
		sourcePatchIds: [],
		metadata: { sourceType: 'faction_action_import', legacyRecord: action },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const nodeInsert = getDb().insert(memoryNodes).values(nodeRow);
	if (options.mode === 'upsert') {
		await nodeInsert.onConflictDoUpdate({
			target: memoryNodes.id,
			set: mutableSyncFields(nodeRow),
		});
	} else {
		await nodeInsert.onConflictDoNothing();
	}
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	return [eventRow.id, nodeRow.id];
}

async function importRumor(
	storyId: string,
	rumor: JsonRecord,
	counts: Record<string, number>,
	options: LivingMemoryWriteOptions = {},
): Promise<string[]> {
	const rumorId = asNullableString(rumor.id) ?? id('rumor');
	const insertedAt = options.timestamp ?? nowIso();
	const serverVersion = options.serverVersion ?? 1;
	const content = asString(rumor.content, 'Imported rumor');
	const row = {
		id: `mem_rumor_${rumorId}`,
		storyId,
		type: 'episodic',
		title: 'Rumor',
		content,
		summary: content,
		keywords: stringList(rumor.originRegion, rumor.relatedFaction, rumor.sourceType, rumor.status),
		entityIds: [],
		factionIds: stringList(rumor.relatedFaction),
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: Math.max(0.35, Math.min(0.8, asNumber(rumor.truthfulness, 0.5))),
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: { sourceType: 'rumor_import', legacyRecord: rumor },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const insert = getDb().insert(memoryNodes).values(row);
	if (options.mode === 'upsert') {
		await insert.onConflictDoUpdate({
			target: memoryNodes.id,
			set: mutableSyncFields(row),
		});
	} else {
		await insert.onConflictDoNothing();
	}
	counts.rumors = (counts.rumors ?? 0) + 1;
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	return [row.id];
}

async function importScheme(
	storyId: string,
	scheme: JsonRecord,
	counts: Record<string, number>,
	options: LivingMemoryWriteOptions = {},
): Promise<string[]> {
	const schemeId = asNullableString(scheme.id) ?? id('scheme');
	const insertedAt = options.timestamp ?? nowIso();
	const serverVersion = options.serverVersion ?? 1;
	const stages = asArray<JsonRecord>(scheme.stages);
	const stageText = stages.map((stage) => compactText(asString(stage.label), asString(stage.hook))).filter(Boolean);
	const description = compactText(`${asString(scheme.ownerName, 'Unknown actor')}: ${asString(scheme.goal, 'Imported scheme')}`, stageText);
	const pressure = asNumber(scheme.pressure, 40);
	const threadRow = {
		id: schemeId,
		storyId,
		description,
		status: schemeThreadStatus(scheme.status),
		significance: schemeSignificance(pressure),
		relatedFactionIds: asString(scheme.ownerType) === 'faction' ? stringList(scheme.ownerEntryId, scheme.ownerName) : [],
		relatedEntityIds: stringList(scheme.ownerEntryId),
		sourceEntryIds: stringList(scheme.triggerEntryId),
		sourceEventIds: [],
		sourcePatchIds: [],
		closedAt: ['resolved', 'foiled', 'abandoned'].includes(asString(scheme.status)) ? insertedAt : null,
		closureReason: ['resolved', 'foiled', 'abandoned'].includes(asString(scheme.status)) ? asString(scheme.status) : null,
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const threadInsert = getDb().insert(storyThreads).values(threadRow);
	if (options.mode === 'upsert') {
		await threadInsert.onConflictDoUpdate({
			target: storyThreads.id,
			set: mutableSyncFields(threadRow),
		});
	} else {
		await threadInsert.onConflictDoNothing();
	}
	counts.schemes = (counts.schemes ?? 0) + 1;
	counts.threads = (counts.threads ?? 0) + 1;

	const nodeRow = {
		id: `mem_scheme_${schemeId}`,
		storyId,
		type: 'plot_ledger',
		title: `Scheme: ${asString(scheme.goal, schemeId)}`,
		content: description,
		summary: description,
		keywords: stringList(scheme.ownerName, scheme.ownerType, scheme.status, scheme.secrecy),
		entityIds: stringList(scheme.ownerEntryId),
		factionIds: asString(scheme.ownerType) === 'faction' ? stringList(scheme.ownerName) : [],
		threadIds: [schemeId],
		locationId: null,
		visibility: asString(scheme.secrecy) === 'secret' ? 'secret' : 'player_known',
		importance: Math.max(0.45, Math.min(0.95, pressure / 100)),
		sourceEntryIds: stringList(scheme.triggerEntryId),
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: { sourceType: 'scheme_import', legacyRecord: scheme },
		serverVersion,
		createdAt: insertedAt,
		updatedAt: insertedAt,
	};
	const nodeInsert = getDb().insert(memoryNodes).values(nodeRow);
	if (options.mode === 'upsert') {
		await nodeInsert.onConflictDoUpdate({
			target: memoryNodes.id,
			set: mutableSyncFields(nodeRow),
		});
	} else {
		await nodeInsert.onConflictDoNothing();
	}
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	return [threadRow.id, nodeRow.id];
}

export async function upsertBackendLivingMemoryFromLocal(
	storyId: string,
	kind: LivingMemoryKind,
	rawRecords: unknown[],
) {
	const records = rawRecords.map(asRecord).filter((record) => Object.keys(record).length > 0);
	if (records.length === 0) {
		const serverVersion = await bumpStoryVersion(storyId);
		await queueStoryVaultSync(storyId, serverVersion, 'living-memory-empty', { kind });
		return { storyId, serverVersion, kind, recordIds: [], counts: {} };
	}

	const serverVersion = await bumpStoryVersion(storyId);
	const timestamp = nowIso();
	const counts: Record<string, number> = {};
	const recordIds: string[] = [];
	for (const record of records) {
		const options: LivingMemoryWriteOptions = { serverVersion, timestamp, mode: 'upsert' };
		if (kind === 'conversationMemory') recordIds.push(...await importConversationMemory(storyId, record, counts, options));
		if (kind === 'worldEvent') recordIds.push(...await importWorldEvent(storyId, record, counts, options));
		if (kind === 'factionAction') recordIds.push(...await importFactionAction(storyId, record, counts, options));
		if (kind === 'rumor') recordIds.push(...await importRumor(storyId, record, counts, options));
		if (kind === 'scheme') recordIds.push(...await importScheme(storyId, record, counts, options));
	}

	await queueStoryVaultSync(storyId, serverVersion, 'living-memory-upsert', { kind, recordIds, counts });
	return { storyId, serverVersion, kind, recordIds, counts };
}

export async function importIndexedDbBundle(input: unknown) {
	const request = indexedDbImportRequestSchema.parse(input);
	const { importEntryLimit } = getServerMemoryConfig();
	const bundle = request.options.preserveIds
		? request.bundle
		: remapImportedBundleIds(request.bundle);
	const legacyStory = asRecord(bundle.story);
	const storyId = asNullableString(legacyStory.id) ?? id('story');
	const counts: Record<string, number> = {};
	const skipped: Array<{ table: string; id?: string; reason: string }> = [];
	const merged: Array<{ table: string; sourceId: string; targetId: string }> = [];
	const insertedAt = nowIso();

	await getDb().insert(stories).values({
		id: storyId,
		clientStoryId: asNullableString(legacyStory.id),
		title: asString(legacyStory.title, 'Imported Story'),
		description: asNullableString(legacyStory.description),
		genre: asNullableString(legacyStory.genre),
		mode: asString(legacyStory.mode, 'adventure'),
		settings: asRecord(legacyStory.settings),
		headerPrompt: asNullableString(legacyStory.headerPrompt),
		metadata: {
			importedFrom: 'indexeddb',
			importedAt: insertedAt,
			playerReputation: asNullableString(legacyStory.playerReputation),
		},
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: stories.id,
		set: {
			title: asString(legacyStory.title, 'Imported Story'),
			description: asNullableString(legacyStory.description),
			updatedAt: insertedAt,
		},
	});
	counts.stories = 1;

	const entries = asArray<JsonRecord>(bundle.storyEntries).slice(0, importEntryLimit);
	for (const entry of entries) {
		const entryId = asNullableString(entry.id) ?? id('entry');
		await getDb().insert(storyEntries).values({
			id: entryId,
			storyId,
			type: asString(entry.type, 'system'),
			content: asString(entry.content),
			position: asNumber(entry.position, counts.entries ?? 0),
			parentId: asNullableString(entry.parentId),
			branchId: asNullableString(entry.branchId),
			metadata: asRecord(entry.metadata),
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.entries = (counts.entries ?? 0) + 1;
	}

	for (const character of asArray<JsonRecord>(bundle.characters)) {
		await insertEntityFromObject(storyId, 'characters', character, 'character', counts, skipped);
	}
	for (const location of asArray<JsonRecord>(bundle.locations)) {
		await insertEntityFromObject(storyId, 'locations', location, 'location', counts, skipped);
	}
	for (const item of asArray<JsonRecord>(bundle.items)) {
		await insertEntityFromObject(storyId, 'items', item, 'item', counts, skipped);
	}
	for (const entry of asArray<JsonRecord>(bundle.lorebookEntries)) {
		const type = asString(entry.type, 'concept');
		const entityId = await insertEntityFromObject(storyId, 'lorebookEntries', entry, type, counts, skipped);
		if (entityId && type === 'faction') await importFactionFromEntry(storyId, entry, entityId, counts);
	}

	for (const rel of asArray<JsonRecord>(bundle.entryRelationships)) {
		const relId = asNullableString(rel.id) ?? id('rel');
		await getDb().insert(relationships).values({
			id: relId,
			storyId,
			sourceEntityId: asString(rel.sourceEntryId),
			targetEntityId: asString(rel.targetEntryId),
			type: asString(rel.type, 'related-to'),
			label: asNullableString(rel.label),
			strength: asNumber(rel.strength, 0.5),
			bidirectional: Boolean(rel.bidirectional),
			metadata: asRecord(rel.metadata),
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.relationships = (counts.relationships ?? 0) + 1;
	}

	for (const agreement of asArray<JsonRecord>(bundle.agreements)) {
		const agreementId = asNullableString(agreement.id) ?? id('agreement');
		await getDb().insert(agreements).values({
			id: agreementId,
			storyId,
			parties: asStringArray(agreement.parties),
			category: asString(agreement.category, 'pact'),
			terms: asString(agreement.terms),
			status: asString(agreement.status, 'active'),
			secrecy: asString(agreement.secrecy, 'known'),
			consequences: asStringArray(agreement.consequences),
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.agreements = (counts.agreements ?? 0) + 1;
	}

	for (const chapter of asArray<JsonRecord>(bundle.chapters)) {
		await createMemoryNodeFromChapter(storyId, chapter, counts);
	}

	for (const arc of asArray<JsonRecord>(bundle.arcs)) {
		const arcId = asNullableString(arc.id) ?? id('arc');
		await getDb().insert(arcs).values({
			id: arcId,
			storyId,
			number: asNumber(arc.arcNumber ?? arc.number, (counts.arcs ?? 0) + 1),
			title: asString(arc.title, `Arc ${(counts.arcs ?? 0) + 1}`),
			summary: asString(arc.summary),
			chapterIds: asStringArray(arc.chapterIds),
			sourceEventIds: asStringArray(arc.sourceEventIds),
			openThreadIds: asStringArray(arc.threadIds ?? arc.unresolvedThreads),
			metadata: { legacyRange: arc.chapterRange ?? null, characterArcs: arc.characterArcs ?? [] },
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.arcs = (counts.arcs ?? 0) + 1;
	}

	for (const thread of asArray<JsonRecord>(bundle.storyThreads)) {
		await createMemoryNodeFromThread(storyId, thread, counts);
	}
	for (const memory of asArray<JsonRecord>(bundle.conversationMemory)) {
		await importConversationMemory(storyId, memory, counts);
	}
	for (const event of asArray<JsonRecord>(bundle.worldEvents)) {
		await importWorldEvent(storyId, event, counts);
	}
	for (const action of asArray<JsonRecord>(bundle.factionActions)) {
		await importFactionAction(storyId, action, counts);
	}
	for (const rumor of asArray<JsonRecord>(bundle.rumors)) {
		await importRumor(storyId, rumor, counts);
	}
	for (const scheme of asArray<JsonRecord>(bundle.schemes)) {
		await importScheme(storyId, scheme, counts);
	}

	const importEventId = id('event');
	await getDb().insert(storyEvents).values({
		id: importEventId,
		storyId,
		type: 'imported_memory',
		title: 'IndexedDB story imported',
		body: `Imported ${counts.entries ?? 0} entries, ${counts.entities ?? 0} entities, ${counts.chapters ?? 0} chapters, and ${counts.factions ?? 0} factions into the terminal world database.`,
		visibility: 'player_known',
		sourceEntryIds: entries.slice(0, 20).map((entry) => asString(entry.id)).filter(Boolean),
		sourcePatchIds: [],
		metadata: { counts },
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.events = (counts.events ?? 0) + 1;

	const serverVersion = await bumpStoryVersion(storyId);
	try {
		const jobIds = await enqueueImportProjectionJobs({ storyId, counts, serverVersion });
		counts.backendJobsQueued = jobIds.length;
	} catch {
		counts.backendJobsQueued = 0;
	}
	return { storyId, serverVersion, counts, skipped, merged };
}

function remapImportedBundleIds(rawBundle: JsonRecord): JsonRecord {
	const bundle = JSON.parse(JSON.stringify(rawBundle)) as JsonRecord;
	const originalStoryId = asNullableString(asRecord(bundle.story).id);
	const targetStoryId = id('story');
	const idMap = new Map<string, string>();
	if (originalStoryId) idMap.set(originalStoryId, targetStoryId);

	const mapId = (value: string): string => {
		const clean = value.trim();
		if (!clean) return value;
		let mapped = idMap.get(clean);
		if (!mapped) {
			mapped = id('import');
			idMap.set(clean, mapped);
		}
		return mapped;
	};

	const remap = (value: unknown, key = ''): unknown => {
		if (Array.isArray(value)) {
			if (isIdListKey(key)) return value.map((item) => typeof item === 'string' ? mapId(item) : remap(item));
			return value.map((item) => remap(item));
		}
		if (!value || typeof value !== 'object') return value;
		const output: JsonRecord = {};
		for (const [childKey, childValue] of Object.entries(value as JsonRecord)) {
			if (childKey === 'storyId') {
				output[childKey] = targetStoryId;
			} else if (childKey === 'serverStoryId' || childKey === 'clientStoryId') {
				output[childKey] = null;
			} else if (childKey === 'syncStatus') {
				output[childKey] = 'syncing';
			} else if (isIdListKey(childKey)) {
				output[childKey] = Array.isArray(childValue)
					? childValue.map((item) => typeof item === 'string' ? mapId(item) : remap(item, childKey))
					: childValue;
			} else if (isIdKey(childKey)) {
				output[childKey] = typeof childValue === 'string'
					? mapId(childValue)
					: childValue == null
						? null
						: remap(childValue, childKey);
			} else {
				output[childKey] = remap(childValue, childKey);
			}
		}
		return output;
	};

	return remap(bundle) as JsonRecord;
}

function isIdKey(key: string): boolean {
	return key === 'id' || key.endsWith('Id');
}

function isIdListKey(key: string): boolean {
	return key.endsWith('Ids');
}

export async function exportBackendStory(storyId: string) {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entryRows,
		entityRows,
		aliasRows,
		relationshipRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		agreementRows,
		threadRows,
		beliefRows,
		eventRows,
		npcEventLinkRows,
		patchRows,
		factRows,
		sourceRefRows,
		patchProposalRows,
		continuityWarningRows,
		nodeRows,
		chapterRows,
		arcRows,
		sagaRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(asc(storyEntries.position)),
		db.select().from(entities).where(eq(entities.storyId, storyId)).orderBy(asc(entities.name)),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, storyId)).orderBy(asc(entityAliases.alias)),
		db.select().from(relationships).where(eq(relationships.storyId, storyId)),
		db.select().from(factions).where(eq(factions.storyId, storyId)).orderBy(asc(factions.name)),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)),
		db.select().from(agreements).where(eq(agreements.storyId, storyId)),
		db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)),
		db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(asc(storyEvents.createdAt)),
		db.select().from(npcEventLinks).where(eq(npcEventLinks.storyId, storyId)).orderBy(asc(npcEventLinks.createdAt)),
		db.select().from(statePatches).where(eq(statePatches.storyId, storyId)).orderBy(asc(statePatches.createdAt)),
		db.select().from(facts).where(eq(facts.storyId, storyId)).orderBy(asc(facts.createdAt)),
		db.select().from(sourceRefs).where(eq(sourceRefs.storyId, storyId)).orderBy(asc(sourceRefs.createdAt)),
		db.select().from(patchProposals).where(eq(patchProposals.storyId, storyId)).orderBy(asc(patchProposals.createdAt)),
		db.select().from(continuityWarnings).where(eq(continuityWarnings.storyId, storyId)).orderBy(asc(continuityWarnings.createdAt)),
		db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId)).orderBy(asc(memoryNodes.updatedAt)),
		db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number)),
		db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(asc(arcs.number)),
		db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number)),
	]);

	const aliasesByEntity = new Map<string, string[]>();
	for (const alias of aliasRows) {
		const list = aliasesByEntity.get(alias.entityId) ?? [];
		list.push(alias.alias);
		aliasesByEntity.set(alias.entityId, list);
	}
	const entityById = new Map(entityRows.map((entity) => [entity.id, entity]));
	const lorebookEntries = entityRows.map((entity) => exportEntityAsLorebookEntry(entity, aliasesByEntity.get(entity.id) ?? []));
	for (const faction of factionRows) {
		if (faction.entityId && entityById.has(faction.entityId)) continue;
		lorebookEntries.push(exportFactionAsLorebookEntry(faction));
	}
	const worldDatabase = {
		story,
		entries: entryRows,
		entities: entityRows,
		entityAliases: aliasRows,
		relationships: relationshipRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		factionProjects: factionProjectRows,
		agreements: agreementRows,
		threads: threadRows,
		npcBeliefs: beliefRows,
		events: eventRows,
		npcEventLinks: npcEventLinkRows,
		statePatches: patchRows,
		facts: factRows,
		sourceRefs: sourceRefRows,
		patchProposals: patchProposalRows,
		continuityWarnings: continuityWarningRows,
		memoryNodes: nodeRows.map((row) => ({ ...row, embedding: undefined })),
		chapters: chapterRows,
		arcs: arcRows,
		sagas: sagaRows,
	};

	return {
		schemaVersion: TERMINAL_WORLD_DATABASE_SCHEMA_VERSION,
		version: TERMINAL_WORLD_DATABASE_SCHEMA_VERSION,
		exportedAt: Date.now(),
		source: 'terminal_world_database',
		worldDatabase,
		story: exportStoryRow(story),
		storyEntries: entryRows.map(exportEntryRow),
		characters: [],
		locations: [],
		items: [],
		storyBeats: [],
		chapters: chapterRows.map(exportChapterRow),
		lorebookEntries,
		arcs: arcRows.map(exportArcRow),
		sagas: sagaRows.map(exportSagaRow),
		entryRelationships: relationshipRows.map(exportRelationshipRow),
		conversationMemory: [],
		worldEvents: eventRows.map(exportEventAsWorldEvent),
		agreements: agreementRows,
		factionActions: [],
		rumors: [],
		schemes: [],
		storyThreads: threadRows,
		backendCanon: worldDatabase,
	};
}

function exportTime(value: string | null | undefined): number {
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function exportStoryRow(story: typeof stories.$inferSelect): JsonRecord {
	const metadata = asRecord(story.metadata);
	return {
		id: story.id,
		title: story.title,
		description: story.description,
		genre: story.genre,
		templateId: null,
		mode: story.mode,
		createdAt: exportTime(story.createdAt),
		updatedAt: exportTime(story.updatedAt),
		settings: story.settings ?? null,
		memoryConfig: null,
		retryState: null,
		styleReviewState: null,
		timeTracker: null,
		currentBranchId: null,
		currentBgImage: null,
		currentLocationId: story.currentLocationId,
		currentTurn: story.currentTurn,
		currentWorldTime: story.currentWorldTime,
		headerPrompt: story.headerPrompt,
		playerReputation: asNullableString(metadata.playerReputation),
		serverStoryId: story.id,
		serverVersion: story.serverVersion,
		syncStatus: 'synced',
		lastWorldSimDay: null,
		compactedLore: null,
		compactedLoreHistory: null,
		meters: null,
	};
}

function exportEntryRow(entry: typeof storyEntries.$inferSelect): JsonRecord {
	return {
		id: entry.id,
		storyId: entry.storyId,
		type: entry.type,
		content: entry.content,
		parentId: entry.parentId,
		position: entry.position,
		createdAt: exportTime(entry.createdAt),
		metadata: entry.metadata,
		branchId: entry.branchId,
	};
}

function exportEntityAsLorebookEntry(entity: typeof entities.$inferSelect, aliases: string[]): JsonRecord {
	return {
		id: entity.id,
		storyId: entity.storyId,
		branchId: null,
		name: entity.name,
		type: entity.type,
		description: entity.description ?? '',
		hiddenInfo: asNullableString(asRecord(entity.state).hiddenInfo),
		aliases,
		state: {
			...asRecord(entity.state),
			type: entity.type,
			status: entity.status,
			visibility: entity.visibility,
		},
		adventureState: null,
		creativeState: null,
		injection: {
			mode: entity.type === 'character' ? 'keyword' : 'keyword',
			keywords: [entity.name, ...aliases],
			priority: entity.type === 'faction' ? 90 : 70,
		},
		firstMentioned: entity.sourceEntryIds[0] ?? null,
		lastMentioned: entity.sourceEntryIds[entity.sourceEntryIds.length - 1] ?? null,
		mentionCount: entity.sourceEntryIds.length,
		createdBy: 'backend',
		createdAt: exportTime(entity.createdAt),
		updatedAt: exportTime(entity.updatedAt),
		loreManagementBlacklisted: false,
		metadata: entity.metadata,
		sourceEventIds: entity.sourceEventIds,
		sourcePatchIds: entity.sourcePatchIds,
	};
}

function exportFactionAsLorebookEntry(faction: typeof factions.$inferSelect): JsonRecord {
	return {
		id: faction.entityId ?? faction.id,
		storyId: faction.storyId,
		branchId: null,
		name: faction.name,
		type: 'faction',
		description: faction.goals.join('; '),
		hiddenInfo: null,
		aliases: [],
		state: {
			type: 'faction',
			goals: faction.goals,
			resources: faction.resources,
			memberEntityIds: faction.memberEntityIds,
			territoryIds: faction.territoryIds,
			allies: faction.allies,
			enemies: faction.enemies,
			pressure: faction.pressure,
		},
		adventureState: null,
		creativeState: null,
		injection: {
			mode: 'keyword',
			keywords: [faction.name],
			priority: 90,
		},
		firstMentioned: faction.sourceEntryIds[0] ?? null,
		lastMentioned: faction.sourceEntryIds[faction.sourceEntryIds.length - 1] ?? null,
		mentionCount: faction.sourceEntryIds.length,
		createdBy: 'backend',
		createdAt: exportTime(faction.createdAt),
		updatedAt: exportTime(faction.updatedAt),
		loreManagementBlacklisted: false,
		metadata: faction.metadata,
	};
}

function exportRelationshipRow(row: typeof relationships.$inferSelect): JsonRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		sourceEntryId: row.sourceEntityId,
		targetEntryId: row.targetEntityId,
		type: row.type,
		label: row.label,
		strength: row.strength,
		bidirectional: row.bidirectional,
		metadata: row.metadata,
		createdAt: exportTime(row.createdAt),
		updatedAt: exportTime(row.updatedAt),
	};
}

function exportChapterRow(row: typeof chapters.$inferSelect): JsonRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		number: row.number,
		title: row.title,
		summary: row.sceneOutcome,
		sceneOutcome: row.sceneOutcome,
		irreversibleChanges: row.irreversibleChanges,
		npcKnowledgeChanges: row.npcKnowledgeChanges,
		promisesDebtsOaths: row.promisesDebtsOaths,
		discoveredClues: row.discoveredClues,
		relationshipChanges: row.relationshipChanges,
		factionChanges: row.factionChanges,
		openThreads: row.openThreads,
		sourceEntryIds: row.sourceEntryIds,
		sourceEventIds: row.sourceEventIds,
		metadata: row.metadata,
		createdAt: exportTime(row.createdAt),
		updatedAt: exportTime(row.updatedAt),
	};
}

function exportArcRow(row: typeof arcs.$inferSelect): JsonRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		number: row.number,
		arcNumber: row.number,
		title: row.title,
		summary: row.summary,
		chapterIds: row.chapterIds,
		sourceEventIds: row.sourceEventIds,
		openThreadIds: row.openThreadIds,
		metadata: row.metadata,
		createdAt: exportTime(row.createdAt),
		updatedAt: exportTime(row.updatedAt),
	};
}

function exportSagaRow(row: typeof sagas.$inferSelect): JsonRecord {
	const metadata = asRecord(row.metadata);
	return {
		id: row.id,
		storyId: row.storyId,
		number: row.number,
		sagaNumber: row.number,
		title: row.title,
		summary: row.summary,
		arcIds: row.arcIds,
		arcRange: asString(metadata.legacyRange, `Arcs ${row.number}`),
		keyFactionShifts: row.keyFactionShifts,
		majorPowerChanges: row.majorPowerChanges,
		lingeringThreads: row.lingeringThreads,
		overallTone: row.overallTone,
		sourceEventIds: row.sourceEventIds,
		openThreadIds: row.openThreadIds,
		metadata: row.metadata,
		createdAt: exportTime(row.createdAt),
		updatedAt: exportTime(row.updatedAt),
	};
}

function exportEventAsWorldEvent(row: typeof storyEvents.$inferSelect): JsonRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		name: row.title,
		type: row.type,
		description: row.body,
		severity: row.visibility === 'secret' ? 'minor' : 'major',
		triggerEntryId: row.sourceEntryIds[0] ?? null,
		sourceEntityId: row.actorEntityIds[0] ?? null,
		consequences: row.targetEntityIds.map((targetEntityId) => ({ targetEntityId, description: row.title })),
		metadata: row.metadata,
		createdAt: exportTime(row.createdAt),
		updatedAt: exportTime(row.updatedAt),
	};
}

export async function getSyncChanges(storyId: string, since: number): Promise<SyncChange[]> {
	const db = getDb();
	const tableSpecs = [
		{ name: 'stories', table: stories, idColumn: stories.id, storyColumn: stories.id },
		{ name: 'story_entries', table: storyEntries, idColumn: storyEntries.id, storyColumn: storyEntries.storyId },
		{ name: 'entities', table: entities, idColumn: entities.id, storyColumn: entities.storyId },
		{ name: 'factions', table: factions, idColumn: factions.id, storyColumn: factions.storyId },
		{ name: 'faction_memberships', table: factionMemberships, idColumn: factionMemberships.id, storyColumn: factionMemberships.storyId },
		{ name: 'faction_resources', table: factionResources, idColumn: factionResources.id, storyColumn: factionResources.storyId },
		{ name: 'faction_goals', table: factionGoals, idColumn: factionGoals.id, storyColumn: factionGoals.storyId },
		{ name: 'faction_projects', table: factionProjects, idColumn: factionProjects.id, storyColumn: factionProjects.storyId },
		{ name: 'agreements', table: agreements, idColumn: agreements.id, storyColumn: agreements.storyId },
		{ name: 'story_threads', table: storyThreads, idColumn: storyThreads.id, storyColumn: storyThreads.storyId },
		{ name: 'npc_beliefs', table: npcBeliefs, idColumn: npcBeliefs.id, storyColumn: npcBeliefs.storyId },
		{ name: 'story_events', table: storyEvents, idColumn: storyEvents.id, storyColumn: storyEvents.storyId },
		{ name: 'npc_event_links', table: npcEventLinks, idColumn: npcEventLinks.id, storyColumn: npcEventLinks.storyId },
		{ name: 'state_patches', table: statePatches, idColumn: statePatches.id, storyColumn: statePatches.storyId },
		{ name: 'facts', table: facts, idColumn: facts.id, storyColumn: facts.storyId },
		{ name: 'source_refs', table: sourceRefs, idColumn: sourceRefs.id, storyColumn: sourceRefs.storyId },
		{ name: 'patch_proposals', table: patchProposals, idColumn: patchProposals.id, storyColumn: patchProposals.storyId },
		{ name: 'continuity_warnings', table: continuityWarnings, idColumn: continuityWarnings.id, storyColumn: continuityWarnings.storyId },
		{ name: 'memory_nodes', table: memoryNodes, idColumn: memoryNodes.id, storyColumn: memoryNodes.storyId },
		{ name: 'chapters', table: chapters, idColumn: chapters.id, storyColumn: chapters.storyId },
		{ name: 'arcs', table: arcs, idColumn: arcs.id, storyColumn: arcs.storyId },
		{ name: 'sagas', table: sagas, idColumn: sagas.id, storyColumn: sagas.storyId },
	];

	const changes: SyncChange[] = [];
	for (const spec of tableSpecs) {
		const rows = await db
			.select()
			.from(spec.table as never)
			.where(and(eq(spec.storyColumn, storyId), gt((spec.table as typeof stories).serverVersion, since)))
			.limit(500);
		for (const row of rows as Array<JsonRecord & { id: string; serverVersion: number }>) {
			changes.push({
				table: spec.name,
				id: row.id,
				version: row.serverVersion,
				op: 'upsert',
				row: spec.name === 'memory_nodes' ? { ...row, embedding: undefined } : row,
			});
		}
	}
	return changes.sort((a, b) => a.version - b.version);
}

export function assertSyncOpReplayMatches(
	op: SyncOperation,
	row: {
		storyId: string;
		type: string;
		payload: Record<string, unknown>;
		clientVersion: number;
	},
): void {
	if (
		row.storyId === op.storyId &&
		row.type === op.type &&
		row.clientVersion === op.clientVersion &&
		stableJson(row.payload) === stableJson(op.payload)
	) return;
	throw new Error(`Sync operation id collision: ${op.id} was already used for a different command.`);
}

export async function applySyncOperation(raw: unknown): Promise<{ op: SyncOperation; eventIds: string[]; patchIds: string[]; projectionJobIds: string[]; alreadyApplied?: boolean }> {
	const op = syncOperationSchema.parse(raw);
	const db = getDb();
	const createdAt = nowIso();
	const eventIds: string[] = [];
	const patchIds: string[] = [];
	const projectionJobIds: string[] = [];

	const [existingOp] = await db
		.select({
			id: syncOps.id,
			storyId: syncOps.storyId,
			type: syncOps.type,
			payload: syncOps.payload,
			clientVersion: syncOps.clientVersion,
			status: syncOps.status,
		})
		.from(syncOps)
		.where(eq(syncOps.id, op.id))
		.limit(1);
	if (existingOp) {
		assertSyncOpReplayMatches(op, existingOp);
		if (existingOp.status === 'applied') {
			return { op, eventIds, patchIds, projectionJobIds, alreadyApplied: true };
		}
	}

	const [inserted] = await db.insert(syncOps).values({
		id: op.id,
		storyId: op.storyId,
		type: op.type,
		payload: op.payload,
		clientVersion: op.clientVersion,
		status: 'applied',
		createdAt,
	}).onConflictDoNothing().returning({ id: syncOps.id });
	if (!inserted) {
		const [replayed] = await db
			.select({
				id: syncOps.id,
				storyId: syncOps.storyId,
				type: syncOps.type,
				payload: syncOps.payload,
				clientVersion: syncOps.clientVersion,
				status: syncOps.status,
			})
			.from(syncOps)
			.where(eq(syncOps.id, op.id))
			.limit(1);
		if (replayed) assertSyncOpReplayMatches(op, replayed);
		return { op, eventIds, patchIds, projectionJobIds, alreadyApplied: true };
	}

	const serverVersion = await bumpStoryVersion(op.storyId);

	if (op.type === 'state_correction') {
		const patchId = id('patch');
		await db.insert(statePatches).values({
			id: patchId,
			storyId: op.storyId,
			operations: asArray<Record<string, unknown>>(op.payload.operations),
			reason: asString(op.payload.reason, 'Player correction'),
			status: 'needs_repair',
			validationWarnings: ['Queued for deterministic review before canon merge.'],
			sourceEntryIds: asStringArray(op.payload.sourceEntryIds),
			sourceEventIds: asStringArray(op.payload.sourceEventIds),
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		patchIds.push(patchId);

		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: op.storyId,
			type: 'correction',
			title: 'Player correction requested',
			body: asString(op.payload.reason, 'Player requested a memory correction.'),
			visibility: 'player_known',
			sourceEntryIds: asStringArray(op.payload.sourceEntryIds),
			sourcePatchIds: [patchId],
			metadata: { syncOpId: op.id },
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
	}

	if (op.type === 'create_entry') {
		const entry = asRecord(op.payload.entry);
		const entryId = asNullableString(entry.id) ?? id('entry');
		await db.insert(storyEntries).values({
			id: entryId,
			storyId: op.storyId,
			type: asString(entry.type, 'user_action'),
			content: asString(entry.content),
			position: asNumber(entry.position, Date.now()),
			parentId: asNullableString(entry.parentId),
			branchId: asNullableString(entry.branchId),
			metadata: asRecord(entry.metadata),
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing();
	}

	if (op.type === 'turn_command') {
		const clientTurnId = asNullableString(op.payload.clientTurnId) ?? op.id;
		const playerText = asString(op.payload.playerText).trim();
		if (playerText) {
			const entryId = asNullableString(op.payload.entryId) ?? `entry_${clientTurnId}`;
			const position = asNumber(op.payload.position, await nextStoryEntryPosition(op.storyId));
			await db.insert(storyEntries).values({
				id: entryId,
				storyId: op.storyId,
				type: 'user_action',
				content: playerText,
				position,
				parentId: null,
				branchId: null,
				metadata: {
					clientTurnId,
					source: 'queued_turn_command',
					syncOpId: op.id,
					clientContext: asRecord(op.payload.clientContext),
					queuedAt: asNullableString(op.payload.queuedAt),
				},
				serverVersion,
				createdAt,
				updatedAt: createdAt,
			}).onConflictDoUpdate({
				target: storyEntries.id,
				set: {
					content: playerText,
					metadata: {
						clientTurnId,
						source: 'queued_turn_command',
						syncOpId: op.id,
						clientContext: asRecord(op.payload.clientContext),
						queuedAt: asNullableString(op.payload.queuedAt),
					},
					serverVersion,
					updatedAt: createdAt,
				},
			});

			const eventId = id('event');
			await db.insert(storyEvents).values({
				id: eventId,
				storyId: op.storyId,
				type: 'scene_transition',
				title: 'Queued player turn received',
				body: playerText,
				visibility: 'player_known',
				sourceEntryIds: [entryId],
				sourcePatchIds: [],
				metadata: { syncOpId: op.id, clientTurnId, queuedAt: op.payload.queuedAt ?? null },
				serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			eventIds.push(eventId);
		}
	}

	if (op.type === 'delete_entry') {
		const entryIds = [
			...asStringArray(op.payload.entryIds),
			asNullableString(op.payload.entryId),
		].filter((value): value is string => Boolean(value));
		for (const entryId of entryIds) {
			await db.delete(storyEntries).where(and(eq(storyEntries.storyId, op.storyId), eq(storyEntries.id, entryId)));
		}
		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: op.storyId,
			type: 'correction',
			title: 'Transcript context removed',
			body: asString(op.payload.reason, 'Player removed transcript context.'),
			visibility: 'player_known',
			sourceEntryIds: entryIds,
			sourcePatchIds: [],
			metadata: { syncOpId: op.id, fromPosition: op.payload.fromPosition ?? null },
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
	}

	if (eventIds.length > 0 || patchIds.length > 0) {
		try {
			projectionJobIds.push(...await enqueueTurnProjectionJobs({
				storyId: op.storyId,
				eventIds,
				memoryNodeIds: [],
				patchIds,
				serverVersion,
			}));
		} catch (error) {
			console.warn('[BackendMemory] Failed to queue sync projection jobs:', error);
		}
	} else {
		const jobId = await queueStoryVaultSync(op.storyId, serverVersion, 'sync-op', {
			syncOpId: op.id,
			type: op.type,
		});
		if (jobId) projectionJobIds.push(jobId);
	}

	return { op, eventIds, patchIds, projectionJobIds };
}
