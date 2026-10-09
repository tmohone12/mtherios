import { describe, expect, it, vi } from 'vitest';
import { executeEngineCommand } from './command';

describe('job recovery command gateway', () => {
	it('passes validated story scope and observed version to the existing jobs service', async () => {
		const retryJob = vi.fn().mockResolvedValue({ jobId: 'job_1', status: 'retry' });
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.retry', args: { jobId: 'job_1', expectedUpdatedAt: '2026-09-05 21:00:00.123456+00' } }, { retryJob });
		expect(response.status).toBe('succeeded');
		expect(retryJob).toHaveBeenCalledExactlyOnceWith({ storyId: 'story_1', jobId: 'job_1', expectedUpdatedAt: '2026-09-05 21:00:00.123456+00' });
		expect(response.projectionChanges).toEqual({ jobs: { retry: { jobId: 'job_1', status: 'retry' } } });
	});

	it('rejects a missing or malformed observed version before retrying', async () => {
		const retryJob = vi.fn();
		for (const expectedUpdatedAt of [undefined, 'not a timestamp']) {
			const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.retry', args: { jobId: 'job_1', expectedUpdatedAt } }, { retryJob });
			expect(response.status).toBe('failed');
		}
		expect(retryJob).not.toHaveBeenCalled();
	});

	it('passes a failed-status filter to the database listing, not a client-side page filter', async () => {
		const listJobs = vi.fn().mockResolvedValue({ jobs: [], stats: {} });
		await executeEngineCommand({ storyId: 'story_1', command: 'jobs.status', args: { status: 'failed' } }, { listJobs });
		expect(listJobs).toHaveBeenCalledExactlyOnceWith({ storyId: 'story_1', limit: 80, allStories: false, status: 'failed' });
	});

	it('routes one-source memory recovery through the scoped gateway', async () => {
		const recoverMemory = vi.fn().mockResolvedValue({ ok: true, storyId: 'story_1', queued: [{ assistantEntryId: 'narration_1' }] });
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'jobs.recoverMemory', args: { limit: 1 } }, { recoverMemory });

		expect(response.status).toBe('succeeded');
		expect(recoverMemory).toHaveBeenCalledExactlyOnceWith({ storyId: 'story_1', limit: 1 });
		expect(response.projectionChanges).toEqual({ jobs: { recoverMemory: { ok: true, storyId: 'story_1', queued: [{ assistantEntryId: 'narration_1' }] } } });
	});
});
