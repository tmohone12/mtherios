import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
	const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
	const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
	const values = vi.fn(() => ({ onConflictDoNothing, onConflictDoUpdate }));
	return {
		insert: vi.fn(() => ({ values })),
		onConflictDoNothing,
		onConflictDoUpdate,
		values,
	};
});

vi.mock('$lib/server/db/client', () => ({ getDb: () => db }));

import { enqueueBackendJob, enqueuePlotBrainJob } from './outbox';

describe('job enqueue conflicts', () => {
	beforeEach(() => vi.clearAllMocks());

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

	it('keeps the existing requeue behavior for other deduplicated jobs', async () => {
		await enqueueBackendJob({
			storyId: 'story_1',
			type: 'continuity_audit',
			dedupeKey: 'continuity-entry_1',
		});

		expect(db.onConflictDoUpdate).toHaveBeenCalledOnce();
		expect(db.onConflictDoNothing).not.toHaveBeenCalled();
	});
});
