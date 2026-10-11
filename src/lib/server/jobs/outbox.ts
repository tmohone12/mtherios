import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { backendJobs, stories } from '$lib/server/db/schema';
import { classifyBackendJobFailure, describeBackendJobError, manualRetryBlockCause } from './failureClassification';

export const backendJobTypes = [
	'validate_agent_settings',
	'generate_image',
	'assistant_batch_child',
	'create_memory_nodes_from_events',
	'embed_memory_nodes',
	'summarize_chapter',
	'chapter_threads',
	'chapter_characters',
	'rebuild_summaries',
	'refresh_scene_checkpoint',
	'rollup_arc',
	'rollup_saga',
	'evaluate_world_sim_tick',
	'evaluate_npc_background_action',
	'update_faction_pressure',
	'rebuild_retrieval_projection',
	'index_canonical_records',
	'sync_story_vault',
	'extract_turn_state',
	'continuity_audit',
	'plan_plot_brain',
] as const;

export type BackendJobType = typeof backendJobTypes[number];
export const factionWorkerJobTypes = [
	'update_faction_pressure',
	'evaluate_world_sim_tick',
	'plan_plot_brain',
] as const satisfies readonly BackendJobType[];

// These handlers upsert stable record IDs, or commit canon and an apply receipt
// together. Keep model-driven advancement and timestamp-keyed continuations out.
export const manuallyRetryableBackendJobTypes = [
	'validate_agent_settings',
	'refresh_scene_checkpoint',
	'create_memory_nodes_from_events',
	'rebuild_retrieval_projection',
	'embed_memory_nodes',
	'extract_turn_state',
	// Chapter follow-ups commit their effects with a receipt on their own job row
	// (threads) or are keyed by stable proposal/event receipts, so a retry never
	// regenerates the chapter or repeats another consumer's effects.
	'chapter_threads',
	'chapter_characters',
	'update_faction_pressure',
] as const satisfies readonly BackendJobType[];

type BackendJobRetryInspection = Pick<typeof backendJobs.$inferSelect, 'status' | 'type' | 'lockedAt' | 'lockedBy'> &
	Partial<Pick<typeof backendJobs.$inferSelect, 'lastError' | 'metadata'>>;

export function backendJobRetryBlockReason(job: BackendJobRetryInspection): string | null {
	if (job.status !== 'failed') return 'Only failed jobs can be retried.';
	if (job.lockedAt !== null || job.lockedBy !== null) return 'This job still has a worker lock. Refresh after recovery.';
	if (!(manuallyRetryableBackendJobTypes as readonly string[]).includes(job.type)) {
		return 'Manual retry is not available for this job type; its effects need review before another run.';
	}
	const metadata = job.metadata && typeof job.metadata === 'object' && !Array.isArray(job.metadata) ? job.metadata as Record<string, unknown> : null;
	const recordedRetryable = metadata?.lastFailure && typeof metadata.lastFailure === 'object' && !Array.isArray(metadata.lastFailure)
		? (metadata.lastFailure as Record<string, unknown>).retryable
		: undefined;
	const cause = typeof job.lastError === 'string' ? classifyBackendJobFailure(job.lastError).cause : null;
	// A changed classifier can repair bad output; the explicit retry remains source- and lock-guarded.
	const correctedExtraction = job.type === 'extract_turn_state' && cause === 'provider_output';
	// A configuration failure is permanent until settings change; then an explicit retry is the fix.
	if (recordedRetryable === false && !correctedExtraction && cause !== 'configuration') return 'Manual retry is blocked for this recorded permanent failure; correct the source or configuration first.';
	if (cause && manualRetryBlockCause(cause) && !correctedExtraction) {
		return `Manual retry is blocked for ${cause.replaceAll('_', ' ')} failures; correct the source or configuration first.`;
	}
	return null;
}

export function backendJobRetryWhere(storyId: string | null, jobId: string, expectedUpdatedAt: string, projectId?: string) {
	if (!storyId && !projectId) throw new Error('Retry requires a game or project scope.');
	return and(
		storyId ? eq(backendJobs.storyId, storyId) : isNull(backendJobs.storyId),
		projectId ? eq(backendJobs.projectId, projectId) : undefined,
		eq(backendJobs.id, jobId),
		eq(backendJobs.status, 'failed'),
		eq(backendJobs.updatedAt, expectedUpdatedAt),
		inArray(backendJobs.type, [...manuallyRetryableBackendJobTypes]),
		isNull(backendJobs.lockedAt),
		isNull(backendJobs.lockedBy),
	)!;
}

export async function retryBackendJob(input: { storyId: string | null; projectId?: string; jobId: string; expectedUpdatedAt: string }) {
	if (!input.storyId && !input.projectId) throw new Error('Retry requires a game or project scope.');
	const [current] = await getDb()
		.select({ status: backendJobs.status, type: backendJobs.type, lockedAt: backendJobs.lockedAt, lockedBy: backendJobs.lockedBy, lastError: backendJobs.lastError, metadata: backendJobs.metadata })
		.from(backendJobs)
		.where(and(input.storyId ? eq(backendJobs.storyId, input.storyId) : isNull(backendJobs.storyId), input.projectId ? eq(backendJobs.projectId, input.projectId) : undefined, eq(backendJobs.id, input.jobId), eq(backendJobs.updatedAt, input.expectedUpdatedAt)))
		.limit(1);
	if (current?.status === 'failed') {
		const retryReason = backendJobRetryBlockReason(current);
		if (retryReason?.startsWith('Manual retry is blocked')) throw new Error(retryReason);
	}
	const requestedAt = nowIso();
	const [job] = await getDb().update(backendJobs).set({
		status: 'retry',
		attemptCount: 0,
		runAfter: requestedAt,
		lastError: null,
		// Merge in SQL so a durable apply receipt cannot be replaced by stale data.
		metadata: sql`${backendJobs.metadata} || jsonb_build_object('manualRetryHistory',
			coalesce(${backendJobs.metadata}->'manualRetryHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
				'requestedAt', ${requestedAt}::text, 'previousUpdatedAt', ${backendJobs.updatedAt},
				'attemptCount', ${backendJobs.attemptCount}, 'maxAttempts', ${backendJobs.maxAttempts},
				'error', ${backendJobs.lastError}, 'failure', ${backendJobs.metadata}->'lastFailure'
			)))`,
		updatedAt: sql`greatest(clock_timestamp(), ${backendJobs.updatedAt} + interval '1 microsecond')`,
	}).where(backendJobRetryWhere(input.storyId, input.jobId, input.expectedUpdatedAt, input.projectId)).returning();
	if (!job) throw new Error('Job changed, is not failed, or cannot be retried safely. Refresh Jobs before trying again.');
	return job;
}

export const backendJobClaimPriorityOrder = sql<number>`case
	when ${backendJobs.type} = 'refresh_scene_checkpoint' then 0
	when ${backendJobs.type} = 'extract_turn_state' then 1
	when ${backendJobs.type} = 'continuity_audit' then 2
	when ${backendJobs.type} = 'evaluate_world_sim_tick' then 5
	when ${backendJobs.type} = 'plan_plot_brain'
		and ${backendJobs.payload}->>'trigger' = 'scheduled_refresh' then 5
	else 3
end`;

export type ClaimedBackendJob = Pick<
	typeof backendJobs.$inferSelect,
	'id' | 'attemptCount' | 'maxAttempts' | 'lockedAt' | 'lockedBy'
>;

export type EnqueueBackendJobInput = ({ storyId: string; projectId?: string; type: Exclude<BackendJobType, 'validate_agent_settings' | 'generate_image' | 'assistant_batch_child'> } | { projectId: string; storyId?: string | null; type: 'validate_agent_settings' | 'generate_image' | 'assistant_batch_child' }) & {
	payload?: Record<string, unknown>;
	dedupeKey?: string;
	requeueExisting?: boolean;
	runAfter?: string;
	maxAttempts?: number;
	metadata?: Record<string, unknown>;
}

type OutboxDb = ReturnType<typeof getDb>;
type OutboxTx = Parameters<Parameters<OutboxDb['transaction']>[0]>[0];

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

export function stableJobId(storyId: string, type: BackendJobType, dedupeKey: string): string {
	const scopedKey = `${storyId}:${dedupeKey}`;
	const normalized = scopedKey
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	const hash = createHash('sha256')
		.update(JSON.stringify(['backend_job', storyId, type, dedupeKey]))
		.digest('hex')
		.slice(0, 16);
	return `job_${type}_${(normalized || 'dedupe').slice(0, 80)}_${hash}`;
}

export async function enqueueBackendJob(
	input: EnqueueBackendJobInput,
	db: Pick<OutboxDb, 'insert'> = getDb(),
): Promise<string> {
	if (input.type === 'validate_agent_settings' || input.type === 'assistant_batch_child' ? (!input.projectId || !!input.storyId) : input.type === 'generate_image' ? !input.projectId : !input.storyId) throw new Error('Invalid project/game scope for job type.');
	const createdAt = nowIso();
	const jobId = input.dedupeKey ? stableJobId(input.storyId ?? `project:${input.projectId}`, input.type, input.dedupeKey) : id('job');
	const insert = db.insert(backendJobs).values({
		id: jobId,
		storyId: input.storyId ?? null,
		projectId: input.projectId ?? sql`(select shelf_id from stories where id = ${input.storyId ?? null})`,
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
			attemptCount: 0,
			maxAttempts: input.maxAttempts ?? 5,
			runAfter: input.runAfter ?? createdAt,
			lockedAt: null,
			lockedBy: null,
			lastError: null,
			metadata: input.metadata ?? {},
			updatedAt: createdAt,
		},
		setWhere: inArray(backendJobs.status, ['queued', 'retry', 'complete', 'failed']),
	});
	return jobId;
}

export async function enqueueStoryVaultSyncJob(input: {
	storyId: string;
	serverVersion: number;
	reason: string;
	payload?: Record<string, unknown>;
}, db: OutboxDb | OutboxTx = getDb()): Promise<string> {
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
	}, db);
}

export function turnStateExtractionDedupeKey(input: { assistantEntryId: string }): string {
	return `turn-state-${input.assistantEntryId}`;
}

export function turnStateSourceFingerprint(playerText: string, narration: string): string {
	return createHash('sha256').update(JSON.stringify([playerText, narration])).digest('hex');
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
	dueEventCandidates?: import('$lib/server/events/dueEventFeedback').DueEventCandidate[];
	factionCue?: { cardId: string; sourceKey: string; sceneKey: string; title: string; logline: string };
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}, db: OutboxDb | OutboxTx = getDb()): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'extract_turn_state',
		dedupeKey: turnStateExtractionDedupeKey({ assistantEntryId: input.assistantEntryId }),
		payload: {
			playerEntryId: input.playerEntryId,
			assistantEntryId: input.assistantEntryId,
			playerText: input.playerText,
			narration: input.narration,
			sourceFingerprint: turnStateSourceFingerprint(input.playerText, input.narration),
			clientTurnId: input.clientTurnId,
			timelineTurn: input.timelineTurn,
			serverVersion: input.serverVersion,
			retrievedMemoryIds: input.retrievedMemoryIds,
			dueEventCandidates: input.dueEventCandidates ?? [],
			...(input.factionCue ? { factionCue: input.factionCue } : {}),
			memorySettings: input.memorySettings ?? {},
		},
		maxAttempts: 3,
		metadata: { subagent: 'memory_context', task: 'turn_memory', sourceEntryIds: [input.playerEntryId, input.assistantEntryId] },
	}, db);
}

export async function recordCompletedInlineTurnMemory(input: Parameters<typeof enqueueTurnStateExtractionJob>[0] & {
	changeCount: number; patchIds: string[]; eventIds: string[];
}): Promise<string> {
	return getDb().transaction(async tx => {
		const jobId = await enqueueTurnStateExtractionJob(input, tx);
		const [completed] = await tx.update(backendJobs).set({
			status: 'complete', lastError: null, updatedAt: nowIso(),
			metadata: sql`${backendJobs.metadata} || ${JSON.stringify({ inlineTurnMemory: {
				version: 1, changeCount: input.changeCount, patchIds: input.patchIds, eventIds: input.eventIds,
			} })}::jsonb`,
		}).where(and(eq(backendJobs.id, jobId), eq(backendJobs.status, 'queued'))).returning({ id: backendJobs.id });
		if (!completed) throw new Error('Inline turn memory job was not queued for this source.');
		return jobId;
	});
}

export async function enqueueChapterSummaryJob(input: {
	storyId: string;
	serverVersion: number;
	eventIds?: string[];
	patchIds?: string[];
	dedupeKey?: string;
	/** A deferred re-check, e.g. while classifier work on the window's turns finishes. */
	runAfter?: string;
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}, db: OutboxDb | OutboxTx = getDb()): Promise<string> {
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'summarize_chapter',
		dedupeKey: input.dedupeKey ?? `chapter-summary-${input.serverVersion}`,
		...(input.runAfter ? { runAfter: input.runAfter } : {}),
		payload: {
			eventIds: input.eventIds ?? [],
			patchIds: input.patchIds ?? [],
			serverVersion: input.serverVersion,
			...(input.memorySettings ?? {}),
		},
	}, db);
}

/** Durable consumers of one committed chapter. Keys include the chapter's commit
 * revision: a chapter deleted and regenerated under the same stable ID gets fresh
 * consumers, while a duplicate attempt for the same commit can never reset one. */
export const chapterFollowUpKinds = ['arcRollup', 'threads', 'characters', 'factionPressure', 'embedding', 'vault'] as const;
export type ChapterFollowUpKind = typeof chapterFollowUpKinds[number];

const chapterFollowUpJobs: Record<ChapterFollowUpKind, { type: BackendJobType; prefix: string; maxAttempts: number }> = {
	arcRollup: { type: 'rollup_arc', prefix: 'arc-rollup', maxAttempts: 3 },
	threads: { type: 'chapter_threads', prefix: 'chapter-threads', maxAttempts: 5 },
	characters: { type: 'chapter_characters', prefix: 'chapter-characters', maxAttempts: 5 },
	factionPressure: { type: 'update_faction_pressure', prefix: 'chapter-faction-pressure', maxAttempts: 5 },
	embedding: { type: 'embed_memory_nodes', prefix: 'chapter-embed', maxAttempts: 3 },
	vault: { type: 'sync_story_vault', prefix: 'chapter-vault', maxAttempts: 3 },
};

function chapterFollowUpDedupeKey(kind: ChapterFollowUpKind, chapterId: string, chapterServerVersion: number): string {
	return `${chapterFollowUpJobs[kind].prefix}-${chapterId}-r${chapterServerVersion}`;
}

export function chapterFollowUpJobId(storyId: string, chapterId: string, chapterServerVersion: number, kind: ChapterFollowUpKind): string {
	return stableJobId(storyId, chapterFollowUpJobs[kind].type, chapterFollowUpDedupeKey(kind, chapterId, chapterServerVersion));
}

export interface ChapterFollowUpInput {
	storyId: string;
	chapterId: string;
	chapterNumber: number;
	chapterServerVersion: number;
	projectionFingerprint: string;
	sourceJobId: string;
	sourceEventIds: string[];
	memoryNodeId: string;
	threadPlan: unknown;
	/** Defaults to every kind. A reviewed runner chapter has no thread, character or event evidence to apply. */
	kinds?: readonly ChapterFollowUpKind[];
}

/** Enqueue every chapter consumer in the caller's commit transaction. */
export async function enqueueChapterFollowUpJobs(input: ChapterFollowUpInput, db: OutboxDb | OutboxTx): Promise<Partial<Record<ChapterFollowUpKind, string>>> {
	const chapter = {
		chapterId: input.chapterId,
		chapterNumber: input.chapterNumber,
		chapterServerVersion: input.chapterServerVersion,
		projectionFingerprint: input.projectionFingerprint,
		sourceJobId: input.sourceJobId,
	};
	const payloads: Partial<Record<ChapterFollowUpKind, Record<string, unknown>>> = {
		arcRollup: { chapterId: input.chapterId },
		threads: { ...chapter, threadPlan: input.threadPlan },
		characters: chapter,
		// Without source events the chapter has no pressure evidence; never fall back to a campaign-wide scan.
		...(input.sourceEventIds.length ? { factionPressure: { ...chapter, eventIds: input.sourceEventIds, serverVersion: input.chapterServerVersion, deferWorldTick: true } } : {}),
		embedding: { ...chapter, memoryNodeIds: [input.memoryNodeId], serverVersion: input.chapterServerVersion },
		vault: { ...chapter, serverVersion: input.chapterServerVersion, reason: 'chapter' },
	};
	const ids: Partial<Record<ChapterFollowUpKind, string>> = {};
	for (const kind of chapterFollowUpKinds) {
		const payload = payloads[kind];
		if (!payload || (input.kinds && !input.kinds.includes(kind))) continue;
		const job = chapterFollowUpJobs[kind];
		ids[kind] = await enqueueBackendJob({
			storyId: input.storyId, type: job.type as Exclude<BackendJobType, 'validate_agent_settings' | 'generate_image' | 'assistant_batch_child'>,
			dedupeKey: chapterFollowUpDedupeKey(kind, input.chapterId, input.chapterServerVersion), payload, maxAttempts: job.maxAttempts, requeueExisting: false,
			metadata: { chapterFollowUp: { kind, chapterId: input.chapterId, chapterServerVersion: input.chapterServerVersion } },
		}, db);
	}
	return ids;
}

const FACTION_TICK_TURN_INTERVAL = 5;

export function factionCadenceDue(currentTurn: number): boolean {
	return Number.isInteger(currentTurn) && currentTurn > 0 && currentTurn % FACTION_TICK_TURN_INTERVAL === 0;
}

export async function enqueueFactionCadenceJob(input: { storyId: string; currentTurn: number; worldTimeJump?: boolean; worldTime?: string | null },
	db: Pick<OutboxDb, 'insert'> = getDb()): Promise<string | null> {
	if (!factionCadenceDue(input.currentTurn) && !input.worldTimeJump) return null;
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'evaluate_world_sim_tick',
		dedupeKey: input.worldTimeJump ? `faction-world-time-${input.worldTime}` : `world-sim-turn-${input.currentTurn}`,
		payload: { ambient: true, force: false, scheduledForTurn: input.currentTurn },
		requeueExisting: false,
	}, db);
}

export async function enqueuePlotBrainJob(input: {
	storyId: string;
	trigger: 'scheduled_refresh' | 'arc_created' | 'faction_shock';
	scopeId: string;
	skipIfPlanned?: boolean;
}, db: OutboxDb | OutboxTx = getDb()): Promise<string> {
	const [story] = input.trigger === 'scheduled_refresh'
		? await db.select({ currentTurn: stories.currentTurn, metadata: stories.metadata }).from(stories).where(eq(stories.id, input.storyId)).limit(1)
		: [];
	const workflow = story?.metadata?.factionWorkflow as Record<string, unknown> | undefined;
 const gardener = workflow?.gardener as Record<string, unknown> | undefined;
 if (story && typeof gardener?.lastTurn === 'number' && story.currentTurn - gardener.lastTurn < 8) return '';
 const scopeId = story
		? `${input.storyId}-turn-${Math.max(0, Math.floor(story.currentTurn))}`
		: input.scopeId;
	return enqueueBackendJob({
		storyId: input.storyId,
		type: 'plan_plot_brain',
		dedupeKey: `plot-brain-${input.trigger}-${scopeId}`,
		payload: {
			trigger: input.trigger,
			execute: true,
			skipIfPlanned: input.skipIfPlanned === true,
			...(story ? { scheduledForTurn: Math.max(0, Math.floor(story.currentTurn)) } : {}),
		},
		requeueExisting: false,
		maxAttempts: 3,
	}, db);
}

export function backendJobFailureIsRetryable(error: unknown): boolean {
	if (error && typeof error === 'object') {
		const retryable = (error as { retryable?: unknown }).retryable;
		if (retryable === false) return false;
		if (retryable === true) return true;
	}
	const message = error instanceof Error || typeof error === 'string' ? describeBackendJobError(error) : '';
	// Automatic retries follow the classifier's decision. Manual recovery has a
	// separate policy; treating everything outside its blocklist as transient
	// repeatedly dispatches unknown/deterministic summary failures.
	return classifyBackendJobFailure(message).retryable;
}

export async function enqueueContinuityAuditJob(input: {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	clientTurnId: string;
	serverVersion: number;
	playerName?: string | null;
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
			playerName: input.playerName ?? null,
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
}, db: OutboxDb | OutboxTx = getDb()): Promise<string[]> {
	const jobs: Promise<string>[] = [];
	const memorySettings = input.memorySettings ?? {};
	if (input.eventIds.length > 0) {
  const material = await db.execute(sql`select id, faction_ids from story_events where story_id=${input.storyId} and id in (${sql.join(input.eventIds.map(id => sql`${id}`), sql`,`)}) and status='committed' and (type in ('agreement','death','faction_move') or metadata->>'material'='true' or (jsonb_typeof(metadata->'actorClaims')='array' and metadata->'actorClaims'<>'[]'::jsonb))`);
  if (material.length) {
   const factionIds = [...new Set(material.flatMap(row => Array.isArray(row.faction_ids) ? row.faction_ids as string[] : []))].slice(0, 2);
   jobs.push(enqueueBackendJob({ storyId: input.storyId, type: 'evaluate_world_sim_tick', dedupeKey: `faction-material-${input.serverVersion}`, payload: { materialFactionIds: factionIds }, requeueExisting: false, maxAttempts: 2 }, db));
   jobs.push(enqueueBackendJob({ storyId: input.storyId, type: 'plan_plot_brain', dedupeKey: `gardener-material-${input.serverVersion}`, payload: { trigger: 'faction_shock' }, requeueExisting: false, maxAttempts: 2 }, db));
  }
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'create_memory_nodes_from_events',
			dedupeKey: `turn-events-${input.serverVersion}`,
			payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		}, db));
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'update_faction_pressure',
			dedupeKey: `faction-pressure-${input.serverVersion}`,
			payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		}, db));
	}
	if (input.memoryNodeIds.length > 0) {
		jobs.push(enqueueBackendJob({
			storyId: input.storyId,
			type: 'embed_memory_nodes',
			dedupeKey: `embed-memory-${input.serverVersion}`,
			payload: { memoryNodeIds: input.memoryNodeIds, serverVersion: input.serverVersion },
		}, db));
	}
	jobs.push(enqueueBackendJob({
		storyId: input.storyId,
		type: 'index_canonical_records',
		dedupeKey: `canonical-index-${input.serverVersion}`,
		payload: { eventIds: input.eventIds, patchIds: input.patchIds, serverVersion: input.serverVersion },
		maxAttempts: 3,
	}, db));
	jobs.push(enqueueChapterSummaryJob({
		storyId: input.storyId,
		serverVersion: input.serverVersion,
		eventIds: input.eventIds,
		patchIds: input.patchIds,
		dedupeKey: input.chapterDedupeKey,
		memorySettings,
	}, db));
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
		}, db));
	}
	return Promise.all(jobs);
}

export async function enqueueImportProjectionJobs(input: {
	storyId: string;
	counts: Record<string, number>;
	serverVersion: number;
}): Promise<string[]> {
	// Restoring a save rebuilds indexes; it must not advance factions, arcs, or the plot.
	return Promise.all([
		enqueueBackendJob({
			storyId: input.storyId,
			type: 'refresh_scene_checkpoint',
			dedupeKey: `import-scene-${input.serverVersion}`,
			maxAttempts: 3,
		}),
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

export async function claimBackendJobs(workerId: string, limit = 10, storyId?: string | null, projectId?: string, types?: readonly BackendJobType[]) {
	const db = getDb();
	const claimedAt = nowIso();
	await recoverStaleBackendJobs(staleLockMs(), storyId, types);
	const filters = [
		inArray(backendJobs.status, ['queued', 'retry']),
		sql`coalesce(${backendJobs.payload}->>'execution','') <> 'api'`,
		lte(backendJobs.runAfter, claimedAt),
	];
	if (storyId) filters.push(eq(backendJobs.storyId, storyId));
	if (projectId) filters.push(eq(backendJobs.projectId, projectId));
	if (types) filters.push(inArray(backendJobs.type, [...types]));
	const candidates = await db
		.select({ id: backendJobs.id })
		.from(backendJobs)
		.where(and(...filters))
		.orderBy(backendJobClaimPriorityOrder, asc(backendJobs.runAfter), asc(backendJobs.createdAt))
		.limit(limit);
	const ids = candidates.map((job) => job.id);
	if (ids.length === 0) return [];
	const claimed = await db.update(backendJobs).set({
		status: 'running',
		attemptCount: sql`${backendJobs.attemptCount} + 1`,
		lockedAt: claimedAt,
		lockedBy: workerId,
		updatedAt: claimedAt,
	}).where(and(
		inArray(backendJobs.id, ids),
		inArray(backendJobs.status, ['queued', 'retry']),
		sql`coalesce(${backendJobs.payload}->>'execution','') <> 'api'`,
		lte(backendJobs.runAfter, claimedAt),
		types ? inArray(backendJobs.type, [...types]) : undefined,
	)).returning();
	return orderClaimedBackendJobs(claimed, ids);
}

export function orderClaimedBackendJobs<T extends { id: string }>(jobs: T[], orderedIds: string[]): T[] {
	const order = new Map(orderedIds.map((id, index) => [id, index]));
	return [...jobs].sort((left, right) => (order.get(left.id) ?? orderedIds.length) - (order.get(right.id) ?? orderedIds.length));
}

function claimedBackendJobWhere(job: Pick<ClaimedBackendJob, 'id' | 'lockedAt' | 'lockedBy'>) {
	return and(
		eq(backendJobs.id, job.id),
		eq(backendJobs.status, 'running'),
		job.lockedAt === null ? isNull(backendJobs.lockedAt) : eq(backendJobs.lockedAt, job.lockedAt),
		job.lockedBy === null ? isNull(backendJobs.lockedBy) : eq(backendJobs.lockedBy, job.lockedBy),
	);
}

export async function recoverStaleBackendJobs(staleMs = staleLockMs(), storyId?: string | null, types?: readonly BackendJobType[]): Promise<number> {
	const db = getDb();
	const recoveredAt = nowIso();
	const cutoff = new Date(Date.now() - Math.max(60_000, staleMs)).toISOString();
	const filters = [
		eq(backendJobs.status, 'running'),
		lte(backendJobs.lockedAt, cutoff),
	];
	if (storyId) filters.push(eq(backendJobs.storyId, storyId));
	if (types) filters.push(inArray(backendJobs.type, [...types]));
	const rows = await db
		.select({
			id: backendJobs.id,
			type: backendJobs.type,
			projectId: backendJobs.projectId,
			storyId: backendJobs.storyId,
			attemptCount: backendJobs.attemptCount,
			maxAttempts: backendJobs.maxAttempts,
			lockedAt: backendJobs.lockedAt,
			lockedBy: backendJobs.lockedBy,
			payload: backendJobs.payload,
		})
		.from(backendJobs)
		.where(and(...filters));

	for (const job of rows) {
		// A provider response may have been persisted just before the worker died.
		// Replay that stored image to finish attachment, but never make an uncertain
		// second paid request when no asset receipt exists.
		const imageAsset = job.type === 'generate_image'
			? (await db.execute(sql`select id from assets where origin_job_id=${job.id} and project_id=${job.projectId}
				and game_id is not distinct from ${job.storyId} limit 1`))[0]
			: null;
		const exhausted = job.type === 'generate_image' ? job.payload.execution === 'api' || !imageAsset : job.attemptCount >= job.maxAttempts;
		await db.update(backendJobs).set({
			status: exhausted ? 'failed' : 'retry',
			...(imageAsset ? { maxAttempts: Math.max(job.maxAttempts, job.attemptCount + 1) } : {}),
			runAfter: recoveredAt,
			lockedAt: null,
			lockedBy: null,
			lastError: `Recovered stale job lock from ${job.lockedBy ?? 'unknown worker'} after ${Math.round(staleMs / 1000)}s.`,
			updatedAt: recoveredAt,
		}).where(claimedBackendJobWhere(job));
	}
	return rows.length;
}

export async function markBackendJobComplete(job: ClaimedBackendJob, metadataPatch?: Record<string, unknown>): Promise<void> {
	const completedAt = nowIso();
	await getDb().update(backendJobs).set({
		status: 'complete',
		lockedAt: null,
		lockedBy: null,
		lastError: null,
		...(metadataPatch ? { metadata: sql`${backendJobs.metadata} || ${JSON.stringify(metadataPatch)}::jsonb` } : {}),
		updatedAt: completedAt,
	}).where(claimedBackendJobWhere(job));
}

export async function markBackendJobFailed(job: ClaimedBackendJob, error: unknown): Promise<void> {
	const failedAt = nowIso();
	const retryable = backendJobFailureIsRetryable(error);
	const exhausted = !retryable
		|| job.attemptCount >= job.maxAttempts;
	const providerDelayMs = error && typeof error === 'object' && 'result' in error
		? Number((error as { result?: { retryAfterMs?: unknown } }).result?.retryAfterMs) : 0;
	const delayMs = Math.max(Math.min(60_000, 1000 * Math.max(1, job.attemptCount) ** 2),
		Number.isFinite(providerDelayMs) ? Math.max(0, providerDelayMs) : 0);
	await getDb().update(backendJobs).set({
		status: exhausted ? 'failed' : 'retry',
		runAfter: new Date(Date.now() + delayMs).toISOString(),
		lockedAt: null,
		lockedBy: null,
		lastError: describeBackendJobError(error),
		metadata: sql`${backendJobs.metadata} || ${JSON.stringify({ lastFailure: {
			kind: !retryable ? 'non_retryable' : exhausted ? 'attempts_exhausted' : 'retry_scheduled',
			failedAt, retryable, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts,
		} })}::jsonb`,
		updatedAt: failedAt,
	}).where(claimedBackendJobWhere(job));
}
