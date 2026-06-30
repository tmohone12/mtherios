import { describe, expect, it } from 'vitest';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildServerTurnPrompt } from './promptPacket';

const now = '2026-06-30T00:00:00.000Z';

function row<T extends Record<string, unknown>>(value: T): T & { serverVersion: number; createdAt: string; updatedAt: string } {
	return { serverVersion: 1, createdAt: now, updatedAt: now, ...value } as T & { serverVersion: number; createdAt: string; updatedAt: string };
}

function entity(id: string, type: string, name: string, description: string, state: Record<string, unknown> = {}) {
	return row({
		id,
		storyId: 'story_test',
		type,
		name,
		description,
		status: 'active',
		visibility: 'player_known',
		state,
		metadata: {},
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
});
