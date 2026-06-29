import { beforeEach, describe, expect, it, vi } from 'vitest';
import { continuityWarnings, entities, entityAliases, npcBeliefs, patchProposals, stories } from '$lib/server/db/schema';
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
	const patchProposalConditions: unknown[] = [];
	const continuityWarningConditions: unknown[] = [];
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
	const aliasRows = [
		{
			id: 'alias_scene',
			storyId: 'story_1',
			entityId: 'npc_scene',
			alias: 'The Scene Witness',
			normalizedAlias: 'the scene witness',
			sourceEntryIds: ['entry_alias'],
		},
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
	const recentAppliedProposals = Array.from({ length: 80 }, (_, index) => ({
		id: `proposal_applied_${index + 1}`,
		storyId: 'story_1',
		proposalType: 'story_event_upsert',
		targetTable: 'story_events',
		targetRecordId: `event_applied_${index + 1}`,
		proposedBy: 'narration',
		operations: [],
		reason: `Already applied proposal ${index + 1}`,
		suggestion: 'No action needed.',
		status: 'applied',
		decision: 'approved',
		validatedBy: 'human',
		affectedEntityIds: [],
		confidence: 0.9,
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: {},
		updatedAt: `2026-06-13T18:${String(index).padStart(2, '0')}:00.000Z`,
	}));
	const pendingCharacterReference = {
		id: 'proposal_pending_ser_olyvar',
		storyId: 'story_1',
		proposalType: 'character_reference_review',
		targetTable: 'entities',
		targetRecordId: 'unresolved_character_ser_olyvar',
		proposedBy: 'narration',
		operations: [{
			op: 'review',
			path: '/entities/character',
			value: { name: 'Ser Olyvar', description: 'A name still waiting for review.' },
		}],
		reason: 'Turn referenced unresolved character Ser Olyvar.',
		suggestion: 'Review this character reference before creating a new canonical record.',
		status: 'needs_review',
		decision: null,
		validatedBy: null,
		affectedEntityIds: [],
		confidence: 0.52,
		sourceEntryIds: ['entry_old'],
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: { sourceName: 'Ser Olyvar' },
		updatedAt: '2026-06-01T00:00:00.000Z',
	};
	const resolvedContinuityWarnings = Array.from({ length: 80 }, (_, index) => ({
		id: `warning_resolved_${index + 1}`,
		storyId: 'story_1',
		warningType: 'continuity',
		level: 'warning',
		title: `Resolved warning ${index + 1}`,
		status: 'resolved',
		details: `Already resolved warning ${index + 1}`,
		entityIds: [],
		factionIds: [],
		threadIds: [],
		actorIds: [],
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		resolutionNotes: 'Done.',
		resolvedBy: 'human',
		resolvedAt: '2026-06-13T00:00:00.000Z',
		metadata: {},
		updatedAt: `2026-06-13T19:${String(index).padStart(2, '0')}:00.000Z`,
	}));
	const openContinuityWarning = {
		id: 'warning_open_ser_olyvar',
		storyId: 'story_1',
		warningType: 'unresolved_reference',
		level: 'warning',
		title: 'Unreviewed character reference',
		status: 'open',
		details: 'Ser Olyvar is still present only as reviewable evidence.',
		entityIds: [],
		factionIds: [],
		threadIds: [],
		actorIds: [],
		sourceEntryIds: ['entry_old'],
		sourceEventIds: [],
		sourcePatchIds: [],
		resolutionNotes: null,
		resolvedBy: null,
		resolvedAt: null,
		metadata: { sourceName: 'Ser Olyvar' },
		updatedAt: '2026-06-01T00:00:00.000Z',
	};

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
				if (selectedTable === entityAliases) return Promise.resolve(aliasRows);
				if (selectedTable === npcBeliefs) {
					beliefConditions.push(selectedCondition);
					if (conditionIncludesInArray(selectedCondition, npcBeliefs.believerEntityId, requestedIds)) return Promise.resolve(requestedBeliefs);
					return Promise.resolve(unrelatedBeliefs);
				}
				if (selectedTable === patchProposals) {
					patchProposalConditions.push(selectedCondition);
					if (conditionIncludesInArray(selectedCondition, patchProposals.status, ['pending', 'needs_review'])) {
						return Promise.resolve([pendingCharacterReference]);
					}
					return Promise.resolve(recentAppliedProposals);
				}
				if (selectedTable === continuityWarnings) {
					continuityWarningConditions.push(selectedCondition);
					if (conditionIncludesInArray(selectedCondition, continuityWarnings.status, ['open'])) {
						return Promise.resolve([openContinuityWarning]);
					}
					return Promise.resolve(resolvedContinuityWarnings);
				}
				return Promise.resolve([]);
			}),
		};
		return chain;
	});

	return {
		db: { select },
		beliefConditions,
		patchProposalConditions,
		continuityWarningConditions,
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
		expect(ctx.entities.find((entity) => entity.id === 'npc_scene')?.state).toMatchObject({
			aliases: ['The Scene Witness'],
		});
		expect(ctx.beliefs.map((belief) => belief.believerEntityId)).toEqual(['npc_present', 'npc_scene']);
		expect(beliefConditions.some((condition) => conditionIncludesInArray(condition, npcBeliefs.believerEntityId, requestedIds))).toBe(true);
	});

	it('keeps repair/audit proposal rows out of normal turn context', async () => {
		const { db, patchProposalConditions, continuityWarningConditions } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1');

		expect(ctx.facts).toEqual([]);
		expect(ctx.patchProposals).toEqual([]);
		expect(ctx.continuityWarnings).toEqual([]);
		expect(patchProposalConditions).toEqual([]);
		expect(continuityWarningConditions).toEqual([]);
	});
});
