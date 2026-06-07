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
		}, { entryLimit: 80 });

		expect(projection.mode).toBe('control_surface');
		expect(projection.entries).toHaveLength(80);
		expect(projection.entries[0].id).toBe('entry_120');
		expect(projection.counts.entries).toBe(10000);
		expect(projection.counts.entities).toBe(500);
		expect(projection.cache.hitCount).toBe(100);
	});
});
