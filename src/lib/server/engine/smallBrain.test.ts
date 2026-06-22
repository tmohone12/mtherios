import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, chapters, entities, facts, factions, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	resolveServiceGeneration: vi.fn(),
	generateServerTextWithMetrics: vi.fn(),
	parseJsonFromGeneratedText: vi.fn(),
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
		storyEvents: [{
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
		facts: [{
			id: 'fact_1',
			storyId: 'story_alpha',
			type: 'observation',
			title: 'Ledger witness',
			statement: 'The ash road witness is known to Mira.',
			subjectEntityId: 'entity_mira',
			sourceEntryIds: ['entry_2'],
		}],
		memoryNodes: [{
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
		chapters: [{
			id: 'chapter_1',
			storyId: 'story_alpha',
			number: 1,
			title: 'The Witness',
			sceneOutcome: 'Mira reveals the ash road witness.',
			sourceEntryIds: ['entry_2'],
		}],
		arcs: [{
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
	mocks.generateServerTextWithMetrics.mockResolvedValue({
		text: JSON.stringify({
			mode: 'context',
			brief: 'Mira and the Old Guild matter now.',
			relevantEntryIds: ['entry_2'],
			relevantEntityIds: ['entity_mira'],
			relevantFactionIds: ['faction_guild'],
			promptNotes: ['Use Mira as the pressure anchor.'],
			uncertainties: [],
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

		const result = await runSmallBrain({ storyId: 'story_alpha', mode: 'context', limit: 2 });

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
		expect(result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			mode: 'context',
			model: 'generated-model',
			result: {
				mode: 'context',
				brief: 'Mira and the Old Guild matter now.',
				relevantEntryIds: ['entry_2'],
				relevantEntityIds: ['entity_mira'],
				relevantFactionIds: ['faction_guild'],
				promptNotes: ['Use Mira as the pressure anchor.'],
				uncertainties: [],
			},
			warnings: [],
		});
		expect(db.insert).not.toHaveBeenCalled();
		expect(db.update).not.toHaveBeenCalled();
		expect(db.delete).not.toHaveBeenCalled();
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
