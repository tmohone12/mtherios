import { describe, expect, it } from 'vitest';
import {
	buildEngineCacheKey,
	createMemoryEngineCacheRepository,
	getEngineCacheStatus,
	readEngineCacheSegment,
	recordEngineCacheSegment,
} from './cache';

describe('engine cache', () => {
	it('records misses and hits by stable content and dependency hashes', async () => {
		const repo = createMemoryEngineCacheRepository();
		const cacheKey = buildEngineCacheKey({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			parts: ['base-rules', 'v1'],
		});

		const first = await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			cacheKey,
			value: 'Rules stay stable across many turns.',
			tokenEstimate: 8,
			dependencyHashes: ['rules-a'],
		}, repo);
		const second = await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			cacheKey,
			value: 'Rules stay stable across many turns.',
			tokenEstimate: 8,
			dependencyHashes: ['rules-a'],
		}, repo);
		const third = await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			cacheKey,
			value: 'Rules stay stable across many turns.',
			tokenEstimate: 8,
			dependencyHashes: ['rules-b'],
		}, repo);

		expect(first.hit).toBe(false);
		expect(first.entry.missCount).toBe(1);
		expect(second.hit).toBe(true);
		expect(second.entry.hitCount).toBe(1);
		expect(third.hit).toBe(false);
		expect(third.entry.hitCount).toBe(1);
		expect(third.entry.missCount).toBe(2);
	});

	it('returns bounded prompt segment diagnostics without cached prompt text', async () => {
		const repo = createMemoryEngineCacheRepository();
		const rulesKey = buildEngineCacheKey({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			parts: ['core-rules', 'v1'],
		});
		const characterKey = buildEngineCacheKey({
			storyId: 'story_alpha',
			kind: 'character_sheet',
			parts: ['npc_mira', 'v1'],
		});

		await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			cacheKey: rulesKey,
			value: 'Rules stay stable across many turns.',
			tokenEstimate: 8,
			dependencyHashes: ['rules-a'],
			metadata: { sourcePath: 'rules/core.md' },
		}, repo);
		await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'rules_pack',
			cacheKey: rulesKey,
			value: 'Rules stay stable across many turns.',
			tokenEstimate: 8,
			dependencyHashes: ['rules-a'],
			metadata: { sourcePath: 'rules/core.md' },
		}, repo);
		await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'character_sheet',
			cacheKey: characterKey,
			value: 'Mira is sharp-eyed and wary.',
			tokenEstimate: 12,
			dependencyHashes: ['npc-mira-a'],
		}, repo);
		await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'character_sheet',
			cacheKey: characterKey,
			value: 'Mira is sharp-eyed, wary, and newly allied.',
			tokenEstimate: 14,
			dependencyHashes: ['npc-mira-b'],
		}, repo);
		await recordEngineCacheSegment({
			storyId: 'story_beta',
			kind: 'rules_pack',
			cacheKey: buildEngineCacheKey({ storyId: 'story_beta', kind: 'rules_pack', parts: ['other'] }),
			value: 'Other story rules.',
		}, repo);

		const status = await getEngineCacheStatus('story_alpha', {
			includeSegments: true,
			segmentLimit: 10,
			kind: 'character_sheet',
			repository: repo,
		});

		expect(status).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			entryCount: 2,
			hitCount: 1,
			missCount: 3,
			tokenEstimate: 22,
		}));
		expect(status.byKind).toEqual([
			expect.objectContaining({
				kind: 'character_sheet',
				entryCount: 1,
				hitCount: 0,
				missCount: 2,
				tokenEstimate: 14,
				invalidatedCount: 1,
			}),
			expect.objectContaining({
				kind: 'rules_pack',
				entryCount: 1,
				hitCount: 1,
				missCount: 1,
				tokenEstimate: 8,
				invalidatedCount: 0,
			}),
		]);
		expect(status.segments).toEqual([
			expect.objectContaining({
				kind: 'character_sheet',
				cacheKey: characterKey,
				tokenEstimate: 14,
				hitCount: 0,
				missCount: 2,
				invalidatedCount: 1,
				dependencyHashes: ['npc-mira-b'],
			}),
		]);
		expect(status.segments?.[0]).not.toHaveProperty('value');
		expect(status.segments?.[0]).toHaveProperty('contentHash');
	});

	it('reads cached segment values only when dependency hashes still match', async () => {
		const repo = createMemoryEngineCacheRepository();
		const cacheKey = buildEngineCacheKey({
			storyId: 'story_alpha',
			kind: 'wiki_context',
			parts: ['query', 'mira'],
		});

		await recordEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'wiki_context',
			cacheKey,
			value: '# Wiki Context\nMira knows the harbor.',
			dependencyHashes: ['wiki/mira.md:hash-a'],
		}, repo);

		const hit = await readEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'wiki_context',
			cacheKey,
			dependencyHashes: ['wiki/mira.md:hash-a'],
		}, repo);
		const stale = await readEngineCacheSegment({
			storyId: 'story_alpha',
			kind: 'wiki_context',
			cacheKey,
			dependencyHashes: ['wiki/mira.md:hash-b'],
		}, repo);
		const status = await getEngineCacheStatus('story_alpha', {
			includeSegments: true,
			kind: 'wiki_context',
			repository: repo,
		});

		expect(hit?.value).toBe('# Wiki Context\nMira knows the harbor.');
		expect(hit?.hitCount).toBe(1);
		expect(stale).toBeNull();
		expect(status.hitCount).toBe(1);
		expect(status.segments?.[0]).not.toHaveProperty('value');
	});
});
