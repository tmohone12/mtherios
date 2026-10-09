import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeEngineCommand } from './command';
import { rebuildSummariesCommand } from './serviceCommands';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { SUMMARY_REBUILD_GENERATION_POLICY } from '$lib/contracts/engine';

vi.mock('$lib/server/jobs/outbox', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/server/jobs/outbox')>(),
	enqueueBackendJob: vi.fn().mockResolvedValue('job_rebuild'),
}));

describe('historical summary rebuild command', () => {
	beforeEach(() => vi.clearAllMocks());

	it('defaults to a queued preview and reports queueing without claiming completion', async () => {
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.rebuildSummaries', args: {} });
		expect(response.status).toBe('succeeded');
		expect(response.result).toEqual({ ok: true, storyId: 'story_1', jobId: 'job_rebuild', status: 'queued', dryRun: true });
		expect(enqueueBackendJob).toHaveBeenCalledExactlyOnceWith({
			storyId: 'story_1',
			type: 'rebuild_summaries',
			payload: { dryRun: true, requestedAt: expect.any(String) },
			metadata: { source: 'manual_summary_rebuild', requestedAt: expect.any(String), summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY },
			maxAttempts: 1,
		});
	});

	it('passes a requested source job to the same policy-stamped rebuild worker', async () => {
		await executeEngineCommand({ storyId: 'story_1', command: 'jobs.rebuildSummaries', args: { dryRun: false, resumeJobId: 'previous_failed_job' } });
		expect(enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({
			payload: { dryRun: false, resumeJobId: 'previous_failed_job', requestedAt: expect.any(String) },
			metadata: expect.objectContaining({ summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY }),
		}));
	});

	it('passes an explicit rebuild to the same projection job with no advancement jobs', async () => {
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.rebuildSummaries', args: { dryRun: false } });
		expect(enqueueBackendJob).toHaveBeenCalledTimes(1);
		expect(enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({ type: 'rebuild_summaries', payload: { dryRun: false, requestedAt: expect.any(String) } }));
		expect(response.projectionChanges).toEqual({ jobs: { rebuildSummaries: response.result } });
	});

	it('rejects invalid controls and missing story scope before queueing', async () => {
		for (const args of [{ dryRun: 'false' }, { dryRun: false, advanceWorld: true }, { allStories: true }, { resumeJobId: '' }]) {
			const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.rebuildSummaries', args });
			expect(response.status).toBe('failed');
		}
		await expect(rebuildSummariesCommand({ dryRun: false })).rejects.toThrow('storyId is required.');
		expect(enqueueBackendJob).not.toHaveBeenCalled();
	});
});
