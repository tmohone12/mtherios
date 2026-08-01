import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, chapters, entities, facts, factions, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	resolveServiceGeneration: vi.fn(),
	generateServerTextWithMetrics: vi.fn(),
	parseJsonFromGeneratedText: vi.fn(),
	retrieveMemoryPacket: vi.fn(),
	loadGmTimelineBrief: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: mocks.getDb,
}));

vi.mock('./llmSettings', () => ({
	resolveServiceGeneration: mocks.resolveServiceGeneration,
}));

vi.mock('$lib/server/turn/provider', () => ({
	generateServerTextWithMetrics: mocks.generateServerTextWithMetrics,
	parseJsonFromGeneratedText: mocks.parseJsonFromGeneratedText,
}));

vi.mock('$lib/server/memory/retrieval', () => ({
	retrieveMemoryPacket: mocks.retrieveMemoryPacket,
}));

vi.mock('$lib/server/events/timeline', () => ({
	loadGmTimelineBrief: mocks.loadGmTimelineBrief,
}));

import { runSmallBrain } from './smallBrain';

const profile = {
	id: 'server-smallBrain',
	name: 'Server smallBrain',
	providerType: 'openrouter',
	apiKey: 'test-key',
	customModels: [],
	fetchedModels: [],
	reasoningModels: [],
	hiddenModels: [],
	favoriteModels: [],
};

function resolved(model = 'small-model') {
	return {
		setting: null,
		profile,
		generation: { model, temperature: 0.1, maxTokens: 900 },
		systemPromptOverride: null,
		missingReason: null,
	};
}

function createDbMock(overrides: {
	storyRows?: Array<Record<string, unknown>>;
	entryRows?: Array<Record<string, unknown>>;
	entityRows?: Array<Record<string, unknown>>;
	factionRows?: Array<Record<string, unknown>>;
	eventRows?: Array<Record<string, unknown>>;
	factRows?: Array<Record<string, unknown>>;
	memoryRows?: Array<Record<string, unknown>>;
	chapterRows?: Array<Record<string, unknown>>;
	arcRows?: Array<Record<string, unknown>>;
} = {}) {
	const rows = {
		stories: overrides.storyRows ?? [{
			id: 'story_alpha',
			title: 'Ash Road',
			description: 'A court road story.',
			genre: 'fantasy',
			mode: 'adventure',
			currentTurn: 9,
			currentWorldTime: 'Highsun',
		}],
		storyEntries: overrides.entryRows ?? [
			{ id: 'entry_2', storyId: 'story_alpha', type: 'assistant', content: 'Mira names the ash road witness.', position: 2 },
			{ id: 'entry_1', storyId: 'story_alpha', type: 'user', content: 'I ask Mira what changed.', position: 1 },
		],
		entities: overrides.entityRows ?? [{
			id: 'entity_mira',
			storyId: 'story_alpha',
			type: 'character',
			name: 'Mira',
			description: 'Harbor broker',
			status: 'active',
			visibility: 'player_known',
			state: { goal: 'protect the ledger' },
			metadata: {},
		}],
		factions: overrides.factionRows ?? [{
			id: 'faction_guild',
			storyId: 'story_alpha',
			name: 'Old Guild',
			goals: ['hold the harbor'],
			pressure: 4,
			metadata: {},
		}],
		storyEvents: overrides.eventRows ?? [{
			id: 'event_1',
			storyId: 'story_alpha',
			type: 'reveal',
			status: 'committed',
			title: 'Witness named',
			body: 'Mira named the ash road witness.',
			actorEntityIds: ['entity_mira'],
			targetEntityIds: [],
			factionIds: ['faction_guild'],
			sourceEntryIds: ['entry_2'],
		}],
		facts: overrides.factRows ?? [{
			id: 'fact_1',
			storyId: 'story_alpha',
			type: 'observation',
			title: 'Ledger witness',
			statement: 'The ash road witness is known to Mira.',
			subjectEntityId: 'entity_mira',
			sourceEntryIds: ['entry_2'],
		}],
		memoryNodes: overrides.memoryRows ?? [{
			id: 'memory_1',
			storyId: 'story_alpha',
			type: 'scene',
			title: 'Harbor pressure',
			content: 'The Old Guild is pressuring Mira.',
			summary: 'Mira under guild pressure.',
			entityIds: ['entity_mira'],
			factionIds: ['faction_guild'],
			sourceEntryIds: ['entry_1'],
		}],
		chapters: overrides.chapterRows ?? [{
			id: 'chapter_1',
			storyId: 'story_alpha',
			number: 1,
			title: 'The Witness',
			sceneOutcome: 'Mira reveals the ash road witness.',
			sourceEntryIds: ['entry_2'],
		}],
		arcs: overrides.arcRows ?? [{
			id: 'arc_1',
			storyId: 'story_alpha',
			number: 1,
			title: 'Harbor Knives',
			summary: 'Guild pressure closes around Mira.',
		}],
	};

	let selectedTable: unknown;
	const selectChain = {
		from: vi.fn((table: unknown) => {
			selectedTable = table;
			return selectChain;
		}),
		where: vi.fn(() => selectChain),
		orderBy: vi.fn(() => selectChain),
		limit: vi.fn((limit: number) => {
			if (selectedTable === stories) return Promise.resolve(rows.stories.slice(0, limit));
			if (selectedTable === storyEntries) return Promise.resolve(rows.storyEntries.slice(0, limit));
			if (selectedTable === entities) return Promise.resolve(rows.entities.slice(0, limit));
			if (selectedTable === factions) return Promise.resolve(rows.factions.slice(0, limit));
			if (selectedTable === storyEvents) return Promise.resolve(rows.storyEvents.slice(0, limit));
			if (selectedTable === facts) return Promise.resolve(rows.facts.slice(0, limit));
			if (selectedTable === memoryNodes) return Promise.resolve(rows.memoryNodes.slice(0, limit));
			if (selectedTable === chapters) return Promise.resolve(rows.chapters.slice(0, limit));
			if (selectedTable === arcs) return Promise.resolve(rows.arcs.slice(0, limit));
			return Promise.resolve([]);
		}),
	};

	const db = {
		select: vi.fn(() => selectChain),
		insert: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	};
	return { db };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveServiceGeneration.mockResolvedValue(resolved());
	mocks.parseJsonFromGeneratedText.mockImplementation((text: string) => JSON.parse(text));
	mocks.retrieveMemoryPacket.mockResolvedValue({
		storyId: 'story_alpha',
		query: 'What changed around Mira?',
		packet: '## Retrieved Memory Packet\n- memory_selected: Mira named the witness. [events:event_due]',
		nodes: [{
			id: 'memory_selected',
			storyId: 'story_alpha',
			type: 'scene',
			title: 'Witness named',
			content: 'Mira named the witness.',
			summary: 'Mira named the witness.',
			keywords: ['Mira', 'witness'],
			entityIds: ['entity_mira'],
			factionIds: ['faction_guild'],
			threadIds: [],
			locationId: null,
			visibility: 'player_known',
			importance: { score: 0.8, tags: [] },
			sourceEntryIds: ['entry_2', 'entry_memory_source'],
			sourceEventIds: ['event_due'],
			sourcePatchIds: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		}],
		tokenEstimate: 32,
		retrievalDebug: [],
		retrievalTrace: [],
	});
	mocks.loadGmTimelineBrief.mockResolvedValue({
		storyId: 'story_alpha',
		currentTurn: 9,
		currentWorldTime: 'Highsun',
		dueEvents: [{ id: 'event_due', type: 'reveal', status: 'due', title: 'Witness arrives', body: 'The witness reaches the road.', turnsUntilDue: 0, worldTime: 'Highsun', npcEntityIds: ['entity_mira'], factionIds: [], locationIds: [], visibility: 'player_known' }],
		recentEvents: [],
		scheduledEvents: [],
		npcEvents: [{ npcEntityId: 'entity_mira', eventIds: ['event_due'], summary: 'Mira expects the witness now.', visibility: 'player_known' }],
	});
	mocks.generateServerTextWithMetrics.mockResolvedValue({
		text: JSON.stringify({
			mode: 'context',
			brief: 'Mira and the Old Guild matter now.',
			relevantEntryIds: ['entry_2', 'entry_memory_source'],
			relevantEntityIds: ['entity_mira'],
			relevantFactionIds: ['faction_guild'],
			promptNotes: [],
			uncertainties: [],
			evidence: [{ statement: 'Mira named the witness.', sourceIds: ['memory_selected', 'event_due'] }],
		}),
		model: 'generated-model',
		endpoint: 'mock',
		durationMs: 1,
		promptChars: 100,
		responseChars: 100,
		usage: { requestTokens: null, responseTokens: null, totalTokens: null },
	});
});

describe('runSmallBrain', () => {
	it('uses smallBrain settings when available and returns a context result', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);

		const result = await runSmallBrain({
			storyId: 'story_alpha',
			mode: 'context',
			query: 'What changed around Mira?',
			sceneEntityIds: ['entity_mira'],
			limit: 2,
		});

		const generationArgs = mocks.generateServerTextWithMetrics.mock.calls[0][0] as {
			model: string;
			system: string;
			prompt: string;
			responseFormat: string;
		};
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'smallBrain');
		expect(mocks.resolveServiceGeneration).toHaveBeenCalledTimes(1);
		expect(generationArgs).toMatchObject({
			model: 'small-model',
			responseFormat: 'json_object',
		});
		expect(generationArgs.system).toContain('cheap structured reasoning worker');
		expect(generationArgs.prompt).toContain('context mode');
		expect(generationArgs.prompt).toContain('canon mode');
		expect(generationArgs.prompt).toContain('world mode');
		expect(generationArgs.prompt).toContain('entry_2');
		expect(generationArgs.prompt).toContain('entity_mira');
		expect(generationArgs.prompt).toContain('faction_guild');
		expect(generationArgs.prompt).toContain('Query focus: What changed around Mira?');
		expect(generationArgs.prompt).toContain('"relevantEntryIds":[]');
		expect(generationArgs.prompt).toContain('Relevant entry/entity/faction arrays may use only their matching Known ids');
		expect(generationArgs.prompt).toContain('memory_selected');
		expect(generationArgs.prompt).toContain('event_due');
		expect(mocks.retrieveMemoryPacket).toHaveBeenCalledWith(expect.objectContaining({
			query: 'What changed around Mira?',
			currentTurn: 9,
			sceneEntityIds: ['entity_mira'],
		}));
		expect(mocks.loadGmTimelineBrief).toHaveBeenCalledWith(expect.objectContaining({
			sceneEntityIds: ['entity_mira'],
		}));
		expect(result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			mode: 'context',
			model: 'generated-model',
			result: {
				mode: 'context',
				brief: 'Mira named the witness.',
				relevantEntryIds: ['entry_2', 'entry_memory_source'],
				relevantEntityIds: ['entity_mira'],
				relevantFactionIds: ['faction_guild'],
				promptNotes: [],
				uncertainties: [],
				evidence: [{ statement: 'Mira named the witness.', sourceIds: ['memory_selected', 'event_due'] }],
			},
			warnings: [],
		});
		expect(db.insert).not.toHaveBeenCalled();
		expect(db.update).not.toHaveBeenCalled();
		expect(db.delete).not.toHaveBeenCalled();
	});

	it('keeps hidden rows out of player-visible context prompts', async () => {
		const { db } = createDbMock({
			entityRows: [{ id: 'entity_secret', storyId: 'story_alpha', type: 'character', name: 'SECRET_ENTITY', status: 'active', visibility: 'secret', state: {}, metadata: {} }],
			eventRows: [{ id: 'event_secret', storyId: 'story_alpha', type: 'reveal', status: 'committed', title: 'SECRET_EVENT', body: 'SECRET_EVENT_BODY', visibility: 'secret', actorEntityIds: [], targetEntityIds: [], factionIds: [], sourceEntryIds: [] }],
			factRows: [{ id: 'fact_secret', storyId: 'story_alpha', type: 'observation', title: 'SECRET_FACT', statement: 'SECRET_FACT_BODY', visibility: 'secret', sourceEntryIds: [] }],
			memoryRows: [{ id: 'memory_secret', storyId: 'story_alpha', type: 'episodic', title: 'SECRET_MEMORY', content: 'SECRET_MEMORY_BODY', visibility: 'secret', entityIds: [], factionIds: [], sourceEntryIds: [] }],
		});
		mocks.getDb.mockReturnValue(db);

		await runSmallBrain({ storyId: 'story_alpha', mode: 'context', includeSecret: false });

		const prompt = mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt as string;
		expect(prompt).not.toMatch(/SECRET_(?:ENTITY|EVENT|FACT|MEMORY)/);
	});

	it('shows context mode only retrieved and focused timeline candidates', async () => {
		const { db } = createDbMock({
			entryRows: [{ id: 'entry_raw', storyId: 'story_alpha', type: 'assistant', content: 'UNRELATED_RAW_ENTRY', position: 2 }],
			entityRows: [{ id: 'entity_akeno', storyId: 'story_alpha', type: 'character', name: 'Akeno Himejima', description: 'Focused identity', status: 'active', visibility: 'player_known', state: {}, metadata: {} }],
			eventRows: [{ id: 'event_raw', storyId: 'story_alpha', title: 'UNRELATED_RAW_EVENT', body: 'UNRELATED_RAW_EVENT_BODY', visibility: 'player_known' }],
			factRows: [{ id: 'fact_raw', storyId: 'story_alpha', title: 'UNRELATED_RAW_FACT', statement: 'UNRELATED_RAW_FACT_BODY', visibility: 'player_known' }],
			memoryRows: [{ id: 'memory_raw', storyId: 'story_alpha', title: 'UNRELATED_RAW_MEMORY', content: 'UNRELATED_RAW_MEMORY_BODY', visibility: 'player_known' }],
			chapterRows: [{ id: 'chapter_raw', storyId: 'story_alpha', number: 68, title: 'UNRELATED_RAW_CHAPTER', sceneOutcome: 'UNRELATED_RAW_CHAPTER_BODY', sourceEntryIds: [] }],
			arcRows: [{ id: 'arc_raw', storyId: 'story_alpha', number: 9, title: 'UNRELATED_RAW_ARC', summary: 'UNRELATED_RAW_ARC_BODY' }],
		});
		mocks.getDb.mockReturnValue(db);
		mocks.retrieveMemoryPacket.mockResolvedValueOnce({
			storyId: 'story_alpha',
			query: 'What happened to Akeno?',
			packet: 'legacy packet text',
			nodes: [{
				id: 'memory_akeno', storyId: 'story_alpha', type: 'scene', title: 'FOCUSED_RETRIEVED', content: 'Akeno secured the pendant.', summary: 'Akeno secured the pendant.',
				keywords: [], entityIds: ['entity_akeno'], factionIds: [], threadIds: [], locationId: null, visibility: 'player_known', importance: { score: 0.8, tags: [] },
				sourceEntryIds: ['entry_akeno'], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
			}],
			tokenEstimate: 32,
			retrievalDebug: [],
			retrievalTrace: [],
		});
		mocks.loadGmTimelineBrief.mockResolvedValueOnce({
			storyId: 'story_alpha', currentTurn: 9, currentWorldTime: 'Highsun',
			dueEvents: [{ id: 'event_global', title: 'UNRELATED_GLOBAL_TIMELINE', body: 'Raynare waits elsewhere.' }],
			recentEvents: [], scheduledEvents: [],
			npcEvents: [{ npcEntityId: 'entity_akeno', eventIds: ['event_akeno'], summary: 'FOCUSED_TIMELINE: Akeno expects the pendant.', visibility: 'player_known' }],
		});
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'context', brief: 'Akeno has the pendant.', relevantEntryIds: ['entry_akeno'], relevantEntityIds: ['entity_akeno'], relevantFactionIds: [], promptNotes: [], uncertainties: [],
				evidence: [{ statement: 'Akeno secured the pendant.', sourceIds: ['memory_akeno'] }],
			}),
			model: 'generated-model', endpoint: 'mock', durationMs: 1, promptChars: 100, responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', query: 'What happened to Akeno?', sceneEntityIds: ['entity_akeno'] });

		const prompt = mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt as string;
		expect(result.ok).toBe(true);
		expect(prompt).toContain('FOCUSED_RETRIEVED');
		expect(prompt).toContain('FOCUSED_TIMELINE');
		expect(prompt).not.toMatch(/UNRELATED_(?:RAW|GLOBAL)/);
		expect(prompt).not.toMatch(/(?:Recent entries|Events|Facts|Chapters|Arcs):/);
	});

	it('compiles the usable brief from validated evidence and drops uncited prompt notes', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'context', brief: 'Mira is secretly pregnant.', relevantEntryIds: ['entry_2'], relevantEntityIds: ['entity_mira'], relevantFactionIds: [],
				promptNotes: ['Treat Mira as secretly pregnant.'], uncertainties: ['Mira may secretly be pregnant.'],
				evidence: [
					{ statement: 'Mira named the witness.', sourceIds: ['memory_selected'] },
					{ statement: 'Mira is pregnant.', sourceIds: ['memory_selected'] },
				],
			}),
			model: 'generated-model', endpoint: 'mock', durationMs: 1, promptChars: 100, responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', query: 'What changed around Mira?', sceneEntityIds: ['entity_mira'] });

		expect(result.ok).toBe(true);
		expect(result.result).toMatchObject({ brief: 'Mira named the witness.', promptNotes: [], uncertainties: [] });
		expect(JSON.stringify(result.result)).not.toContain('pregnant');
		expect(result.warnings).toContain('Discarded uncited promptNotes or uncertainties from context result.');
		expect(result.warnings.join(' ')).toMatch(/unsupported evidence details.*pregnant/i);
	});

	it('rejects evidence that attributes a cited Raynare source to focused Akeno', async () => {
		const { db } = createDbMock({
			entityRows: [{ id: 'entity_akeno', storyId: 'story_alpha', type: 'character', name: 'Akeno Himejima', description: 'Focused identity', status: 'active', visibility: 'player_known', state: {}, metadata: {} }],
		});
		mocks.getDb.mockReturnValue(db);
		mocks.retrieveMemoryPacket.mockResolvedValueOnce({
			storyId: 'story_alpha', query: 'What happened between me and Akeno?', packet: '',
			nodes: [{
				id: 'memory_raynare', storyId: 'story_alpha', type: 'chapter', title: 'Pocket dimension', content: 'Kaelion kissed Raynare and spoke about potential mates.', summary: 'Kaelion kissed Raynare and spoke about potential mates.',
				keywords: [], entityIds: [], factionIds: [], threadIds: [], locationId: null, visibility: 'player_known', importance: { score: 0.8, tags: [] },
				sourceEntryIds: ['entry_raynare'], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
			}],
			tokenEstimate: 32, retrievalDebug: [], retrievalTrace: [],
		});
		mocks.loadGmTimelineBrief.mockResolvedValueOnce({ storyId: 'story_alpha', currentTurn: 9, currentWorldTime: null, dueEvents: [], recentEvents: [], scheduledEvents: [], npcEvents: [] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'context', brief: 'Akeno remains unresolved.', relevantEntryIds: ['entry_raynare'], relevantEntityIds: ['entity_akeno'], relevantFactionIds: [], promptNotes: [], uncertainties: [],
				evidence: [{ statement: 'Kaelion kissed Akeno and discussed potential mates.', sourceIds: ['memory_raynare'] }],
			}),
			model: 'generated-model', endpoint: 'mock', durationMs: 1, promptChars: 100, responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', query: 'What happened between me and Akeno?', sceneEntityIds: ['entity_akeno'] });

		expect(result).toMatchObject({ ok: false, result: null });
		expect(result.warnings.join(' ')).toMatch(/unsupported evidence attribution.*Akeno/i);
	});

	it('rejects unsupported details even when the cited source matches the focused entity', async () => {
		const { db } = createDbMock({
			entityRows: [{ id: 'entity_raynare', storyId: 'story_alpha', type: 'character', name: 'Raynare', description: 'Focused identity', status: 'active', visibility: 'player_known', state: {}, metadata: {} }],
		});
		mocks.getDb.mockReturnValue(db);
		mocks.retrieveMemoryPacket.mockResolvedValueOnce({
			storyId: 'story_alpha', query: "What is Raynare's relationship to Kaelion's child?",
			packet: '## Retrieved Memory Packet\n- (chapter) Claimed and Loved: Raynare accepted Kaelion as her bonded mate, and a star mark appeared on her forehead.',
			nodes: [{
				id: 'memory_raynare', storyId: 'story_alpha', type: 'chapter', title: 'Claimed and Loved', content: 'Raynare accepted Kaelion as her bonded mate, and a star mark appeared on her forehead.', summary: 'Raynare accepted Kaelion as her bonded mate, and a star mark appeared on her forehead.',
				keywords: [], entityIds: ['entity_raynare'], factionIds: [], threadIds: [], locationId: null, visibility: 'player_known', importance: { score: 0.8, tags: [] },
				sourceEntryIds: ['entry_raynare'], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
			}],
			tokenEstimate: 32, retrievalDebug: [], retrievalTrace: [],
		});
		mocks.loadGmTimelineBrief.mockResolvedValueOnce({ storyId: 'story_alpha', currentTurn: 9, currentWorldTime: null, dueEvents: [], recentEvents: [], scheduledEvents: [], npcEvents: [] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'context', brief: 'Raynare is pregnant.', relevantEntryIds: ['entry_raynare'], relevantEntityIds: ['entity_raynare'], relevantFactionIds: [], promptNotes: [], uncertainties: [],
				evidence: [{ statement: "Raynare is Kaelion's bonded mate, marked with a silver star, and is pregnant with his child.", sourceIds: ['memory_raynare'] }],
			}),
			model: 'generated-model', endpoint: 'mock', durationMs: 1, promptChars: 100, responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', query: "What is Raynare's relationship to Kaelion's child?", sceneEntityIds: ['entity_raynare'] });

		expect(result).toMatchObject({ ok: false, result: null });
		expect(result.warnings.join(' ')).toMatch(/unsupported evidence details.*(?:silver|pregnant|child)/i);
	});

	it('rejects a short claim whose entity and predicate are split across sources without explicit focus ids', async () => {
		const { db } = createDbMock({
			entityRows: [{ id: 'entity_akeno', storyId: 'story_alpha', type: 'character', name: 'Akeno Himejima', description: 'Query-matched identity', status: 'active', visibility: 'player_known', state: {}, metadata: {} }],
		});
		mocks.getDb.mockReturnValue(db);
		mocks.retrieveMemoryPacket.mockResolvedValueOnce({
			storyId: 'story_alpha', query: 'Is Akeno pregnant?',
			packet: '## Retrieved Memory Packet\n- (scene) School visit: Akeno visited the school.\n- (scene) Raynare pregnancy: Raynare is pregnant.',
			nodes: [
				{
					id: 'memory_akeno', storyId: 'story_alpha', type: 'scene', title: 'School visit', content: 'Akeno visited the school.', summary: 'Akeno visited the school.',
					keywords: [], entityIds: ['entity_akeno'], factionIds: [], threadIds: [], locationId: null, visibility: 'player_known', importance: { score: 0.8, tags: [] },
					sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					id: 'memory_raynare', storyId: 'story_alpha', type: 'scene', title: 'Raynare pregnancy', content: 'Raynare is pregnant.', summary: 'Raynare is pregnant.',
					keywords: [], entityIds: ['entity_raynare'], factionIds: [], threadIds: [], locationId: null, visibility: 'player_known', importance: { score: 0.8, tags: [] },
					sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			tokenEstimate: 32, retrievalDebug: [], retrievalTrace: [],
		});
		mocks.loadGmTimelineBrief.mockResolvedValueOnce({ storyId: 'story_alpha', currentTurn: 9, currentWorldTime: null, dueEvents: [], recentEvents: [], scheduledEvents: [], npcEvents: [] });
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'context', brief: 'Akeno is pregnant.', relevantEntryIds: [], relevantEntityIds: ['entity_akeno'], relevantFactionIds: [], promptNotes: [], uncertainties: [],
				evidence: [{ statement: 'Akeno is pregnant.', sourceIds: ['memory_akeno', 'memory_raynare'] }],
			}),
			model: 'generated-model', endpoint: 'mock', durationMs: 1, promptChars: 100, responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', query: 'Is Akeno pregnant?' });

		expect(result).toMatchObject({ ok: false, result: null });
		expect(result.warnings.join(' ')).toMatch(/unsupported evidence details.*pregnant/i);
	});

	it('falls back to classifier and reports warning when smallBrain settings fail', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.resolveServiceGeneration
			.mockResolvedValueOnce({
				setting: null,
				profile: null,
				generation: {},
				systemPromptOverride: null,
				missingReason: 'smallBrain missing',
			})
			.mockResolvedValueOnce(resolved('classifier-model'));

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context' });

		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'smallBrain');
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(2, 'classifier');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].model).toBe('classifier-model');
		expect(result.ok).toBe(true);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('smallBrain');
		expect(result.warnings[0]).toContain('classifier');
	});

	it('falls back to classifier when smallBrain has no usable model', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.resolveServiceGeneration
			.mockResolvedValueOnce({
				setting: null,
				profile,
				generation: { model: '' },
				systemPromptOverride: null,
				missingReason: null,
			})
			.mockResolvedValueOnce(resolved('classifier-model'));

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context' });

		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'smallBrain');
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(2, 'classifier');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].model).toBe('classifier-model');
		expect(result.ok).toBe(true);
		expect(result.warnings.join(' ')).toContain('smallBrain');
		expect(result.warnings.join(' ')).toMatch(/classifier|fallback/);
	});

	it('falls back to classifier and reports warning when smallBrain resolution rejects', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.resolveServiceGeneration
			.mockRejectedValueOnce(new Error('smallBrain exploded'))
			.mockResolvedValueOnce(resolved('classifier-model'));

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context' });

		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(1, 'smallBrain');
		expect(mocks.resolveServiceGeneration).toHaveBeenNthCalledWith(2, 'classifier');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].model).toBe('classifier-model');
		expect(result.ok).toBe(true);
		expect(result.warnings.join(' ')).toContain('smallBrain');
		expect(result.warnings.join(' ')).toContain('fallback');
	});

	it('returns ok:false on invalid JSON parse failure', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.parseJsonFromGeneratedText.mockImplementationOnce(() => {
			throw new Error('bad json');
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context' });

		expect(result).toMatchObject({
			ok: false,
			storyId: 'story_alpha',
			mode: 'context',
			model: 'generated-model',
			result: null,
		});
		expect(result.warnings.join(' ')).toMatch(/parse|json/i);
	});

	it('validates mode mismatch as failure', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'canon' });

		expect(result).toMatchObject({
			ok: false,
			storyId: 'story_alpha',
			mode: 'canon',
			model: 'generated-model',
			result: null,
		});
		expect(result.warnings.join(' ')).toMatch(/mode/i);
	});

	it('flags missing source ids in warnings while keeping ok:true', async () => {
		const { db } = createDbMock();
		mocks.getDb.mockReturnValue(db);
		mocks.generateServerTextWithMetrics.mockResolvedValueOnce({
			text: JSON.stringify({
				mode: 'world',
				npcIntents: [{
					entityId: 'entity_missing',
					name: 'Unknown agent',
					intent: 'Lean on Mira',
					pressure: 0.5,
					evidenceEntryIds: ['entry_missing'],
				}],
				strategicPulse: [{
					factionId: 'faction_missing',
					label: 'Hidden leverage',
					pressure: 0.4,
					recommendedAttention: 'Check the next faction move.',
				}],
				wikiDrafts: [{
					title: 'Ash Road Witness',
					body: 'A contested witness thread.',
					sourceEntryIds: ['entry_ghost'],
				}],
			}),
			model: 'generated-model',
			endpoint: 'mock',
			durationMs: 1,
			promptChars: 100,
			responseChars: 100,
			usage: { requestTokens: null, responseTokens: null, totalTokens: null },
		});

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'world' });

		expect(result.ok).toBe(true);
		expect(result.result?.mode).toBe('world');
		expect(result.warnings).toEqual(expect.arrayContaining([
			'Unknown referenced entry id: entry_missing',
			'Unknown referenced entry id: entry_ghost',
			'Unknown referenced entity id: entity_missing',
			'Unknown referenced faction id: faction_missing',
		]));
	});

	it('missing story returns ok:false before generation', async () => {
		const { db } = createDbMock({ storyRows: [] });
		mocks.getDb.mockReturnValue(db);

		const result = await runSmallBrain({ storyId: 'story_missing', mode: 'context' });

		expect(result).toEqual({
			ok: false,
			storyId: 'story_missing',
			mode: 'context',
			model: '',
			result: null,
			warnings: ['Story not found: story_missing'],
		});
		expect(mocks.resolveServiceGeneration).not.toHaveBeenCalled();
		expect(mocks.generateServerTextWithMetrics).not.toHaveBeenCalled();
	});
});
