import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	memoryEmbeddingConfig: vi.fn(),
	embedMemoryText: vi.fn(),
	validateMemoryEmbeddingVector: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: mocks.getDb,
}));

vi.mock('$lib/server/memory/embeddings', () => ({
	embedMemoryText: mocks.embedMemoryText,
	memoryEmbeddingConfig: mocks.memoryEmbeddingConfig,
	validateMemoryEmbeddingVector: mocks.validateMemoryEmbeddingVector,
}));

import { attachEntityAliasesForCanonicalSearch, canonicalSearchEmbeddingText, canonicalSearchRecordText, indexCanonicalRecords, searchCanonicalWorld } from './canonicalSearch';

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	mocks.memoryEmbeddingConfig.mockReturnValue(null);
	mocks.validateMemoryEmbeddingVector.mockImplementation((value) => value);
});

describe('canonical search indexing', () => {
	it('keeps short embedding text unchanged', () => {
		const text = 'Record type: chapters\n\nTitle: The Golden Court\n\nAurion enters Yin.';

		expect(canonicalSearchEmbeddingText(text)).toBe(text);
	});

	it('caps oversized embedding text before sending it to Ollama', () => {
		const text = `Record type: transcript\n\n${'silk and gold '.repeat(600)}`;
		const capped = canonicalSearchEmbeddingText(text);

		expect(capped.length).toBeLessThanOrEqual(2400);
		expect(capped).toContain('[truncated for search indexing]');
	});

	it('indexes character current state and event memory even when metadata exists', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_mira',
			type: 'character',
			name: 'Mira',
			description: 'A harbor negotiator.',
			status: 'active',
			visibility: 'player_known',
			state: {
				currentAction: 'holding the bridge bargain together',
				emotionalState: 'controlled fear under professional calm',
				goals: ['keep the bridge bargain alive'],
				eventMemory: {
					saw: ['Mira saw Valen hesitate at the bridge.'],
					knows: ['Mira knows the bridge bargain has a hidden witness.'],
				},
			},
			metadata: { entityResolver: { decision: 'update' } },
		});

		expect(text).toContain('Current action: holding the bridge bargain together');
		expect(text).toContain('Emotional state: controlled fear under professional calm');
		expect(text).toContain('Goals: keep the bridge bargain alive');
		expect(text).toContain('Memory saw: Mira saw Valen hesitate at the bridge.');
		expect(text).toContain('Memory knows: Mira knows the bridge bargain has a hidden witness.');
		expect(text).toContain('Metadata: {"entityResolver":{"decision":"update"}}');
	});

	it('promotes metadata character event memory into search text', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_mira',
			type: 'character',
			name: 'Mira',
			state: {},
			metadata: {
				eventMemory: {
					knows: ['Mira knows the ledger names Zhen.'],
				},
			},
		});

		expect(text).toContain('Memory knows: Mira knows the ledger names Zhen.');
	});

	it('promotes metadata character current state into search text', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_mira',
			type: 'character',
			name: 'Mira',
			state: {
				goals: ['protect Aurion'],
			},
			metadata: {
				status: 'wanted by the guard captain',
				currentAction: 'guarding the ledger room',
				emotionalState: 'controlled fear under court composure',
				relationship: { status: 'reluctant ally', level: 62 },
				goals: ['expose the harbor witness'],
				pressures: ['the guard captain is searching for the ledger'],
			},
		});

		expect(text).toContain('Character status: wanted by the guard captain');
		expect(text).toContain('Current action: guarding the ledger room');
		expect(text).toContain('Emotional state: controlled fear under court composure');
		expect(text).toContain('Relationship: reluctant ally, level 62');
		expect(text).toContain('Goals: protect Aurion; expose the harbor witness');
		expect(text).toContain('Pressures: the guard captain is searching for the ledger');
	});

	it('adds entity alias rows to character search text', () => {
		const [row] = attachEntityAliasesForCanonicalSearch([{
			id: 'entity_zhen',
			type: 'character',
			name: 'Vermillion Zhen Lian',
			state: { aliases: ['Empress Zhen'] },
			metadata: {},
		}], [
			{ entity_id: 'entity_zhen', alias: 'Zhen Lian' },
			{ entity_id: 'entity_zhen', alias: 'The Vermillion Empress' },
		]);

		const text = canonicalSearchRecordText('entities', row);

		expect(text).toContain('Aliases: Empress Zhen; Zhen Lian; The Vermillion Empress');
	});

	it('promotes metadata character aliases into search text', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_aurion',
			type: 'character',
			name: 'Aurion Balaerys',
			state: {},
			metadata: { aliases: ['Aegon Targaryen', 'Golden Dragon'] },
		});

		expect(text).toContain('Aliases: Aegon Targaryen; Golden Dragon');
	});

	it('promotes snake_case character faction tags into search text', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_aurion',
			type: 'character',
			name: 'Aurion Balaerys',
			state: { faction_tags: ['Hidden Dragon Claim'] },
			metadata: {},
		});

		expect(text).toContain('Faction tags: Hidden Dragon Claim');
	});

	it('promotes metadata character faction tags into search text', () => {
		const text = canonicalSearchRecordText('entities', {
			id: 'entity_aurion',
			type: 'character',
			name: 'Aurion Balaerys',
			state: {},
			metadata: {
				factionTags: ['House Balaerys'],
				faction_tags: ['Hidden Dragon Claim'],
			},
		});

		expect(text).toContain('Faction tags: House Balaerys; Hidden Dragon Claim');
	});

	it('targets a requested record id during manual reindex jobs', async () => {
		const inserted: Array<Record<string, unknown>> = [];
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([
				{ id: 'entity_old', story_id: 'story_1', type: 'character', name: 'Old' },
				{ id: 'entity_keep', story_id: 'story_1', type: 'character', name: 'Keep' },
			]),
			insert: () => ({
				values: (value: Record<string, unknown>) => {
					inserted.push(value);
					return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
				},
			}),
		});

		const result = await indexCanonicalRecords({
			storyId: 'story_1',
			recordTypes: ['entities'],
			recordId: 'entity_keep',
		});

		expect(result).toMatchObject({ indexed: 0, skipped: 1 });
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			storyId: 'story_1',
			recordType: 'entities',
			recordId: 'entity_keep',
			status: 'skipped',
			metadata: { payloadVersion: 2 },
		});
	});

	it('keeps semantic character search wired to indexed entity records', async () => {
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		mocks.validateMemoryEmbeddingVector.mockReturnValue([0.1, 0.2, 0.3]);
		mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			result: [
				{ score: 0.91, payload: { recordType: 'entities', recordId: 'entity_mira', title: 'Mira', entityType: 'character' } },
				{ score: 0.89, payload: { recordType: 'entities', recordId: 'entity_yin', title: 'Yin', entityType: 'location' } },
			],
		}), { status: 200 })));

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'bridge bargain',
			type: 'characters',
			includeSemantic: true,
		});

		expect(result.results).toEqual([expect.objectContaining({
			source: 'semantic',
			recordType: 'characters',
			recordId: 'entity_mira',
			title: 'Mira',
		})]);
	});
});
