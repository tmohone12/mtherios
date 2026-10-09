import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { turnContextReceiptSchema, type TurnResponse } from '$lib/contracts/memory';
import type { Story } from '$lib/types';

const mocks = vi.hoisted(() => ({
	processBackendTurn: vi.fn(),
	pullBackendChanges: vi.fn(),
	pushPendingBackendOps: vi.fn(),
	putStoryEntry: vi.fn(),
	putChapter: vi.fn(),
	deleteChapter: vi.fn(),
	deleteArc: vi.fn(),
	deleteSaga: vi.fn(),
	updateStory: vi.fn(),
}));

vi.mock('$lib/services/backendMemory', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/services/backendMemory')>(),
	processBackendTurn: mocks.processBackendTurn,
	pullBackendChanges: mocks.pullBackendChanges,
	pushPendingBackendOps: mocks.pushPendingBackendOps,
}));

vi.mock('$lib/services/database', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/services/database')>(),
	putStoryEntry: mocks.putStoryEntry,
	putChapter: mocks.putChapter,
	deleteChapter: mocks.deleteChapter,
	deleteArc: mocks.deleteArc,
	deleteSaga: mocks.deleteSaga,
	updateStory: mocks.updateStory,
	getChapters: vi.fn().mockResolvedValue([]),
	getArcs: vi.fn().mockResolvedValue([]),
	getSagas: vi.fn().mockResolvedValue([]),
}));

import { story } from './story.svelte';

const currentStory = {
	id: 'story_local',
	title: 'Backend Turn Test',
	description: null,
	genre: null,
	templateId: null,
	mode: 'adventure',
	createdAt: 1,
	updatedAt: 1,
	settings: null,
	memoryConfig: null,
	retryState: null,
	styleReviewState: null,
	timeTracker: null,
	currentBranchId: null,
	currentBgImage: null,
	headerPrompt: null,
	serverStoryId: 'story_server',
	serverVersion: 7,
	syncStatus: 'synced',
	lastWorldSimDay: null,
	compactedLore: null,
	compactedLoreHistory: null,
	meters: null,
} satisfies Story;

const response = {
	narration: 'The gate opens onto a rain-dark courtyard.',
	entries: [
		{
			id: 'entry_turn_1',
			storyId: 'story_server',
			type: 'user_action',
			content: 'I open the gate.',
			position: 10,
			createdAt: '2026-08-31T02:00:00.000Z',
		},
		{
			id: 'narration_turn_1',
			storyId: 'story_server',
			type: 'narration',
			content: 'The gate opens onto a rain-dark courtyard.',
			position: 11,
			createdAt: '2026-08-31T02:00:01.000Z',
		},
	],
	playerEntryId: 'entry_turn_1',
	assistantEntryId: 'narration_turn_1',
	statePatchIds: [],
	eventIds: [],
	retrievedMemoryIds: [],
	memoryNodeIds: [],
	serverVersion: 8,
	syncChanges: [],
	warnings: [],
	generationTimings: [],
	performance: null,
	contextReceipt: null,
} satisfies TurnResponse;

describe('backend turn local mirroring', () => {
	beforeEach(() => {
		story.clear();
		vi.clearAllMocks();
		mocks.processBackendTurn.mockResolvedValue(response);
		mocks.pushPendingBackendOps.mockResolvedValue(null);
		mocks.pullBackendChanges.mockResolvedValue(null);
		mocks.putStoryEntry.mockRejectedValueOnce(new Error('IndexedDB write failed'));
		mocks.updateStory.mockResolvedValue(undefined);
		story.currentStory = { ...currentStory };
	});

	afterEach(() => {
		story.clear();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('does not resurrect an imported party role after the server clears it', () => {
		const internal = story as unknown as { serverEntityToCharacter(row: unknown): { metadata: Record<string, unknown> } };
		const character = internal.serverEntityToCharacter({
			id: 'mira', name: 'Mira', type: 'character', status: 'active',
			state: { partyMember: false, partyRole: null },
			metadata: { originalMetadata: { partyRole: 'Scout' } },
		});
		expect(character.metadata).toMatchObject({ partyMember: false, partyRole: null });
	});

	it('restores saved narration receipts after bootstrap and a later projection refresh', async () => {
		vi.useFakeTimers();
		mocks.putStoryEntry.mockReset().mockResolvedValue(undefined);
		const internal = story as unknown as {
			_loadGeneration: number;
			applyBackendBootstrap(local: Story, bootstrap: unknown, generation: number): Promise<void>;
			applyCampaignProjection(projection: unknown): Promise<void>;
			connectEngineStream(): void;
			loadImagesForEntries(): Promise<void>;
		};
		vi.spyOn(internal, 'connectEngineStream').mockImplementation(() => undefined);
		vi.spyOn(internal, 'loadImagesForEntries').mockResolvedValue(undefined);
		const saved = turnContextReceiptSchema.parse({ turnId: 'saved_turn', storyId: 'story_server', included: { totalTokens: 800 }, budgets: { dynamicContextTokensMax: 2000 }, selection: { version: 1, groups: [], sections: [{ id: 'context', label: 'Scene', tokens: 500, chars: 1900 }] } });
		const entry = { ...response.entries[1], metadata: { contextReceipt: saved } };
		await internal.applyBackendBootstrap(currentStory, {
			story: { id: 'story_server' }, serverVersion: 8, entries: [entry], entryCount: 12,
			entities: [], agreements: [], recentEvents: [], memoryNodes: [], npcBeliefs: [], threads: [], chapters: [], arcs: [], sagas: [],
		}, internal._loadGeneration);
		expect(story.lastContextReceipt).toEqual(saved);
		expect(story.worldHydrationError).toBeNull();
		const newer = { ...saved, turnId: 'newer_turn' };
		await internal.applyCampaignProjection({
			story: { id: 'story_server', serverVersion: 9 }, entries: [{ ...entry, id: 'newer_narration', position: 13, metadata: { contextReceipt: newer } }],
			entities: [], chapters: [], arcs: [], sagas: [], counts: { entries: 14, chapters: 0, arcs: 0, sagas: 0 },
		});
		expect(story.lastContextReceipt).toEqual(newer);
	});

	it('removes stale local chapter rows during bootstrap when the terminal projection is complete', async () => {
		vi.useFakeTimers();
		mocks.putStoryEntry.mockReset().mockResolvedValue(undefined);
		const database = await import('$lib/services/database');
		vi.mocked(database.getChapters).mockResolvedValue([{ id: 'chapter_stale' }] as never);
		vi.mocked(database.getArcs).mockResolvedValue([]);
		vi.mocked(database.getSagas).mockResolvedValue([]);
		const internal = story as unknown as {
			_loadGeneration: number;
			applyBackendBootstrap(local: Story, bootstrap: unknown, generation: number): Promise<void>;
			connectEngineStream(): void;
			loadImagesForEntries(): Promise<void>;
		};
		vi.spyOn(internal, 'connectEngineStream').mockImplementation(() => undefined);
		vi.spyOn(internal, 'loadImagesForEntries').mockResolvedValue(undefined);
		await internal.applyBackendBootstrap(currentStory, {
			story: { id: 'story_server' }, serverVersion: 8, entries: [], entryCount: 0,
			entities: [], agreements: [], recentEvents: [], memoryNodes: [], npcBeliefs: [], threads: [],
			chapters: [{ id: 'chapter_current', number: 1, summary: 'Authoritative chapter.', sourceEntryIds: [] }], arcs: [], sagas: [],
			projection: { mode: 'control_surface', story: { id: 'story_server' }, entries: [], entities: [], threads: [], recentEvents: [], chapters: [{ id: 'chapter_current', number: 1, sceneOutcome: 'Authoritative chapter.', sourceEntryIds: [] }], arcs: [], sagas: [], counts: { entries: 0, entities: 0, events: 0, memoryNodes: 0, chapters: 1, arcs: 0, sagas: 0 }, vault: { vaultPath: '', fileCount: 0, lastIndexedVersion: 0 }, cache: { storyId: null, entryCount: 0, hitCount: 0, missCount: 0, tokenEstimate: 0, byKind: [] } },
		}, internal._loadGeneration);
		expect(mocks.deleteChapter).toHaveBeenCalledWith('chapter_stale');
		expect(mocks.putChapter).toHaveBeenCalledWith(expect.objectContaining({ id: 'chapter_current', summary: 'Authoritative chapter.' }));
	});

	it('keeps a committed narration when the local IndexedDB mirror fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const result = await story.submitBackendTurn({
			clientTurnId: 'turn_1',
			playerText: 'I open the gate.',
			actionType: 'do',
		});

		expect(result.narration).toBe(response.narration);
		expect(story.entries).toContainEqual(expect.objectContaining({
			id: 'narration_turn_1',
			content: response.narration,
		}));
		expect(story.currentStory?.syncStatus).toBe('syncing');
	});
});
