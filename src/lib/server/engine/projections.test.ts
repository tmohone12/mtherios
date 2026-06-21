import { describe, expect, it } from 'vitest';
import { buildCampaignProjection } from './projections';

describe('campaign projections', () => {
	it('returns a bounded control-surface projection for long campaigns', () => {
		const entries = Array.from({ length: 200 }, (_, index) => ({
			id: `entry_${index}`,
			position: index,
			type: index % 2 === 0 ? 'user_action' : 'narration',
			content: `Entry ${index}`,
		}));

		const projection = buildCampaignProjection({
			story: {
				id: 'story_alpha',
				title: 'Long Campaign',
				serverVersion: 12,
				currentTurn: 10000,
				currentWorldTime: 'Year 12',
			},
			entries,
			entryCount: 10000,
			entityCount: 500,
			eventCount: 1200,
			memoryNodeCount: 900,
			vaultStatus: {
				vaultPath: 'data/vaults/campaigns/story_alpha',
				fileCount: 3000,
				lastIndexedVersion: 12,
			},
			cacheStatus: {
				storyId: 'story_alpha',
				entryCount: 25,
				hitCount: 100,
				missCount: 10,
				tokenEstimate: 2000,
				byKind: [{ kind: 'rules_pack', entryCount: 2, hitCount: 10, missCount: 1, invalidatedCount: 0, tokenEstimate: 120 }],
				segments: [],
			},
		} as any, { entryLimit: 80 });

		expect(projection.mode).toBe('control_surface');
		expect(projection.entries).toHaveLength(80);
		expect(projection.entries[0].id).toBe('entry_120');
		expect(projection.counts.entries).toBe(10000);
		expect(projection.counts.entities).toBe(500);
		expect(projection.cache.hitCount).toBe(100);
	});

	it('carries complete chapter arc and saga records for local control-surface reconciliation', () => {
		const projection = buildCampaignProjection({
			story: {
				id: 'story_alpha',
				title: 'Long Campaign',
				serverVersion: 12,
			},
			entries: [],
			chapters: [{ id: 'chapter_1', storyId: 'story_alpha', number: 1, title: 'Gold Court' }],
			arcs: [{ id: 'arc_1', storyId: 'story_alpha', number: 1, title: 'Eastern Rise' }],
			sagas: [{ id: 'saga_1', storyId: 'story_alpha', number: 1, title: 'The Vermillion Court' }],
			entryCount: 0,
			entityCount: 500,
			eventCount: 1200,
			memoryNodeCount: 900,
			chapterCount: 1,
			arcCount: 1,
			sagaCount: 1,
			vaultStatus: {
				vaultPath: 'data/vaults/campaigns/story_alpha',
				fileCount: 3000,
				lastIndexedVersion: 12,
			},
			cacheStatus: {
				storyId: 'story_alpha',
				entryCount: 25,
				hitCount: 100,
				missCount: 10,
				tokenEstimate: 2000,
				byKind: [],
				segments: [],
			},
		} as any, { entryLimit: 80 });

		expect((projection as any).chapters).toEqual([{ id: 'chapter_1', storyId: 'story_alpha', number: 1, title: 'Gold Court' }]);
		expect((projection as any).arcs).toEqual([{ id: 'arc_1', storyId: 'story_alpha', number: 1, title: 'Eastern Rise' }]);
		expect((projection as any).sagas).toEqual([{ id: 'saga_1', storyId: 'story_alpha', number: 1, title: 'The Vermillion Court' }]);
		expect((projection as any).counts.chapters).toBe(1);
		expect((projection as any).counts.arcs).toBe(1);
		expect((projection as any).counts.sagas).toBe(1);
	});
});
