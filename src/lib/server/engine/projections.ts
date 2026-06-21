import { desc, eq, sql } from 'drizzle-orm';
import type { CampaignProjection, CampaignVaultStatus, EngineCacheStatus } from '$lib/contracts/engine';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, memoryNodes, sagas, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import { getCampaignVaultStatus } from './campaignVault';
import { getEngineCacheStatus } from './cache';

type JsonRecord = Record<string, unknown>;

export interface BuildCampaignProjectionInput {
	story: JsonRecord;
	entries: JsonRecord[];
	chapters: JsonRecord[];
	arcs: JsonRecord[];
	sagas: JsonRecord[];
	entryCount: number;
	entityCount: number;
	eventCount: number;
	memoryNodeCount: number;
	chapterCount: number;
	arcCount: number;
	sagaCount: number;
	vaultStatus: CampaignVaultStatus;
	cacheStatus: EngineCacheStatus;
}

function clampLimit(value: number | null | undefined, fallback = 80): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(200, Math.trunc(value)));
}

export function buildCampaignProjection(
	input: BuildCampaignProjectionInput,
	options: { entryLimit?: number | null; chapterLimit?: number | null; arcLimit?: number | null; sagaLimit?: number | null } = {},
): CampaignProjection {
	const entryLimit = clampLimit(options.entryLimit, 80);
	const chapterLimit = clampLimit(options.chapterLimit, 200);
	const arcLimit = clampLimit(options.arcLimit, 80);
	const sagaLimit = clampLimit(options.sagaLimit, 40);
	const entries = (input.entries ?? []).slice(-entryLimit);
	const chapterRows = (input.chapters ?? []).slice(-chapterLimit);
	const arcRows = (input.arcs ?? []).slice(-arcLimit);
	const sagaRows = (input.sagas ?? []).slice(-sagaLimit);
	return {
		mode: 'control_surface',
		story: input.story,
		entries,
		chapters: chapterRows,
		arcs: arcRows,
		sagas: sagaRows,
		counts: {
			entries: Math.max(0, Math.trunc(input.entryCount)),
			entities: Math.max(0, Math.trunc(input.entityCount)),
			events: Math.max(0, Math.trunc(input.eventCount)),
			memoryNodes: Math.max(0, Math.trunc(input.memoryNodeCount)),
			chapters: Math.max(0, Math.trunc(input.chapterCount ?? chapterRows.length)),
			arcs: Math.max(0, Math.trunc(input.arcCount ?? arcRows.length)),
			sagas: Math.max(0, Math.trunc(input.sagaCount ?? sagaRows.length)),
		},
		vault: input.vaultStatus,
		cache: input.cacheStatus,
	};
}

export async function getCampaignProjection(
	storyId: string,
	options: { entryLimit?: number | null; chapterLimit?: number | null; arcLimit?: number | null; sagaLimit?: number | null } = {},
): Promise<CampaignProjection> {
	const db = getDb();
	const entryLimit = clampLimit(options.entryLimit, 80);
	const chapterLimit = clampLimit(options.chapterLimit, 200);
	const arcLimit = clampLimit(options.arcLimit, 80);
	const sagaLimit = clampLimit(options.sagaLimit, 40);
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entryRows,
		entryCountRows,
		chapterRows,
		chapterCountRows,
		arcRows,
		arcCountRows,
		sagaRows,
		sagaCountRows,
		entityCountRows,
		eventCountRows,
		memoryNodeCountRows,
		vaultStatus,
		cacheStatus,
	] = await Promise.all([
		db
			.select()
			.from(storyEntries)
			.where(eq(storyEntries.storyId, storyId))
			.orderBy(desc(storyEntries.position))
			.limit(entryLimit),
		db.select({ count: sql<number>`count(*)::int` }).from(storyEntries).where(eq(storyEntries.storyId, storyId)),
		db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, storyId))
			.orderBy(desc(chapters.number))
			.limit(chapterLimit),
		db.select({ count: sql<number>`count(*)::int` }).from(chapters).where(eq(chapters.storyId, storyId)),
		db
			.select()
			.from(arcs)
			.where(eq(arcs.storyId, storyId))
			.orderBy(desc(arcs.number))
			.limit(arcLimit),
		db.select({ count: sql<number>`count(*)::int` }).from(arcs).where(eq(arcs.storyId, storyId)),
		db
			.select()
			.from(sagas)
			.where(eq(sagas.storyId, storyId))
			.orderBy(desc(sagas.number))
			.limit(sagaLimit),
		db.select({ count: sql<number>`count(*)::int` }).from(sagas).where(eq(sagas.storyId, storyId)),
		db.select({ count: sql<number>`count(*)::int` }).from(entities).where(eq(entities.storyId, storyId)),
		db.select({ count: sql<number>`count(*)::int` }).from(storyEvents).where(eq(storyEvents.storyId, storyId)),
		db.select({ count: sql<number>`count(*)::int` }).from(memoryNodes).where(eq(memoryNodes.storyId, storyId)),
		getCampaignVaultStatus(storyId),
		getEngineCacheStatus(storyId),
	]);

	return buildCampaignProjection({
		story,
		entries: [...entryRows].sort((a, b) => a.position - b.position),
		chapters: [...chapterRows].sort((a, b) => a.number - b.number),
		arcs: [...arcRows].sort((a, b) => a.number - b.number),
		sagas: [...sagaRows].sort((a, b) => a.number - b.number),
		entryCount: Number(entryCountRows[0]?.count ?? entryRows.length),
		chapterCount: Number(chapterCountRows[0]?.count ?? chapterRows.length),
		arcCount: Number(arcCountRows[0]?.count ?? arcRows.length),
		sagaCount: Number(sagaCountRows[0]?.count ?? sagaRows.length),
		entityCount: Number(entityCountRows[0]?.count ?? 0),
		eventCount: Number(eventCountRows[0]?.count ?? 0),
		memoryNodeCount: Number(memoryNodeCountRows[0]?.count ?? 0),
		vaultStatus,
		cacheStatus,
	}, { entryLimit, chapterLimit, arcLimit, sagaLimit });
}
