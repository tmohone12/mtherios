import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const db = vi.hoisted(() => {
	const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
	const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
	const values = vi.fn((_row: Record<string, any>) => ({ onConflictDoNothing, onConflictDoUpdate }));
	const updateReturning = vi.fn().mockResolvedValue([]);
	const updateWhere = vi.fn((_where: SQL) => ({ returning: updateReturning }));
	const updateSet = vi.fn((_row: Record<string, any>) => ({ where: updateWhere }));
	const retryLookup = { currentTurn: 12, status: 'failed', type: 'extract_turn_state', lockedAt: null, lockedBy: null, lastError: null as string | null, metadata: {} as Record<string, unknown> };
	return {
		insert: vi.fn(() => ({ values })),
		update: vi.fn(() => ({ set: updateSet })),
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([retryLookup]) })),
			})),
		})),
		onConflictDoNothing,
		onConflictDoUpdate,
		updateSet,
		updateWhere,
		updateReturning,
		values,
		retryLookup,
	};
});

vi.mock('$lib/server/db/client', () => ({ getDb: () => db }));

import {
	backendJobClaimPriorityOrder,
	backendJobFailureIsRetryable,
	backendJobRetryBlockReason,
	backendJobRetryWhere,
	enqueueBackendJob,
	enqueueFactionCadenceJob,
	enqueueImportProjectionJobs,
	enqueuePlotBrainJob,
	enqueueStoryVaultSyncJob,
	enqueueTurnStateExtractionJob,
	enqueueTurnProjectionJobs,
	markBackendJobComplete,
	markBackendJobFailed,
	orderClaimedBackendJobs,
	retryBackendJob,
	stableJobId,
} from './outbox';

function compiledSql(value: Parameters<PgDialect['sqlToQuery']>[0]) {
	return new PgDialect().sqlToQuery(value);
}

describe('job enqueue conflicts', () => {
	it('queues project-only work without inventing a story and isolates dedupe', async () => {
		await enqueueBackendJob({ projectId: 'project_one', type: 'validate_agent_settings', dedupeKey: 'settings-1' });
		const first = db.values.mock.calls.at(-1)![0];
		expect(first).toMatchObject({ projectId: 'project_one', storyId: null, type: 'validate_agent_settings' });
		await enqueueBackendJob({ projectId: 'project_two', type: 'validate_agent_settings', dedupeKey: 'settings-1' });
		expect(db.values.mock.calls.at(-1)![0].id).not.toBe(first.id);
		await expect(enqueueBackendJob({ projectId: 'project_one', type: 'extract_turn_state' } as any)).rejects.toThrow('Invalid project/game scope');
		await expect(enqueueBackendJob({ projectId: 'project_one', storyId: 'story_one', type: 'validate_agent_settings' } as any)).rejects.toThrow('Invalid project/game scope');
	});

	it('scopes project retry by project and a null game without matching campaign jobs', () => {
		const where = compiledSql(backendJobRetryWhere(null, 'job_one', '2026-09-21T00:00:00Z', 'project_one'));
		expect(where.sql).toContain('"backend_jobs"."story_id" is null');
		expect(where.params).toContain('project_one');
		expect(() => backendJobRetryWhere(null, 'job_one', '2026-09-21T00:00:00Z')).toThrow('scope');
	});

	beforeEach(() => {
		db.retryLookup.lastError = null;
		db.retryLookup.metadata = {};
		vi.clearAllMocks();
	});

	it('does not reset an existing plot planner job', async () => {
		await enqueuePlotBrainJob({
			storyId: 'story_1',
			trigger: 'scheduled_refresh',
			scopeId: 'story_1',
			skipIfPlanned: true,
		});

		expect(db.onConflictDoNothing).toHaveBeenCalledOnce();
		expect(db.onConflictDoUpdate).not.toHaveBeenCalled();
	});

	it('queues one immutable faction tick per cadence turn, independent of chapter jobs', async () => {
		expect(await enqueueFactionCadenceJob({ storyId: 'story_1', currentTurn: 19 })).toBeNull();
		expect(db.values).not.toHaveBeenCalled();
		const first = await enqueueFactionCadenceJob({ storyId: 'story_1', currentTurn: 20 });
		const retry = await enqueueFactionCadenceJob({ storyId: 'story_1', currentTurn: 20 });
		expect(retry).toBe(first);
		expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
			type: 'evaluate_world_sim_tick',
			payload: { ambient: true, force: false, scheduledForTurn: 20 },
		}));
		expect(db.onConflictDoNothing).toHaveBeenCalledTimes(2);
		expect(db.onConflictDoUpdate).not.toHaveBeenCalled();
		expect(await enqueueFactionCadenceJob({ storyId: 'story_1', currentTurn: 25 })).not.toBe(first);
	});

	it('preserves the faction-shock trigger used to wake a quiet Plot Director', async () => {
		await enqueuePlotBrainJob({
			storyId: 'story_1',
			trigger: 'faction_shock',
			scopeId: 'event_faction_1',
		});

		expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
			type: 'plan_plot_brain',
			payload: expect.objectContaining({ trigger: 'faction_shock' }),
		}));
	});

	it('records the Memory & Context turn-memory task and its transcript sources', async () => {
		await enqueueTurnStateExtractionJob({ storyId: 'story_1', playerEntryId: 'player_1', assistantEntryId: 'gm_1',
			playerText: 'I enter.', narration: 'The door opens.', clientTurnId: 'client_1', timelineTurn: 1,
			serverVersion: 2, retrievedMemoryIds: [] });
		expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ type: 'extract_turn_state',
			metadata: { subagent: 'memory_context', task: 'turn_memory', sourceEntryIds: ['player_1', 'gm_1'] } }));
	});

	it('deduplicates scheduled refreshes by story turn instead of caller-specific scope', async () => {
		await enqueuePlotBrainJob({ storyId: 'story_1', trigger: 'scheduled_refresh', scopeId: 'narration_1' });
		await enqueuePlotBrainJob({ storyId: 'story_1', trigger: 'scheduled_refresh', scopeId: 'chapter_1' });

		const [first, second] = db.values.mock.calls.map(([row]) => row);
		expect(first.id).toBe(second.id);
		expect(first.id).toContain('story_1_turn_12');
		expect(first.payload).toMatchObject({ scheduledForTurn: 12 });
	});

	it('restores import projections and scene excerpts without advancing factions, chapters, or the plot', async () => {
		await enqueueImportProjectionJobs({ storyId: 'story_1', counts: {}, serverVersion: 7 });
		const insertedJobs = db.values.mock.calls.map(([row]) => row);
		expect(insertedJobs.map((row) => row.type)).toEqual([
			'refresh_scene_checkpoint', 'rebuild_retrieval_projection', 'embed_memory_nodes', 'index_canonical_records', 'sync_story_vault',
		]);
	});

	it('requeues only idle jobs and resets their complete execution state', async () => {
		await enqueueBackendJob({
			storyId: 'story_1',
			type: 'continuity_audit',
			dedupeKey: 'continuity-entry_1',
			maxAttempts: 3,
		});

		expect(db.onConflictDoUpdate).toHaveBeenCalledOnce();
		expect(db.onConflictDoNothing).not.toHaveBeenCalled();
		const [{ set, setWhere }] = db.onConflictDoUpdate.mock.calls[0];
		expect(set).toMatchObject({
			status: 'queued',
			attemptCount: 0,
			maxAttempts: 3,
			lockedAt: null,
			lockedBy: null,
			lastError: null,
		});
		const guard = compiledSql(setWhere);
		expect(guard.sql).toContain('"backend_jobs"."status" in');
		expect(guard.params).toEqual(['queued', 'retry', 'complete', 'failed']);
	});

	it('scopes every deduped job ID to its story', async () => {
		const input = {
			storyId: 'story_1',
			type: 'index_canonical_records' as const,
			dedupeKey: 'canonical-index-7',
		};
		const first = await enqueueBackendJob(input);
		const repeated = await enqueueBackendJob(input);
		const otherStory = await enqueueBackendJob({ ...input, storyId: 'story_2' });

		expect(first).toBe(repeated);
		expect(otherStory).not.toBe(first);
		expect(first).toContain('story_1');
		expect(otherStory).toContain('story_2');
	});

	it('keeps punctuation-equivalent job scopes distinct', () => {
		const first = stableJobId('story-a', 'plan_plot_brain', 'plot-brain:turn-7');
		const second = stableJobId('story_a', 'plan_plot_brain', 'plot-brain turn 7');

		expect(first).not.toBe(second);
		expect(first).toMatch(/^job_plan_plot_brain_story_a_plot_brain_turn_7_[a-f0-9]{16}$/);
		expect(second).toMatch(/^job_plan_plot_brain_story_a_plot_brain_turn_7_[a-f0-9]{16}$/);
		expect(stableJobId('story-a', 'plan_plot_brain', 'plot-brain:turn-7')).toBe(first);
	});

	it('deduplicates versioned story-vault syncs per story without cross-story collisions', async () => {
		const input = {
			storyId: 'story_1',
			serverVersion: 5,
			reason: 'plot-brain-apply',
			payload: { clean: true, index: true, frameId: 'frame_1' },
		};
		const first = await enqueueStoryVaultSyncJob(input);
		const repeated = await enqueueStoryVaultSyncJob(input);
		const otherStory = await enqueueStoryVaultSyncJob({ ...input, storyId: 'story_2' });

		expect(first).toBe(repeated);
		expect(otherStory).not.toBe(first);
		expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
			id: first,
			storyId: 'story_1',
			type: 'sync_story_vault',
			payload: {
				clean: true,
				index: true,
				frameId: 'frame_1',
				serverVersion: 5,
				reason: 'plot-brain-apply',
			},
		}));
	});

	it('uses the supplied transaction for a story-vault outbox write', async () => {
		const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
		const values = vi.fn(() => ({ onConflictDoUpdate, onConflictDoNothing: vi.fn() }));
		const tx = { insert: vi.fn(() => ({ values })) };

		await enqueueStoryVaultSyncJob({
			storyId: 'story_1', serverVersion: 5, reason: 'plot-brain-apply', payload: { frameId: 'frame_1' },
		}, tx as never);

		expect(values).toHaveBeenCalledWith(expect.objectContaining({ storyId: 'story_1', type: 'sync_story_vault' }));
		expect(onConflictDoUpdate).toHaveBeenCalledOnce();
		expect(db.values).not.toHaveBeenCalled();
	});

	it('writes turn projection outbox rows through the caller-owned transaction', async () => {
		const txValues = vi.fn((_row: Record<string, unknown>) => ({
			onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
			onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
		}));
		const tx = { insert: vi.fn(() => ({ values: txValues })), execute: vi.fn().mockResolvedValue([]) };

		await enqueueTurnProjectionJobs({
			storyId: 'story_1',
			eventIds: ['event_1'],
			memoryNodeIds: [],
			patchIds: ['patch_1'],
			serverVersion: 7,
			chapterDedupeKey: 'chapter-summary-entry_1',
		}, tx as any);

		expect(db.insert).not.toHaveBeenCalled();
		expect(txValues.mock.calls.map(([row]) => row.type)).toEqual([
			'create_memory_nodes_from_events',
			'update_faction_pressure',
			'index_canonical_records',
			'summarize_chapter',
		]);
	});

	it('writes story-vault outbox rows through the caller-owned transaction', async () => {
		const txValues = vi.fn((_row: Record<string, unknown>) => ({
			onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
			onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
		}));
		const tx = { insert: vi.fn(() => ({ values: txValues })) };

		await enqueueStoryVaultSyncJob({
			storyId: 'story_1',
			serverVersion: 8,
			reason: 'plot-brain-apply',
		}, tx as any);

		expect(db.insert).not.toHaveBeenCalled();
		expect(txValues).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			type: 'sync_story_vault',
		}));
	});
});

describe('claimed job completion', () => {
	beforeEach(() => vi.clearAllMocks());

	const job = {
		id: 'job_1',
		attemptCount: 2,
		maxAttempts: 3,
		lockedAt: '2026-08-30T20:00:00.000Z',
		lockedBy: 'worker_new',
	};

	it('marks complete only when the running lock still belongs to this claim', async () => {
		await markBackendJobComplete(job);

		expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({
			status: 'complete',
			lockedAt: null,
			lockedBy: null,
			lastError: null,
		}));
		const guard = compiledSql(db.updateWhere.mock.calls[0][0]);
		expect(guard.sql).toContain('"backend_jobs"."status" =');
		expect(guard.sql).toContain('"backend_jobs"."locked_at" =');
		expect(guard.sql).toContain('"backend_jobs"."locked_by" =');
		expect(guard.params).toEqual(['job_1', 'running', job.lockedAt, job.lockedBy]);
	});

	it('marks failed only when the running lock still belongs to this claim', async () => {
		await markBackendJobFailed(job, Object.assign(new Error('invalid output'), { retryable: false }));

		expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({
			status: 'failed',
			lockedAt: null,
			lockedBy: null,
			lastError: 'invalid output',
		}));
		const guard = compiledSql(db.updateWhere.mock.calls[0][0]);
		expect(guard.params).toEqual(['job_1', 'running', job.lockedAt, job.lockedBy]);
	});

	it('stops ordinary permanent output failures without an explicit retry flag', async () => {
		await markBackendJobFailed(job, new Error('Classifier returned an invalid state extraction response.'));

		expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({
			status: 'failed',
			lastError: 'Classifier returned an invalid state extraction response.',
		}));
		const update = db.updateSet.mock.calls[0][0];
		const metadata = compiledSql(update.metadata);
		expect(JSON.parse(String(metadata.params[0])).lastFailure.retryable).toBe(false);
	});
});

describe('job retry classification', () => {
	beforeEach(() => {
		db.retryLookup.lastError = null;
		db.retryLookup.metadata = {};
		db.update.mockClear();
		db.updateReturning.mockReset();
		db.updateReturning.mockResolvedValue([]);
	});

	it('limits manual retry to replay-safe failed, unlocked jobs', () => {
		const job = { type: 'extract_turn_state', status: 'failed', lockedAt: null, lockedBy: null };
		expect(backendJobRetryBlockReason(job)).toBeNull();
		expect(backendJobRetryBlockReason({ ...job, lastError: 'Server LLM request failed (402): Insufficient Balance' })).toContain('provider account');
		expect(backendJobRetryBlockReason({ ...job, lastError: 'Classifier returned an empty state extraction response.', metadata: { lastFailure: { retryable: false } } })).toBeNull();
		expect(backendJobRetryBlockReason({ ...job, type: 'refresh_scene_checkpoint', lastError: 'Classifier returned an invalid state extraction response.' })).toContain('provider output');
		expect(backendJobRetryBlockReason({ ...job, lastError: 'Projection dependency changed; stale source.' })).toBeNull();
		expect(backendJobRetryBlockReason({ ...job, type: 'plan_plot_brain' })).toContain('effects need review');
		expect(backendJobRetryBlockReason({ ...job, status: 'running' })).toContain('Only failed');
		expect(backendJobRetryBlockReason({ ...job, lockedBy: 'worker' })).toContain('worker lock');
	});

	it('allows chapter and arc jobs to be retried only after a configuration failure', () => {
		const configuration = 'Model configuration needed: Summaries has no model profile. Choose one in Settings → Models.';
		for (const type of ['summarize_chapter', 'rollup_arc']) {
			const job = { type, status: 'failed', lockedAt: null, lockedBy: null, lastError: configuration };
			expect(backendJobRetryBlockReason(job), type).toBeNull();
			expect(backendJobRetryBlockReason({ ...job, lastError: 'Server LLM request timed out after 120000ms.' }), type).toMatch(/^Manual retry is blocked/);
			expect(backendJobRetryBlockReason({ ...job, lastError: null }), type).toMatch(/^Manual retry is blocked/);
		}
		// Saga rollups are deterministic stable-ID upserts, so they are replay-safe for any failure.
		expect(backendJobRetryBlockReason({ type: 'rollup_saga', status: 'failed', lockedAt: null, lockedBy: null, lastError: 'Deadlock detected.' })).toBeNull();
		const guard = compiledSql(backendJobRetryWhere('story_1', 'job_1', '2026-09-05 21:00:00.123456+00'));
		expect(guard.params).toEqual(expect.arrayContaining(['summarize_chapter', 'rollup_arc', 'rollup_saga']));
	});

	it('refuses to requeue an arc job whose failure was not configuration', async () => {
		Object.assign(db.retryLookup, { type: 'rollup_arc', lastError: 'Arc summary output was invalid.' });
		try {
			await expect(retryBackendJob({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05T21:00:00Z' })).rejects.toThrow(/^Manual retry is blocked/);
			expect(db.update).not.toHaveBeenCalled();
		} finally {
			db.retryLookup.type = 'extract_turn_state';
		}
	});

	it('compares story, exact observed version, status, type and both locks atomically', () => {
		const guard = compiledSql(backendJobRetryWhere('story_1', 'job_1', '2026-09-05 21:00:00.123456+00'));
		for (const field of ['story_id', 'id', 'status', 'updated_at', 'type', 'locked_at', 'locked_by']) expect(guard.sql).toContain(`"backend_jobs"."${field}"`);
		expect(guard.params.slice(0, 4)).toEqual(['story_1', 'job_1', 'failed', '2026-09-05 21:00:00.123456+00']);
		expect(guard.params).not.toContain('complete');
	});

	it('merges retry history without replacing payload or partial progress metadata', async () => {
		db.updateReturning.mockResolvedValueOnce([{ id: 'job_1', status: 'retry' }]);
		await expect(retryBackendJob({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05T21:00:00Z' })).resolves.toMatchObject({ status: 'retry' });
		const update = db.updateSet.mock.lastCall![0];
		expect(update).toMatchObject({ status: 'retry', attemptCount: 0, lastError: null });
		expect(update).not.toHaveProperty('payload');
		expect(update).not.toHaveProperty('maxAttempts');
		const merge = compiledSql(update.metadata);
		expect(merge.sql).toContain('"backend_jobs"."metadata" ||');
		expect(merge.sql).toContain('manualRetryHistory');
		expect(merge.sql).toContain('lastFailure');
	});

	it('allows an explicit retry of failed extraction after correcting classifier output', async () => {
		db.retryLookup.lastError = 'Classifier returned an empty state extraction response.';
		db.retryLookup.metadata = { lastFailure: { retryable: false } };
		db.updateReturning.mockResolvedValueOnce([{ id: 'job_1', status: 'retry' }]);
		await expect(retryBackendJob({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05T21:00:00Z' })).resolves.toMatchObject({ status: 'retry' });
	});

	it('blocks manual retry for known permanent provider failures before writing', async () => {
		db.retryLookup.lastError = 'Server LLM request failed (402): Insufficient Balance';
		await expect(retryBackendJob({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05T21:00:00Z' })).rejects.toThrow(/provider account/);
		expect(db.update).not.toHaveBeenCalled();
	});

	it('rejects stale or competing retry requests instead of claiming another attempt', async () => {
		db.updateReturning.mockResolvedValueOnce([]);
		await expect(retryBackendJob({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05T21:00:00Z' })).rejects.toThrow('Refresh Jobs');
	});

	it('does not retry deterministic structured-output failures', () => {
		expect(backendJobFailureIsRetryable(Object.assign(new Error('truncated'), { retryable: false }))).toBe(false);
		expect(backendJobFailureIsRetryable(new Error('Classifier returned an invalid state extraction response.'))).toBe(false);
		expect(backendJobFailureIsRetryable(new Error('Server LLM request failed (402): Insufficient Balance'))).toBe(false);
		expect(backendJobFailureIsRetryable(new Error('Request exceeds the model context allowance.'))).toBe(false);
		expect(backendJobFailureIsRetryable(new Error('temporary provider outage'))).toBe(true);
	});

	it.each([
		'Summary response did not contain a complete JSON object (finish_reason: length).',
		'Accounts response did not contain a complete JSON object (finish_reason: stop).',
		'Incomplete summary: accounts must cover every source exactly once in chronological order.',
		'Unexpected summary compiler failure',
	])('does not automatically repurchase a deterministic or unknown failure: %s', message => {
		expect(backendJobFailureIsRetryable(new Error(message))).toBe(false);
	});

	it.each([
		'Server LLM request failed (503): Service Unavailable',
		'Server LLM request failed (429): Too Many Requests',
		'read ECONNRESET',
		'could not serialize access due to concurrent update',
	])('preserves automatic retries for a transient failure: %s', message => {
		expect(backendJobFailureIsRetryable(new Error(message))).toBe(true);
	});

	it('honors the explicit retry contract even when a wrapper message is ambiguous', () => {
		expect(backendJobFailureIsRetryable(Object.assign(new Error('summary fallback failed'), { retryable: true }))).toBe(true);
		expect(backendJobFailureIsRetryable(Object.assign(new Error('network result exhausted'), { retryable: false }))).toBe(false);
	});
});

describe('claimed job order', () => {
	it('prioritizes scene checkpoints and fresh turn state ahead of routine plot refreshes', () => {
		const order = compiledSql(backendJobClaimPriorityOrder);
		expect(order.sql).toContain('"backend_jobs"."type" = \'refresh_scene_checkpoint\'');
		expect(order.sql).toContain('"backend_jobs"."type" = \'extract_turn_state\'');
		expect(order.sql).toContain('"backend_jobs"."type" = \'continuity_audit\'');
		expect(order.sql).toContain('"backend_jobs"."type" = \'evaluate_world_sim_tick\' then 5');
		expect(order.sql).toContain('"backend_jobs"."payload"->>\'trigger\' = \'scheduled_refresh\'');
		expect(order.params).toEqual([]);
	});

	it('restores the selection order after UPDATE RETURNING', () => {
		expect(orderClaimedBackendJobs(
			[{ id: 'job_3' }, { id: 'job_1' }, { id: 'job_2' }],
			['job_1', 'job_2', 'job_3'],
		)).toEqual([{ id: 'job_1' }, { id: 'job_2' }, { id: 'job_3' }]);
	});
});
