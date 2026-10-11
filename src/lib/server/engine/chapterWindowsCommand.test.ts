import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), reconcile: vi.fn(), enqueue: vi.fn() }));
vi.mock('$lib/server/jobs/chapterWindows', () => ({ chapterWindowStatus: mocks.status, reconcileChapterWindow: mocks.reconcile }));
vi.mock('$lib/server/jobs/outbox', async original => ({ ...await original<typeof import('$lib/server/jobs/outbox')>(), enqueueChapterSummaryJob: mocks.enqueue }));

import { executeEngineCommand } from './command';

beforeEach(() => vi.clearAllMocks());

describe('chapter window commands', () => {
	it('reports chapter progress for the scoped story without writes', async () => {
		mocks.status.mockResolvedValue({ storyId: 'story_1', chapters: 2 });
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'chapters.windows.status', args: {} });
		expect(response).toMatchObject({ status: 'succeeded', result: { chapters: 2 } });
		expect(mocks.status).toHaveBeenCalledExactlyOnceWith('story_1');
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});

	it('requires a named reviewer and an explicit decision, then schedules one chapter check', async () => {
		const missing = await executeEngineCommand({ storyId: 'story_1', command: 'chapters.windows.reconcile', args: { windowId: 'w', revision: 1, decision: 'redispatch' } });
		expect(missing.status).toBe('failed');
		expect(mocks.reconcile).not.toHaveBeenCalled();
		mocks.reconcile.mockResolvedValue({ attempt: { state: 'ready' }, releasedCheckpoints: 1 });
		const response = await executeEngineCommand({ storyId: 'story_1', command: 'chapters.windows.reconcile',
			args: { windowId: 'w', revision: 1, decision: 'redispatch', reviewedBy: 'Operator' } });
		expect(response).toMatchObject({ status: 'succeeded', result: { releasedCheckpoints: 1 } });
		expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith({ storyId: 'story_1', windowId: 'w', revision: 1, decision: 'redispatch', reviewedBy: 'Operator' });
		expect(mocks.enqueue).toHaveBeenCalledOnce();
	});
});
