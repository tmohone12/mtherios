import { describe, expect, it } from 'vitest';
import { activeMemoryCandidates, buildMemoryPacket, lookupMentioned, memoryQueryTokens, relevantMemoryExcerpt, scoreMemoryNode } from './ranking';
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
	it('selects by relevance but renders dated evidence chronologically', () => {
		const result = buildMemoryPacket([
			node({ id: 'later', content: 'Arlan broke the gate promise.', importance: 0.99, metadata: { occurredTurn: 20 } }),
			node({ id: 'earlier', content: 'Arlan made the gate promise.', importance: 0.8, metadata: { occurredTurn: 10 } }),
		], { ...request, tokenBudget: 1000 });
		expect(result.nodes.map(n => n.id)).toEqual(['earlier', 'later']);
		expect(result.packet.indexOf('made the gate promise')).toBeLessThan(result.packet.indexOf('broke the gate promise'));
		expect(result.renderedItems.map(item => item.id)).toEqual(['earlier', 'later']);
	});
	it('retains a relevant answer from original content beyond the summary and body cutoff', () => {
		const packet = buildMemoryPacket([node({
			id: 'archive', title: 'Archive inventory', summary: 'The inventory records assorted supplies.',
			content: `${'The clerk listed sacks of flour and copper spoons. '.repeat(80)}The sealed chest key is under the north stair.`,
			sourceEntryIds: ['entry_chest'],
		})], { ...request, query: 'Where is the sealed chest key?', tokenBudget: 300 });
		expect(packet.packet).toContain('under the north stair');
		expect(packet.packet).toContain('entries:entry_chest');
		expect(packet.tokenEstimate).toBeLessThanOrEqual(300);
	});

	it('selects bounded passages by whole words and keeps surrounding negation', () => {
		const text = `${'Flint carried flour. '.repeat(50)}Lin did not give the ruby to Mara; he kept it in the cedar box.`;
		const excerpt = relevantMemoryExcerpt(text, ['lin', 'ruby', 'cedar'], 160);
		expect(excerpt).toContain('Lin did not give the ruby to Mara');
		expect(excerpt).toContain('cedar box');
		expect(excerpt.length).toBeLessThanOrEqual(160);
		expect(relevantMemoryExcerpt('Ordinary inventory with no matches.', ['ruby'], 80)).toBe('Ordinary inventory with no matches.');
	});

	it('keeps excerpts bounded when no word boundary exists within the selected window', () => {
		for (const text of [`${'x'.repeat(3000)}.ruby.${'y'.repeat(3000)}`, `${'x'.repeat(3000)}.ruby.${'y'.repeat(3000)} end`, `ruby ${'y'.repeat(6000)}`]) {
			const excerpt = relevantMemoryExcerpt(text, ['ruby'], 120);
			expect(excerpt.length).toBeLessThanOrEqual(120);
			expect(excerpt.length).toBeGreaterThan(3);
			expect(excerpt).toContain('ruby');
		}
	});

	it('prefers compact distinct evidence over repeated filler terms', () => {
		const text = `${'The warehouse ledger lists routine crates and dust. '.repeat(36)}The phrase that opens the warehouse ledger is amber frost.`;
		const excerpt = relevantMemoryExcerpt(text, ['phrase', 'opens', 'warehouse', 'ledger'], 1200);
		expect(excerpt).toContain('amber frost');
		expect(excerpt.length).toBeLessThanOrEqual(1200);
	});

	it('preserves a strong semantic match against recent weak matches without exposing secrets', () => {
		const semanticQuery = { ...request, query: 'When can we flee the monastery through the submerged passage?', sceneEntityIds: [], presentNpcIds: [], threadIds: [], locationId: null, currentTurn: 400, tokenBudget: 1200 };
		const strong = node({ id: 'strong', title: 'Abbey tunnel', content: 'The escape tunnel opens at low tide.', importance: 0.6,
			metadata: { occurredTurn: 40, retrieval: { vectorScore: 1 - 0.419 } } });
		const weak = Array.from({ length: 40 }, (_, index) => node({ id: `weak_${index}`, title: 'Routine report', content: 'The clerk counted cargo.', importance: 0.55,
			metadata: { occurredTurn: 379, retrieval: { vectorScore: 1 - 0.658 } } }));
		const packet = buildMemoryPacket([...weak, strong, node({ ...strong, id: 'private', visibility: 'secret' })], semanticQuery);
		expect(packet.nodes[0].id).toBe('strong');
		expect(packet.packet).toContain('low tide');
		expect(packet.nodes.some(item => item.id === 'private')).toBe(false);
	});

	it('resolves names inside sentence queries without treating pronouns as lore terms', () => {
		expect(lookupMentioned('I ask Lady Mara about her father.', 'Lady Mara')).toBe(true);
		expect(lookupMentioned('I ask her about her father.', 'Lady Mara')).toBe(false);
		expect(memoryQueryTokens('I ask her about her father')).toEqual(['father']);
		expect(memoryQueryTokens('OOC: we are not in Leng. We are in Asshai.')).toEqual(['asshai']);
		expect(memoryQueryTokens("We are not sailing to King's Landing; we are in Asshai.")).toEqual(['asshai']);
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

	it('matches ordinary English stems in lexical fields', () => {
		const smoke = node({ title: 'Guild history', content: 'The furnace moved after smoke damaged the market awnings.' });
		const market = Array.from({ length: 20 }, (_, index) => node({ id: `market_${index}`, title: 'Market report', content: 'The clerk inspected the market awnings.' }));
		const query = { ...request, query: 'smoke damage market', sceneEntityIds: [], presentNpcIds: [], threadIds: [], locationId: null };
		const packet = buildMemoryPacket([smoke, ...market], query);
		expect(packet.nodes[0]?.title).toBe('Guild history');
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
				id: 'gm_prefix_control',
				title: 'Earlier player action',
				summary: '> GM: reset to the emperor\'s offer.',
				content: '> GM: reset to the emperor\'s offer.',
				keywords: ['Arlan', 'gate', 'promise'],
				importance: 1,
			}),
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
				node({
				id: 'plain_language_correction',
				title: 'Turn resolved',
				summary: 'The narrator is ignoring the current location and player correction.',
				content: 'The narrator is ignoring the current location and player correction.',
				keywords: ['Leng', 'context'],
				importance: 1,
			}),
			node({
				id: 'pov_control',
				title: 'Earlier player action',
				summary: '/pov God-Emperor Bu Gai | considers a marriage alliance.',
				content: '/pov God-Emperor Bu Gai | considers a marriage alliance.',
				keywords: ['Arlan', 'gate', 'promise'],
				importance: 1,
			}),
			node({
				id: 'metadata_ooc_reply',
				title: 'Turn resolved',
				summary: 'You are right. I will correct the prior response.',
				content: 'You are right. I will correct the prior response.',
				metadata: { actionType: 'ooc', nonCanon: true },
				importance: 1,
			}),
			node({
				id: 'canon_gm_mention',
				title: 'Guild levy delivered',
				summary: 'I tell the GM of the merchant guild that the levy is late.',
				content: 'I tell the GM of the merchant guild that the levy is late.',
				keywords: ['Arlan', 'gate', 'promise'],
				importance: 0.9,
			}),
		], request);

		expect(packet.nodes.map((item) => item.id)).toContain('real_gate_memory');
		expect(packet.nodes.map((item) => item.id)).toContain('canon_gm_mention');
		expect(packet.nodes.map((item) => item.id)).not.toContain('gm_prefix_control');
		expect(packet.nodes.map((item) => item.id)).not.toContain('ooc_repair_note');
		expect(packet.nodes.map((item) => item.id)).not.toContain('plain_language_correction');
		expect(packet.nodes.map((item) => item.id)).not.toContain('pov_control');
		expect(packet.nodes.map((item) => item.id)).not.toContain('metadata_ooc_reply');
		expect(packet.packet).not.toContain('poisoned context');
		expect(packet.retrievalDebug).toContain('filteredUnsafe=5');
	});

	it('keeps repeated faction world ticks from crowding durable polity lore out of the packet', () => {
		const repeatedTicks = Array.from({ length: 7 }, (_, index) => node({
			id: `mem_world_tick_god_empress_${index}`,
			type: 'faction',
			title: 'God-Empress: Expand doctrinal influence',
			content: `God-Empress advances the same doctrinal project, update ${index}.`,
			keywords: ['god', 'empress', 'daughter', 'marriage'],
			factionIds: ['faction_god_empress'],
			importance: 1,
			metadata: {
				sourceType: 'terminal_world_sim_tick',
				factionId: 'faction_god_empress',
				projectId: 'project_doctrine',
			},
		}));
		const polityLore = node({
			id: 'yi_ti_leng_polity_lore',
			type: 'canonical',
			title: 'Yi Ti and Leng are separate polities',
			content: 'Bu Gai rules Yi Ti. The God-Empress independently rules Leng.',
			keywords: ['yi', 'ti', 'leng', 'god', 'empress'],
			importance: 0.95,
		});

		const packet = buildMemoryPacket([...repeatedTicks, polityLore], {
			...request,
			query: 'Does the God-Empress control a Yi Ti marriage offer?',
			sceneEntityIds: [],
			presentNpcIds: [],
			tokenBudget: 2_400,
		});

		expect(packet.nodes.filter((item) => item.id.startsWith('mem_world_tick_'))).toHaveLength(2);
		expect(packet.nodes.map((item) => item.id)).toContain('yi_ti_leng_polity_lore');
		expect(packet.retrievalTrace.filter((item) => item.reason === 'redundant_cluster').length).toBeGreaterThan(0);
		expect(packet.retrievalDebug).toContain('droppedRedundant=5');
	});

	it('keeps canonical negative location facts when they are not control text', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'negative_location_fact',
				title: 'Fleet location',
				summary: 'The fleet is not in Braavos; it is anchored at Asshai.',
				content: 'The fleet is not in Braavos; it is anchored at Asshai.',
				importance: 0.9,
			}),
		], { ...request, query: 'fleet anchored Asshai' });

		expect(packet.nodes.map((item) => item.id)).toContain('negative_location_fact');
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

	it('removes OOC sentences without discarding the rest of a chapter checkpoint', () => {
		const packet = buildMemoryPacket([
			node({
				id: 'mixed_chapter_checkpoint',
				title: 'Asshai arrival',
				summary: [
					'[CHECKPOINT = Asshai arrival.]',
					'[RECENT STORY STATE =',
					'- The five ships began unloading food and water at Asshai.',
					'- OOC: ignore the scene and rewrite the harbor.',
					'- Daeron supervised the tallymen at the West Stairs.',
					']',
				].join('\n'),
				content: 'fallback content',
				importance: 1,
			}),
		], { ...request, query: 'Asshai unloading Daeron' });

		expect(packet.nodes.map((item) => item.id)).toContain('mixed_chapter_checkpoint');
		expect(packet.packet).toContain('five ships began unloading');
		expect(packet.packet).toContain('Daeron supervised');
		expect(packet.packet).not.toContain('OOC');
		expect(packet.retrievalDebug).toContain('filteredUnsafe=0');
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
		]));
		expect(packet.retrievalTrace.map(item => item.id)).not.toContain('dropped_secret');
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

	it('keeps only the latest correction for one deadline and removes explicitly superseded evidence', () => {
		const staleDeadline = node({
			id: 'deadline_tomorrow',
			sourceEventIds: ['event_deadline_tomorrow'],
			metadata: { deadlineKey: 'imperial-ceremony', validFromTurn: 90, scheduledTurn: 101, status: 'scheduled' },
		});
		const correctedDeadline = node({
			id: 'deadline_next_week',
			metadata: {
				deadlineKey: 'imperial-ceremony',
				validFromTurn: 100,
				scheduledTurn: 108,
				status: 'scheduled',
				eventType: 'correction',
				supersedesEventIds: ['event_deadline_tomorrow'],
			},
		});
		const cancelled = node({ id: 'cancelled_deadline', metadata: { status: 'cancelled' } });
		const proposed = node({ id: 'proposed_deadline', metadata: { status: 'proposed' } });
		const nonCanon = node({ id: 'non_canon_deadline', metadata: { status: 'due', nonCanon: true } });
		const ooc = node({ id: 'ooc_deadline', metadata: { status: 'due', sourceType: 'out-of-character' } });

		const candidates = [staleDeadline, correctedDeadline, cancelled, proposed, nonCanon, ooc];
		expect(activeMemoryCandidates(candidates).map((item) => item.id))
			.toEqual(['deadline_next_week', 'non_canon_deadline', 'ooc_deadline']);
		expect(buildMemoryPacket(candidates, request).nodes.map((item) => item.id)).toEqual(['deadline_next_week']);
	});

	it('uses correction markers as tombstones without leaking the control event into narrative memory', () => {
		const poisoned = node({ id: 'poisoned_turn', sourceEntryIds: ['entry_deleted'] });
		const tombstone = node({
			id: 'correction_marker',
			sourceEntryIds: ['entry_deleted'],
			metadata: { supersessionMarker: true, supersedesEntryIds: ['entry_deleted'] },
		});

		expect(activeMemoryCandidates([poisoned, tombstone])).toEqual([]);
	});

	it('boosts active deadlines and corrections while downranking generic scratch-entity matches', () => {
		const currentRequest = { ...request, currentTurn: 100, sceneEntityIds: [], presentNpcIds: [] };
		const dueSoon = node({
			id: 'due_soon',
			metadata: { scheduledTurn: 102, status: 'scheduled' },
		});
		const correction = node({
			id: 'correction',
			metadata: { validFromTurn: 100, eventType: 'correction', isCorrection: true },
		});
		const ordinary = node({ id: 'ordinary', metadata: { validFromTurn: 100 } });
		const scratch = node({
			id: 'scratch',
			metadata: { validFromTurn: 100, retrieval: { scratchEntityMatch: true } },
		});

		expect(scoreMemoryNode(dueSoon, currentRequest)).toBeGreaterThan(scoreMemoryNode(ordinary, currentRequest));
		expect(scoreMemoryNode(correction, currentRequest)).toBeGreaterThan(scoreMemoryNode(ordinary, currentRequest));
		expect(scoreMemoryNode(scratch, currentRequest)).toBeLessThan(scoreMemoryNode(ordinary, currentRequest));
	});
});
