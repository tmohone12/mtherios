import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchBackendEntriesAround,
	previewBackendTurn,
	processBackendTurn,
	pullBackendChanges,
	retrieveBackendMemory,
	runBackendPlotBrainPlan,
	runBackendWorldSimTick,
	TerminalRequestError,
} from './backendMemory';
import type { Story } from '$lib/types';

const turnRequest = {
	storyId: 'story_alpha',
	clientTurnId: 'turn_1',
	playerText: 'I open the silver gate.',
	actionType: 'do' as const,
	localVersion: 12,
	clientContext: {
		presentNpcIds: ['npc_mira'],
		sceneEntityIds: ['npc_mira', 'location_gate'],
		threadIds: [],
		deferStateExtraction: true,
	},
};

const turnResult = {
	narration: 'The silver gate opens.',
	entries: [{ id: 'entry_1', type: 'narration', content: 'The silver gate opens.' }],
	playerEntryId: 'entry_player',
	assistantEntryId: 'entry_1',
	statePatchIds: ['patch_1'],
	eventIds: ['event_1'],
	retrievedMemoryIds: ['memory_1'],
	memoryNodeIds: [],
	serverVersion: 13,
	syncChanges: [],
	warnings: [],
	generationTimings: [],
	performance: null,
	contextReceipt: null,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('backend memory turn client', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('routes turn submissions through the streaming turn endpoint', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'turn_1',
			clientCommandId: 'turn_1',
			storyId: 'story_alpha',
			command: 'turn.submit',
			status: 'succeeded',
			result: turnResult,
			projectionChanges: { entries: turnResult.entries, serverVersion: 13 },
			error: null,
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		const result = await processBackendTurn(turnRequest);

		expect(result).toEqual(turnResult);
		expect(fetchMock).toHaveBeenCalledWith('/api/turn/stream', expect.objectContaining({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		}));
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload).toEqual(turnRequest);
	});

	it('routes context preview through the read-only engine command', async () => {
		const preview = {
			inspection: true,
			storyId: 'story_alpha',
			clientTurnId: 'preview_1',
			preparedAt: '2026-09-06T00:00:00.000Z',
			preparationMs: 12,
			draftFingerprint: 'draft_hash',
			settingsFingerprint: 'settings_hash',
			model: { id: 'test-model', providerType: 'openai', capacityTokens: 128000, capacitySource: 'model-window-registry-or-default' },
			prompt: { systemChars: 10, systemDynamicChars: 20, playerPromptChars: 8, messageCount: 1, messageChars: 12, totalChars: 50, tokenEstimate: 13 },
			budgets: { contextTokens: 12000, recentDialogueTokens: 12000, memoryTokens: 1200 },
			selection: { version: 1, groups: [], sections: [] },
			sourceReferences: [],
			warnings: [],
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'preview_1', clientCommandId: 'preview_1', storyId: 'story_alpha', command: 'turn.preview', status: 'succeeded', result: preview, projectionChanges: {}, error: null,
			createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
		}));

		await expect(previewBackendTurn({ ...turnRequest, clientTurnId: 'preview_1' })).resolves.toEqual(preview);
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload.command).toBe('turn.preview');
		expect(payload.args).toEqual(expect.objectContaining({ clientTurnId: 'preview_1', playerText: turnRequest.playerText }));
	});

	it('opens bounded transcript evidence through the existing engine read command', async () => {
		const around = { storyId: 'story_alpha', position: 42, entries: [{ id: 'entry_42', position: 42, content: 'The harbor bell rings.' }] };
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'around_1', clientCommandId: null, storyId: 'story_alpha', command: 'campaign.entriesAround', status: 'succeeded', result: around, projectionChanges: {}, error: null,
			createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
		}));

		await expect(fetchBackendEntriesAround('story_alpha', 42, 2)).resolves.toEqual(around);
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload).toEqual({ storyId: 'story_alpha', command: 'campaign.entriesAround', args: { position: 42, radius: 2 } });
	});

	it('surfaces failed engine command turn submissions as terminal request errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'turn_1',
			clientCommandId: 'turn_1',
			storyId: 'story_alpha',
			command: 'turn.submit',
			status: 'failed',
			result: null,
			projectionChanges: {},
			error: 'Model service unavailable.',
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		await expect(processBackendTurn(turnRequest)).rejects.toMatchObject({
			name: 'TerminalRequestError',
			message: 'Model service unavailable.',
			code: 'ENGINE_COMMAND_FAILED',
		} satisfies Partial<TerminalRequestError>);
	});

	it('routes memory retrieval through the shared engine command gateway', async () => {
		const memoryResult = {
			storyId: 'story_alpha',
			query: 'silver gate',
			packet: 'Mira remembers the silver gate.',
			nodes: [],
			tokenEstimate: 12,
			retrievalDebug: [],
			retrievalTrace: [],
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'cmd_memory',
			clientCommandId: null,
			storyId: 'story_alpha',
			command: 'memory.retrieve',
			status: 'succeeded',
			result: memoryResult,
			projectionChanges: { memory: { nodeCount: 0, tokenEstimate: 12 } },
			error: null,
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		const result = await retrieveBackendMemory({
			storyId: 'story_alpha',
			query: 'silver gate',
			sceneEntityIds: [],
			presentNpcIds: [],
			threadIds: [],
			includeSecret: false,
			tokenBudget: 420,
		});

		expect(result).toEqual(memoryResult);
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({ method: 'POST' }));
		expect(payload).toEqual({
			storyId: 'story_alpha',
			command: 'memory.retrieve',
			args: expect.objectContaining({
				storyId: 'story_alpha',
				query: 'silver gate',
				tokenBudget: 420,
			}),
		});
	});

	it('routes sync pulls through the shared engine command gateway', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'cmd_pull',
			clientCommandId: null,
			storyId: 'story_alpha',
			command: 'sync.pull',
			status: 'succeeded',
			result: {
				storyId: 'story_alpha',
				serverVersion: 14,
				changes: [{ table: 'story_entries', id: 'entry_1', version: 14, op: 'upsert', row: { id: 'entry_1' } }],
			},
			projectionChanges: { sync: { serverVersion: 14, changeCount: 1 } },
			error: null,
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		const result = await pullBackendChanges({
			id: 'local_story',
			serverStoryId: 'story_alpha',
			serverVersion: 12,
		} as Story);

		expect(result).toEqual({
			serverVersion: 14,
			changes: [{ table: 'story_entries', id: 'entry_1', version: 14, op: 'upsert', row: { id: 'entry_1' } }],
		});
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload).toEqual({
			storyId: 'story_alpha',
			command: 'sync.pull',
			args: {
				since: 12,
			},
		});
	});

	it('routes world-sim ticks through the shared engine command gateway', async () => {
		const jobResult = { ok: true, storyId: 'story_alpha', jobId: 'job_1' };
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'cmd_world_sim',
			clientCommandId: null,
			storyId: 'story_alpha',
			command: 'jobs.worldSim',
			status: 'succeeded',
			result: jobResult,
			projectionChanges: { jobs: { worldSim: jobResult } },
			error: null,
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		const result = await runBackendWorldSimTick({
			id: 'local_story',
			serverStoryId: 'story_alpha',
			serverVersion: 12,
		} as Story);

		expect(result).toEqual(jobResult);
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload).toEqual({
			storyId: 'story_alpha',
			command: 'jobs.worldSim',
			args: {
				localVersion: 12,
				force: true,
			},
		});
	});

	it('routes strategic plot-brain planning through the shared engine command gateway', async () => {
		const planResult = { ok: true, storyId: 'story_alpha', frameId: 'frame_1', plotCardCount: 2 };
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'cmd_plot_brain',
			clientCommandId: null,
			storyId: 'story_alpha',
			command: 'plotBrain.plan',
			status: 'succeeded',
			result: planResult,
			projectionChanges: { plotBrain: { ok: true, storyId: 'story_alpha', frameId: 'frame_1', plotCardCount: 2 } },
			error: null,
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		const result = await runBackendPlotBrainPlan({
			id: 'local_story',
			serverStoryId: 'story_alpha',
			serverVersion: 12,
		} as Story, {
			trigger: 'manual',
			execute: true,
			currentTurn: 17,
			currentWorldTime: 'Day 12, midnight',
		});

		expect(result).toEqual(planResult);
		const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(payload).toEqual({
			storyId: 'story_alpha',
			command: 'plotBrain.plan',
			args: {
				trigger: 'manual',
				execute: true,
				currentTurn: 17,
				currentWorldTime: 'Day 12, midnight',
				includeSecret: true,
			},
		});
	});
});
