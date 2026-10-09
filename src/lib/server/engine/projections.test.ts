import { describe, expect, it } from 'vitest';
import { buildCampaignProjection, enrichFactionEntities } from './projections';

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
			entities: [{ id: 'entity_player', type: 'character', name: 'Aurion Belaerys', state: { relationship: 'self' } }],
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
			expect(projection.entities).toEqual([{ id: 'entity_player', type: 'character', name: 'Aurion Belaerys', state: { relationship: 'self' } }]);
		expect(projection.threads).toEqual([]);
		expect(projection.recentEvents).toEqual([]);
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
			threads: [{ id: 'thread_1', status: 'open', description: 'A claimant gathers support.' }],
			recentEvents: [{ id: 'event_1', status: 'scheduled', threadIds: ['thread_1'], title: 'A messenger rides' }],
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
		expect(projection.threads).toEqual([{ id: 'thread_1', status: 'open', description: 'A claimant gathers support.' }]);
		expect(projection.recentEvents).toEqual([{ id: 'event_1', status: 'scheduled', threadIds: ['thread_1'], title: 'A messenger rides' }]);
		expect((projection as any).arcs).toEqual([{ id: 'arc_1', storyId: 'story_alpha', number: 1, title: 'Eastern Rise' }]);
		expect((projection as any).sagas).toEqual([{ id: 'saga_1', storyId: 'story_alpha', number: 1, title: 'The Vermillion Court' }]);
		expect((projection as any).counts.chapters).toBe(1);
		expect((projection as any).counts.arcs).toBe(1);
		expect((projection as any).counts.sagas).toBe(1);
	});

	it('projects scratch faction promotion metadata onto its linked entity', () => {
		const [entity] = enrichFactionEntities({
			entities: [{ id: 'remapped_entity', metadata: { scratchSeed: true }, state: {} }],
			factions: [{
				id: 'remapped_faction', entityId: 'remapped_entity', storyId: 'story_alpha', name: 'Promoted House',
				goals: [], resources: {}, memberEntityIds: [], territoryIds: [], pressure: 0,
				metadata: { currentStoryEvidence: true, worldSimEnabled: true, worldSimPromoted: true, factionType: 'feudal_house' },
				createdAt: new Date(), updatedAt: new Date(),
			} as any],
			memberships: [], resources: [], goals: [], projects: [],
		});

		expect(entity.metadata).toMatchObject({
			scratchSeed: true,
			currentStoryEvidence: true,
			worldSimEnabled: true,
			worldSimPromoted: true,
			factionType: 'feudal_house',
		});
	});

	it('uses membership records over stale base members after a removal', () => {
		const [entity] = enrichFactionEntities({
			entities: [],
			factions: [{ id: 'guild', storyId: 'story_alpha', name: 'Guild', goals: [], resources: {}, memberEntityIds: ['retired'], territoryIds: [], pressure: 0, metadata: {}, createdAt: new Date(), updatedAt: new Date() } as any],
			memberships: [{ id: 'membership', factionId: 'guild', entityId: 'retired', status: 'inactive', visibility: 'player_known' } as any],
			resources: [], goals: [], projects: [],
		});
		expect((entity.state as Record<string, unknown>).knownMembers).toEqual([]);
	});

	it('projects automatic role and culture tags as passive until explicitly promoted', () => {
		const [entity] = enrichFactionEntities({
			entities: [],
			factions: [{
				id: 'faction_tag_valyrian', entityId: null, storyId: 'story_alpha', name: 'Valyrian',
				goals: ['spread Valyrian influence'], resources: {}, memberEntityIds: ['pc_aurion'], territoryIds: [], pressure: 90,
				metadata: { sourceType: 'character_faction_tag', currentStoryEvidence: true, worldSimEnabled: true, factionType: 'culture' },
				createdAt: new Date(), updatedAt: new Date(),
			} as any],
			memberships: [], resources: [], goals: [], projects: [],
		});

		expect(entity.metadata).toMatchObject({ sourceType: 'character_faction_tag' });
		expect((entity.state as Record<string, unknown>).operational).toBe(false);
	});

	it('does not preserve stale entity-only faction promotion metadata', () => {
		const [entity] = enrichFactionEntities({
			entities: [{
				id: 'remapped_entity', state: {},
				metadata: { scratchSeed: true, currentStoryEvidence: true, worldSimEnabled: true, factionType: 'feudal_house' },
			}],
			factions: [{
				id: 'remapped_faction', entityId: 'remapped_entity', storyId: 'story_alpha', name: 'Passive House',
				goals: [], resources: {}, memberEntityIds: [], territoryIds: [], pressure: 0, metadata: {},
				createdAt: new Date(), updatedAt: new Date(),
			} as any],
			memberships: [], resources: [], goals: [], projects: [],
		});

		expect(entity.metadata).toMatchObject({ scratchSeed: true });
		expect((entity.metadata as Record<string, unknown>).currentStoryEvidence).toBeUndefined();
		expect((entity.metadata as Record<string, unknown>).worldSimEnabled).toBeUndefined();
		expect((entity.metadata as Record<string, unknown>).factionType).toBeUndefined();
	});
});
