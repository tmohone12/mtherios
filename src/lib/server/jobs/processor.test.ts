import { describe, expect, it } from 'vitest';
import { backendJobTypes, continuityAuditDedupeKey, shouldQueueTurnStoryVaultSync, turnStateExtractionDedupeKey } from './outbox';
import { backendJobStatusEventData, buildChapterSummary, isSupersededJobFailure, storyVaultFollowupVersion, summarizeBackendJobs } from './processor';

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

describe('turn story vault sync cadence', () => {
	it('does not queue generated wiki sync on every turn by default', () => {
		expect(shouldQueueTurnStoryVaultSync(11, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(12, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(15, 5)).toBe(true);
	});

	it('can disable automatic turn wiki sync', () => {
		expect(shouldQueueTurnStoryVaultSync(20, 0)).toBe(false);
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

	it('does not count superseded failures as active startup failures', () => {
		const rows = [
			{
				id: 'job_old_failed',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'failed',
				attemptCount: 3,
				maxAttempts: 3,
				runAfter: '2026-06-05T19:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: 'Missing column before migration.',
				createdAt: '2026-06-05T18:59:00.000Z',
				updatedAt: '2026-06-05T19:00:00.000Z',
			},
			{
				id: 'job_new_complete',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'complete',
				attemptCount: 1,
				maxAttempts: 3,
				runAfter: '2026-06-05T20:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: null,
				createdAt: '2026-06-05T20:00:00.000Z',
				updatedAt: '2026-06-05T20:10:00.000Z',
			},
		];

		expect(summarizeBackendJobs(rows).failed).toBe(0);
		expect(summarizeBackendJobs(rows).failedByType).toEqual({});
		expect(summarizeBackendJobs(rows).recentFailures).toEqual([]);
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

describe('deterministic chapter summaries', () => {
	it('writes a clean Mtherios rollup instead of nested raw transcript dumps', () => {
		const entries = [
			{
				id: 'entry_62',
				type: 'user_action',
				content: '> I say, "Yes, Aelyx’s younger better-looking brother."',
				position: 62,
			},
			{
				id: 'entry_63',
				type: 'narration',
				content: '[ 🕰️ Time 15:30 | 🗓️ Day 3, Seventh Moon, 295 AC | 📍 Location The Black Walls - Fountain of the First Flame | 🌤️ Weather Sweltering, 34°C ] Aerene teases Aurion while Serala watches from the fountain.',
				position: 63,
			},
			{
				id: 'entry_64',
				type: 'user_action',
				content: '> I ask, "Dragonlord blood?"',
				position: 64,
			},
			{
				id: 'entry_65',
				type: 'narration',
				content: '[ 🕰️ Time 15:31 | 🗓️ Day 3, Seventh Moon, 295 AC | 📍 Location The Black Walls - Fountain of the First Flame | 🌤️ Weather Sweltering, 34°C ] Serala explains that House Balaerys is still remembered for dragonlord blood and relics.',
				position: 65,
			},
		] as any[];
		const events = [
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[1].content,
				actorEntityIds: ['npc_serala'],
			},
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[3].content,
				actorEntityIds: ['npc_serala'],
			},
		] as any[];

		const summary = buildChapterSummary(entries, events);

		expect(summary).toContain('[BEGINNING= Terminal checkpoint covering transcript positions 62-65.');
		expect(summary).toContain('[RECENT=');
		expect(summary).toContain('- Player: says, "Yes, Aelyx’s younger better-looking brother."');
		expect(summary).toContain('- Narrator: Serala explains that House Balaerys is still remembered for dragonlord blood and relics.');
		expect(summary).not.toContain('- - Turn resolved');
		expect(summary).not.toContain('Transcript trace:');
		expect(summary).not.toContain('not established by deterministic terminal checkpoint');
		expect(summary).not.toContain('🕰️');
	});
});
