import { describe, expect, it } from 'vitest';
import type { SyncOperation } from '$lib/contracts/memory';
import { assertSyncOpReplayMatches } from './canonical';

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
