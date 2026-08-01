import { describe, expect, it } from 'vitest';
import { buildMemoryPacket, lookupMentioned, memoryQueryTokens, scoreMemoryNode } from './ranking';
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
	it('resolves names inside sentence queries without treating pronouns as lore terms', () => {
		expect(lookupMentioned('I ask Lady Mara about her father.', 'Lady Mara')).toBe(true);
		expect(lookupMentioned('I ask her about her father.', 'Lady Mara')).toBe(false);
		expect(memoryQueryTokens('I ask her about her father')).toEqual(['father']);
	});

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

	it('trims oversized memory nodes before they can break the requested budget', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'giant_arc',
				type: 'plot_ledger',
				title: 'Arc 3: Oversized Rollup',
				summary: `Important opening fact. ${'raw chapter wall '.repeat(2000)} Oversized memory tail sentinel.`,
				content: `Important opening fact. ${'raw chapter wall '.repeat(2000)} Oversized memory tail sentinel.`,
				importance: 1,
			}),
			node({
				id: 'small_fact',
				title: 'Useful small fact',
				summary: 'Arlan still remembers the gate promise.',
				content: 'Arlan still remembers the gate promise.',
				importance: 0.8,
			}),
		], request);

		expect(packet.packet).toContain('Important opening fact.');
		expect(packet.packet).not.toContain('Oversized memory tail sentinel');
		expect(packet.tokenEstimate).toBeLessThanOrEqual(request.tokenBudget);
	});

	it('keeps OOC repair notes out of retrieved canon memory', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'ooc_repair_note',
				title: 'OOC correction',
				summary: '**OOC:** I overreached and created poisoned context. Do not treat this as canon.',
				content: '**OOC:** I overreached and created poisoned context. Do not treat this as canon.',
				keywords: ['Arlan', 'gate', 'promise'],
				entityIds: ['npc_arlan'],
				importance: 1,
			}),
			node({
				id: 'real_gate_memory',
				title: 'Gate promise',
				summary: 'Arlan promised to open the postern gate before dawn.',
				content: 'Arlan promised to open the postern gate before dawn.',
				keywords: ['gate', 'promise'],
				entityIds: ['npc_arlan'],
				importance: 0.9,
			}),
		], request);

		expect(packet.nodes.map((item) => item.id)).toContain('real_gate_memory');
		expect(packet.nodes.map((item) => item.id)).not.toContain('ooc_repair_note');
		expect(packet.packet).not.toContain('poisoned context');
		expect(packet.retrievalDebug).toContain('filteredUnsafe=1');
	});

	it('renders Mtherios checkpoint memories as readable story memory', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'chapter_checkpoint',
				title: 'The Gate Chapter',
				summary: [
					'[CHECKPOINT = Chapter checkpoint covering transcript positions 1-40.]',
					'[SOURCE COVERAGE =',
					'- 40 entries covered.',
					']',
					'[RECENT STORY STATE =',
					'- Arlan admits he promised to open the postern gate before dawn.',
					']',
					'[CHARACTER STATE =',
					'Arlan [npc_arlan]:',
					'- Frightened, cornered, and still bound by the gate promise.',
					']',
					'[ACTIVE THREADS =',
					'- Whether Arlan keeps the gate promise.',
					']',
				].join('\n'),
				content: 'fallback content',
				keywords: ['Arlan', 'gate', 'promise'],
				entityIds: ['npc_arlan'],
				importance: 1,
			}),
		], request);

		expect(packet.packet).toContain('Arlan admits he promised to open the postern gate before dawn.');
		expect(packet.packet).toContain('Characters: Arlan [npc_arlan]:');
		expect(packet.packet).not.toContain('[CHECKPOINT');
		expect(packet.packet).not.toContain('SOURCE COVERAGE');
	});

	it('returns an explainable selected and dropped retrieval trace', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'selected_memory',
				title: 'Gate promise',
				content: 'Arlan promised the gate would open.',
				entityIds: ['npc_arlan'],
				threadIds: ['thread_gate'],
				locationId: 'loc_keep',
				sourceEventIds: ['event_gate'],
				importance: 0.9,
			}),
			node({
				id: 'dropped_secret',
				title: 'Hidden betrayal',
				content: 'Secret fact.',
				visibility: 'secret',
				importance: 1,
			}),
		], request);

		expect(packet.retrievalTrace.map((item) => item.id)).toContain('selected_memory');
		expect(packet.retrievalTrace).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: 'selected_memory',
				included: true,
				reason: 'selected',
				entityIds: ['npc_arlan'],
				sourceEventIds: ['event_gate'],
				tokenEstimate: expect.any(Number),
			}),
			expect.objectContaining({
				id: 'dropped_secret',
				included: false,
				reason: 'low_score',
			}),
		]));
		expect(packet.retrievalTrace[0].signals.length).toBeGreaterThan(0);
	});

	it('combines vector similarity with keyword relevance and reports score signals', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'vector_memory',
				title: 'Gate promise',
				content: 'Arlan promised the gate would open before dawn.',
				keywords: ['gate', 'promise'],
				score: 0.95,
				importance: 0.5,
			}),
		], request);

		expect(packet.retrievalTrace[0].score).toBeGreaterThan(3);
		expect(packet.retrievalTrace[0].signals).toEqual(expect.arrayContaining([
			expect.stringMatching(/^keyword /),
			expect.stringMatching(/^vector /),
		]));
	});

	it('prefers fresh memories over stale low-importance memories and reports age decay', () => {
		const fresh = node({
			id: 'fresh_gate',
			title: 'Gate promise',
			content: 'Arlan promised the gate would open before dawn.',
			importance: 0.25,
			updatedAt: new Date().toISOString(),
		});
		const stale = node({
			id: 'stale_gate',
			title: 'Gate promise',
			content: 'Arlan promised the gate would open before dawn.',
			importance: 0.25,
			updatedAt: '2000-01-01T00:00:00.000Z',
		});

		expect(scoreMemoryNode(fresh, request)).toBeGreaterThan(scoreMemoryNode(stale, request));

		const packet = buildMemoryPacket([stale], request);
		expect(packet.retrievalTrace[0].signals).toEqual(expect.arrayContaining([
			expect.stringMatching(/^age decay /),
		]));
	});

	it('uses story-turn distance before file timestamps when temporal metadata exists', () => {
		const storyRequest = { ...request, currentTurn: 100 };
		const recentInStory = node({
			id: 'recent_in_story',
			updatedAt: '2000-01-01T00:00:00.000Z',
			metadata: { validFromTurn: 99 },
		});
		const ancientInStory = node({
			id: 'ancient_in_story',
			updatedAt: new Date().toISOString(),
			metadata: { validFromTurn: 1 },
		});

		expect(scoreMemoryNode(recentInStory, storyRequest)).toBeGreaterThan(scoreMemoryNode(ancientInStory, storyRequest));

		const packet = buildMemoryPacket([recentInStory, ancientInStory], storyRequest);
		expect(packet.retrievalTrace.find((item) => item.id === 'recent_in_story')?.signals).toEqual(expect.arrayContaining([
			expect.stringMatching(/^story recency /),
		]));
		expect(packet.retrievalTrace.find((item) => item.id === 'ancient_in_story')?.signals).toEqual(expect.arrayContaining([
			expect.stringMatching(/^story age decay /),
		]));
	});
});
