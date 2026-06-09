import { describe, expect, it } from 'vitest';
import { backendJobTypes, continuityAuditDedupeKey, turnStateExtractionDedupeKey } from './outbox';
import { backendJobStatusEventData, isSupersededJobFailure, storyVaultFollowupVersion } from './processor';

describe('turn state extraction jobs', () => {
	it('exposes a stable background job type and dedupe key', () => {
		expect(backendJobTypes).toContain('extract_turn_state');
		expect(turnStateExtractionDedupeKey({ assistantEntryId: 'entry_assistant' })).toBe('turn-state-entry_assistant');
	});
});

describe('continuity audit jobs', () => {
	it('exposes a stable background job type and dedupe key', () => {
		expect(backendJobTypes).toContain('continuity_audit');
		expect(continuityAuditDedupeKey({ assistantEntryId: 'entry_assistant' })).toBe('continuity-audit-entry_assistant');
	});
});

describe('story vault sync catch-up', () => {
	it('queues the current backend version when the manifest trails canon', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 101,
			manifestVersion: 100,
		})).toBe(101);
	});

	it('queues a follow-up when no manifest exists yet', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 7,
			manifestVersion: null,
		})).toBe(7);
	});

	it('does not queue when the manifest is current or newer', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 12,
		})).toBeNull();
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 13,
		})).toBeNull();
	});
});

describe('job status summaries', () => {
	it('treats an older failed job as superseded by a newer complete job in the same story/type family', () => {
		const latestCompletedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedAt)).toBe(true);
	});

	it('does not supersede newer failures or failures from another job family', () => {
		const latestCompletedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T21:00:00.000Z',
		}, latestCompletedAt)).toBe(false);
		expect(isSupersededJobFailure({
			storyId: 'story_2',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedAt)).toBe(false);
	});
});

describe('job status stream events', () => {
	it('builds a compact job status payload for the control-surface stream', () => {
		expect(backendJobStatusEventData({
			id: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			attemptCount: 2,
			maxAttempts: 3,
		}, 'completed', {
			result: { status: 'applied', patchIds: ['patch_1'] },
		})).toEqual({
			jobId: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			status: 'completed',
			attemptCount: 2,
			maxAttempts: 3,
			result: { status: 'applied', patchIds: ['patch_1'] },
		});
	});
});
