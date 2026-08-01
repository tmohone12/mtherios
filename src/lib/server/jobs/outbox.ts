import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { backendJobs } from '$lib/server/db/schema';

export const backendJobTypes = [
	'create_memory_nodes_from_events',
	'embed_memory_nodes',
	'summarize_chapter',
	'rollup_arc',
	'evaluate_world_sim_tick',
	'update_faction_pressure',
	'rebuild_retrieval_projection',
	'index_canonical_records',
	'sync_story_vault',
	'extract_turn_state',
	'continuity_audit',
	'plan_plot_brain',
] as const;

export type BackendJobType = typeof backendJobTypes[number];

export interface EnqueueBackendJobInput {
	storyId: string;
	type: BackendJobType;
	payload?: Record<string, unknown>;
	dedupeKey?: string;
	requeueExisting?: boolean;
	runAfter?: string;
	maxAttempts?: number;
	metadata?: Record<string, unknown>;
}

const DEFAULT_STALE_LOCK_MS = 30 * 60_000;
const DEFAULT_TURN_STORY_VAULT_SYNC_EVERY = 5;

function nowIso(): string {
	return new Date().toISOString();
}

function staleLockMs(): number {
	const parsed = Number(process.env.MTHERIOS_JOB_STALE_LOCK_MS ?? DEFAULT_STALE_LOCK_MS);
	return Number.isFinite(parsed) ? Math.max(60_000, Math.trunc(parsed)) : DEFAULT_STALE_LOCK_MS;
}

function id(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function turnStoryVaultSyncEvery(): number {
	const raw = Number(process.env.MTHERIOS_TURN_STORY_VAULT_SYNC_EVERY ?? DEFAULT_TURN_STORY_VAULT_SYNC_EVERY);
	return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : DEFAULT_TURN_STORY_VAULT_SYNC_EVERY;
}

export function shouldQueueTurnStoryVaultSync(serverVersion: number, cadence = turnStoryVaultSyncEvery()): boolean {
	if (cadence <= 0) return false;
	const version = Number.isFinite(serverVersion) ? Math.max(1, Math.trunc(serverVersion)) : 1;
	return version % cadence === 0;
}

function stableJobId(type: BackendJobType, dedupeKey: string): string {
	const normalized = dedupeKey
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 96);
	return `job_${type}_${normalized || id('dedupe')}`;
}

export async function enqueueBackendJob(input: EnqueueBackendJobInput): Promise<string> {
	const createdAt = nowIso();
	const jobId = input.dedupeKey ? stableJobId(input.type, input.dedupeKey) : id('job');
	const insert = getDb().insert(backendJobs).values({
		id: jobId,
		storyId: input.storyId,
		type: input.type,
		payload: input.payload ?? {},
		status: 'queued',
		attemptCount: 0,
		maxAttempts: input.maxAttempts ?? 5,
		runAfter: input.runAfter ?? createdAt,
		lockedAt: null,
		lockedBy: null,
		lastError: null,
		metadata: input.metadata ?? {},
		createdAt,
		updatedAt: createdAt,
	});
	if (input.requeueExisting === false) {
		await insert.onConflictDoNothing();
		return jobId;
	}
	await insert.onConflictDoUpdate({
		target: backendJobs.id,
		set: {
			payload: input.payload ?? {},
			status: 'queued',
			runAfter: input.runAfter ?? createdAt,
			lastError: null,
			metadata: input.metadata ?? {},
			updatedAt: createdAt,
		},
	});
	return jobId;
}

export async function enqueueStoryVaultSyncJob(input: {
	storyId: string;
	serverVersion: number;
	reason: string;
	payload?: Record<string, unknown>;
}): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'sync_story_vault',
		dedupeKey: `${input.reason}-story-vault-${input.serverVersion}`,
		payload: {
			...(input.payload ?? {}),
			serverVersion: input.serverVersion,
			reason: input.reason,
		},
		maxAttempts: 3,
	});
}

export function turnStateExtractionDedupeKey(input: { assistantEntryId: string }): string {
	return `turn-state-${input.assistantEntryId}`;
}

export function continuityAuditDedupeKey(input: { assistantEntryId: string }): string {
	return `continuity-audit-${input.assistantEntryId}`;
}

export async function enqueueTurnStateExtractionJob(input: {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	playerText: string;
	narration: string;
	clientTurnId: string;
	timelineTurn: number;
	serverVersion: number;
	retrievedMemoryIds: string[];
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'extract_turn_state',
		dedupeKey: turnStateExtractionDedupeKey({ assistantEntryId: input.assistantEntryId }),
		payload: {
			playerEntryId: input.playerEntryId,
			assistantEntryId: input.assistantEntryId,
			playerText: input.playerText,
			narration: input.narration,
			clientTurnId: input.clientTurnId,
			timelineTurn: input.timelineTurn,
			serverVersion: input.serverVersion,
			retrievedMemoryIds: input.retrievedMemoryIds,
			memorySettings: input.memorySettings ?? {},
		},
		maxAttempts: 3,
	});
}

export async function enqueueChapterSummaryJob(input: {
	storyId: string;
	serverVersion: number;
	eventIds?: string[];
	patchIds?: string[];
	dedupeKey?: string;
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'summarize_chapter',
		dedupeKey: input.dedupeKey ?? `chapter-summary-${input.serverVersion}`,
		payload: {
			eventIds: input.eventIds ?? [],
			patchIds: input.patchIds ?? [],
			serverVersion: input.serverVersion,
			...(input.memorySettings ?? {}),
		},
	});
}

export async function enqueuePlotBrainJob(input: {
	storyId: string;
	trigger: 'scheduled_refresh' | 'arc_created';
	scopeId: string;
	skipIfPlanned?: boolean;
}): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'plan_plot_brain',
		dedupeKey: `plot-brain-${input.trigger}-${input.scopeId}`,
		payload: {
			trigger: input.trigger,
			execute: true,
			skipIfPlanned: input.skipIfPlanned === true,
		},
		requeueExisting: false,
		maxAttempts: 3,
	});
}

export async function enqueueContinuityAuditJob(input: {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	clientTurnId: string;
	serverVersion: number;
	contextReceipt?: Record<string, unknown> | null;
	performance?: Record<string, unknown> | null;
}): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'continuity_audit',
		dedupeKey: continuityAuditDedupeKey({ assistantEntryId: input.assistantEntryId }),
		payload: {
			playerEntryId: input.playerEntryId,
			assistantEntryId: input.assistantEntryId,
			clientTurnId: input.clientTurnId,
			serverVersion: input.serverVersion,
			contextReceipt: input.contextReceipt ?? null,
			performance: input.performance ?? null,
		},
		maxAttempts: 3,
	});
}

export async function enqueueTurnProjectionJobs(input: {
	storyId: string;
	eventIds: string[];
	memoryNodeIds: string[];
	patchIds: string[];
	serverVersion: number;
	chapterDedupeKey?: string;
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}): Promise<string[]> {
	const jobs: Promise<string>[] = [];
	const memorySettings = input.memorySettings ?? {};
	if (input.eventIds.length > 0) {
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'create_memory_nodes_from_events',
			dedupeKey: `turn-events-${input.serverVersion}`,
			payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		}));
	}
	if (input.memoryNodeIds.length > 0) {
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'embed_memory_nodes',
			dedupeKey: `embed-memory-${input.serverVersion}`,
			payload: { memoryNodeIds: input.memoryNodeIds, serverVersion: input.serverVersion },
		}));
	}
	jobs.push(enqueueBackendJob({
		storyId: input.storyId,
		type: 'index_canonical_records',
		dedupeKey: `canonical-index-${input.serverVersion}`,
		payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		maxAttempts: 3,
	}));
	jobs.push(enqueueChapterSummaryJob({
		storyId: input.storyId,
		serverVersion: input.serverVersion,
		eventIds: input.eventIds,
		patchIds: input.patchIds,
		dedupeKey: input.chapterDedupeKey,
		memorySettings,
	}));
	if (shouldQueueTurnStoryVaultSync(input.serverVersion)) {
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'sync_story_vault',
			dedupeKey: `story-vault-${input.serverVersion}`,
			payload: {
				eventIds: input.eventIds,
				patchIds: input.patchIds,
				serverVersion: input.serverVersion,
				reason: 'turn_cadence',
				cadence: turnStoryVaultSyncEvery(),
			},
			maxAttempts: 3,
		}));
	}
	return Promise.all(jobs);
}

export async function enqueueImportProjectionJobs(input: {
	storyId: string;
	counts: Record<string, number>;
	serverVersion: number;
}): Promise<string[]> {
	return Promise.all([
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'rebuild_retrieval_projection',
			dedupeKey: `import-retrieval-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'embed_memory_nodes',
			dedupeKey: `import-embed-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'rollup_arc',
			dedupeKey: `import-arc-rollup-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'update_faction_pressure',
			dedupeKey: `import-faction-pressure-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'evaluate_world_sim_tick',
			dedupeKey: `import-world-sim-tick-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'index_canonical_records',
			dedupeKey: `import-canonical-index-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
			maxAttempts: 3,
		}),
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'sync_story_vault',
			dedupeKey: `import-story-vault-${input.serverVersion}`,
			payload: { counts: input.counts, serverVersion: input.serverVersion },
			maxAttempts: 3,
		}),
	]);
}

export async function claimBackendJobs(workerId: string, limit = 10, storyId?: string | null) {
	const db = getDb();
	const claimedAt = nowIso();
	await recoverStaleBackendJobs(staleLockMs(), storyId);
	const filters = [
		inArray(backendJobs.status, ['queued', 'retry']),
		lte(backendJobs.runAfter, claimedAt),
	];
	if (storyId) filters.push(eq(backendJobs.storyId, storyId));
	const candidates = await db
		.select({ id: backendJobs.id })
		.from(backendJobs)
		.where(and(...filters))
		.orderBy(asc(backendJobs.runAfter), asc(backendJobs.createdAt))
		.limit(limit);
	const ids = candidates.map((job) => job.id);
	if (ids.length === 0) return [];
	return db.update(backendJobs).set({
		status: 'running',
		attemptCount: sql`${backendJobs.attemptCount} + 1`,
		lockedAt: claimedAt,
		lockedBy: workerId,
		updatedAt: claimedAt,
	}).where(inArray(backendJobs.id, ids)).returning();
}

export async function recoverStaleBackendJobs(staleMs = staleLockMs(), storyId?: string | null): Promise<number> {
	const db = getDb();
	const recoveredAt = nowIso();
	const cutoff = new Date(Date.now() - Math.max(60_000, staleMs)).toISOString();
	const filters = [
		eq(backendJobs.status, 'running'),
		lte(backendJobs.lockedAt, cutoff),
	];
	if (storyId) filters.push(eq(backendJobs.storyId, storyId));
	const rows = await db
		.select({
			id: backendJobs.id,
			attemptCount: backendJobs.attemptCount,
			maxAttempts: backendJobs.maxAttempts,
			lockedAt: backendJobs.lockedAt,
			lockedBy: backendJobs.lockedBy,
		})
		.from(backendJobs)
		.where(and(...filters));

	for (const job of rows) {
		const exhausted = job.attemptCount >= job.maxAttempts;
		await db.update(backendJobs).set({
			status: exhausted ? 'failed' : 'retry',
			runAfter: recoveredAt,
			lockedAt: null,
			lockedBy: null,
			lastError: `Recovered stale job lock from ${job.lockedBy ?? 'unknown worker'} after ${Math.round(staleMs / 1000)}s.`,
			updatedAt: recoveredAt,
		}).where(eq(backendJobs.id, job.id));
	}
	return rows.length;
}

export async function markBackendJobComplete(jobId: string): Promise<void> {
	const completedAt = nowIso();
	await getDb().update(backendJobs).set({
		status: 'complete',
		lockedAt: null,
		lockedBy: null,
		lastError: null,
		updatedAt: completedAt,
	}).where(eq(backendJobs.id, jobId));
}

export async function markBackendJobFailed(jobId: string, error: unknown): Promise<void> {
	const db = getDb();
	const failedAt = nowIso();
	const [job] = await db.select().from(backendJobs).where(eq(backendJobs.id, jobId)).limit(1);
	const exhausted = (job?.attemptCount ?? 0) >= (job?.maxAttempts ?? 5);
	const delayMs = Math.min(60_000, 1000 * Math.max(1, job?.attemptCount ?? 1) ** 2);
	await db.update(backendJobs).set({
		status: exhausted ? 'failed' : 'retry',
		runAfter: new Date(Date.now() + delayMs).toISOString(),
		lockedAt: null,
		lockedBy: null,
		lastError: error instanceof Error ? error.message : String(error),
		updatedAt: failedAt,
	}).where(eq(backendJobs.id, jobId));
}
