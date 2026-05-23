import { describe, expect, it } from 'vitest';
import { buildMemoryPacket, scoreMemoryNode } from './ranking';
import type { MemoryNode, MemoryRetrieveRequest } from '$lib/contracts/memory';

function node(overrides: Partial<MemoryNode>): MemoryNode {
	return {
		id: overrides.id ?? 'mem_1',
		storyId: 'story_1',
		type: overrides.type ?? 'episodic',
		title: overrides.title ?? 'Old promise',
		content: overrides.content ?? 'Ser Arlan promised to open the postern gate before dawn.',
		summary: overrides.summary ?? null,
		keywords: overrides.keywords ?? [],
		entityIds: overrides.entityIds ?? [],
		factionIds: overrides.factionIds ?? [],
		threadIds: overrides.threadIds ?? [],
		locationId: overrides.locationId ?? null,
		visibility: overrides.visibility ?? 'player_known',
		importance: overrides.importance ?? 0.5,
		sourceEntryIds: overrides.sourceEntryIds ?? [],
		sourceEventIds: overrides.sourceEventIds ?? [],
		sourcePatchIds: overrides.sourcePatchIds ?? [],
		createdAt: '2026-05-17T00:00:00.000Z',
		updatedAt: '2026-05-17T00:00:00.000Z',
		...overrides,
	};
}

const request: MemoryRetrieveRequest = {
	storyId: 'story_1',
	query: 'Ask Arlan about the gate promise',
	sceneEntityIds: ['npc_arlan'],
	locationId: 'loc_keep',
	threadIds: ['thread_gate'],
	presentNpcIds: ['npc_arlan'],
	includeSecret: false,
	tokenBudget: 420,
};

describe('backend memory ranking', () => {
	it('boosts exact action terms, scene entities, location, and open threads', () => {
		const relevant = node({
			id: 'relevant',
			entityIds: ['npc_arlan'],
			threadIds: ['thread_gate'],
			locationId: 'loc_keep',
			keywords: ['promise', 'gate'],
		});
		const unrelated = node({
			id: 'unrelated',
			title: 'Distant feast',
			content: 'A bard played under summer lanterns.',
			importance: 0.1,
		});

		expect(scoreMemoryNode(relevant, request)).toBeGreaterThan(scoreMemoryNode(unrelated, request));
	});

	it('keeps secret memories out unless explicitly allowed', () => {
		const secret = node({ visibility: 'secret', importance: 1 });
		expect(scoreMemoryNode(secret, request)).toBeLessThan(0);
	});

	it('builds a compact source-linked packet within the requested budget', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'promise',
				sourceEventIds: ['event_1'],
				sourceEntryIds: ['entry_1'],
				entityIds: ['npc_arlan'],
				threadIds: ['thread_gate'],
				locationId: 'loc_keep',
			}),
			node({
				id: 'secret',
				visibility: 'secret',
				content: 'Hidden canon that should not leak.',
				importance: 1,
			}),
		], request);

		expect(packet.nodes.map(item => item.id)).toContain('promise');
		expect(packet.nodes.map(item => item.id)).not.toContain('secret');
		expect(packet.packet).toContain('events:event_1');
		expect(packet.tokenEstimate).toBeLessThanOrEqual(request.tokenBudget);
	});
});
