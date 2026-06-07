import { describe, expect, it } from 'vitest';
import { buildTurnSubmitCommandRequest, executeTurnSubmitCommand } from './turnFacade';
import type { TurnRequest, TurnResponse } from '$lib/contracts/memory';

const turnRequest: TurnRequest = {
	storyId: 'story_alpha',
	clientTurnId: 'legacy_turn_1',
	playerText: 'I ask who moved before dawn.',
	localVersion: 12,
	clientContext: {
		presentNpcIds: ['npc_mira'],
		sceneEntityIds: ['npc_mira', 'location_hall'],
		threadIds: [],
		deferStateExtraction: true,
	},
	generation: {
		temperature: 0.9,
		maxTokens: 2048,
	},
};

const turnResponse: TurnResponse = {
	narration: 'Mira names the harbor envoy.',
	entries: [],
	playerEntryId: 'entry_player',
	assistantEntryId: 'entry_assistant',
	statePatchIds: ['patch_1'],
	eventIds: ['event_1'],
	retrievedMemoryIds: ['memory_1'],
	memoryNodeIds: ['memory_1'],
	serverVersion: 13,
	syncChanges: [],
	warnings: [],
	generationTimings: [],
};

describe('legacy turn engine facade', () => {
	it('builds a turn.submit command envelope from a legacy turn request', () => {
		expect(buildTurnSubmitCommandRequest(turnRequest)).toEqual({
			storyId: 'story_alpha',
			command: 'turn.submit',
			clientCommandId: 'legacy_turn_1',
			args: turnRequest,
		});
	});

	it('executes legacy turn requests through the engine command handler', async () => {
		const submittedInputs: unknown[] = [];
		const result = await executeTurnSubmitCommand(turnRequest, {
			submitTurn: async (input) => {
				submittedInputs.push(input);
				return turnResponse;
			},
		});

		expect(result).toEqual(turnResponse);
		expect(submittedInputs).toEqual([
			expect.objectContaining({
				storyId: 'story_alpha',
				clientTurnId: 'legacy_turn_1',
				playerText: 'I ask who moved before dawn.',
				clientContext: expect.objectContaining({
					presentNpcIds: ['npc_mira'],
					deferStateExtraction: true,
				}),
			}),
		]);
	});
});
