import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entities, npcBeliefs, stories } from '$lib/server/db/schema';
import { loadTurnContext } from './context';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
	desc: vi.fn((column: unknown) => ({ kind: 'desc', column })),
	eq: vi.fn((left: unknown, right: unknown) => ({ kind: 'eq', left, right })),
	inArray: vi.fn((left: unknown, values: unknown[]) => ({ kind: 'inArray', left, values })),
	ne: vi.fn((left: unknown, right: unknown) => ({ kind: 'ne', left, right })),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('drizzle-orm', async (importActual) => {
	const actual = await importActual<typeof import('drizzle-orm')>();
	return {
		...actual,
		and: dbMocks.and,
		desc: dbMocks.desc,
		eq: dbMocks.eq,
		inArray: dbMocks.inArray,
		ne: dbMocks.ne,
	};
});

function conditionIncludesInArray(value: unknown, left: unknown, expectedValues: string[]): boolean {
	if (!value || typeof value !== 'object') return false;
	const record = value as { kind?: unknown; left?: unknown; values?: unknown[]; conditions?: unknown[] };
	if (record.kind === 'inArray' && record.left === left && expectedValues.every((expected) => record.values?.includes(expected))) {
		return true;
	}
	return Array.isArray(record.conditions) && record.conditions.some((condition) => conditionIncludesInArray(condition, left, expectedValues));
}

function createDbMock() {
	const requestedIds = ['npc_present', 'npc_scene'];
	const beliefConditions: unknown[] = [];
	const storyRow = {
		id: 'story_1',
		headerPrompt: null,
		metadata: {},
	};
	const baseEntities = [
		{ id: 'loc_hall', storyId: 'story_1', type: 'location', name: 'Great Hall', state: { current: true } },
		{ id: 'npc_present', storyId: 'story_1', type: 'character', name: 'Present NPC', state: { present: true } },
	];
	const requestedEntities = [
		{ id: 'npc_scene', storyId: 'story_1', type: 'character', name: 'Scene NPC', state: {} },
	];
	const requestedBeliefs = [
		{ id: 'belief_present', storyId: 'story_1', believerEntityId: 'npc_present', subjectEntityId: null, belief: 'Present NPC trusts the hall gossip.', confidence: 0.7 },
		{ id: 'belief_scene', storyId: 'story_1', believerEntityId: 'npc_scene', subjectEntityId: null, belief: 'Scene NPC remembers the hidden compact.', confidence: 0.85 },
	];
	const unrelatedBeliefs = Array.from({ length: 120 }, (_, index) => ({
		id: `belief_unrelated_${index + 1}`,
		storyId: 'story_1',
		believerEntityId: `npc_unrelated_${index + 1}`,
		subjectEntityId: null,
		belief: `Unrelated belief ${index + 1}`,
		confidence: 0.5,
	}));

	const select = vi.fn(() => {
		let selectedTable: unknown;
		let selectedCondition: unknown;
		const chain = {
			from: vi.fn((table: unknown) => {
				selectedTable = table;
				return chain;
			}),
			where: vi.fn((condition: unknown) => {
				selectedCondition = condition;
				return chain;
			}),
			orderBy: vi.fn(() => chain),
			limit: vi.fn(() => {
				if (selectedTable === stories) return Promise.resolve([storyRow]);
				if (selectedTable === entities) {
					if (conditionIncludesInArray(selectedCondition, entities.id, requestedIds)) return Promise.resolve(requestedEntities);
					return Promise.resolve(baseEntities);
				}
				if (selectedTable === npcBeliefs) {
					beliefConditions.push(selectedCondition);
					if (conditionIncludesInArray(selectedCondition, npcBeliefs.believerEntityId, requestedIds)) return Promise.resolve(requestedBeliefs);
					return Promise.resolve(unrelatedBeliefs);
				}
				return Promise.resolve([]);
			}),
		};
		return chain;
	});

	return {
		db: { select },
		beliefConditions,
		requestedIds,
	};
}

beforeEach(() => {
	dbMocks.getDb.mockReset();
	dbMocks.and.mockClear();
	dbMocks.desc.mockClear();
	dbMocks.eq.mockClear();
	dbMocks.inArray.mockClear();
	dbMocks.ne.mockClear();
});

describe('loadTurnContext', () => {
	it('explicitly loads scene entities and their NPC beliefs outside broad context limits', async () => {
		const { db, beliefConditions, requestedIds } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1', ['npc_present'], ['npc_scene']);

		expect(ctx.entities.map((entity) => entity.id)).toEqual(['loc_hall', 'npc_present', 'npc_scene']);
		expect(ctx.beliefs.map((belief) => belief.believerEntityId)).toEqual(['npc_present', 'npc_scene']);
		expect(beliefConditions.some((condition) => conditionIncludesInArray(condition, npcBeliefs.believerEntityId, requestedIds))).toBe(true);
	});
});
