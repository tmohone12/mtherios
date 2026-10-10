import { describe, expect, it, vi } from 'vitest';

// @ts-ignore The CLI helper is a plain ESM script module exercised through Vitest.
const {
	buildStoryBootstrapCommandRequest,
	buildStoryEntriesCommandRequest,
	buildStoryMemoryCommandRequest,
	buildStoryTurnCommandRequest,
	unwrapEngineTurnCommand,
} = await import('../../../../scripts/app-story-core.mjs') as {
	buildStoryBootstrapCommandRequest: (bootstrapArgs: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildStoryEntriesCommandRequest: (entriesArgs: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildStoryMemoryCommandRequest: (memoryArgs: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildStoryTurnCommandRequest: (turnArgs: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	unwrapEngineTurnCommand: (payload: unknown) => Record<string, unknown>;
};

describe('app-story CLI turn command', () => {
	it('prints a pending question and does not refresh the wiki before the turn completes', async () => {
		// @ts-ignore CLI modules intentionally remain plain JavaScript.
		const { runTurn, printTurn } = await import('../../../../scripts/app-story.mjs');
		const pending = { status: 'awaiting_input', runId: 'run_cli', interactions: [{ id: 'question_cli', revision: 1, prompt: 'Cross the bridge?', options: [{ id: 'yes', label: 'Cross' }] }] };
		const request = vi.fn(async () => ({ status: 'succeeded', result: pending }));
		const result = await runTurn('http://fixture.invalid', { story: 'story_alpha', clientTurnId: 'turn_cli', text: 'Inspect the bridge.', wiki: true }, [], request);
		expect(result).toEqual(pending);
		expect(request).toHaveBeenCalledOnce();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			printTurn(result, false);
			expect(log.mock.calls.flat().join('\n')).toContain('Turn awaiting_input: run_cli');
			expect(log.mock.calls.flat().join('\n')).toContain('Cross the bridge?');
			expect(log.mock.calls.flat().join('\n')).not.toContain('Terminal turn complete');
		} finally { log.mockRestore(); }
	});
	it('routes shell bootstrap reads through the shared engine command gateway', () => {
		const request = buildStoryBootstrapCommandRequest({
			storyId: 'story_alpha',
			entryLimit: 40,
			entityLimit: 50,
			memoryNodeLimit: 20,
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'campaign.bootstrap',
				args: {
					entryLimit: 40,
					entityLimit: 50,
					memoryNodeLimit: 20,
				},
			},
		});
	});

	it('routes shell transcript pages through the shared engine command gateway', () => {
		const request = buildStoryEntriesCommandRequest({
			storyId: 'story_alpha',
			beforePosition: 120,
			limit: 40,
			branchId: 'main',
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'campaign.transcriptPage',
				args: {
					beforePosition: 120,
					limit: 40,
					branchId: 'main',
				},
			},
		});
	});

	it('routes shell memory retrieval through the shared engine command gateway', () => {
		const request = buildStoryMemoryCommandRequest({
			storyId: 'story_alpha',
			query: 'silver gate',
			sceneEntityIds: ['npc_gatekeeper'],
			presentNpcIds: ['npc_gatekeeper'],
			threadIds: ['thread_gate'],
			includeSecret: true,
			tokenBudget: 420,
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'memory.retrieve',
				args: {
					storyId: 'story_alpha',
					query: 'silver gate',
					sceneEntityIds: ['npc_gatekeeper'],
					presentNpcIds: ['npc_gatekeeper'],
					threadIds: ['thread_gate'],
					includeSecret: true,
					tokenBudget: 420,
				},
			},
		});
	});

	it('routes shell turn commands through the shared engine command gateway', async () => {
		const request = buildStoryTurnCommandRequest({
			storyId: 'story_alpha',
			clientTurnId: 'turn_cli_1',
			playerText: 'I knock on the old gate.',
			localVersion: 9,
			generation: {
				temperature: 1,
				maxTokens: 4096,
			},
			clientContext: {
				sceneEntityIds: ['npc_gatekeeper', 'location_gate'],
				presentNpcIds: ['npc_gatekeeper'],
				threadIds: ['thread_gate'],
			},
		});

		expect(unwrapEngineTurnCommand({
				commandId: 'turn_cli_1',
				clientCommandId: 'turn_cli_1',
				storyId: 'story_alpha',
				command: 'turn.submit',
				status: 'succeeded',
				result: {
					narration: 'The gate opens.',
					serverVersion: 10,
				},
				projectionChanges: {},
				error: null,
			})).toEqual({
			narration: 'The gate opens.',
			serverVersion: 10,
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'turn.submit',
				clientCommandId: 'turn_cli_1',
				args: {
					storyId: 'story_alpha',
					clientTurnId: 'turn_cli_1',
					playerText: 'I knock on the old gate.',
					localVersion: 9,
					generation: {
						temperature: 1,
						maxTokens: 4096,
					},
					clientContext: {
						sceneEntityIds: ['npc_gatekeeper', 'location_gate'],
						presentNpcIds: ['npc_gatekeeper'],
						threadIds: ['thread_gate'],
					},
				},
			},
		});
	});
});
