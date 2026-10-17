import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchBackendEntriesAround,
	listBackendWorldChronicle,
	previewBackendTurn,
	pullBackendChanges,
	reviewBackendWorldChronicle,
	runBackendPlotBrainPlan,
	runBackendWorldChronicle,
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

	it('surfaces failed engine commands as terminal request errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			commandId: 'turn_1',
			clientCommandId: 'turn_1',
			storyId: 'story_alpha',
			command: 'turn.preview',
			status: 'failed',
			result: null,
			projectionChanges: {},
			error: 'Model service unavailable.',
			createdAt: '2026-06-05T12:00:00.000Z',
			updatedAt: '2026-06-05T12:00:01.000Z',
		}));

		await expect(previewBackendTurn(turnRequest)).rejects.toMatchObject({
			name: 'TerminalRequestError',
			message: 'Model service unavailable.',
			code: 'ENGINE_COMMAND_FAILED',
		} satisfies Partial<TerminalRequestError>);
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

	it('routes World Chronicle advance, list and review through the shared engine command gateway', async () => {
		const envelope = (command: string, result: unknown) => jsonResponse({ commandId: `cmd_${command}`, clientCommandId: null, storyId: 'story_alpha', command,
			status: 'succeeded', result, projectionChanges: {}, error: null, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:01.000Z' });
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(envelope('world.chronicle.advance', { ok: true, jobId: 'job_chronicle', status: 'complete',
				job: { completed: true, result: { created: 3, proposed: 2, autoAccepted: 1, skippedDuplicates: 1, dropped: [{ title: 'x', reason: 'y' }],
					clockAdvancedMinutes: 10080, clockAdvancedDays: 7, clockLabel: 'Day 11 | 09:00' } } }))
			.mockResolvedValueOnce(envelope('world.chronicle.advance', { ok: false, jobId: 'job_chronicle', status: 'failed', error: 'Model configuration needed: World planning has no model profile.' }))
			.mockResolvedValueOnce(envelope('world.chronicle.list', { events: [{ id: 'wh_1', status: 'proposed', type: 'world_happening', title: 'Tolls rise', body: 'The guild raised tolls.',
				visibility: 'player_known', worldTime: 'Day 9', createdAt: '2026-10-16 12:00:00+00', metadata: { stakes: 'medium' } }], settings: { eventfulness: 'quiet', creativity: 'wild' }, currentWorldTime: 'Day 11' }))
			.mockResolvedValueOnce(envelope('world.chronicle.review', { changed: true, event: { id: 'wh_1', status: 'committed' }, serverVersion: 12 }));

		expect(await runBackendWorldChronicle('story_alpha', { span: 'week', eventfulness: 'turbulent', creativity: 'grounded' })).toEqual({
			jobId: 'job_chronicle', status: 'complete', created: 3, proposed: 2, autoAccepted: 1, skippedDuplicates: 1, dropped: 1,
			clockAdvancedMinutes: 10080, clockAdvancedDays: 7, clockLabel: 'Day 11 | 09:00', clockReason: null, alreadyComplete: false, error: null });
		expect(await runBackendWorldChronicle('story_alpha', { span: 'day' })).toMatchObject({ status: 'failed', error: 'Model configuration needed: World planning has no model profile.' });
		expect(await listBackendWorldChronicle('story_alpha')).toMatchObject({ settings: { eventfulness: 'quiet', creativity: 'wild' }, events: [{ id: 'wh_1', status: 'proposed' }] });
		expect(await reviewBackendWorldChronicle('story_alpha', { eventId: 'wh_1', action: 'accept' })).toEqual({ changed: true, status: 'committed' });
		expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toEqual([
			{ storyId: 'story_alpha', command: 'world.chronicle.advance', args: { span: 'week', eventfulness: 'turbulent', creativity: 'grounded', runNow: true } },
			{ storyId: 'story_alpha', command: 'world.chronicle.advance', args: { span: 'day', runNow: true } },
			{ storyId: 'story_alpha', command: 'world.chronicle.list', args: { limit: 60 } },
			{ storyId: 'story_alpha', command: 'world.chronicle.review', args: { eventId: 'wh_1', action: 'accept' } },
		]);
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
