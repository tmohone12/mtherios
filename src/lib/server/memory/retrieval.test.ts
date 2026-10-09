import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { memoryRetrieveRequestSchema } from '$lib/contracts/memory';
import type { MemoryNode } from '$lib/contracts/memory';
import { buildMemoryPacket } from './ranking';
import { dedupeMemoryCandidates, filterIneligibleGeneratedFactionMemories, memoryCorrectionCondition, transcriptMemoryCandidates, withAuthoritativeStoryAnchor } from './retrieval';

function eventMemory(overrides: Partial<MemoryNode>): MemoryNode {
	return {
		id: 'mem_event_event_arrival',
		storyId: 'story_veil',
		type: 'episodic',
		title: 'Arrival at Asshai',
		content: 'The five ships reached Asshai and began unloading.',
		summary: 'The five ships reached Asshai and began unloading.',
		keywords: [],
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: 'loc_asshai',
		visibility: 'player_known',
		importance: 0.8,
		sourceEntryIds: [],
		sourceEventIds: ['event_arrival'],
		sourcePatchIds: [],
		createdAt: '2026-08-30T00:00:00.000Z',
		updatedAt: '2026-08-30T00:00:00.000Z',
		...overrides,
	};
}

describe('memory correction dependencies', () => {
	it('looks up linked sources and topic revisions using parameters, not query wording', () => {
		const predicate = memoryCorrectionCondition([eventMemory({
			id: 'old_contract', sourceEntryIds: ['wedding_entry'], sourcePatchIds: ['contract_patch'],
			metadata: { correctionKey: "union's status" },
		})]);
		const query = new PgDialect().sqlToQuery(predicate!);
		expect(query.sql).not.toContain("union's status");
		expect(query.params).toContain("union's status");
		expect(query.params).toContain(JSON.stringify(['old_contract', 'wedding_entry', 'event_arrival', 'contract_patch']));
		expect(query.params).toContain('supersedesEntryIds');
		expect(query.params).toContain('supersedesPatchId');
	});
});

describe('dedupeMemoryCandidates', () => {
	it('collapses stored and live event projections while keeping live canon and the higher score', () => {
		const liveProjection = eventMemory({ id: 'event_memory_event_arrival', content: 'Live canonical arrival.', score: 4 });
		const storedProjection = eventMemory({ id: 'mem_event_event_arrival', content: 'Stale projected arrival.', score: 7 });

		expect(dedupeMemoryCandidates([storedProjection, liveProjection])).toEqual([
			expect.objectContaining({ id: 'event_memory_event_arrival', content: 'Live canonical arrival.', score: 7 }),
		]);
	});

	it('keeps distinct memories that only share an event citation', () => {
		const first = eventMemory({ id: 'memory_first', title: 'Harbor arrival' });
		const second = eventMemory({ id: 'memory_second', title: 'Cargo tally' });

		expect(dedupeMemoryCandidates([first, second]).map((node) => node.id))
			.toEqual(['memory_first', 'memory_second']);
	});
});

describe('generated faction memory eligibility', () => {
	it('drops pressure and world-tick projections from unpromoted character tags', () => {
		const pressure = eventMemory({
			id: 'mem_faction_pressure_tag',
			type: 'faction',
			factionIds: ['faction_tag_story_azure_throne'],
			metadata: { sourceType: 'terminal_faction_pressure_job', factionId: 'faction_tag_story_azure_throne' },
		});
		const worldTick = eventMemory({
			id: 'mem_world_tick_tag',
			type: 'faction',
			factionIds: ['faction_tag_story_azure_throne'],
			metadata: { sourceType: 'terminal_world_sim_tick', factionId: 'faction_tag_story_azure_throne' },
		});
		const ordinary = eventMemory({ id: 'ordinary_memory', factionIds: ['faction_tag_story_azure_throne'], metadata: {} });
		const unpromoted = {
			id: 'faction_tag_story_azure_throne',
			status: 'active',
			metadata: { sourceType: 'character_faction_tag', worldSimEnabled: true, currentStoryEvidence: true },
		};

		expect(filterIneligibleGeneratedFactionMemories([pressure, worldTick, ordinary], [unpromoted] as never).map(node => node.id))
			.toEqual(['ordinary_memory']);
		expect(filterIneligibleGeneratedFactionMemories([pressure, worldTick], [{
			...unpromoted,
			metadata: { ...unpromoted.metadata, worldSimPromoted: true },
		}] as never).map(node => node.id)).toEqual(['mem_faction_pressure_tag', 'mem_world_tick_tag']);
	});
});

describe('withAuthoritativeStoryAnchor', () => {
	it('replaces a stale client location in retrieval scene hints with backend canon', () => {
		const request = memoryRetrieveRequestSchema.parse({
			storyId: 'story_veil',
			query: 'What happens at court?',
			locationId: 'loc_stale_harbor',
			sceneEntityIds: ['pc_aurion', 'loc_stale_harbor', 'npc_envoy'],
		});

		expect(withAuthoritativeStoryAnchor(request, {
			currentTurn: 42,
			currentLocationId: 'loc_emperors_court',
		})).toMatchObject({
			currentTurn: 42,
			locationId: 'loc_emperors_court',
			sceneEntityIds: ['pc_aurion', 'npc_envoy', 'loc_emperors_court'],
		});
	});
});

describe('transcriptMemoryCandidates', () => {
	it('filters sparse historical control pairs, foreign entries, and hidden transcript evidence', () => {
		const old = { storyId: 'story_1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', type: 'narration' };
		const rows = [
			{ ...old, id: 'control', position: 10, type: 'user_action', content: 'OOC: change the story tone.' },
			{ ...old, id: 'control_reply', position: 11, parentId: 'control', content: 'The ruby is beneath the stair.' },
			{ ...old, id: 'hidden', position: 30, content: 'The ruby is beneath the stair.', metadata: { visibility: 'secret' } },
			{ ...old, id: 'foreign', storyId: 'story_other', position: 50, content: 'The ruby is beneath the stair.' },
			{ ...old, id: 'public', position: 70, content: 'The ruby was left inside the blue vase.' },
		];
		const query = memoryRetrieveRequestSchema.parse({ storyId: 'story_1', query: 'Where is the ruby?' });
		expect(transcriptMemoryCandidates(rows, query, []).map(item => item.id)).toEqual(['transcript_public']);
		expect(transcriptMemoryCandidates(rows, { ...query, includeSecret: true }, []).find(item => item.id === 'transcript_hidden')?.visibility).toBe('secret');
	});

	it('recalls a cited fact from the oldest edge of 100 exchanges and drops unrelated rows', () => {
		const request = memoryRetrieveRequestSchema.parse({
			storyId: 'story_1',
			query: 'What promise did she make at the moon shrine?',
			sceneEntityIds: ['npc_akeno'],
		});
		const entries = [
			...Array.from({ length: 199 }, (_, index) => ({
				id: `entry_recent_${index}`, storyId: 'story_1', type: 'narration', position: 200 - index,
				content: `Akeno quietly adjusted her gloves for moment ${index}.`,
				createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
			})),
			{
				id: 'entry_old', storyId: 'story_1', type: 'narration', position: 1,
				content: `[ Time 22:00 | Moon Shrine ]\n\n${'Unrelated atmospheric opening. '.repeat(100)}\n\nAt the moon shrine, Akeno promised to return the silver bell before dawn.`,
				createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
			},
		];

		const candidates = transcriptMemoryCandidates(entries, request, [{ entityId: 'npc_akeno', label: 'Akeno' }]);
		const packet = buildMemoryPacket(candidates, request);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: 'transcript_entry_old',
			entityIds: ['npc_akeno'],
			sourceEntryIds: ['entry_old'],
		});
		expect(packet.nodes[0]?.id).toBe('transcript_entry_old');
		expect(packet.packet).toContain('[entries:entry_old]');
		expect(packet.packet).toContain('Akeno promised to return the silver bell before dawn.');
		expect(packet.packet).not.toContain('Unrelated atmospheric opening.');
		expect(packet.tokenEstimate).toBeLessThanOrEqual(request.tokenBudget);
	});

	it('does not recall an OOC correction or the stale narration it produced', () => {
		const request = memoryRetrieveRequestSchema.parse({
			storyId: 'story_veil',
			query: 'Where did the ships unload in Asshai?',
		});
		const entries = [
			{
				id: 'gm_reply', storyId: 'story_veil', type: 'narration', position: 408, parentId: 'gm_correction',
				content: 'I will reset the harbor scene.',
				createdAt: '2026-08-31T00:00:03.000Z', updatedAt: '2026-08-31T00:00:03.000Z',
			},
			{
				id: 'intervening_narration', storyId: 'story_veil', type: 'narration', position: 407,
				content: 'The court bells ring once.',
				createdAt: '2026-08-31T00:00:02.500Z', updatedAt: '2026-08-31T00:00:02.500Z',
			},
			{
				id: 'gm_correction', storyId: 'story_veil', type: 'user_action', position: 406,
				content: 'Narrator: reset to the emperor\'s offer.',
				createdAt: '2026-08-31T00:00:02.000Z', updatedAt: '2026-08-31T00:00:02.000Z',
			},
			{
				id: 'ooc_reply', storyId: 'story_veil', type: 'narration', position: 405,
				content: 'You are right. The ships did not unload in Asshai because Leng harbor custom forbids it.',
				createdAt: '2026-08-31T00:00:01.000Z', updatedAt: '2026-08-31T00:00:01.000Z',
			},
			{
				id: 'ooc_correction', storyId: 'story_veil', type: 'user_action', position: 404,
				content: 'OOC: we are not in Leng. We are in Asshai.',
				createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
			},
			{
				id: 'canon_unloading', storyId: 'story_veil', type: 'narration', position: 388,
				content: 'The five ships began unloading food and water in Asshai while Daeron supervised.',
				createdAt: '2026-08-30T23:00:00.000Z', updatedAt: '2026-08-30T23:00:00.000Z',
			},
		];

		const candidates = transcriptMemoryCandidates(entries, request, []);

		expect(candidates.map((item) => item.id)).toEqual(['transcript_canon_unloading']);
		expect(candidates[0]?.content).toContain('five ships began unloading');
		expect(candidates[0]?.content).not.toContain('Leng');
		expect(candidates[0]?.content).not.toContain('reset');
	});

	it('drops a slash command but keeps the narration it generated', () => {
		const request = memoryRetrieveRequestSchema.parse({ storyId: 'story_veil', query: 'daughter studies foreign king' });
		const entries = [
			{
				id: 'pov_reply', storyId: 'story_veil', type: 'narration', position: 22, parentId: 'pov_command',
				content: 'Behind the veil, the emperor\'s daughter studies the foreign king.',
				createdAt: '2026-08-31T00:00:01.000Z', updatedAt: '2026-08-31T00:00:01.000Z',
			},
			{
				id: 'pov_command', storyId: 'story_veil', type: 'user_action', position: 21,
				content: '/pov The Veiled Daughter | studies the foreign king.',
				createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
			},
		];

		expect(transcriptMemoryCandidates(entries, request, []).map((item) => item.id))
			.toEqual(['transcript_pov_reply']);
	});

	it('honors non-canon metadata and collapses duplicate assistant transcript rows', () => {
		const request = memoryRetrieveRequestSchema.parse({ storyId: 'story_veil', query: 'Asshai harbor unloading' });
		const duplicate = 'The ships began unloading in Asshai harbor.';
		const entries = [
			{
				id: 'metadata_ooc', storyId: 'story_veil', type: 'narration', position: 12, content: 'Asshai harbor correction.',
				metadata: { actionType: 'ooc', nonCanon: true },
				createdAt: '2026-08-31T00:00:02.000Z', updatedAt: '2026-08-31T00:00:02.000Z',
			},
			{
				id: 'new_duplicate', storyId: 'story_veil', type: 'narration', position: 11, content: duplicate,
				createdAt: '2026-08-31T00:00:01.000Z', updatedAt: '2026-08-31T00:00:01.000Z',
			},
			{
				id: 'old_duplicate', storyId: 'story_veil', type: 'narration', position: 10, content: duplicate,
				createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
			},
		];

		const candidates = transcriptMemoryCandidates(entries, request, []);

		expect(candidates.map((item) => item.id)).toEqual(['transcript_new_duplicate']);
	});

	it('lets a later source-linked correction supersede an older transcript deadline', () => {
		const request = memoryRetrieveRequestSchema.parse({
			storyId: 'story_veil',
			query: 'When is the imperial ceremony scheduled?',
			currentTurn: 42,
		});
		const entries = [
			{
				id: 'deadline_new', storyId: 'story_veil', type: 'narration', position: 42,
				content: 'The imperial ceremony is scheduled for next week, after the mourning period.',
				metadata: { deadlineKey: 'imperial-ceremony', isCorrection: true },
				createdAt: '2026-08-31T00:00:01.000Z', updatedAt: '2026-08-31T00:00:01.000Z',
			},
			{
				id: 'deadline_old', storyId: 'story_veil', type: 'narration', position: 30,
				content: 'The imperial ceremony is scheduled for tomorrow morning.',
				metadata: { deadlineKey: 'imperial-ceremony' },
				createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
			},
		];

		const candidates = transcriptMemoryCandidates(entries, request, []);
		const packet = buildMemoryPacket(candidates, request);

		expect(candidates).toHaveLength(2);
		expect(packet.nodes.map((item) => item.id)).toEqual(['transcript_deadline_new']);
		expect(packet.packet).toContain('next week');
		expect(packet.packet).not.toContain('tomorrow morning');
	});
});
