import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, chapters, entities, patchProposals, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	bumpStoryVersion: vi.fn(),
	resolveServiceGeneration: vi.fn(),
	generateServerTextWithMetrics: vi.fn(),
	parseJsonFromGeneratedText: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: mocks.getDb,
}));

vi.mock('$lib/server/memory/canonical', () => ({
	bumpStoryVersion: mocks.bumpStoryVersion,
}));

vi.mock('./llmSettings', () => ({
	resolveServiceGeneration: mocks.resolveServiceGeneration,
}));

vi.mock('$lib/server/turn/provider', () => ({
	generateServerTextWithMetrics: mocks.generateServerTextWithMetrics,
	parseJsonFromGeneratedText: mocks.parseJsonFromGeneratedText,
}));

import { draftCharacterUpdateFromStoryContext } from './characterDrafts';

function createDbMock() {
	const insertCalls: Array<{ table: unknown; value: Record<string, unknown> }> = [];
	const character = {
		id: 'npc_mira',
		storyId: 'story_alpha',
		type: 'character',
		name: 'Mira of the Harbor',
		description: 'A broker who survived the harbor coup.',
		status: 'active',
		visibility: 'player_known',
		state: {
			bio: 'Existing harbor broker bio.',
			relationship: { level: 0, status: 'unknown', history: [] },
			knownFacts: ['Mira knew the market code.'],
			revealedSecrets: [],
			factionTags: ['Old Guild'],
			pressures: [],
		},
		metadata: {
			localAliases: ['The Harbor Broker'],
			currentDisposition: 'wanted by the guard captain',
			pressures: ['the guard captain is searching for the ledger'],
			knownFacts: ['Mira knows the old quay password.'],
		},
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		serverVersion: 1,
		createdAt: '2026-06-18T00:00:00.000Z',
		updatedAt: '2026-06-18T00:00:00.000Z',
	} satisfies typeof entities.$inferSelect;
	const recentRows = [
		{
			id: 'entry_new',
			storyId: 'story_alpha',
			type: 'assistant',
			content: 'Mira barred the quay and realized the ledger names Zhen.',
			position: 12,
			parentId: null,
			branchId: null,
			metadata: null,
			serverVersion: 1,
			createdAt: '2026-06-18T00:02:00.000Z',
			updatedAt: '2026-06-18T00:02:00.000Z',
		},
		{
			id: 'entry_old',
			storyId: 'story_alpha',
			type: 'user',
			content: 'I ask Mira what she saw at the oath.',
			position: 11,
			parentId: null,
			branchId: null,
			metadata: null,
			serverVersion: 1,
			createdAt: '2026-06-18T00:01:00.000Z',
			updatedAt: '2026-06-18T00:01:00.000Z',
		},
	] satisfies Array<typeof storyEntries.$inferSelect>;
	const chapterRows = [
		{
			id: 'chapter_7',
			storyId: 'story_alpha',
			number: 7,
			title: 'The Quay Ledger',
			sceneOutcome: 'Mira chose Aurion over the guard captain.',
			irreversibleChanges: ['Mira hid the ledger from the guard.'],
			npcKnowledgeChanges: [{ npc: 'Mira', knows: 'Zhen is named in the ledger.' }],
			promisesDebtsOaths: [],
			discoveredClues: ['Mira found the seal.'],
			relationshipChanges: ['Mira trusts Aurion more openly.'],
			factionChanges: [],
			openThreads: ['Who else saw the ledger?'],
			sourceEntryIds: ['entry_chapter_mira'],
			sourceEventIds: [],
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-06-18T00:03:00.000Z',
			updatedAt: '2026-06-18T00:03:00.000Z',
		},
	] satisfies Array<typeof chapters.$inferSelect>;
	const arcRows = [
		{
			id: 'arc_2',
			storyId: 'story_alpha',
			number: 2,
			title: 'Harbor Knives',
			summary: 'Mira becomes a dangerous witness after the harbor coup.',
			chapterIds: ['chapter_7'],
			sourceEventIds: [],
			openThreadIds: [],
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-06-18T00:04:00.000Z',
			updatedAt: '2026-06-18T00:04:00.000Z',
		},
	] satisfies Array<typeof arcs.$inferSelect>;

	let selectedTable: unknown;
	const selectChain = {
		from: vi.fn((table: unknown) => {
			selectedTable = table;
			return selectChain;
		}),
		where: vi.fn(() => selectChain),
		orderBy: vi.fn(() => selectChain),
		limit: vi.fn((limit: number) => {
			if (selectedTable === entities) return Promise.resolve([character].slice(0, limit));
			if (selectedTable === storyEntries) return Promise.resolve(recentRows.slice(0, limit));
			if (selectedTable === chapters) return Promise.resolve(chapterRows.slice(0, limit));
			if (selectedTable === arcs) return Promise.resolve(arcRows.slice(0, limit));
			return Promise.resolve([]);
		}),
	};

	const db = {
		select: vi.fn(() => selectChain),
		insert: vi.fn((table: unknown) => ({
			values: vi.fn((value: Record<string, unknown>) => {
				insertCalls.push({ table, value });
				return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
			}),
		})),
	};
	return { db, insertCalls };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.bumpStoryVersion.mockResolvedValue(42);
	mocks.resolveServiceGeneration.mockResolvedValue({
		setting: null,
		profile: {
			id: 'server-classifier',
			name: 'Server classifier',
			providerType: 'openrouter',
			apiKey: 'test-key',
			customModels: [],
			fetchedModels: [],
			reasoningModels: [],
			hiddenModels: [],
			favoriteModels: [],
		},
		generation: { model: 'test-model', temperature: 0.2, maxTokens: 1800 },
		systemPromptOverride: null,
		missingReason: null,
	});
	mocks.parseJsonFromGeneratedText.mockImplementation((text: string) => JSON.parse(text));
	mocks.generateServerTextWithMetrics.mockImplementation(async () => ({
		text: JSON.stringify({
			appearance: 'Ink-stained silk gloves and a salt-dark cloak.',
			currentDisposition: 'guarding the ledger and blocking the quay',
			affinity: 35,
			motivations: ['protect Aurion', 'expose the harbor witness'],
			knownFacts: ['the ledger names Zhen'],
			factionTags: ['Old Guild', 'Balaerys Trading Post'],
		}),
		model: 'test-model',
		endpoint: 'mock',
		durationMs: 1,
		promptChars: 100,
		responseChars: 100,
		usage: { requestTokens: null, responseTokens: null, totalTokens: null },
	}));
});

describe('draftCharacterUpdateFromStoryContext', () => {
	it('drafts current lorebook character state without erasing existing facts', async () => {
		const { db, insertCalls } = createDbMock();
		mocks.getDb.mockReturnValue(db);

		const result = await draftCharacterUpdateFromStoryContext('story_alpha', {
			recordId: 'npc_mira',
			instructions: 'Refresh Mira from the harbor scene.',
			recentLimit: 30,
		});

		const generationArgs = mocks.generateServerTextWithMetrics.mock.calls[0][0] as { prompt: string; responseFormat: string };
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'memory');
		expect(generationArgs.responseFormat).toBe('json_object');
		expect(generationArgs.prompt).toContain('bio, appearance, personality, rank, currentDisposition, affinity, motivations, factionTags, knownFacts');
		expect(generationArgs.prompt).toContain('Use motivations for goals.');
		expect(generationArgs.prompt).not.toContain('personalOpinion');
		expect(generationArgs.prompt).not.toContain('mannerisms');
		expect(generationArgs.prompt).not.toContain('eventMemory.did');
		expect(generationArgs.prompt).toContain('=== SELECTED STORY MEMORY ===');
		expect(generationArgs.prompt).toContain('Chapter 7: The Quay Ledger');
		expect(generationArgs.prompt).toContain('Arc 2: Harbor Knives');

		const proposal = insertCalls.find((call) => call.table === patchProposals)?.value;
		const operation = (proposal?.operations as Array<Record<string, unknown>>)[0];
		const state = operation.value as Record<string, unknown>;

		expect(result).toMatchObject({
			storyId: 'story_alpha',
			recordId: 'npc_mira',
			status: 'pending',
		});
		expect(proposal).toMatchObject({
			storyId: 'story_alpha',
			proposalType: 'character_context_update',
			targetTable: 'entities',
			targetRecordId: 'npc_mira',
			sourceEntryIds: ['entry_old', 'entry_new', 'entry_chapter_mira'],
			metadata: expect.objectContaining({
				searchTerm: 'Mira of the Harbor',
				searchTerms: expect.arrayContaining(['Mira of the Harbor', 'Mira']),
				sourceChapterIds: ['chapter_7'],
				sourceArcIds: ['arc_2'],
			}),
			serverVersion: 42,
		});
		expect(state).toMatchObject({
			appearance: 'Ink-stained silk gloves and a salt-dark cloak.',
			bio: 'Existing harbor broker bio.',
			currentDisposition: 'guarding the ledger and blocking the quay',
			relationship: { level: 35, status: 'unknown', history: [] },
			knownFacts: ['Mira knew the market code.', 'Mira knows the old quay password.', 'the ledger names Zhen'],
			factionTags: ['Old Guild', 'Balaerys Trading Post'],
			motivations: ['protect Aurion', 'expose the harbor witness'],
		});
		expect(state).not.toHaveProperty('personalOpinion');
		expect(state).not.toHaveProperty('mannerisms');
		expect(state).not.toHaveProperty('conversationTopics');
	});

	it('skips empty drafts instead of creating useless proposals', async () => {
		const { db, insertCalls } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				traits: [],
				pressures: [],
				relationship: null,
			}),
			model: 'test-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 100,
			responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await draftCharacterUpdateFromStoryContext('story_alpha', {
			recordId: 'npc_mira',
			instructions: 'Refresh Mira from the harbor scene.',
			recentLimit: 30,
		});

		expect(result).toEqual({
			storyId: 'story_alpha',
			recordId: 'npc_mira',
			proposalId: null,
			status: 'skipped',
			reason: 'No supported character changes found.',
		});
		expect(insertCalls).toEqual([]);
		expect(mocks.bumpStoryVersion).not.toHaveBeenCalled();
	});
});
