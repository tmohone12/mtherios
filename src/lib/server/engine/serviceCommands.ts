import {
	engineJobStatusArgsSchema,
	enginePlotBrainPlanArgsSchema,
	engineRollupArcJobArgsSchema,
	engineStoryVaultSyncJobArgsSchema,
	reindexStoryRequestSchema,
	type EngineJobStatusArgs,
	type EnginePlotBrainPlanArgs,
	type EngineRollupArcJobArgs,
	type EngineStoryVaultSyncJobArgs,
} from '$lib/contracts/engine';
import {
	memoryRetrieveRequestSchema,
	syncPullRequestSchema,
	syncPushRequestSchema,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
	type SyncChange,
	type SyncOperation,
} from '$lib/contracts/memory';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { applySyncOperation, getSyncChanges } from '$lib/server/memory/canonical';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { getBackendJobStats, runBackendJobNow, runDueBackendJobs } from '$lib/server/jobs/processor';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { listStoryVaultFreshnessItems } from '$lib/server/wiki/storyVault';
import { getDb } from '$lib/server/db/client';
import { agreements, arcs, backendJobs, chapters, entities, factionGoals, factionProjects, factions, memoryNodes, storyEntries, storyEvents, stories, storyThreads } from '$lib/server/db/schema';
import type { StrategicWorldBrainInput } from '$lib/services/ai/context/strategicWorldBrainInput';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { applyPlotBrainReconciliationPlan, buildPlotBrainReconciliationPlan, type PlotBrainApplyResult, type PlotBrainReconciliationInput, type PlotBrainReconciliationPlan } from '$lib/server/plotBrain/reconciler';
import { planStrategicWorldFrameWithTerminal } from '$lib/server/plotBrain/planner';
import type { Agreement, Arc, Chapter, Entry, FactionActionRecord, FactionGoal, POV, RumorRecord, Scheme, Story, StoryEntry, StoryMode, StoryThread, StrategicBrainTrigger, StrategicWorldFrame, Tense, WorldEvent } from '$lib/types';
import { and, asc, desc, eq } from 'drizzle-orm';

type JsonRecord = Record<string, unknown>;
type ServiceDb = ReturnType<typeof getDb>;
type ServiceTx = Parameters<Parameters<ServiceDb['transaction']>[0]>[0];

interface StoredPlotBrainDraft {
	frame: StrategicWorldFrame;
	currentTurn: number;
	baseServerVersion: number;
	serverVersion: number;
}

export interface SyncPullCommandResult {
	storyId: string;
	serverVersion: number;
	changes: SyncChange[];
}

export interface SyncPushCommandResult {
	storyId: string;
	serverVersion: number;
	appliedOpIds: string[];
	rejected: Array<{ opId: string; reason: string }>;
	repairItems: Array<{ opId: string; reason: string; payload: unknown }>;
	changes: SyncChange[];
}

export interface WorldSimJobCommandInput {
	storyId: string;
	localVersion?: number | null;
	force?: boolean;
	workerId?: string;
}

export interface RunDueJobsCommandInput {
	storyId?: string | null;
	workerId?: string;
	limit?: number;
	allStories?: boolean;
}

export interface JobStatusCommandInput extends EngineJobStatusArgs {
	storyId?: string | null;
}

export interface RollupArcJobCommandInput extends EngineRollupArcJobArgs {
	storyId?: string | null;
}

export interface StoryVaultSyncJobCommandInput extends EngineStoryVaultSyncJobArgs {
	storyId?: string | null;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function toTimestamp(value: string | number | null | undefined): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const parsed = value ? Date.parse(String(value)) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function storyMode(value: unknown): StoryMode {
	return value === 'creative-writing' ? 'creative-writing' : 'adventure';
}

function strategicTrigger(value: EnginePlotBrainPlanArgs['trigger']): StrategicBrainTrigger {
	return (value === 'world_tick' || value === 'scheduled_refresh') ? 'manual' : value;
}

function storyMetadataFrame(metadata: unknown): StrategicWorldFrame | null {
	const root = asRecord(metadata);
	const plotBrain = asRecord(root.plotBrain);
	const candidate = asRecord(plotBrain.lastFrame ?? root.strategicWorldFrame);
	const parsed = strategicWorldFrameSchema.safeParse(candidate);
	return parsed.success ? parsed.data as unknown as StrategicWorldFrame : null;
}

function mapStory(row: typeof stories.$inferSelect): Story {
	const metadata = asRecord(row.metadata);
	return {
		id: row.id,
		shelfId: row.shelfId,
		title: row.title,
		description: row.description ?? null,
		genre: row.genre ?? null,
		templateId: null,
		mode: storyMode(row.mode),
		createdAt: toTimestamp(row.createdAt),
		updatedAt: toTimestamp(row.updatedAt),
		settings: row.settings as Story['settings'],
		memoryConfig: null,
		retryState: null,
		styleReviewState: null,
		timeTracker: null,
		currentBranchId: null,
		currentBgImage: null,
		headerPrompt: row.headerPrompt ?? null,
		playerReputation: typeof metadata.playerReputation === 'string' ? metadata.playerReputation : null,
		playerLedger: typeof metadata.playerLedger === 'string' ? metadata.playerLedger : null,
		serverStoryId: row.id,
		serverVersion: row.serverVersion,
		syncStatus: 'synced',
		lastWorldSimDay: null,
		compactedLore: null,
		compactedLoreHistory: null,
		meters: null,
	};
}

function mapStoryEntry(row: typeof storyEntries.$inferSelect): StoryEntry {
	return {
		id: row.id,
		storyId: row.storyId,
		type: row.type === 'user_action' || row.type === 'narration' || row.type === 'system' || row.type === 'retry' ? row.type : 'system',
		content: row.content,
		parentId: row.parentId ?? null,
		position: row.position,
		createdAt: toTimestamp(row.createdAt),
		metadata: row.metadata as StoryEntry['metadata'],
		branchId: row.branchId ?? null,
	};
}

function mapChapter(row: typeof chapters.$inferSelect): Chapter {
	const summary = [
		row.sceneOutcome,
		...asStringArray(row.irreversibleChanges).map(item => `Irreversible: ${item}`),
		...asStringArray(row.promisesDebtsOaths).map(item => `Promise/debt/oath: ${item}`),
		...asStringArray(row.discoveredClues).map(item => `Clue: ${item}`),
		...asStringArray(row.relationshipChanges).map(item => `Relationship: ${item}`),
		...row.npcKnowledgeChanges.map(item => `NPC knowledge: ${JSON.stringify(item)}`),
		...asStringArray(row.factionChanges).map(item => `Faction: ${item}`),
	].filter(Boolean).join(' ');
	return {
		id: row.id,
		storyId: row.storyId,
		number: row.number,
		title: row.title,
		startEntryId: asStringArray(row.sourceEntryIds)[0] ?? '',
		endEntryId: asStringArray(row.sourceEntryIds).slice(-1)[0] ?? '',
		entryCount: asStringArray(row.sourceEntryIds).length,
		summary,
		startTime: null,
		endTime: null,
		keywords: [],
		characters: [],
		locations: [],
		plotThreads: asStringArray(row.openThreads),
		emotionalTone: null,
		branchId: null,
		createdAt: toTimestamp(row.createdAt),
	};
}

function mapArc(row: typeof arcs.$inferSelect, chapterRows: Chapter[]): Arc {
	const chapterIds = asStringArray(row.chapterIds);
	const arcChapters = chapterIds.length > 0 ? chapterRows.filter(chapter => chapterIds.includes(chapter.id)) : [];
	const numbers = arcChapters.map(chapter => chapter.number).filter(Number.isFinite);
	return {
		id: row.id,
		storyId: row.storyId,
		arcNumber: row.number,
		title: row.title,
		summary: row.summary,
		keyPlotPoints: [],
		characterArcs: [],
		unresolvedThreads: asStringArray(row.openThreadIds),
		threadIds: asStringArray(row.openThreadIds),
		resolvedThreadIds: [],
		emotionalProgression: '',
		chapterIds,
		chapterRange: numbers.length > 0 ? `${Math.min(...numbers)}-${Math.max(...numbers)}` : '',
		branchId: null,
		createdAt: toTimestamp(row.createdAt),
	};
}

function mapEntity(row: typeof entities.$inferSelect): Entry {
	const rawState = asRecord(row.state);
	const state = Object.keys(rawState).length > 0 ? rawState : { type: row.type };
	return {
		id: row.id,
		storyId: row.storyId,
		name: row.name,
		type: row.type as Entry['type'],
		description: row.description ?? '',
		hiddenInfo: row.visibility === 'secret' ? row.description ?? null : null,
		aliases: [],
		state: state as unknown as Entry['state'],
		adventureState: null,
		creativeState: null,
		injection: { mode: 'keyword', keywords: [], priority: 0 },
		firstMentioned: asStringArray(row.sourceEntryIds)[0] ?? null,
		lastMentioned: asStringArray(row.sourceEntryIds).slice(-1)[0] ?? null,
		mentionCount: asStringArray(row.sourceEntryIds).length,
		createdBy: 'import',
		createdAt: toTimestamp(row.createdAt),
		updatedAt: toTimestamp(row.updatedAt),
		loreManagementBlacklisted: row.status === 'deleted',
		branchId: null,
	};
}

function mapFactionEntry(
	faction: typeof factions.$inferSelect,
	entityById: Map<string, typeof entities.$inferSelect>,
	goalsByFactionId: Map<string, Array<typeof factionGoals.$inferSelect>>,
): Entry {
	const entity = faction.entityId ? entityById.get(faction.entityId) : null;
	const resources = asRecord(faction.resources);
	const goalsForFaction: FactionGoal[] = (goalsByFactionId.get(faction.id) ?? []).map(goal => ({
		description: goal.goal,
		priority: goal.priority,
		progress: typeof asRecord(goal.metadata).progress === 'number' ? asRecord(goal.metadata).progress as number : 0,
		type: 'survival',
	}));
	return {
		...(entity ? mapEntity(entity) : mapEntity({
			id: faction.entityId ?? faction.id,
			storyId: faction.storyId,
			type: 'faction',
			name: faction.name,
			description: null,
			status: 'active',
			visibility: 'player_known',
			state: {},
			metadata: {},
			sourceEntryIds: faction.sourceEntryIds,
			sourceEventIds: faction.sourceEventIds,
			sourcePatchIds: faction.sourcePatchIds,
			serverVersion: faction.serverVersion,
			createdAt: faction.createdAt,
			updatedAt: faction.updatedAt,
		} as typeof entities.$inferSelect)),
		id: faction.id,
		name: faction.name,
		type: 'faction',
		description: entity?.description ?? goalsForFaction.map(goal => goal.description).join('; '),
		state: {
			type: 'faction',
			playerStanding: 0,
			status: 'unknown',
			knownMembers: asStringArray(faction.memberEntityIds),
			goals: goalsForFaction,
			resources: {
				military: typeof resources.military === 'number' ? resources.military : faction.pressure,
				wealth: typeof resources.wealth === 'number' ? resources.wealth : 50,
				influence: typeof resources.influence === 'number' ? resources.influence : 50,
				information: typeof resources.information === 'number' ? resources.information : 50,
				morale: typeof resources.morale === 'number' ? resources.morale : 50,
			},
			disposition: faction.pressure >= 70 ? 'aggressive' : faction.pressure >= 40 ? 'scheming' : 'neutral',
			territory: asStringArray(faction.territoryIds),
		},
	};
}

function mapThread(row: typeof storyThreads.$inferSelect): StoryThread {
	return {
		id: row.id,
		storyId: row.storyId,
		description: row.description,
		status: row.status as StoryThread['status'],
		significance: row.significance as StoryThread['significance'],
		sourceArcId: null,
		sourceChapterId: null,
		createdAt: toTimestamp(row.createdAt),
		updatedAt: toTimestamp(row.updatedAt),
		closedAt: row.closedAt ? toTimestamp(row.closedAt) : null,
		closureReason: row.closureReason ?? null,
		relatedFactionIds: asStringArray(row.relatedFactionIds),
		relatedCharacterNames: asStringArray(row.relatedEntityIds),
	};
}

function mapWorldEvent(row: typeof storyEvents.$inferSelect): WorldEvent {
	const impact = asRecord(row.memoryImpact);
	return {
		id: row.id,
		storyId: row.storyId,
		name: row.title,
		description: row.body,
		triggerEntryId: asStringArray(row.sourceEntryIds)[0] ?? '',
		triggerPosition: row.createdTurn,
		sourceEntityId: asStringArray(row.actorEntityIds)[0] ?? null,
		type: 'custom',
		severity: impact.significance === 'critical' ? 'catastrophic' : impact.significance === 'major' ? 'major' : impact.significance === 'minor' ? 'minor' : 'moderate',
		consequences: asStringArray(impact.consequences).map((description, index) => ({
			id: `${row.id}_consequence_${index}`,
			description,
			status: 'pending',
			targetEntityId: null,
			targetEntityName: '',
			effectType: 'custom',
			effectPayload: {},
			delay: 0,
			appliedAt: null,
		})),
		appliedAt: row.occurredTurn ?? null,
		createdAt: toTimestamp(row.createdAt),
	};
}

function mapFactionAction(row: typeof storyEvents.$inferSelect): FactionActionRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		factionName: asStringArray(row.factionIds)[0] ?? 'Unknown faction',
		action: row.body,
		actionType: row.type,
		target: asStringArray(row.targetEntityIds)[0] ?? null,
		motivation: null,
		consequences: asStringArray(asRecord(row.memoryImpact).consequences),
		urgency: 'medium',
		affectedRegions: asStringArray(row.locationIds),
		chapterNumber: null,
		status: row.status === 'committed' ? 'active' : 'resolved',
		createdAt: toTimestamp(row.createdAt),
	};
}

function mapAgreement(row: typeof agreements.$inferSelect): Agreement {
	return {
		id: row.id,
		storyId: row.storyId,
		parties: asStringArray(row.parties),
		category: row.category as Agreement['category'],
		terms: row.terms,
		status: row.status as Agreement['status'],
		secrecy: row.secrecy as Agreement['secrecy'],
		createdChapterNumber: null,
		resolvedChapterNumber: null,
		consequences: asStringArray(row.consequences),
		metadata: null,
		createdAt: toTimestamp(row.createdAt),
		updatedAt: toTimestamp(row.updatedAt),
	};
}

function mapProjectScheme(row: typeof factionProjects.$inferSelect, factionName: string): Scheme {
	return {
		id: row.id,
		storyId: row.storyId,
		ownerType: 'faction',
		ownerEntryId: row.factionId,
		ownerName: factionName,
		goal: row.project,
		trigger: 'strategic backend project',
		triggerChapter: null,
		triggerEntryId: null,
		stages: [{ index: 0, label: row.status, hook: row.project, condition: 'time', conditionPayload: { dueTurn: row.dueTurn, worldTime: row.worldTime }, completed: row.status === 'completed', completedAt: null }],
		currentStageIndex: 0,
		pressure: Math.max(0, Math.min(100, Math.round(row.priority * 10 + row.progress * 50))),
		status: row.status === 'planned' ? 'incubating' : row.status === 'completed' ? 'resolved' : 'active',
		secrecy: row.visibility === 'secret' ? 'secret' : row.visibility === 'rumored' ? 'rumored' : 'known',
		nextTickAtDay: row.dueTurn ?? null,
		branchId: null,
		createdAt: toTimestamp(row.createdAt),
		updatedAt: toTimestamp(row.updatedAt),
	};
}

function mapRumor(row: typeof memoryNodes.$inferSelect): RumorRecord {
	return {
		id: row.id,
		storyId: row.storyId,
		content: row.content,
		truthfulness: typeof asRecord(row.metadata).truthfulness === 'number' ? asRecord(row.metadata).truthfulness as number : 0.5,
		originRegion: row.locationId ?? 'unknown',
		spreadRadius: 'local',
		sourceType: row.type,
		relatedFaction: asStringArray(row.factionIds)[0] ?? null,
		chapterNumber: null,
		staleAfterChapters: 3,
		status: 'spreading',
		createdAt: toTimestamp(row.createdAt),
	};
}

export interface PlotBrainPlanCommandInput {
	storyId: string;
	trigger: EnginePlotBrainPlanArgs['trigger'];
	execute: boolean;
	currentTurn: number;
	currentWorldTime: string | null;
	includeSecret: boolean;
	contextBudget?: number;
	serverVersion?: number;
	frameId?: string;
}

export interface PlotBrainPlanCommandDeps {
	loadInput?: (input: PlotBrainPlanCommandInput) => Promise<StrategicWorldBrainInput>;
	planner?: { plan: (input: StrategicWorldBrainInput) => Promise<StrategicWorldFrame> };
	loadDraft?: (storyId: string, frameId: string) => Promise<StoredPlotBrainDraft>;
	buildPlan?: (input: PlotBrainReconciliationInput) => PlotBrainReconciliationPlan;
	applyPlan?: (plan: PlotBrainReconciliationPlan) => Promise<PlotBrainApplyResult>;
	persistFrame?: (input: {
		storyId: string;
		frame: StrategicWorldFrame;
		serverVersion: number;
		baseServerVersion: number;
		currentTurn: number;
		now: string;
		status: 'pending' | 'applied';
	}) => Promise<void>;
	now?: () => string;
}

export async function runMemoryRetrieveCommand(input: MemoryRetrieveRequest): Promise<RetrievedMemoryPacket> {
	return retrieveMemoryPacket(memoryRetrieveRequestSchema.parse(input));
}

export async function runSyncPullCommand(input: { storyId: string; since?: number }): Promise<SyncPullCommandResult> {
	const request = syncPullRequestSchema.parse(input);
	const changes = await getSyncChanges(request.storyId, request.since);
	const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.since);
	return { storyId: request.storyId, serverVersion, changes };
}

export async function runSyncPushCommand(input: {
	storyId: string;
	localVersion?: number;
	ops?: SyncOperation[];
}): Promise<SyncPushCommandResult> {
	const request = syncPushRequestSchema.parse(input);
	const appliedOpIds: string[] = [];
	const rejected: Array<{ opId: string; reason: string }> = [];
	const repairItems: Array<{ opId: string; reason: string; payload: unknown }> = [];

	for (const op of request.ops) {
		try {
			await applySyncOperation(op);
			appliedOpIds.push(op.id);
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Unknown sync failure.';
			rejected.push({ opId: op.id, reason });
			repairItems.push({ opId: op.id, reason, payload: op.payload });
		}
	}

	const changes = await getSyncChanges(request.storyId, request.localVersion);
	const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.localVersion);
	return {
		storyId: request.storyId,
		serverVersion,
		appliedOpIds,
		rejected,
		repairItems,
		changes,
	};
}

export async function runWorldSimJobCommand(input: WorldSimJobCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const storyId = optionalString(body.storyId) ?? '';
	if (!storyId) throw new Error('storyId is required.');
	const requestedAt = new Date().toISOString();
	const workerId = optionalString(body.workerId) ?? `manual_world_sim_${Date.now()}`;
	const force = body.force !== false;
	const before = await getBackendJobStats(storyId);
	const jobId = await enqueueBackendJob({
		storyId,
		type: 'evaluate_world_sim_tick',
		payload: {
			force,
			manual: true,
			requestedAt,
			clientVersion: typeof body.localVersion === 'number' ? body.localVersion : null,
		},
		metadata: {
			source: 'frontend_manual_world_sim',
			requestedAt,
		},
		maxAttempts: 2,
	});
	const job = await runBackendJobNow(jobId, workerId);
	const after = await getBackendJobStats(storyId);

	return {
		ok: job.completed,
		storyId,
		jobId,
		workerId,
		before,
		after,
		job,
	};
}

export async function loadStrategicWorldBrainInputFromDb(input: PlotBrainPlanCommandInput): Promise<StrategicWorldBrainInput> {
	const storyId = input.storyId.trim();
	if (!storyId) throw new Error('storyId is required.');
	const db = getDb();
	const [storyRow] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!storyRow) throw new Error(`Story not found: ${storyId}`);

	const [entryRows, entityRows, factionRows, goalRows, projectRows, chapterDbRows, arcDbRows, threadRows, eventRows, agreementRows, memoryRows] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(desc(storyEntries.position)).limit(24),
		db.select().from(entities).where(eq(entities.storyId, storyId)).orderBy(asc(entities.type), asc(entities.name)).limit(120),
		db.select().from(factions).where(eq(factions.storyId, storyId)).orderBy(desc(factions.pressure), asc(factions.name)).limit(40),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).orderBy(desc(factionGoals.priority), asc(factionGoals.goal)).limit(120),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).orderBy(desc(factionProjects.priority), desc(factionProjects.updatedAt)).limit(80),
		db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(desc(chapters.number)).limit(24),
		db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(desc(arcs.number)).limit(8),
		db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)).orderBy(desc(storyThreads.updatedAt)).limit(80),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.createdAt)).limit(80),
		db.select().from(agreements).where(eq(agreements.storyId, storyId)).orderBy(desc(agreements.updatedAt)).limit(40),
		db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId)).orderBy(desc(memoryNodes.importance), desc(memoryNodes.updatedAt)).limit(80),
	]);
	const visibleEntityRows = input.includeSecret ? entityRows : entityRows.filter(row => row.visibility !== 'secret');
	const visibleGoalRows = input.includeSecret ? goalRows : goalRows.filter(row => row.secrecy !== 'secret');
	const visibleProjectRows = input.includeSecret ? projectRows : projectRows.filter(row => row.visibility !== 'secret');
	const visibleEventRows = input.includeSecret ? eventRows : eventRows.filter(row => row.visibility !== 'secret');
	const visibleAgreementRows = input.includeSecret ? agreementRows : agreementRows.filter(row => row.secrecy !== 'secret');
	const visibleMemoryRows = input.includeSecret ? memoryRows : memoryRows.filter(row => row.visibility !== 'secret');

	const chapterModels = chapterDbRows.slice().reverse().map(mapChapter);
	const arcModels = arcDbRows.slice().reverse().map(row => mapArc(row, chapterModels));
	const completedChapterIds = new Set(arcModels.flatMap(arc => arc.chapterIds));
	const uncoveredChapters = chapterModels.filter(chapter => !completedChapterIds.has(chapter.id));
	const currentArcChapters = uncoveredChapters.length > 0 ? uncoveredChapters.slice(-8) : chapterModels.slice(-8);
	const entityById = new Map<string, typeof entities.$inferSelect>(visibleEntityRows.map(row => [row.id, row]));
	const goalsByFactionId = new Map<string, Array<typeof factionGoals.$inferSelect>>();
	for (const row of visibleGoalRows) {
		const rows = goalsByFactionId.get(row.factionId) ?? [];
		rows.push(row);
		goalsByFactionId.set(row.factionId, rows);
	}
	const factionNameById = new Map(factionRows.map(row => [row.id, row.name]));
	const mappedFactions = factionRows.length > 0
		? factionRows.map(row => mapFactionEntry(row, entityById, goalsByFactionId))
		: visibleEntityRows.filter(row => row.type === 'faction').map(mapEntity);
	const mappedCharacters = visibleEntityRows.filter(row => row.type === 'character').map(mapEntity);
	const schemes = visibleProjectRows.map(row => mapProjectScheme(row, factionNameById.get(row.factionId) ?? row.factionId));
	const strategicStory = mapStory(storyRow);

	return {
		story: strategicStory,
		trigger: strategicTrigger(input.trigger),
		currentArc: null,
		recentArcs: arcModels.slice(-4),
		relevantOlderArcs: arcModels.slice(0, Math.max(0, arcModels.length - 4)),
		currentArcChapters,
		recentChapters: chapterModels.slice(-8),
		recentEntries: entryRows.slice().reverse().map(mapStoryEntry),
		factions: mappedFactions,
		characters: mappedCharacters,
		activeSchemes: schemes.filter(scheme => scheme.status !== 'resolved' && scheme.status !== 'foiled' && scheme.status !== 'abandoned'),
		recentlyResolvedSchemes: schemes.filter(scheme => scheme.status === 'resolved' || scheme.status === 'foiled' || scheme.status === 'abandoned').slice(-8),
		storyThreads: threadRows.map(mapThread),
		worldEvents: visibleEventRows.slice().reverse().map(mapWorldEvent),
		rumors: visibleMemoryRows.filter(row => row.type === 'rumor' || row.type === 'plot_ledger').slice(0, 20).map(mapRumor),
		agreements: visibleAgreementRows.map(mapAgreement),
		factionActions: visibleEventRows.filter(row => row.type === 'faction_move').slice().reverse().map(mapFactionAction),
		playerLedger: strategicStory.playerLedger ?? null,
		playerReputation: strategicStory.playerReputation ?? null,
		previousStrategicFrame: storyMetadataFrame(storyRow.metadata),
		mode: strategicStory.mode,
		pov: 'second' as POV,
		tense: 'present' as Tense,
		timeTracker: null,
		currentTurn: input.currentTurn || storyRow.currentTurn,
		currentWorldTime: input.currentWorldTime ?? storyRow.currentWorldTime,
		contextBudget: input.contextBudget,
		includeSecret: input.includeSecret,
		knownEntityIds: visibleEntityRows.map(row => row.id),
		knownFactionIds: factionRows.map(row => row.id),
		knownThreadIds: threadRows.map(row => row.id),
	};
}

async function loadStoredPlotBrainDraft(storyId: string, frameId: string): Promise<StoredPlotBrainDraft> {
	const [storyRow] = await getDb().select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!storyRow) throw new Error(`Story not found: ${storyId}`);
	const plotBrain = asRecord(asRecord(storyRow.metadata).plotBrain);
	const parsed = strategicWorldFrameSchema.safeParse(plotBrain.pendingFrame);
	if (!parsed.success || plotBrain.pendingFrameId !== frameId || parsed.data.id !== frameId) {
		throw new Error(`Pending plot frame not found: ${frameId}`);
	}
	if (parsed.data.storyId && parsed.data.storyId !== storyId) throw new Error('Pending plot frame belongs to another story.');
	const baseServerVersion = typeof plotBrain.pendingBaseServerVersion === 'number'
		? Math.floor(plotBrain.pendingBaseServerVersion)
		: -1;
	if (baseServerVersion !== storyRow.serverVersion) {
		throw new Error(`Pending plot frame is stale: story version changed from ${baseServerVersion} to ${storyRow.serverVersion}. Draft again.`);
	}
	return {
		frame: parsed.data as unknown as StrategicWorldFrame,
		currentTurn: typeof plotBrain.pendingCurrentTurn === 'number' ? Math.max(0, Math.floor(plotBrain.pendingCurrentTurn)) : storyRow.currentTurn,
		baseServerVersion,
		serverVersion: storyRow.serverVersion,
	};
}

async function persistStrategicPlotBrainFrame(input: {
	storyId: string;
	frame: StrategicWorldFrame;
	serverVersion: number;
	baseServerVersion: number;
	currentTurn: number;
	now: string;
	status: 'pending' | 'applied';
}, db: ServiceDb | ServiceTx = getDb()): Promise<void> {
	const [storyRow] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
	if (!storyRow) throw new Error(`Story not found: ${input.storyId}`);
	const metadata = asRecord(storyRow.metadata);
	const plotBrain = { ...asRecord(metadata.plotBrain) };
	if (input.status === 'pending') {
		Object.assign(plotBrain, {
			pendingFrame: input.frame,
			pendingFrameId: input.frame.id,
			pendingBaseServerVersion: input.baseServerVersion,
			pendingCurrentTurn: input.currentTurn,
			pendingPlanAt: input.now,
		});
	} else {
		delete plotBrain.pendingFrame;
		delete plotBrain.pendingFrameId;
		delete plotBrain.pendingBaseServerVersion;
		delete plotBrain.pendingCurrentTurn;
		delete plotBrain.pendingPlanAt;
		Object.assign(plotBrain, {
			lastFrame: input.frame,
			lastFrameId: input.frame.id,
			lastPlanAt: input.now,
			plotCardCount: input.frame.plotCards.length,
		});
	}
	const updated = await db.update(stories).set({
		metadata: {
			...metadata,
			plotBrain,
		},
		...(input.status === 'applied' ? { serverVersion: input.serverVersion } : {}),
		updatedAt: input.now,
	}).where(and(eq(stories.id, input.storyId), eq(stories.serverVersion, input.baseServerVersion))).returning({ id: stories.id });
	if (updated.length !== 1) throw new Error('Story changed while the plot frame was being planned or applied. Draft again.');
}

export async function runPlotBrainPlanCommand(
	input: PlotBrainPlanCommandInput | JsonRecord,
	deps: PlotBrainPlanCommandDeps = {},
): Promise<JsonRecord> {
	const body = asRecord(input);
	const storyId = optionalString(body.storyId) ?? '';
	if (!storyId) throw new Error('storyId is required.');
	const args = enginePlotBrainPlanArgsSchema.parse(body);
	const commandInput: PlotBrainPlanCommandInput = { ...args, storyId };
	const now = deps.now?.() ?? new Date().toISOString();
	let frame: StrategicWorldFrame;
	let currentTurn: number;
	let baseServerVersion: number;
	if (args.execute && args.frameId) {
		const draft = await (deps.loadDraft ?? loadStoredPlotBrainDraft)(storyId, args.frameId);
		frame = draft.frame;
		currentTurn = draft.currentTurn;
		baseServerVersion = draft.serverVersion;
	} else {
		const strategicInput = await (deps.loadInput ?? loadStrategicWorldBrainInputFromDb)(commandInput);
		frame = await (deps.planner
			? deps.planner.plan(strategicInput)
			: planStrategicWorldFrameWithTerminal(strategicInput));
		currentTurn = strategicInput.currentTurn ?? args.currentTurn;
		baseServerVersion = strategicInput.story.serverVersion ?? 1;
	}
	if (frame.storyId && frame.storyId !== storyId) throw new Error('Plot frame belongs to another story.');
	const serverVersion = args.execute ? Math.max(1, baseServerVersion + 1) : baseServerVersion;
	if (args.serverVersion && args.serverVersion !== serverVersion) {
		throw new Error(`Plot frame version mismatch: expected ${serverVersion}, received ${args.serverVersion}.`);
	}
	const reconciliation = (deps.buildPlan ?? buildPlotBrainReconciliationPlan)({
		frame,
		currentTurn,
		now,
		serverVersion,
	});
	const counts = {
		threadCount: reconciliation.storyThreads.length + reconciliation.storyThreadUpdates.length,
		eventCount: reconciliation.storyEvents.length,
		npcEventLinkCount: reconciliation.npcEventLinks.length,
		proposalCount: reconciliation.patchProposals.length,
	};
	let applied: PlotBrainApplyResult | null = null;
	if (args.execute) {
		const persisted = { storyId, frame, serverVersion, baseServerVersion, currentTurn, now, status: 'applied' as const };
		if (deps.applyPlan || deps.persistFrame) {
			applied = await (deps.applyPlan ?? applyPlotBrainReconciliationPlan)(reconciliation);
			await (deps.persistFrame ?? persistStrategicPlotBrainFrame)(persisted);
		} else {
			await getDb().transaction(async (tx) => {
				applied = await applyPlotBrainReconciliationPlan(reconciliation, { db: tx });
				await persistStrategicPlotBrainFrame(persisted, tx);
			});
		}
	} else {
		await (deps.persistFrame ?? persistStrategicPlotBrainFrame)({
			storyId,
			frame,
			serverVersion,
			baseServerVersion,
			currentTurn,
			now,
			status: 'pending',
		});
	}

	return {
		ok: true,
		storyId,
		frameId: frame.id,
		arcId: frame.arcId ?? null,
		arcNumber: frame.arcNumber,
		trigger: frame.trigger,
		executed: args.execute,
		pending: !args.execute,
		currentTurn,
		plotCardCount: frame.plotCards.length,
		...counts,
		warnings: reconciliation.warnings,
		applied,
		frame,
		reconciliation: {
			storyThreads: reconciliation.storyThreads.map(row => row.id),
			storyThreadUpdates: reconciliation.storyThreadUpdates.map(row => row.threadId),
			storyEvents: reconciliation.storyEvents.map(row => row.id),
			npcEventLinks: reconciliation.npcEventLinks.map(row => row.id),
			patchProposals: reconciliation.patchProposals.map(row => row.id),
		},
	};
}

export async function runReindexStoryJobCommand(input: unknown): Promise<JsonRecord> {
	const request = reindexStoryRequestSchema.parse(input);
	const jobId = await enqueueBackendJob({
		storyId: request.storyId,
		type: 'index_canonical_records',
		dedupeKey: `manual-canonical-index-${request.storyId}-${request.recordTypes.join('-') || 'all'}-${request.recreate ? 'recreate' : 'update'}`,
		payload: {
			recordTypes: request.recordTypes,
			recreate: request.recreate,
			provider: request.provider,
			model: request.model,
			reason: 'manual_reindex_api',
		},
		maxAttempts: 3,
	});
	const job = request.runNow ? await runBackendJobNow(jobId, `manual_reindex_${Date.now()}`) : null;
	return {
		ok: job ? job.completed : true,
		storyId: request.storyId,
		jobId,
		job,
	};
}

export async function listBackendJobsCommand(input: JobStatusCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const args = engineJobStatusArgsSchema.parse(body);
	const storyId = args.allStories ? null : optionalString(body.storyId) ?? null;
	const rows = await getDb()
		.select()
		.from(backendJobs)
		.where(storyId ? eq(backendJobs.storyId, storyId) : undefined)
		.orderBy(desc(backendJobs.updatedAt))
		.limit(args.limit);
	return {
		stats: await getBackendJobStats(storyId),
		jobs: rows,
	};
}

export async function runDueBackendJobsCommand(input: RunDueJobsCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const allStories = body.allStories === true;
	const storyId = allStories ? null : optionalString(body.storyId);
	if (!allStories && !storyId) throw new Error('storyId is required.');
	const workerId = optionalString(body.workerId) ?? `terminal_${Date.now()}`;
	const limitValue = typeof body.limit === 'number' ? body.limit : 10;
	const limit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(limitValue) ? limitValue : 10)));
	const before = await getBackendJobStats(storyId);
	const result = await runDueBackendJobs(workerId, limit, storyId);
	const after = await getBackendJobStats(storyId);
	return {
		ok: true,
		storyId,
		workerId,
		limit,
		before,
		after,
		...result,
	};
}

export async function runRollupArcJobCommand(input: RollupArcJobCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const args = engineRollupArcJobArgsSchema.parse(body);
	const storyId = optionalString(body.storyId);
	if (!storyId) throw new Error('storyId is required.');
	const requestedAt = new Date().toISOString();
	const workerId = args.workerId ?? `manual_arc_rollup_${Date.now()}`;
	const before = await getBackendJobStats(storyId);
	const jobId = await enqueueBackendJob({
		storyId,
		type: 'rollup_arc',
		payload: {
			manual: true,
			requestedAt,
			chaptersPerArc: args.chaptersPerArc,
		},
		metadata: {
			source: 'manual_arc_rollup',
			requestedAt,
		},
		maxAttempts: 2,
	});
	const runNow = args.runNow !== false;
	const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
	const after = await getBackendJobStats(storyId);

	return {
		ok: job ? job.completed : true,
		storyId,
		jobId,
		workerId,
		runNow,
		before,
		after,
		job,
	};
}

export async function runStoryVaultSyncJobCommand(input: StoryVaultSyncJobCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const args = engineStoryVaultSyncJobArgsSchema.parse(body);
	const allStories = args.allStories === true;
	const workerId = args.workerId ?? `manual_wiki_${Date.now()}`;
	const payload = (reason: string) => wikiJobPayload(args, reason);

	if (allStories) {
		const runNow = args.runNow === true;
		const items = await listStoryVaultFreshnessItems(getMtheriosAppConfig(), args.limit);
		const selected = items.filter((item) =>
			args.includeFresh ||
			!item.vaultFresh ||
			(args.index && !item.indexFresh) ||
			(args.lint && !item.lintFresh)
		);
		const before = await getBackendJobStats();
		const jobs = [];
		for (const item of selected) {
			const jobId = await enqueueBackendJob({
				storyId: item.storyId,
				type: 'sync_story_vault',
				dedupeKey: `manual-wiki-${item.storyId}-${item.serverVersion}-${args.index ? 'index' : 'sync'}-${args.lint ? 'lint' : 'nolint'}`,
				payload: payload('manual_bulk_api'),
				maxAttempts: 3,
			});
			const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
			jobs.push({
				storyId: item.storyId,
				storyTitle: item.storyTitle,
				jobId,
				job,
			});
		}
		const after = await getBackendJobStats();

		return {
			ok: jobs.every((row) => !row.job || row.job.completed),
			mode: 'bulk',
			workerId,
			selected: selected.length,
			queued: jobs.length,
			runNow,
			before,
			after,
			jobs,
		};
	}

	const storyId = optionalString(body.storyId);
	if (!storyId) throw new Error('storyId is required.');
	const runNow = args.runNow !== false;
	const before = await getBackendJobStats(storyId);
	const jobId = await enqueueBackendJob({
		storyId,
		type: 'sync_story_vault',
		payload: payload('manual_api'),
		maxAttempts: 3,
	});
	const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
	const after = await getBackendJobStats(storyId);

	return {
		ok: job ? job.completed : true,
		storyId,
		jobId,
		workerId,
		before,
		after,
		job,
	};
}

function wikiJobPayload(input: EngineStoryVaultSyncJobArgs, reason: string): Record<string, unknown> {
	return {
		index: input.index,
		recreate: input.recreate,
		dryRun: input.dryRun,
		clean: input.clean,
		lint: input.lint,
		thinChars: input.thinChars,
		orphanLayer: input.orphanLayer,
		provider: input.provider,
		model: input.model,
		reason,
	};
}
