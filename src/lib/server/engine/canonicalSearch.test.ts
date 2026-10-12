import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMtheriosAppConfig } from '$lib/server/app/config';

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

import { INDEXABLE_TYPES, attachEntityAliasesForCanonicalSearch, canonicalSearchCollection, canonicalSearchEmbeddingText, canonicalSearchIndexRecordId, canonicalSearchRecordIsUsable, canonicalSearchRecordText, indexCanonicalRecords, markPairedTranscriptControlResponses, searchCanonicalWorld } from './canonicalSearch';

const { syncWikiPoints } = await import(pathToFileURL(resolve(process.cwd(), 'scripts/wiki-core/lib/qdrant.mjs')).href) as {
	syncWikiPoints: (
		points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
		config: { url: string; collection: string; lockDir?: string; lockTimeoutMs?: number; lockStaleMs?: number; lockPollMs?: number },
		batchSize?: number,
	) => Promise<{ upserted: number; removed: number }>;
};

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	mocks.memoryEmbeddingConfig.mockReturnValue(null);
	mocks.validateMemoryEmbeddingVector.mockImplementation((value) => value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/** No stored index markers (the marker lookup used when embeddings are off). */
const noMarkers = (markers: unknown[] = []) => ({ from: () => ({ where: async () => markers }) });

describe('canonical search indexing', () => {
	it('rejects non-canon, merged, and terminally unusable records', () => {
		const unusable: Array<[string, Record<string, unknown>]> = [
			['transcript', { metadata: { nonCanon: true } }],
			['transcript', { metadata: { actionType: 'ooc' } }],
			['transcript', { metadata: { narrativeMode: 'ooc' } }],
			['transcript', { content: '> Game Master: reset to the emperor\'s offer.', metadata: {} }],
			['transcript', { content: '/pov God-Emperor Bu Gai | weighs the marriage offer.', metadata: {} }],
			['memoryNodes', { content: 'Narrator: correct the location.', metadata: {} }],
			['entities', { status: 'active', metadata: { mergedInto: 'entity_keep' } }],
			['entities', { status: 'inactive' }],
			['entities', { status: 'archived' }],
			['events', { status: 'cancelled' }],
			['agreements', { status: 'archived' }],
			['agreements', { status: 'deleted' }],
			['memoryNodes', { metadata: { playerDeleted: true } }],
			['patches', { status: 'rejected' }],
			['threads', { status: 'closed' }],
		];

		for (const [type, row] of unusable) expect(canonicalSearchRecordIsUsable(type, row)).toBe(false);
		expect(canonicalSearchRecordIsUsable('events', { status: 'committed', metadata: {} })).toBe(true);
		expect(canonicalSearchRecordIsUsable('transcript', {
			content: 'I tell the GM of the merchant guild that the levy is late.', metadata: {},
		})).toBe(true);
	});

	it('rejects historical narration paired to a control prefix but keeps slash-command narration', () => {
		const rows = markPairedTranscriptControlResponses([
			{ id: 'gm_reply', type: 'narration', parent_id: 'gm_control', content: 'I will reset the harbor.' },
			{ id: 'pov_reply', type: 'narration', parent_id: 'pov_command', content: 'The veiled daughter studies the offer.' },
		], [
			{ id: 'gm_control', type: 'user_action', content: 'GM: reset to the emperor\'s offer.', metadata: {} },
			{ id: 'pov_command', type: 'user_action', content: '/pov The Veiled Daughter | studies the offer.', metadata: {} },
		]);

		expect(canonicalSearchRecordIsUsable('transcript', rows[0])).toBe(false);
		expect(canonicalSearchRecordIsUsable('transcript', rows[1])).toBe(true);
	});

	it('retires a historical paired control reply during transcript index rebuild', async () => {
		const deleteWhere = vi.fn().mockResolvedValue(undefined);
		const insert = vi.fn();
		const execute = vi.fn()
			.mockResolvedValueOnce([{
				id: 'gm_reply', story_id: 'story_veil', type: 'narration', parent_id: 'gm_control',
				content: 'I will reset the harbor.', metadata: {},
			}])
			.mockResolvedValueOnce([{
				id: 'gm_control', story_id: 'story_veil', type: 'user_action',
				content: 'GM: reset to the emperor\'s offer.', metadata: {},
			}]);
		mocks.getDb.mockReturnValue({
			select: () => noMarkers(),
			execute,
			delete: vi.fn(() => ({ where: deleteWhere })),
			insert,
		});

		const result = await indexCanonicalRecords({ storyId: 'story_veil', recordTypes: ['transcript'] });

		expect(result).toMatchObject({ indexed: 0, skipped: 0, retired: 1 });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(deleteWhere).toHaveBeenCalledOnce();
		expect(insert).not.toHaveBeenCalled();
	});

	it('keeps long readable record ids collision-resistant within the storage cap', () => {
		const sharedPrefix = `event_world_tick_${'faction_project_'.repeat(16)}`;
		const first = canonicalSearchIndexRecordId('story_1', 'events', `${sharedPrefix}alpha`, 'mtherios_wiki_story_1');
		const second = canonicalSearchIndexRecordId('story_1', 'events', `${sharedPrefix}beta`, 'mtherios_wiki_story_1');

		expect(first).toHaveLength(220);
		expect(second).toHaveLength(220);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^search_story_1_events_event_world_tick_/);
		expect(first).toMatch(/_[a-f0-9]{16}$/);
		expect(canonicalSearchIndexRecordId('story_1', 'events', 'event_1', 'collection_1'))
			.toBe('search_story_1_events_event_1_collection_1');
	});

	it('retires a legacy truncated index row while reindexing a long record id', async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const deleteRow = vi.fn().mockResolvedValue(undefined);
		const db = {
			execute: vi.fn().mockResolvedValue([{
				id: `event_world_tick_${'faction_project_'.repeat(16)}alpha`,
				story_id: 'story_1',
				title: 'A long-running faction project advances',
			}]),
			select: vi.fn(() => ({
				from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
			})),
			delete: vi.fn(() => ({ where: deleteRow })),
			insert: vi.fn(() => ({
				values: (value: Record<string, unknown>) => {
					inserted.push(value);
					return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
				},
			})),
		};
		mocks.getDb.mockReturnValue(db);
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'local-hash-768', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })));

		const result = await indexCanonicalRecords({
			storyId: 'story_1',
			recordTypes: ['events'],
			maxRecords: 1,
		});

		expect(result).toMatchObject({ indexed: 1, failed: 0, partial: false });
		expect(db.delete).toHaveBeenCalledOnce();
		expect(deleteRow).toHaveBeenCalledOnce();
		expect(inserted[0]?.id).toEqual(expect.stringMatching(/_[a-f0-9]{16}$/));
		expect(String(inserted[0]?.id)).toHaveLength(220);
	});

	it('keeps repair artifacts and old memory nodes out of default indexing', () => {
		expect(INDEXABLE_TYPES).toEqual(expect.arrayContaining([
			'transcript',
			'entities',
			'events',
			'chapters',
			'arcs',
			'sagas',
		]));
		expect(INDEXABLE_TYPES).not.toEqual(expect.arrayContaining([
			'facts',
			'sourceRefs',
			'patchProposals',
			'continuityWarnings',
			'memoryNodes',
		]));
	});

	it('can search every advertised canonical type without crashing on sagas', async () => {
		const execute = vi.fn().mockResolvedValue([]);
		mocks.getDb.mockReturnValue({ execute });

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'a phrase with no matches',
			includeSemantic: false,
		});

		expect(result.results).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(INDEXABLE_TYPES.length);
	});

	it('keeps broad keyword search diverse across canonical record types', async () => {
		let call = 0;
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockImplementation(async () => {
				call += 1;
				return call === 1
					? Array.from({ length: 6 }, (_, index) => ({ id: `entry_${index}`, content: 'harbor bargain' }))
					: call === 2
						? [{ id: 'entity_mira', name: 'Mira', type: 'character' }]
						: [];
			}),
		});

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'harbor',
			limit: 4,
			includeSemantic: false,
		});

		expect(result.results.map((row) => row.recordType)).toEqual(['transcript', 'entities', 'transcript', 'transcript']);
	});

	it('filters unusable records from keyword search', async () => {
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([
				{ id: 'event_ooc', title: 'OOC harbor correction', status: 'committed', metadata: { nonCanon: true } },
				{ id: 'event_cancelled', title: 'Cancelled harbor reveal', status: 'cancelled', metadata: {} },
				{ id: 'event_live', title: 'Harbor bargain accepted', status: 'committed', metadata: {} },
			]),
		});

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'harbor',
			type: 'events',
			includeSemantic: false,
		});

		expect(result.results.map((row) => row.recordId)).toEqual(['event_live']);
	});

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
			select: () => noMarkers(),
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

	it('leaves an unchanged skipped marker alone when embeddings are off', async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const rows = [{ id: 'entity_keep', story_id: 'story_1', type: 'character', name: 'Keep' }];
		const db = (markers: unknown[]) => ({
			select: () => noMarkers(markers),
			execute: vi.fn().mockResolvedValue(rows),
			delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
			insert: () => ({ values: (value: Record<string, unknown>) => { inserted.push(value); return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }; } }),
		});
		mocks.getDb.mockReturnValue(db([]));
		await indexCanonicalRecords({ storyId: 'story_1', recordTypes: ['entities'] });
		expect(inserted).toHaveLength(1);
		const marker = { recordType: 'entities', recordId: 'entity_keep', contentHash: inserted[0].contentHash, status: 'skipped' };
		inserted.length = 0;
		mocks.getDb.mockReturnValue(db([marker]));
		await expect(indexCanonicalRecords({ storyId: 'story_1', recordTypes: ['entities'] })).resolves.toMatchObject({ skipped: 0, unchanged: 1 });
		expect(inserted).toHaveLength(0);
	});

	it('paginates through canonical tables instead of dropping records after the old 2000-row ceiling', async () => {
		let page = 0;
		const insert = vi.fn(() => ({
			values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
		}));
		mocks.getDb.mockReturnValue({
			select: () => noMarkers(),
			execute: vi.fn().mockImplementation(async () => {
				const current = page++;
				if (current < 4) return Array.from({ length: 500 }, (_, index) => ({
					id: `event_${current * 500 + index}`,
					title: 'Indexed event',
				}));
				return current === 4 ? [{ id: 'event_2000', title: 'The formerly unreachable event' }] : [];
			}),
			insert,
		});

		const result = await indexCanonicalRecords({ storyId: 'story_1', recordTypes: ['events'] });

		expect(result).toMatchObject({ indexed: 0, skipped: 2001 });
		expect(insert).toHaveBeenCalledTimes(2001);
		expect(page).toBe(5);
	});

	it('clears stale SQL index markers when recreating a deleted Qdrant collection', async () => {
		const deleteWhere = vi.fn().mockResolvedValue(undefined);
		const inserted: Array<Record<string, unknown>> = [];
		const insert = vi.fn(() => ({
			values: (value: Record<string, unknown>) => {
				inserted.push(value);
				return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
			},
		}));
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([{ id: 'event_1', title: 'Freshly rebuilt event' }]),
			delete: vi.fn(() => ({ where: deleteWhere })),
			insert,
		});
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response('', { status: 404 }))
			.mockImplementation(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await indexCanonicalRecords({
			storyId: 'story_1',
			recordTypes: ['events'],
			recreate: true,
			maxRecords: 1,
		});

		expect(result).toMatchObject({ indexed: 1, failed: 0, partial: false });
		expect(deleteWhere).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledOnce();
	});

	it('preserves wiki points and holds the lock through a full canonical recreate before wiki sync can start', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-canonical-lock-'));
		vi.stubEnv('MTHERIOS_QDRANT_LOCK_DIR', lockDir);
		const storyId = 'story_full_recreate_lock';
		const collection = canonicalSearchCollection(storyId);
		const appConfig = getMtheriosAppConfig();
		const operations: string[] = [];
		let releaseMarkerDelete!: () => void;
		let markerDeleteStarted!: () => void;
		const markerDeleteGate = new Promise<void>((resolveGate) => { releaseMarkerDelete = resolveGate; });
		const markerDeleteSeen = new Promise<void>((resolveSeen) => { markerDeleteStarted = resolveSeen; });
		const markerDelete = vi.fn(async () => {
			operations.push('recreate:markers');
			markerDeleteStarted();
			await markerDeleteGate;
		});
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([]),
			delete: vi.fn(() => ({ where: markerDelete })),
		});
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 1 });
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			if (method === 'GET' && url.endsWith(`/collections/${collection}`)) {
				operations.push('recreate:get');
				return new Response(JSON.stringify({ result: { status: 'green' } }), { status: 200 });
			}
			if (method === 'PUT' && url.endsWith(`/collections/${collection}`)) {
				operations.push('recreate:create');
				return new Response('{}', { status: 200 });
			}
			if (url.endsWith('/points/delete?wait=true')) {
				operations.push('recreate:canonical-delete');
				return new Response('{}', { status: 200 });
			}
			if (url.endsWith('/points?wait=true')) {
				operations.push('sync:upsert');
				return new Response('{}', { status: 200 });
			}
			if (url.endsWith('/points/scroll')) {
				operations.push('sync:scroll');
				return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), { status: 200 });
			}
			throw new Error(`Unexpected Qdrant request: ${method} ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const recreate = indexCanonicalRecords({ storyId, recreate: true });
			await markerDeleteSeen;
			const sync = syncWikiPoints(
				[{ id: 'wiki-current', vector: [0.1], payload: { kind: 'wiki_chunk' } }],
				{ url: appConfig.qdrantUrl, collection, lockDir, lockPollMs: 5, lockTimeoutMs: 2_000 },
			);
			await new Promise((resolveWait) => setTimeout(resolveWait, 40));
			expect(operations).toEqual([
				'recreate:get',
				...INDEXABLE_TYPES.map(() => 'recreate:canonical-delete'),
				'recreate:markers',
			]);

			releaseMarkerDelete();
			await Promise.all([recreate, sync]);
			expect(operations).toEqual([
				'recreate:get',
				...INDEXABLE_TYPES.map(() => 'recreate:canonical-delete'),
				'recreate:markers',
				'sync:upsert',
				'sync:scroll',
			]);
		} finally {
			releaseMarkerDelete();
			await rm(lockDir, { recursive: true, force: true });
		}
	});

	it('keeps an incremental canonical writer serialized with wiki sync after ensure', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-canonical-lock-'));
		vi.stubEnv('MTHERIOS_QDRANT_LOCK_DIR', lockDir);
		const storyId = 'story_incremental_lock';
		const collection = canonicalSearchCollection(storyId);
		const appConfig = getMtheriosAppConfig();
		const operations: string[] = [];
		let releaseEmbedding!: () => void;
		let embeddingStarted!: () => void;
		const embeddingGate = new Promise<void>((resolveGate) => { releaseEmbedding = resolveGate; });
		const embeddingSeen = new Promise<void>((resolveSeen) => { embeddingStarted = resolveSeen; });
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([{ id: 'event_current', title: 'Current event' }]),
			select: vi.fn(() => ({
				from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
			})),
			insert: vi.fn(() => ({
				values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
			})),
		});
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 1 });
		mocks.embedMemoryText.mockImplementation(async () => {
			operations.push('canonical:embed');
			embeddingStarted();
			await embeddingGate;
			return [0.1];
		});
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			if (method === 'GET' && url.endsWith(`/collections/${collection}`)) {
				operations.push('canonical:ensure');
				return new Response(JSON.stringify({ result: { status: 'green' } }), { status: 200 });
			}
			if (url.endsWith('/points?wait=true')) {
				const body = JSON.parse(String(init?.body ?? '{}')) as { points?: Array<{ payload?: { kind?: string } }> };
				operations.push(body.points?.[0]?.payload?.kind === 'canonical_record' ? 'canonical:upsert' : 'sync:upsert');
				return new Response('{}', { status: 200 });
			}
			if (url.endsWith('/points/scroll')) {
				operations.push('sync:scroll');
				return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), { status: 200 });
			}
			throw new Error(`Unexpected Qdrant request: ${method} ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const canonical = indexCanonicalRecords({ storyId, recordTypes: ['events'], maxRecords: 1 });
			await embeddingSeen;
			const sync = syncWikiPoints(
				[{ id: 'wiki-current', vector: [0.1], payload: { kind: 'wiki_chunk' } }],
				{ url: appConfig.qdrantUrl, collection, lockDir, lockPollMs: 5, lockTimeoutMs: 2_000 },
			);
			await new Promise((resolveWait) => setTimeout(resolveWait, 40));
			expect(operations).toEqual(['canonical:ensure', 'canonical:embed']);

			releaseEmbedding();
			await Promise.all([canonical, sync]);
			expect(operations).toEqual([
				'canonical:ensure',
				'canonical:embed',
				'canonical:upsert',
				'sync:upsert',
				'sync:scroll',
			]);
		} finally {
			releaseEmbedding();
			await rm(lockDir, { recursive: true, force: true });
		}
	});

	it('retires the stale point and marker when targeted canon becomes unusable', async () => {
		const deleteWhere = vi.fn().mockResolvedValue(undefined);
		const db = {
			execute: vi.fn().mockResolvedValue([{
				id: 'event_rejected_harbor',
				title: 'Rejected harbor correction',
				status: 'cancelled',
				metadata: { nonCanon: true },
			}]),
			delete: vi.fn(() => ({ where: deleteWhere })),
			insert: vi.fn(),
		};
		mocks.getDb.mockReturnValue(db);
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await indexCanonicalRecords({
			storyId: 'story_1',
			recordTypes: ['events'],
			recordId: 'event_rejected_harbor',
		});

		expect(result).toMatchObject({ indexed: 0, failed: 0, retired: 1, partial: false });
		expect(db.insert).not.toHaveBeenCalled();
		expect(db.delete).toHaveBeenCalledOnce();
		expect(deleteWhere).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const deleteRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(deleteRequest.filter.must).toEqual(expect.arrayContaining([
			{ key: 'recordType', match: { value: 'events' } },
			{ key: 'recordId', match: { value: 'event_rejected_harbor' } },
		]));
	});

	it('keeps semantic character search wired to indexed entity records', async () => {
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		mocks.validateMemoryEmbeddingVector.mockReturnValue([0.1, 0.2, 0.3]);
		mocks.getDb.mockReturnValue({
			execute: vi.fn().mockResolvedValue([{ id: 'entity_mira', type: 'character', name: 'Mira' }]),
		});
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			result: [
				{ score: 0.99, payload: { path: 'wiki/lore.md', title: 'Unrelated wiki result' } },
				{ score: 0.91, payload: { recordType: 'entities', recordId: 'entity_mira', title: 'Mira', entityType: 'character' } },
				{ score: 0.89, payload: { recordType: 'entities', recordId: 'entity_yin', title: 'Yin', entityType: 'location' } },
			],
		}), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

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
		const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(requestBody.filter).toEqual({
			must: [
				{ key: 'kind', match: { value: 'canonical_record' } },
				{ key: 'storyId', match: { value: 'story_1' } },
				{ key: 'recordType', match: { value: 'entities' } },
				{ key: 'entityType', match: { value: 'character' } },
			],
		});
	});

	it('does not return deleted canon that remains in Qdrant', async () => {
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			result: [{
				score: 0.99,
				payload: { recordType: 'factions', recordId: 'faction_deleted', title: 'Deleted Faction' },
			}],
		}), { status: 200 })));

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'deleted faction',
			type: 'factions',
		});

		expect(result.results).toEqual([]);
		expect(result.warnings).toContain('Ignored 1 deleted or stale semantic result.');
	});

	it('does not return live-but-unusable canon that remains in Qdrant', async () => {
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		const execute = vi.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: 'event_ooc', status: 'committed', metadata: { actionType: 'ooc' } }])
			.mockResolvedValueOnce([{ id: 'event_live', status: 'committed', metadata: {} }]);
		mocks.getDb.mockReturnValue({ execute });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			result: [
				{ score: 0.99, payload: { recordType: 'events', recordId: 'event_ooc', title: 'OOC event' } },
				{ score: 0.91, payload: { recordType: 'events', recordId: 'event_live', title: 'Live event' } },
			],
		}), { status: 200 })));

		const result = await searchCanonicalWorld({
			storyId: 'story_1',
			query: 'harbor event',
			type: 'events',
		});

		expect(result.results.map((row) => row.recordId)).toEqual(['event_live']);
		expect(result.warnings).toContain('Ignored 1 deleted or stale semantic result.');
	});

	it('surfaces semantic fallback when the story index is missing', async () => {
		mocks.memoryEmbeddingConfig.mockReturnValue({ model: 'test-embed', dimensions: 3 });
		mocks.embedMemoryText.mockResolvedValue([0.1, 0.2, 0.3]);
		mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

		const result = await searchCanonicalWorld({ storyId: 'story_1', query: 'missing index' });

		expect(result.results).toEqual([]);
		expect(result.warnings).toEqual([
			expect.stringContaining('Canonical semantic index is missing'),
		]);
	});
});
