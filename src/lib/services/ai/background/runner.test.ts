import { beforeEach, describe, expect, it, vi } from 'vitest';

const { aiMock, storyMock, settingsMock, databaseMocks, canonicalMocks } = vi.hoisted(() => {
	const aiMock = {
		memory: {
			analyzeForChapter: vi.fn(),
			summarizeChapter: vi.fn(),
		},
		worldSim: {
			simulateForNewChapter: vi.fn(),
		},
		embeddings: {
			embed: vi.fn(),
		},
		loreManagement: {
			manage: vi.fn(),
		},
	};
	const storyMock = {
		currentStory: null as any,
		entries: [] as any[],
		entryCount: 0,
		storyMode: 'adventure',
		pov: 'second',
		tense: 'present',
		lorebookEntries: [] as any[],
		worldEvents: [] as any[],
		factionActions: [] as any[],
		rumors: [] as any[],
		lastWorldSimResult: null as any,
		campaignProjection: null as any,
	};
	const settingsMock = {
		getServiceConfig: vi.fn(),
		uiSettings: {
			chapterThreshold: 1,
			postChapterBuffer: 0,
			maxPrevChaptersInSummary: 5,
			chaptersPerArc: 99,
		},
	};
	const databaseMocks = {
		getChapters: vi.fn(),
		getArcs: vi.fn(),
		getSagas: vi.fn(),
		getStoryBeats: vi.fn(),
		getStoryEntry: vi.fn(),
		getStoryEntriesAfterPosition: vi.fn(),
	};
	const canonicalMocks = {
		patchCanonicalLorebookEntry: vi.fn(),
		saveCanonicalArc: vi.fn(),
		saveCanonicalChapter: vi.fn(),
		saveCanonicalFactionActions: vi.fn(),
		saveCanonicalSaga: vi.fn(),
		saveCanonicalLorebookEntry: vi.fn(),
		saveCanonicalRumors: vi.fn(),
		saveCanonicalWorldEvent: vi.fn(),
	};
	return { aiMock, storyMock, settingsMock, databaseMocks, canonicalMocks };
});

vi.mock('$lib/services/ai', () => ({ ai: aiMock }));
vi.mock('$lib/stores/story.svelte', () => ({ story: storyMock }));
vi.mock('$lib/stores/settings.svelte', () => ({ settings: settingsMock }));
vi.mock('$lib/services/database', () => databaseMocks);
vi.mock('$lib/services/canonicalWrites', () => canonicalMocks);

import { runBackgroundJobs } from './runner';

function chapter(number: number) {
	return {
		id: `chapter-${number}`,
		storyId: 'story-1',
		number,
		title: `Chapter ${number}`,
		startEntryId: `entry-${number}-start`,
		endEntryId: `entry-${number}-end`,
		entryCount: 1,
		summary: `Summary ${number}`,
		startTime: null,
		endTime: null,
		keywords: [],
		characters: [],
		locations: [],
		plotThreads: [],
		emotionalTone: null,
		branchId: null,
		createdAt: number,
	};
}

function resetMocks() {
	vi.clearAllMocks();
	storyMock.currentStory = { id: 'story-1', currentBranchId: null, serverVersion: 1, syncStatus: 'synced' };
	storyMock.entries = [];
	storyMock.entryCount = 5;
	storyMock.lorebookEntries = [];
	storyMock.worldEvents = [];
	storyMock.factionActions = [];
	storyMock.rumors = [];
	storyMock.lastWorldSimResult = null;
	storyMock.campaignProjection = null;

	settingsMock.getServiceConfig.mockImplementation((name: string) => ({
		enabled: name === 'memory' || name === 'loreManagement',
	}));

	const existingChapters = [1, 2, 3, 4].map(chapter);
	databaseMocks.getChapters.mockResolvedValue(existingChapters);
	databaseMocks.getArcs.mockResolvedValue([]);
	databaseMocks.getSagas.mockResolvedValue([]);
	databaseMocks.getStoryBeats.mockResolvedValue([]);
	databaseMocks.getStoryEntry.mockResolvedValue({ id: 'entry-4-end', position: 4 });
	databaseMocks.getStoryEntriesAfterPosition.mockResolvedValue(Array.from({ length: 20 }, (_, index) => [
		{
			id: `player-${index}`, storyId: 'story-1', type: 'user_action',
			content: 'I ask about Ser Olyvar and the Ember Court.', parentId: null, branchId: null,
			position: 5 + index * 2, createdAt: 5 + index * 2,
		},
		{
			id: `narration-${index}`, storyId: 'story-1', type: 'narration',
			content: 'A chapter-closing scene names Ser Olyvar and the Ember Court.', parentId: `player-${index}`, branchId: null,
			position: 6 + index * 2, createdAt: 6 + index * 2,
		},
	]).flat());

	aiMock.memory.analyzeForChapter.mockResolvedValue({
		shouldCreateChapter: true,
		optimalEndIndex: 0,
	});
	aiMock.memory.summarizeChapter.mockResolvedValue({
		title: 'The Ash Court Turns',
		summary: 'Ser Olyvar is mentioned while the Ember Court becomes politically important.',
		keywords: ['ash', 'court'],
		keyCharacters: ['Ser Olyvar'],
		keyLocations: [],
		emotionalTone: 'tense',
	});
	aiMock.embeddings.embed.mockResolvedValue(undefined);
	aiMock.worldSim.simulateForNewChapter.mockResolvedValue({
		plotInjection: null,
		worldNarrative: '',
		factionActions: [],
		rumors: [],
		worldTension: 0,
		plotSeeds: [],
		plotMomentum: null,
		threadUpdates: [],
	});
	aiMock.loreManagement.manage.mockResolvedValue({
		updates: [
			{
				action: 'create',
				entryId: null,
				name: 'Ser Olyvar',
				type: 'character',
				description: 'A knight mentioned by chapter summary.',
				keywords: ['Ser Olyvar'],
				reason: 'Named in a chapter summary.',
				bio: 'A knight mentioned by chapter summary.',
				motivations: ['Unknown'],
				personality: 'Unknown.',
			},
			{
				action: 'create',
				entryId: null,
				name: 'The Ember Court',
				type: 'faction',
				description: 'A political faction that became important.',
				keywords: ['Ember Court'],
				reason: 'Faction importance was established.',
				knownMembers: [],
				goals: [],
				resources: null,
				disposition: null,
				territory: [],
			},
		],
		summary: 'Create one character and one faction entry.',
	});

	canonicalMocks.patchCanonicalLorebookEntry.mockResolvedValue({ entry: null, serverVersion: 2 });
	canonicalMocks.saveCanonicalArc.mockResolvedValue(2);
	canonicalMocks.saveCanonicalChapter.mockResolvedValue(2);
	canonicalMocks.saveCanonicalFactionActions.mockResolvedValue(2);
	canonicalMocks.saveCanonicalSaga.mockResolvedValue(2);
	canonicalMocks.saveCanonicalLorebookEntry.mockResolvedValue(2);
	canonicalMocks.saveCanonicalRumors.mockResolvedValue(2);
	canonicalMocks.saveCanonicalWorldEvent.mockResolvedValue(2);
}

describe('runBackgroundJobs lore management', () => {
	beforeEach(() => {
		resetMocks();
	});

	it('summarizes the complete20-turn window despite old thresholds and a boundary-model refusal', async () => {
		aiMock.memory.analyzeForChapter.mockResolvedValue({ shouldCreateChapter: false });
		const errors = await runBackgroundJobs();
		expect(errors).toEqual([]);
		expect(aiMock.memory.analyzeForChapter).not.toHaveBeenCalled();
		expect(aiMock.memory.summarizeChapter.mock.calls[0][0]).toHaveLength(40);
		expect(canonicalMocks.saveCanonicalChapter).toHaveBeenCalledWith(expect.objectContaining({
			startEntryId: 'player-0', endEntryId: 'narration-19', entryCount: 40,
		}), 'create');
	});

	it('waits for the twentieth narration and keeps a lone action out of the completed count', async () => {
		const entries = await databaseMocks.getStoryEntriesAfterPosition();
		databaseMocks.getStoryEntriesAfterPosition.mockResolvedValue(entries.slice(0, 39));
		expect(await runBackgroundJobs()).toEqual([]);
		expect(aiMock.memory.summarizeChapter).not.toHaveBeenCalled();
		expect(canonicalMocks.saveCanonicalChapter).not.toHaveBeenCalled();
	});

	it.each([true, false])('reattaches a late narration parent only when prior chapters did not cover it (covered=%s)', async covered => {
		const entries = (await databaseMocks.getStoryEntriesAfterPosition()).slice(0, 38);
		const oldAction = { id: 'old-action', type: 'user_action', content: 'I ask the envoy.', position: 2, createdAt: 2, branchId: null, parentId: null };
		entries.push({ id: 'late-reply', type: 'narration', content: 'The envoy finally answers.', position: 45, createdAt: 45, branchId: null, parentId: oldAction.id });
		databaseMocks.getStoryEntriesAfterPosition.mockResolvedValue(entries);
		databaseMocks.getChapters.mockResolvedValue([1, 2, 3, 4].map(number => ({ ...chapter(number), sourceEntryIds: covered ? [oldAction.id] : [] })));
		databaseMocks.getStoryEntry.mockImplementation(async id => id === oldAction.id ? oldAction : { id: 'entry-4-end', position: 4 });
		expect(await runBackgroundJobs()).toEqual([]);
		expect(canonicalMocks.saveCanonicalChapter).toHaveBeenCalledTimes(covered ? 0 : 1);
		if (!covered) expect(canonicalMocks.saveCanonicalChapter).toHaveBeenCalledWith(expect.objectContaining({
			sourceEntryIds: expect.arrayContaining([oldAction.id, 'late-reply']),
		}), 'create');
	});

	it.each(['ambiguous', 'mismatched_id'])('does not merge lore into the wrong character (%s)', async scenario => {
		storyMock.lorebookEntries = ['one', 'two'].map(id => ({ id, type: 'character', name: id, aliases: scenario === 'ambiguous' ? ['Shared Alias'] : [], state: { bio: 'Authored origin.' } }));
		aiMock.loreManagement.manage.mockResolvedValue({ updates: [{ action: 'update', entryId: 'one', name: scenario === 'ambiguous' ? 'Shared Alias' : 'two', type: 'character', description: 'A new spy biography.', keywords: [] }] });
		const errors = await runBackgroundJobs();
		expect(canonicalMocks.patchCanonicalLorebookEntry).not.toHaveBeenCalled();
		expect(errors.join(' ')).toContain('ambiguous or does not match');
	});

	it('skips automatic character creations while still creating non-character lore', async () => {
		const errors = await runBackgroundJobs();

		expect(errors).toEqual([]);
		expect(canonicalMocks.saveCanonicalLorebookEntry).toHaveBeenCalledTimes(1);
		expect(canonicalMocks.saveCanonicalLorebookEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'The Ember Court',
				type: 'faction',
			}),
			'create',
		);
		expect(storyMock.lorebookEntries).toHaveLength(1);
		expect(storyMock.lorebookEntries[0]).toMatchObject({
			name: 'The Ember Court',
			type: 'faction',
		});
	});

	it('keeps unknown lore-management faction members unresolved instead of canonical', async () => {
		storyMock.lorebookEntries = [
			{
				id: 'entry-established-ally',
				storyId: 'story-1',
				name: 'Established Ally',
				type: 'character',
				description: 'A known character already in canon.',
				aliases: [],
				injection: { mode: 'keyword', keywords: ['Established Ally'], priority: 0 },
				state: { type: 'character' },
			},
			{
				id: 'entry-ridge-watch',
				storyId: 'story-1',
				name: 'Ridge Watch',
				type: 'faction',
				description: 'A faction watching the ridge.',
				aliases: [],
				injection: { mode: 'keyword', keywords: ['Ridge Watch'], priority: 0 },
				state: {
					type: 'faction',
					playerStanding: 0,
					status: 'unknown',
					knownMembers: [],
				},
			},
		];
		aiMock.loreManagement.manage.mockResolvedValue({
			updates: [
				{
					action: 'update',
					entryId: 'entry-ridge-watch',
					name: 'Ridge Watch',
					type: 'faction',
					description: 'The faction now has a named ally and an unresolved scout mention.',
					keywords: ['ridge'],
					reason: 'Chapter summary mentioned members.',
					knownMembers: ['Established Ally', 'Unnamed Scout'],
					goals: [],
					resources: null,
					disposition: null,
					territory: [],
				},
			],
			summary: 'Updated Ridge Watch members.',
		});

		const errors = await runBackgroundJobs();

		expect(errors).toEqual([]);
		expect(canonicalMocks.patchCanonicalLorebookEntry).toHaveBeenCalledWith(
			'entry-ridge-watch',
			expect.objectContaining({
				state: expect.objectContaining({
					knownMembers: ['entry-established-ally'],
					unresolvedKnownMembers: ['Unnamed Scout'],
				}),
			}),
		);
		expect(storyMock.lorebookEntries.find(entry => entry.id === 'entry-ridge-watch')?.state).toMatchObject({
			knownMembers: ['entry-established-ally'],
			unresolvedKnownMembers: ['Unnamed Scout'],
		});
	});

	it('uses direct story-beat significance for chapter enrichment and plot threads', async () => {
		databaseMocks.getStoryBeats.mockResolvedValue([
			{
				id: 'beat-1',
				storyId: 'story-1',
				title: 'The Gate Betrayal',
				description: 'The gate captain betrays the pact.',
				type: 'event',
				significance: 'critical',
				status: 'active',
				triggeredAt: 5,
				resolvedAt: null,
				metadata: null,
				branchId: null,
			},
		]);

		const errors = await runBackgroundJobs();

		expect(errors).toEqual([]);
		expect(aiMock.memory.summarizeChapter).toHaveBeenCalledWith(
			expect.any(Array),
			expect.any(Array),
			'adventure',
			'second',
			'present',
			expect.objectContaining({
				storyBeats: [expect.objectContaining({
					title: 'The Gate Betrayal',
					significance: 'critical',
				})],
			}),
			expect.any(Array),
			5,
		);
		expect(canonicalMocks.saveCanonicalChapter).toHaveBeenCalledWith(
			expect.objectContaining({
				plotThreads: ['The Gate Betrayal'],
			}),
			'create',
		);
	});

	it('creates a chapter without asking the browser to invent world movement', async () => {
		const errors = await runBackgroundJobs();
		expect(errors).toEqual([]);
		expect(canonicalMocks.saveCanonicalChapter).toHaveBeenCalled();
		expect(aiMock.worldSim.simulateForNewChapter).not.toHaveBeenCalled();
		expect(canonicalMocks.saveCanonicalWorldEvent).not.toHaveBeenCalled();
	});
});
