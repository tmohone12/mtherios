import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, chapters, entities, entityAliases, factions, patchProposals, stories, storyEntries, storyThreads } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	bumpStoryVersion: vi.fn(),
	resolveServiceGeneration: vi.fn(),
	generateServerTextWithMetrics: vi.fn(),
	parseJsonFromGeneratedText: vi.fn(),
	recordApiCallLog: vi.fn(),
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

vi.mock('./apiCallLogs', () => ({
	recordApiCallLog: mocks.recordApiCallLog,
}));

vi.mock('$lib/server/turn/provider', () => ({
	generateServerTextWithMetrics: mocks.generateServerTextWithMetrics,
	parseJsonFromGeneratedText: mocks.parseJsonFromGeneratedText,
}));

import { draftCharacterCreateFromStoryContext, draftCharacterUpdateFromStoryContext, refineChapterCharacterUpdates } from './characterDrafts';

function createDbMock(options: { characterRows?: Array<typeof entities.$inferSelect>; entryRows?: Array<typeof storyEntries.$inferSelect>; pendingRows?: Array<Partial<typeof patchProposals.$inferSelect>> } = {}) {
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
			if (selectedTable === stories) return Promise.resolve([{
				id: 'story_alpha',
				title: 'Harbor Knives',
				description: 'Rival houses contest a storm-walled harbor.',
				genre: 'political fantasy',
				currentTurn: 12,
				currentWorldTime: 'late autumn',
			}].slice(0, limit));
			if (selectedTable === entities) return Promise.resolve((options.characterRows ?? [character]).slice(0, limit));
			if (selectedTable === patchProposals) return Promise.resolve((options.pendingRows ?? []).slice(0, limit));
			if (selectedTable === entityAliases || selectedTable === factions || selectedTable === storyThreads) return Promise.resolve([]);
			if (selectedTable === storyEntries) return Promise.resolve((options.entryRows ?? recentRows).slice(0, limit));
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
	mocks.recordApiCallLog.mockResolvedValue(null);
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
		generation: { model: 'test-model', temperature: 0.2, maxTokens: 1800, reasoningEffort: 'high' },
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
	it('finds a former name and drafts only requested profile changes from narrative evidence', async () => {
		const character = { id: 'npc_aurion', storyId: 'story_alpha', type: 'character', name: 'Aegon Targaryen 6th (Aurion Maegyr)', serverVersion: 17, state: { bio: 'Raised behind the Black Walls.', relationship: { status: 'self', level: 100 }, playerSheet: { armorClass: 10 } }, metadata: {}, description: null, status: 'active', visibility: 'player_known', sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' } satisfies typeof entities.$inferSelect;
		const entryRows = [
			{ id: 'origin', storyId: 'story_alpha', type: 'narration', position: 1, content: 'Aurion was raised as the second son of House Maegyr.', metadata: null, parentId: null },
			{ id: 'ooc', storyId: 'story_alpha', type: 'user_action', position: 2, content: 'OOC: Give everyone blue eyes.', metadata: { actionType: 'ooc' }, parentId: null },
			{ id: 'reply', storyId: 'story_alpha', type: 'narration', position: 3, content: 'Everyone has blue eyes.', metadata: null, parentId: 'ooc' },
		] as Array<typeof storyEntries.$inferSelect>;
		const { db, insertCalls } = createDbMock({ characterRows: [character], entryRows });
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValue({ text: JSON.stringify({ bio: 'Raised behind the Black Walls, he is a six-foot sword prodigy.', appearance: 'Six feet tall; violet eyes.', personality: 'Proud and independent.', playerSheet: { armorClass: 99 }, currentLocation: 'Invented castle' }), model: 'test-model' });
		await draftCharacterUpdateFromStoryContext('story_alpha', { recordId: character.id, instructions: 'Six feet tall; violet eyes; sword prodigy.', recentLimit: 8 });
		const prompt = mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt;
		expect(prompt).toContain('Aurion Maegyr, Aegon, Aurion');
		expect(prompt).toContain('Aurion was raised as the second son');
		expect(prompt).not.toMatch(/everyone blue eyes|Everyone has blue eyes/);
		const proposal = insertCalls.find(call => call.table === patchProposals)!.value;
		expect(proposal.status).toBe('pending');
		expect(proposal.metadata).toMatchObject({ characterUpdateBaseVersion: 17, authorInstructions: 'Six feet tall; violet eyes; sword prodigy.' });
		expect(proposal.sourceEntryIds).toContain('origin');
		expect(proposal.sourceEntryIds).not.toContain('ooc');
		expect((proposal.operations as Array<{ value: unknown }>)[0].value).toEqual({ bio: 'Raised behind the Black Walls, he is a six-foot sword prodigy.', appearance: 'Six feet tall; violet eyes.', personality: 'Proud and independent.' });
	});

	it('drafts current lorebook character state without erasing existing facts', async () => {
		const { db, insertCalls } = createDbMock();
		mocks.getDb.mockReturnValue(db);

		const result = await draftCharacterUpdateFromStoryContext('story_alpha', {
			recordId: 'npc_mira',
			instructions: 'Refresh Mira from the harbor scene.',
			recentLimit: 30,
		});

		const generationArgs = mocks.generateServerTextWithMetrics.mock.calls[0][0] as { prompt: string; responseFormat: string; reasoningEffort: string };
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'characterUpdate');
		expect(generationArgs.responseFormat).toBe('json_object');
		expect(generationArgs.reasoningEffort).toBe('off');
		expect(generationArgs.prompt).toContain('bio, appearance, presentation, speechStyle, personality, rank, currentDisposition, affinity, motivations, factionTags, knownFacts');
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
			currentDisposition: 'guarding the ledger and blocking the quay',
			relationship: { level: 35 },
			knownFacts: ['the ledger names Zhen'],
			factionTags: ['Balaerys Trading Post'],
			motivations: ['protect Aurion', 'expose the harbor witness'],
		});
		expect(state).not.toHaveProperty('personalOpinion');
		expect(state).not.toHaveProperty('mannerisms');
		expect(state).not.toHaveProperty('conversationTopics');
		expect(state).not.toHaveProperty('bio');
		expect(state).not.toHaveProperty('isPresent');
		expect(state.relationship).toEqual({ level: 35 });
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

describe('draftCharacterCreateFromStoryContext', () => {
	const creationSeeds = { name: 'Tala Venn', role: 'Harbor courier', backstory: 'She learned the smuggler routes while paying a family debt.', narrativePurpose: 'Carry contradictory evidence between rival houses.' };

	it.each([
		{ label: 'an automatic NPC candidate', proposedBy: 'chapter_scribe', input: creationSeeds },
		{ label: 'a prior human draft with different seeds', proposedBy: 'gm_character_draft', input: { ...creationSeeds, backstory: 'An old backstory the user has replaced.' } },
		{ label: 'a prior human draft with an omitted old optional seed', proposedBy: 'gm_character_draft', input: { ...creationSeeds, fear: 'A fear the user has removed.' } },
	])('generates the requested character instead of reusing $label', async ({ proposedBy, input }) => {
		const { db, insertCalls } = createDbMock({ pendingRows: [{ id: 'old_candidate', proposedBy, status: 'pending', metadata: { input } }] });
		mocks.getDb.mockReturnValue(db);
		const result = await draftCharacterCreateFromStoryContext('story_alpha', creationSeeds);
		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledTimes(1);
		expect(result.proposalId).not.toBe('old_candidate');
		const created = insertCalls.find((call) => call.table === patchProposals)?.value;
		expect(created).toMatchObject({ proposedBy: 'gm_character_draft', metadata: expect.objectContaining({ input: creationSeeds }) });
	});

	it('reuses a pending human draft only when its validated input seeds match', async () => {
		const { db, insertCalls } = createDbMock({ pendingRows: [{ id: 'matching_draft', proposedBy: 'gm_character_draft', status: 'pending', metadata: { input: creationSeeds } }] });
		mocks.getDb.mockReturnValue(db);
		const result = await draftCharacterCreateFromStoryContext('story_alpha', { ...creationSeeds, name: '  Tala Venn  ' });
		expect(result).toMatchObject({ proposalId: 'matching_draft', status: 'pending' });
		expect(mocks.generateServerTextWithMetrics).not.toHaveBeenCalled();
		expect(insertCalls).toEqual([]);
	});

	it('keeps the human seeds in compact canonical character fields', async () => {
		const { db, insertCalls } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				description: 'A quick-eyed courier caught between two harbor powers.',
				bio: 'She knows which warehouse doors never appear on guild maps.',
				appearance: 'Salt-dark cloak and ink-stained gloves.',
				personality: 'Watchful and dryly funny.',
				rank: 'invented rank that must not replace the human role',
				currentDisposition: 'testing whether the player can be trusted',
				motivations: ['Keep the hidden routes secret.'],
				factionTags: ['Dock Runners'],
				knownFacts: ['The east warehouse has a false wall.'],
				aliases: ['Tide Sparrow'],
				portraitPrompt: 'A harbor courier beneath storm lanterns.',
			}),
			model: 'test-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 100,
			responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await draftCharacterCreateFromStoryContext('story_alpha', {
			name: 'Tala Venn',
			role: 'Harbor courier',
			backstory: 'Tala learned every smuggler route while paying off her family debt.',
			narrativePurpose: 'Carry contradictory evidence between rival houses.',
			desire: 'Free her family from debt.',
			fear: 'The guild will discover who taught her the hidden routes.',
			faction: 'Harbor Guild',
			location: 'East Tide Warehouses',
		});

		const proposal = insertCalls.find((call) => call.table === patchProposals)?.value;
		const operation = (proposal?.operations as Array<Record<string, unknown>>)[0];
		const value = operation.value as Record<string, unknown>;
		const state = value.state as Record<string, unknown>;

		expect(result).toMatchObject({
			storyId: 'story_alpha',
			recordId: 'unresolved_character_tala_venn',
			status: 'pending',
		});
		expect(value).toMatchObject({
			storyId: 'story_alpha',
			type: 'character',
			name: 'Tala Venn',
			visibility: 'gm',
			aliases: ['Tide Sparrow'],
		});
		expect(state).toMatchObject({
			bio: 'Tala learned every smuggler route while paying off her family debt.\n\nShe knows which warehouse doors never appear on guild maps.',
			rank: 'Harbor courier',
			currentLocation: 'East Tide Warehouses',
			motivations: [
				'Keep the hidden routes secret.',
				'Fear: The guild will discover who taught her the hidden routes.',
				'Free her family from debt.',
			],
			factionTags: ['Dock Runners', 'Harbor Guild'],
		});
		expect(proposal).toMatchObject({
			proposedBy: 'gm_character_draft',
			metadata: expect.objectContaining({
				input: expect.objectContaining({ role: 'Harbor courier', faction: 'Harbor Guild' }),
			}),
		});
	});

	it('does not collapse distinct non-Latin character names into one pending identity', async () => {
		const existing = {
			id: 'npc_wang_xue',
			storyId: 'story_alpha',
			type: 'character',
			name: '王雪',
			description: null,
			status: 'active',
			visibility: 'gm',
			state: {},
			metadata: {},
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: '2026-06-18T00:00:00.000Z',
			updatedAt: '2026-06-18T00:00:00.000Z',
		} satisfies typeof entities.$inferSelect;
		const { db, insertCalls } = createDbMock({ characterRows: [existing] });
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: '{}',
			model: 'test-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 100,
			responseChars: 2,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await draftCharacterCreateFromStoryContext('story_alpha', {
			name: '李梅',
			role: '王室信使',
			backstory: '她从边境法院带来一封封印的信。',
			narrativePurpose: '让敌对家族的线索发生碰撞。',
		});

		expect(result.status).toBe('pending');
		expect(result.recordId).toMatch(/^unresolved_character_name_[0-9a-f]{12}$/);
		expect(insertCalls.some((call) => call.table === patchProposals)).toBe(true);
	});
});

describe('refineChapterCharacterUpdates', () => {
	it('accepts one quoted evidence string after validating it against supplied context', async () => {
		const text = JSON.stringify({ updates: [{ entityId: 'mira', patch: { appearance: 'Grey eyes' }, confidence: 0.9, evidence: 'She has grey eyes.' }] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({ text, model: 'test', endpoint: 'mock', durationMs: 1, promptChars: 20, responseChars: text.length, usage: {} });
		const result = await refineChapterCharacterUpdates({ storyId: 'story_alpha', chapterWindow: [1, 2], sourceEvidence: [{ id: 'original', content: 'Mira stands at the quay. She has grey eyes.' }], candidates: [{ entityId: 'mira', name: 'Mira', description: 'She has grey eyes.', state: {} }] });
		expect(result.updates[0]).toMatchObject({ evidence: ['She has grey eyes.'], state: { appearance: 'Grey eyes' } });
	});
	it.each(['', 'null', '[]', '{}', '{"updates":"wrong shape"}'])('rejects blank or wrong-shaped responses: %s', async text => {
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({ text, model: 'test', endpoint: 'mock', durationMs: 1, promptChars: 20, responseChars: text.length, usage: {} });
		await expect(refineChapterCharacterUpdates({ storyId: 'story_alpha', chapterWindow: [1, 2], candidates: [{ entityId: 'mira', name: 'Mira', state: {} }] })).rejects.toThrow();
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
	});

	it.each([{ confidence: 0.3, evidence: ['She has grey eyes.'] }, { confidence: 0.9, evidence: [] }, { confidence: 0.9, evidence: ['She is secretly a dragon.'] }])('rejects unsupported enrichment %#', async support => {
		const text = JSON.stringify({ updates: [{ entityId: 'mira', patch: { appearance: 'Dragon scales' }, ...support }] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({ text, model: 'test', endpoint: 'mock', durationMs: 1, promptChars: 20, responseChars: text.length, usage: {} });
		const result = await refineChapterCharacterUpdates({ storyId: 'story_alpha', chapterWindow: [1, 2], candidates: [{ entityId: 'mira', name: 'Mira', description: 'She has grey eyes.', state: {} }] });
		expect(result).toMatchObject({ status: 'skipped', updates: [] });
	});

	it('includes canonical description and legacy fields and retains quoted enrichment evidence', async () => {
		const text = JSON.stringify({ updates: [{ entityId: 'mira', patch: { appearance: 'Grey eyes', speechStyle: 'Measured diction' }, confidence: 0.9, evidence: ['She has grey eyes.'] }] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({ text, model: 'test', endpoint: 'mock', durationMs: 1, promptChars: 20, responseChars: text.length, usage: {} });
		const result = await refineChapterCharacterUpdates({ storyId: 'story_alpha', chapterWindow: [1, 2], sourceEvidence: [{ id: 'original', content: 'Mira stands at the quay. She has grey eyes.' }], candidates: [{ entityId: 'mira', name: 'Mira', description: 'She has grey eyes.', state: { background: 'A harbor broker.', traits: ['patient'], speechStyle: 'Measured diction' } }] });
		const prompt = mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt;
		expect(prompt).toContain('She has grey eyes.');
		expect(prompt).toContain('"bio":"A harbor broker."');
		expect(prompt).toContain('"personality":"patient"');
		expect(result.updates[0]).toMatchObject({ evidence: ['She has grey eyes.'], confidence: 0.9, state: { appearance: 'Grey eyes' } });
		expect(result.updates[0].state).not.toHaveProperty('speechStyle');
	});

	it('uses one character-update call and only merges allowed fields for known ids', async () => {
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				updates: [
					{
						entityId: 'npc_mira',
						evidence: ['Mira barred the quay and chose to protect the harbor witness.'],
						confidence: 0.9,
						patch: {
							currentDisposition: 'protective of the harbor witness',
							motivations: ['keep the witness alive'],
							knownFacts: ['the witness crossed the north quay'],
							currentAction: 'invented replacement action',
							eventMemory: { did: ['invented replacement memory'] },
						},
					},
					{ entityId: 'npc_unknown', patch: { bio: 'must be rejected' } },
				],
			}),
			model: 'character-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 250,
			responseChars: 150,
			usage: { requestTokens: 20, responseTokens: 10, totalTokens: 30 },
		});

		const result = await refineChapterCharacterUpdates({
			storyId: 'story_alpha',
			chapterWindow: [7, 8],
			chapterEvidence: [{
				number: 8,
				title: 'The North Quay',
				summary: 'Mira barred the quay and chose to protect the harbor witness.',
			}],
			sourceEvidence: [{ id: 'original', content: 'Mira barred the quay and chose to protect the harbor witness.' }],
			candidates: [{
				entityId: 'npc_mira',
				name: 'Mira',
				state: {
					currentAction: 'barred the north quay',
					eventMemory: { did: ['Chapter 8: Mira barred the north quay.'], saw: [] },
					knownFacts: ['Mira knew the market code.'],
				},
			}],
		});

		expect(mocks.resolveServiceGeneration).toHaveBeenCalledTimes(1);
		expect(mocks.resolveServiceGeneration).toHaveBeenCalledWith('characterUpdate');
		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledTimes(1);
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt).toContain('The North Quay');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt).toContain('Mira barred the quay');
		expect(result).toMatchObject({
			status: 'generated',
			effectiveServiceId: 'characterUpdate',
			model: 'character-model',
			updates: [{
				entityId: 'npc_mira',
				state: {
					currentDisposition: 'protective of the harbor witness',
					motivations: ['keep the witness alive'],
					knownFacts: ['the witness crossed the north quay'],
				},
			}],
		});
		expect(result.updates[0].state).not.toHaveProperty('eventMemory');
		expect(result.updates[0].state).not.toHaveProperty('currentAction');
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({
			serviceId: 'characterUpdate',
			operation: 'chapter.character_update',
			status: 'success',
			metadata: expect.objectContaining({ parseOutcome: 'parsed' }),
		}));
	});

	it('honors an explicitly disabled character-update service without falling back', async () => {
		mocks.resolveServiceGeneration.mockResolvedValueOnce({
			setting: { serviceId: 'characterUpdate', enabled: false },
			profile: null,
			generation: {},
			systemPromptOverride: null,
			missingReason: 'Terminal LLM service "characterUpdate" is disabled.',
		});

		const result = await refineChapterCharacterUpdates({
			storyId: 'story_alpha',
			chapterWindow: [7, 8],
			candidates: [{ entityId: 'npc_mira', name: 'Mira', state: {} }],
		});

		expect(result).toMatchObject({
			status: 'skipped',
			effectiveServiceId: 'characterUpdate',
			reason: expect.stringContaining('disabled'),
		});
		expect(mocks.resolveServiceGeneration).toHaveBeenCalledTimes(1);
		expect(mocks.generateServerTextWithMetrics).not.toHaveBeenCalled();
	});

	it('uses classifier only as a migration fallback when no new service row exists', async () => {
		mocks.resolveServiceGeneration
			.mockResolvedValueOnce({
				setting: null,
				profile: null,
				generation: {},
				systemPromptOverride: null,
				missingReason: 'missing characterUpdate row',
			})
			.mockResolvedValueOnce({
				setting: { serviceId: 'classifier', enabled: true },
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
				generation: { model: 'legacy-model', temperature: 0.2, maxTokens: 1800 },
				systemPromptOverride: null,
				missingReason: null,
			});
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({ updates: [] }),
			model: 'legacy-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 100,
			responseChars: 14,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await refineChapterCharacterUpdates({
			storyId: 'story_alpha',
			chapterWindow: [7, 8],
			candidates: [{ entityId: 'npc_mira', name: 'Mira', state: {} }],
		});

		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'characterUpdate');
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(2, 'classifier');
		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'off' }));
		expect(result).toMatchObject({ status: 'skipped', effectiveServiceId: 'classifier', updates: [] });
	});
});
