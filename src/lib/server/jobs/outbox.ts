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
] as const;

export type BackendJobType = typeof backendJobTypes[number];

export interface EnqueueBackendJobInput {
	storyId: string;
	type: BackendJobType;
	payload?: Record<string, unknown>;
	dedupeKey?: string;
	runAfter?: string;
	maxAttempts?: number;
	metadata?: Record<string, unknown>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
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
	await getDb().insert(backendJobs).values({
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
	}).onConflictDoUpdate({
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

export async function enqueueTurnProjectionJobs(input: {
	storyId: string;
	eventIds: string[];
	memoryNodeIds: string[];
	patchIds: string[];
	serverVersion: number;
}): Promise<string[]> {
	const jobs: Promise<string>[] = [];
	if (input.eventIds.length > 0) {
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'create_memory_nodes_from_events',
			dedupeKey: `turn-events-${input.serverVersion}`,
			payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		}));
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'update_faction_pressure',
			dedupeKey: `faction-pressure-${input.serverVersion}`,
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
		type: 'summarize_chapter',
		dedupeKey: `chapter-summary-${input.serverVersion}`,
		payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
	}));
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
	]);
}

export async function claimBackendJobs(workerId: string, limit = 10) {
	const db = getDb();
	const claimedAt = nowIso();
	const candidates = await db
		.select({ id: backendJobs.id })
		.from(backendJobs)
		.where(and(
			inArray(backendJobs.status, ['queued', 'retry']),
			lte(backendJobs.runAfter, claimedAt),
		))
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
