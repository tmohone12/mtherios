import { describe, expect, it } from 'vitest';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildServerTurnPrompt } from './promptPacket';

const now = '2026-06-30T00:00:00.000Z';

function row<T extends Record<string, unknown>>(value: T): T & { serverVersion: number; createdAt: string; updatedAt: string } {
	return { serverVersion: 1, createdAt: now, updatedAt: now, ...value } as T & { serverVersion: number; createdAt: string; updatedAt: string };
}

function entity(
	id: string,
	type: string,
	name: string,
	description: string,
	state: Record<string, unknown> = {},
	metadata: Record<string, unknown> = {},
) {
	return row({
		id,
		storyId: 'story_test',
		type,
		name,
		description,
		status: 'active',
		visibility: 'player_known',
		state,
		metadata,
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
	});
}

function packet(query = ''): RetrievedMemoryPacket {
	return {
		storyId: 'story_test',
		query,
		packet: '',
		nodes: [],
		tokenEstimate: 0,
		retrievalDebug: [],
		retrievalTrace: [],
	};
}

function context(): TurnContext {
	const unrelated = Array.from({ length: 14 }, (_, index) =>
		entity(`npc_history_${index}`, 'character', `Aegon ${index} Targaryen`, `Historical dragon king ${index}.`, { present: true }),
	);
	return {
		story: row({
			id: 'story_test',
			clientStoryId: null,
			title: 'Character Context Test',
			description: 'A test story.',
			genre: 'fantasy',
			mode: 'adventure',
			settings: null,
			headerPrompt: null,
			currentLocationId: 'loc_study',
			metadata: {},
		}),
		recentEntries: [
			row({
				id: 'entry_1',
				storyId: 'story_test',
				type: 'user_action',
				content: 'I ask Maera about Volantis.',
				position: 1,
				parentId: null,
				branchId: null,
				metadata: {},
			}),
			row({
				id: 'narration_1',
				storyId: 'story_test',
				type: 'narration',
				content: '[ Time 7:55 PM | Villa of the Sun - Maera Belaerys\'s private study ] Maera Belaerys stands by the map. The room is empty except for the old woman and Aurion.',
				position: 2,
				parentId: 'entry_1',
				branchId: null,
				metadata: {},
			}),
		],
		entities: [
			entity('loc_study', 'location', 'Maera Belaerys private study', 'A quiet study.', { current: true }),
			entity('pc_aurion', 'character', 'Aurion Belaerys', 'The player character.', { relationship: 'self', present: true }),
			entity('npc_maera', 'character', 'Maera Belaerys', 'The relevant grandmother.', { present: true }),
			entity('npc_addam', 'character', 'Addam Velaryon', 'A dead historical dragonseed.', { present: true }),
			...unrelated,
		],
		factions: [],
		factionMemberships: [],
		factionResources: [],
		factionGoals: [],
		factionProjects: [],
		agreements: [],
		threads: [],
		events: [],
		beliefs: [],
		facts: [],
		patchProposals: [],
		continuityWarnings: [],
		chapters: [],
		arcs: [],
		sagas: [],
		gmBrief: null,
	} as unknown as TurnContext;
}

describe('server turn prompt character context', () => {
	it('guards against over-broad client sceneEntityIds from loading unrelated active NPCs', () => {
		const ctx = context();
		const allEntityIds = ctx.entities.map((item) => item.id);
		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera what comes next'), 'entry_1', {
			sceneEntityIds: allEntityIds,
			presentNpcIds: allEntityIds.filter((id) => id.startsWith('npc_')),
		});

		expect(prompt.prompt).toContain('Maera Belaerys');
		expect(prompt.prompt).toContain('Player character:');
		expect(prompt.prompt).not.toContain('Addam Velaryon');
		expect(prompt.prompt).not.toContain('Aegon 0 Targaryen');
	});

	it('keeps stored context subordinate to the current scene and drops generated placeholder noise', () => {
		const ctx = context();
		ctx.entities.push(entity(
			'npc_first_self_stub',
			'character',
			'First Self',
			'First Self is important in this chapter checkpoint.',
			{ present: true, eventMemory: { did: ['Turn resolved'] } },
			{ createdFrom: 'character_reference_review' },
		));
		ctx.events = [
			row({ id: 'event_generic', storyId: 'story_test', type: 'scene', title: 'Turn resolved', body: 'Turn resolved.', status: 'resolved', metadata: {} }),
			row({ id: 'event_signal', storyId: 'story_test', type: 'political', title: 'The harbor pact fractures', body: 'Maera receives proof that the pact was altered.', status: 'active', metadata: {} }),
		] as TurnContext['events'];

		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about the altered pact'), 'entry_1', {
			sceneEntityIds: ['pc_aurion', 'npc_maera', 'npc_first_self_stub'],
			presentNpcIds: ['npc_maera', 'npc_first_self_stub'],
		});

		expect(prompt.system.startsWith('ROLEPLAY AUTHORITY:')).toBe(true);
		expect(prompt.system).toContain('SOURCE PRIORITY: latest player action > current scene/clock');
		expect(prompt.prompt).toContain('<context_data>');
		expect(prompt.prompt).toContain('</context_data>');
		expect(prompt.prompt).not.toContain('First Self is important in this chapter checkpoint');
		expect(prompt.prompt).toContain('The harbor pact fractures');
		expect(prompt.prompt).not.toContain('Turn resolved.');
	});

	it('uses the story currentLocationId before stale entity current flags', () => {
		const ctx = context();
		ctx.recentEntries = ctx.recentEntries.filter((entry) => entry.type !== 'narration');
		ctx.entities[0] = entity('loc_study', 'location', 'Maera Belaerys private study', 'The authoritative room.', { current: false });
		ctx.entities.unshift(entity('loc_stale', 'location', 'Old Harbor', 'A stale location.', { current: true }));

		const prompt = buildServerTurnPrompt(ctx, packet(), 'entry_1');

		expect(prompt.prompt).toContain('Current location:\nMaera Belaerys private study');
		expect(prompt.prompt).not.toContain('Current location:\nOld Harbor');
	});
});
