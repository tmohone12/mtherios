import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stories, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), generate: vi.fn(), log: vi.fn(), service: vi.fn(), enqueue: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/engine/apiCallLogs', () => ({ recordApiCallLog: mocks.log }));
vi.mock('$lib/server/engine/llmSettings', async original => ({
	...await original<typeof import('$lib/server/engine/llmSettings')>(), resolveServiceGeneration: mocks.service,
}));
vi.mock('./outbox', async original => ({
	...await original<typeof import('./outbox')>(), enqueueChapterSummaryJob: mocks.enqueue,
}));
vi.mock('$lib/server/turn/context', async original => ({
	...await original<typeof import('$lib/server/turn/context')>(),
	loadCanonicalCharacters: async () => [], loadClassifierAgreements: async () => [],
	loadClassifierLocations: async () => [], loadClassifierFactions: async () => [],
}));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.generate,
}));

import { extractTurnState } from './processor';
import { ServerGenerationError, type ServerGenerationResult } from '$lib/server/turn/provider';
import { reuseGenerationResult } from '$lib/server/engine/generationAccounting';

const playerText = 'I offer the envoy the key.';
const narration = 'The envoy accepts the key and promises to guard the gate.';
const entries = [
	{ id: 'player', storyId: 'story', type: 'user_action', content: playerText, position: 1, parentId: null, metadata: {} },
	{ id: 'answer', storyId: 'story', type: 'narration', content: narration, position: 2, parentId: 'player', metadata: {} },
];
const job: Parameters<typeof extractTurnState>[0] = {
	id: 'extraction-job', storyId: 'story', type: 'extract_turn_state', attemptCount: 1, lastError: null, metadata: {},
	projectId: 'test-project', status: 'running', maxAttempts: 5,
	createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', runAfter: '2026-10-03T00:00:00Z',
	lockedAt: '2026-10-03T00:00:00Z', lockedBy: 'test-worker',
	payload: { playerEntryId: 'player', assistantEntryId: 'answer', playerText, narration, clientTurnId: 'turn' },
};

function generation(text: string, requestId: string, cost: number): ServerGenerationResult {
	const usage = { requestTokens: 200, responseTokens: 100, totalTokens: 300, inputTokens: 200, cachedInputTokens: 80,
		cacheWriteTokens: null, outputTokens: 100, reasoningTokens: 60, estimatedCostUsd: cost, providerCostUsd: cost };
	return { text, model: 'fixture-model', endpoint: 'http://fixture.invalid', durationMs: 10, promptChars: 500,
		responseChars: text.length, finishReason: text.startsWith('{') ? 'stop' : 'length', usage,
		attempts: [{ attemptId: `attempt-${requestId}`, providerRequestId: requestId, requestHash: `hash-${requestId}`, attempt: 1,
			startedAt: '2026-10-03T00:00:00Z', model: 'fixture-model', endpoint: 'http://fixture.invalid', status: 'success',
			statusCode: 200, durationMs: 10, promptChars: 500, responseChars: text.length,
			finishReason: text.startsWith('{') ? 'stop' : 'length', usage, error: null }],
	};
}

let sourceReads = 0;
let invalidateAt = Number.POSITIVE_INFINITY;
beforeEach(() => {
	vi.resetAllMocks();
	sourceReads = 0;
	invalidateAt = Number.POSITIVE_INFINITY;
	mocks.log.mockResolvedValue('receipt');
	mocks.enqueue.mockResolvedValue('summary-job');
	mocks.service.mockResolvedValue({ profile: { id: 'fixture', name: 'Fixture', providerType: 'openai-compatible',
		baseUrl: 'http://fixture.invalid', model: 'fixture-model' }, setting: { enabled: true },
		generation: { model: 'fixture-model', maxTokens: 1000 } });
	mocks.getDb.mockReturnValue({ select: () => {
		let table: unknown;
		const query = {
			from: (value: unknown) => { table = value; return query; }, where: () => query, limit: () => query,
			then: (resolve: (rows: unknown[]) => unknown) => {
				const rows = table === storyEntries ? ++sourceReads >= invalidateAt ? [] : structuredClone(entries)
					: table === stories ? [{ metadata: {} }] : [];
				return Promise.resolve(rows).then(resolve);
			},
		};
		return query;
	} });
});

describe('deferred extraction provider accounting', () => {
	it('retains invalid initial usage and distinct valid repair without double counting', async () => {
		mocks.generate.mockResolvedValueOnce(generation('truncated invalid JSON', 'initial', 0.02))
			.mockResolvedValueOnce(generation('{"update":{}}', 'repair', 0.03));
		await expect(extractTurnState(job)).resolves.toMatchObject({ status: 'no_changes' });
		expect(mocks.generate).toHaveBeenCalledTimes(2);
		expect(mocks.log).toHaveBeenCalledTimes(2);
		const rows = mocks.log.mock.calls.map(([row]) => row);
		expect(rows.map(row => row.metadata.providerRequestId)).toEqual(['initial', 'repair']);
		expect(rows[0]).toMatchObject({ status: 'error', metadata: { extractionAttempt: 1, parseOutcome: 'error', applyOutcome: 'not_started', repairPlanned: true } });
		expect(rows[1]).toMatchObject({ status: 'success', metadata: { extractionAttempt: 2, parseOutcome: 'valid', applyOutcome: 'no_changes' } });
		expect(rows.map(row => row.requestTokens)).toEqual([200, 200]);
	});

	it('persists transport receipts before repair and updates their same identities after validation', async () => {
		const saved = new Map<string, Record<string, unknown>>();
		mocks.log.mockImplementation(async (row, options) => { saved.set(options.id, row); return row; });
		mocks.generate.mockImplementationOnce(async options => {
			const result = generation('invalid JSON', 'initial', 0.02);
			await options.onAttempt(result.attempts![0]);
			expect(saved.has('attempt-initial')).toBe(true);
			return result;
		}).mockImplementationOnce(async options => {
			expect(saved.get('attempt-initial')).toMatchObject({ status: 'error', metadata: { parseOutcome: 'error' } });
			const result = generation('{"update":{}}', 'repair', 0.03);
			await options.onAttempt(result.attempts![0]);
			return result;
		});
		await expect(extractTurnState(job)).resolves.toMatchObject({ status: 'no_changes' });
		expect(mocks.log).toHaveBeenCalledTimes(4);
		expect(saved.size).toBe(2);
		expect([...saved.values()].map(row => (row.metadata as Record<string, unknown>).providerCostUsd)).toEqual([0.02, 0.03]);
		expect(saved.get('attempt-repair')).toMatchObject({ status: 'success', metadata: { parseOutcome: 'valid' } });
	});

	it('records the repair failure itself without reusing the first receipt', async () => {
		const failed = generation('', 'repair-error', 0.004);
		failed.attempts![0].status = 'error';
		failed.attempts![0].statusCode = 502;
		mocks.generate.mockResolvedValueOnce(generation('invalid JSON', 'initial', 0.02))
			.mockRejectedValueOnce(new ServerGenerationError('Provider request failed', { ...failed, statusCode: 502 }));
		await expect(extractTurnState(job)).rejects.toThrow('Provider request failed');
		expect(mocks.log).toHaveBeenCalledTimes(2);
		expect(mocks.log.mock.calls.map(([row]) => row.metadata.providerRequestId)).toEqual(['initial', 'repair-error']);
	});

	it('does not invent or duplicate a billable receipt when repair fails before dispatch', async () => {
		mocks.generate.mockResolvedValueOnce(generation('invalid JSON', 'initial', 0.02))
			.mockRejectedValueOnce(new Error('Missing provider configuration'));
		await expect(extractTurnState(job)).rejects.toThrow('Missing provider configuration');
		expect(mocks.log).toHaveBeenCalledTimes(1);
	});

	it.each([2, 4])('retains paid result when sources change on validation %i', async invalidation => {
		invalidateAt = invalidation;
		mocks.generate.mockResolvedValueOnce(generation('invalid JSON', 'initial', 0.02))
			.mockResolvedValueOnce(generation('{"update":{}}', 'repair', 0.03));
		await expect(extractTurnState(job)).resolves.toMatchObject({ status: 'skipped_source_invalid' });
		expect(mocks.log).toHaveBeenCalledTimes(invalidation === 2 ? 1 : 2);
		expect(mocks.log.mock.lastCall?.[0]).toMatchObject({ metadata: { applyOutcome: 'skipped_source_invalid' } });
	});

	it('retains both receipts when repair output also fails validation', async () => {
		mocks.generate.mockResolvedValueOnce(generation('invalid JSON', 'initial', 0.02))
			.mockResolvedValueOnce(generation('still invalid JSON', 'repair', 0.03));
		await expect(extractTurnState(job)).rejects.toThrow();
		expect(mocks.log).toHaveBeenCalledTimes(2);
		expect(mocks.log.mock.lastCall?.[0]).toMatchObject({ status: 'error', metadata: { extractionAttempt: 2, parseOutcome: 'error' } });
	});

	it('does not bill per-job applications of an already logged batch result again', async () => {
		const reused = reuseGenerationResult(generation('{"update":{}}', 'batch', 0.07), { operation: 'job.extract_turn_state.batch' });
		await expect(extractTurnState(job, undefined, reused)).resolves.toMatchObject({ status: 'no_changes' });
		expect(mocks.generate).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});
});
