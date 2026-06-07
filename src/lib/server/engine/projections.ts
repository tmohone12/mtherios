import { desc, eq, sql } from 'drizzle-orm';
import type { CampaignProjection, CampaignVaultStatus, EngineCacheStatus } from '$lib/contracts/engine';
import { getDb } from '$lib/server/db/client';
import { entities, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import { getCampaignVaultStatus } from './campaignVault';
import { getEngineCacheStatus } from './cache';

type JsonRecord = Record<string, unknown>;

export interface BuildCampaignProjectionInput {
	story: JsonRecord;
	entries: JsonRecord[];
	entryCount: number;
	entityCount: number;
	eventCount: number;
	memoryNodeCount: number;
	vaultStatus: CampaignVaultStatus;
	cacheStatus: EngineCacheStatus;
}

function clampLimit(value: number | null | undefined, fallback = 80): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(200, Math.trunc(value)));
}

export function buildCampaignProjection(
	input: BuildCampaignProjectionInput,
	options: { entryLimit?: number | null } = {},
): CampaignProjection {
	const entryLimit = clampLimit(options.entryLimit, 80);
	const entries = input.entries.slice(-entryLimit);
	return {
		mode: 'control_surface',
		story: input.story,
		entries,
		counts: {
			entries: Math.max(0, Math.trunc(input.entryCount)),
			entities: Math.max(0, Math.trunc(input.entityCount)),
			events: Math.max(0, Math.trunc(input.eventCount)),
			memoryNodes: Math.max(0, Math.trunc(input.memoryNodeCount)),
		},
		vault: input.vaultStatus,
		cache: input.cacheStatus,
	};
}

export async function getCampaignProjection(
	storyId: string,
	options: { entryLimit?: number | null } = {},
): Promise<CampaignProjection> {
	const db = getDb();
	const entryLimit = clampLimit(options.entryLimit, 80);
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entryRows,
		entryCountRows,
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
		db.select({ count: sql<number>`count(*)::int` }).from(entities).where(eq(entities.storyId, storyId)),
		db.select({ count: sql<number>`count(*)::int` }).from(storyEvents).where(eq(storyEvents.storyId, storyId)),
		db.select({ count: sql<number>`count(*)::int` }).from(memoryNodes).where(eq(memoryNodes.storyId, storyId)),
		getCampaignVaultStatus(storyId),
		getEngineCacheStatus(storyId),
	]);

	return buildCampaignProjection({
		story,
		entries: [...entryRows].sort((a, b) => a.position - b.position),
		entryCount: Number(entryCountRows[0]?.count ?? entryRows.length),
		entityCount: Number(entityCountRows[0]?.count ?? 0),
		eventCount: Number(eventCountRows[0]?.count ?? 0),
		memoryNodeCount: Number(memoryNodeCountRows[0]?.count ?? 0),
		vaultStatus,
		cacheStatus,
	}, { entryLimit });
}
