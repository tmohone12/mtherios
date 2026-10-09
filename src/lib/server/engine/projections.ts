import { and, desc, eq, sql } from 'drizzle-orm';
import type { CampaignProjection, CampaignVaultStatus, EngineCacheStatus } from '$lib/contracts/engine';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, factionGoals, factionMemberships, factionProjects, factionResources, factions, memoryNodes, sagas, stories, storyEntries, storyEvents, storyThreads } from '$lib/server/db/schema';
import { getCampaignVaultStatus } from './campaignVault';
import { getEngineCacheStatus } from './cache';
import { isWorldSimEligibleFaction } from '$lib/services/ai/context/factionEligibility';

type JsonRecord = Record<string, unknown>;

export interface BuildCampaignProjectionInput {
	story: JsonRecord;
	entries: JsonRecord[];
	entities?: JsonRecord[];
	threads?: JsonRecord[];
	recentEvents?: JsonRecord[];
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

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function enrichFactionEntities(input: {
	entities: JsonRecord[];
	factions: Array<typeof factions.$inferSelect>;
	memberships: Array<typeof factionMemberships.$inferSelect>;
	resources: Array<typeof factionResources.$inferSelect>;
	goals: Array<typeof factionGoals.$inferSelect>;
	projects: Array<typeof factionProjects.$inferSelect>;
}): JsonRecord[] {
	const entityById = new Map(input.entities.map((entity) => [String(entity.id ?? ''), entity]));
	for (const faction of input.factions) {
		const entityId = faction.entityId ?? faction.id;
		const entity = entityById.get(entityId) ?? {
			id: entityId,
			storyId: faction.storyId,
			type: 'faction',
			name: faction.name,
			description: null,
			status: 'active',
			visibility: 'player_known',
			metadata: {},
			createdAt: faction.createdAt,
			updatedAt: faction.updatedAt,
		};
		const existingState = asRecord(entity.state);
		const entityMetadata = asRecord(entity.metadata);
		const factionMetadata = asRecord(faction.metadata);
		const legacyResources = asRecord(faction.resources);
		const normalizedResources = Object.fromEntries(input.resources
			.filter((resource) => resource.factionId === faction.id && resource.visibility !== 'secret')
			.map((resource) => [resource.kind || resource.name, resource.amount ?? resource.status]));
		const resourceNumber = (key: string, fallback: number) => {
			const value = normalizedResources[key] ?? legacyResources[key];
			return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
		};
		const goals = input.goals
			.filter((goal) => goal.factionId === faction.id && goal.secrecy !== 'secret' && goal.status !== 'completed')
			.sort((a, b) => b.priority - a.priority)
			.map((goal) => ({
				description: goal.goal,
				priority: goal.priority,
				progress: typeof asRecord(goal.metadata).progress === 'number' ? asRecord(goal.metadata).progress : 0,
				type: 'survival',
			}));
		const factionMembershipRows = input.memberships.filter((membership) => membership.factionId === faction.id);
		const knownMembers = factionMembershipRows
			.filter((membership) => membership.visibility !== 'secret' && membership.status === 'active')
			.map((membership) => membership.entityId)
			.filter((id): id is string => Boolean(id));
		const effectiveMembers = factionMembershipRows.length ? knownMembers : asStringArray(faction.memberEntityIds);
		const visibleProjects = input.projects
			.filter((project) => project.factionId === faction.id && project.visibility !== 'secret' && !['completed', 'cancelled'].includes(project.status))
			.map((project) => ({ id: project.id, project: project.project, progress: project.progress, status: project.status, dueTurn: project.dueTurn }));
		const operational = isWorldSimEligibleFaction(faction, {
			status: typeof entity.status === 'string' ? entity.status : null,
			state: existingState,
			metadata: entityMetadata,
		}) && (factionMetadata.worldSimEnabled === true
			|| goals.length > 0
			|| visibleProjects.length > 0
			|| Object.keys(normalizedResources).length > 0
			|| effectiveMembers.length > 0
			|| asStringArray(faction.territoryIds).length > 0
			|| asStringArray(faction.goals).length > 0);
		entityById.set(entityId, {
			...entity,
			name: faction.name,
			type: 'faction',
			metadata: {
				...entityMetadata,
				currentStoryEvidence: factionMetadata.currentStoryEvidence,
				worldSimEnabled: factionMetadata.worldSimEnabled,
				worldSimPromoted: factionMetadata.worldSimPromoted,
				factionType: factionMetadata.factionType,
				sourceType: factionMetadata.sourceType,
				...((entityMetadata.scratchSeed === true || factionMetadata.scratchSeed === true) ? { scratchSeed: true } : {}),
			},
			state: {
				...existingState,
				type: 'faction',
				canonicalFactionId: faction.id,
				operational,
				knownMembers: [...new Set(effectiveMembers)],
				goals: goals.length > 0 ? goals : asStringArray(faction.goals).map((description) => ({ description, priority: 5, progress: 0, type: 'survival' })),
				resources: {
					military: resourceNumber('military', faction.pressure),
					wealth: resourceNumber('wealth', 50),
					influence: resourceNumber('influence', 50),
					information: resourceNumber('information', 50),
					morale: resourceNumber('morale', 50),
					...normalizedResources,
				},
				disposition: existingState.disposition ?? (faction.pressure >= 70 ? 'aggressive' : faction.pressure >= 40 ? 'scheming' : 'neutral'),
				territory: asStringArray(faction.territoryIds),
				pressure: faction.pressure,
				projects: visibleProjects,
			},
		});
	}
	return [...entityById.values()];
}

export function buildCampaignProjection(
	input: BuildCampaignProjectionInput,
	options: { entryLimit?: number | null; entityLimit?: number | null; chapterLimit?: number | null; arcLimit?: number | null; sagaLimit?: number | null } = {},
): CampaignProjection {
	const entryLimit = clampLimit(options.entryLimit, 80);
	const entityLimit = typeof options.entityLimit === 'number' && Number.isFinite(options.entityLimit)
		? Math.max(0, Math.min(200, Math.trunc(options.entityLimit)))
		: 200;
	const chapterLimit = clampLimit(options.chapterLimit, 200);
	const arcLimit = clampLimit(options.arcLimit, 80);
	const sagaLimit = clampLimit(options.sagaLimit, 40);
	const entries = (input.entries ?? []).slice(-entryLimit);
	const entityRows = (input.entities ?? []).slice(0, entityLimit);
	const chapterRows = (input.chapters ?? []).slice(-chapterLimit);
	const arcRows = (input.arcs ?? []).slice(-arcLimit);
	const sagaRows = (input.sagas ?? []).slice(-sagaLimit);
	return {
		mode: 'control_surface',
		story: input.story,
		entries,
		entities: entityRows,
		threads: input.threads ?? [],
		recentEvents: input.recentEvents ?? [],
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
	options: { entryLimit?: number | null; entityLimit?: number | null; chapterLimit?: number | null; arcLimit?: number | null; sagaLimit?: number | null } = {},
): Promise<CampaignProjection> {
	const db = getDb();
	const entryLimit = clampLimit(options.entryLimit, 80);
	const entityLimit = typeof options.entityLimit === 'number' && Number.isFinite(options.entityLimit)
		? Math.max(0, Math.min(200, Math.trunc(options.entityLimit)))
		: 200;
	const chapterLimit = clampLimit(options.chapterLimit, 200);
	const arcLimit = clampLimit(options.arcLimit, 80);
	const sagaLimit = clampLimit(options.sagaLimit, 40);
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entryRows,
		entityRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		threadRows,
		recentEventRows,
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
		entityLimit > 0
			? db
				.select()
				.from(entities)
				.where(eq(entities.storyId, storyId))
				.orderBy(desc(entities.updatedAt))
				.limit(entityLimit)
			: Promise.resolve([] as Array<typeof entities.$inferSelect>),
		db.select().from(factions).where(eq(factions.storyId, storyId)).limit(200),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).limit(400),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).limit(400),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).limit(400),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).limit(400),
		db.select({
			id: storyThreads.id,
			description: storyThreads.description,
			status: storyThreads.status,
			significance: storyThreads.significance,
			closureReason: storyThreads.closureReason,
			updatedAt: storyThreads.updatedAt,
		}).from(storyThreads).where(eq(storyThreads.storyId, storyId))
			.orderBy(sql`case when ${storyThreads.status} in ('closed', 'abandoned') then 1 else 0 end`, desc(storyThreads.updatedAt)).limit(120),
		db.select({
			id: storyEvents.id,
			title: storyEvents.title,
			body: storyEvents.body,
			status: storyEvents.status,
			occurredTurn: storyEvents.occurredTurn,
			scheduledTurn: storyEvents.scheduledTurn,
			threadIds: storyEvents.threadIds,
			metadata: storyEvents.metadata,
			updatedAt: storyEvents.updatedAt,
		}).from(storyEvents).where(and(
			eq(storyEvents.storyId, storyId),
			sql`(jsonb_array_length(${storyEvents.threadIds}) > 0 or ${storyEvents.metadata}->>'plotBrain' = 'true')`,
		)).orderBy(desc(storyEvents.updatedAt)).limit(100),
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
		entities: enrichFactionEntities({
			entities: entityRows,
			factions: factionRows,
			memberships: factionMembershipRows,
			resources: factionResourceRows,
			goals: factionGoalRows,
			projects: factionProjectRows,
		}),
		threads: threadRows,
		recentEvents: recentEventRows,
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
	}, { entryLimit, entityLimit, chapterLimit, arcLimit, sagaLimit });
}
