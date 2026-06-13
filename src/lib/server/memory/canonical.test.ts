import { describe, expect, it } from 'vitest';
import type { SyncOperation } from '$lib/contracts/memory';
import { assertSyncOpReplayMatches, normalizeBootstrapOptions } from './canonical';

const baseOp: SyncOperation = {
	id: 'op_replay_1',
	storyId: 'story_1',
	type: 'turn_command',
	clientVersion: 4,
	clientCreatedAt: '2026-05-31T00:00:00.000Z',
	payload: {
		clientTurnId: 'turn_1',
		playerText: 'Open the postern gate.',
		entryId: 'entry_1',
		position: 7,
		clientContext: {
			scene: 'inner keep',
			flags: ['night', 'alarm'],
		},
	},
};

describe('sync operation replay guard', () => {
	it('allows exact replays even when JSON object keys arrive in a different order', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 4,
			payload: {
				position: 7,
				entryId: 'entry_1',
				playerText: 'Open the postern gate.',
				clientContext: {
					flags: ['night', 'alarm'],
					scene: 'inner keep',
				},
				clientTurnId: 'turn_1',
			},
		})).not.toThrow();
	});

	it('rejects reused sync op IDs that point at different command content', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 4,
			payload: {
				...baseOp.payload,
				playerText: 'Open the river gate instead.',
			},
		})).toThrow('Sync operation id collision');
	});

	it('rejects reused sync op IDs that drift across story, type, or client version', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_2',
			type: 'turn_command',
			clientVersion: 4,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');

		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'state_correction',
			clientVersion: 4,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');

		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 5,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');
	});
});

describe('backend bootstrap projection limits', () => {
	it('defaults to bounded control-surface slices instead of broad history/world loads', () => {
		expect(normalizeBootstrapOptions()).toEqual({
			entryLimit: 80,
			entityLimit: 120,
			relationshipLimit: 200,
			factionLimit: 80,
			factionMembershipLimit: 160,
			factionResourceLimit: 160,
			factionGoalLimit: 160,
			factionProjectLimit: 160,
			agreementLimit: 80,
			npcBeliefLimit: 80,
			threadLimit: 80,
			chapterLimit: 80,
			arcLimit: 80,
			sagaLimit: 40,
			eventLimit: 80,
			patchLimit: 80,
			memoryNodeLimit: 80,
		});
	});

	it('clamps bootstrap limits so a control surface cannot request a giant campaign blob', () => {
		expect(normalizeBootstrapOptions({
			entryLimit: 10000,
			entityLimit: 9999,
			memoryNodeLimit: 9999,
			npcBeliefLimit: -5,
			sagaLimit: 0,
		})).toEqual(expect.objectContaining({
			entryLimit: 200,
			entityLimit: 200,
			memoryNodeLimit: 200,
			npcBeliefLimit: 0,
			sagaLimit: 0,
		}));
	});
});
