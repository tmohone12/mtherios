import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { agreements, continuityWarnings, entities, entityAliases, factions, npcBeliefs, patchProposals, stories, storyEntries } from '$lib/server/db/schema';
import { filterNarrativeContextEntries, loadTurnContext, NARRATOR_RECENT_ENTRY_LIMIT, TURN_CONTEXT_AGREEMENT_LIMIT, TURN_CONTEXT_ENTITY_LIMIT } from './context';

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

function conditionArray(value: unknown, left: unknown): unknown[] | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const record = value as { kind?: unknown; left?: unknown; values?: unknown[]; conditions?: unknown[] };
	if (record.kind === 'inArray' && record.left === left) return record.values;
	return record.conditions?.map((condition) => conditionArray(condition, left)).find(Boolean);
}

function createDbMock() {
	const requestedIds = ['npc_present', 'npc_scene', 'loc_hall'];
	const beliefConditions: unknown[] = [];
	const agreementOrders: unknown[][] = [];
	const agreementLimits: number[] = [];
	const entityLimits: number[] = [];
	const storyEntryConditions: unknown[] = [];
	const storyEntryLimits: number[] = [];
	const patchProposalConditions: unknown[] = [];
	const continuityWarningConditions: unknown[] = [];
	const storyRow = {
		id: 'story_1',
		headerPrompt: null,
		currentLocationId: 'loc_hall',
		currentTurn: 42,
		metadata: {},
	};
	const recentEntriesDesc = [
		{ id: 'entry_2', storyId: 'story_1', type: 'narration', content: 'Second.', position: 2 },
		{ id: 'entry_1', storyId: 'story_1', type: 'user_action', content: 'First.', position: 1 },
	];
	const baseEntities = [
		{ id: 'loc_hall', storyId: 'story_1', type: 'location', name: 'Great Hall', state: { current: true } },
		{ id: 'npc_present', storyId: 'story_1', type: 'character', name: 'Present NPC', state: { present: true } },
	];
	const requestedEntities = [
		{ id: 'npc_scene', storyId: 'story_1', type: 'character', name: 'Scene NPC', state: {} },
		{ id: 'loc_hall', storyId: 'story_1', type: 'location', name: 'Great Hall', state: { current: true } },
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
	const factionRows = Array.from({ length: 85 }, (_, index) => ({ id: `faction_${index + 1}`, storyId: 'story_1', name: `Faction ${index + 1}` }));
	const agreementRows = Array.from({ length: 90 }, (_, index) => ({ id: `agreement_${index + 1}`, storyId: 'story_1', parties: ['npc_present'], status: 'active', terms: `Oath ${index + 1}` }));
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
			orderBy: vi.fn((...order: unknown[]) => {
				if (selectedTable === agreements) agreementOrders.push(order);
				return chain;
			}),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(selectedTable === factions ? factionRows : selectedTable === agreements ? agreementRows : []).then(resolve),
			limit: vi.fn((limit: number) => {
				if (selectedTable === stories) return Promise.resolve([storyRow]);
				if (selectedTable === storyEntries) {
					storyEntryConditions.push(selectedCondition);
					storyEntryLimits.push(limit);
					return Promise.resolve(recentEntriesDesc);
				}
				if (selectedTable === entities) {
					entityLimits.push(limit);
					if (conditionIncludesInArray(selectedCondition, entities.id, requestedIds)) return Promise.resolve(requestedEntities);
					return Promise.resolve(baseEntities);
				}
				if (selectedTable === entityAliases) return Promise.resolve(aliasRows);
				if (selectedTable === npcBeliefs) {
					beliefConditions.push(selectedCondition);
					const actorIds = conditionArray(selectedCondition, npcBeliefs.believerEntityId);
					return Promise.resolve([...unrelatedBeliefs, ...requestedBeliefs].filter((belief) => !actorIds || actorIds.includes(belief.believerEntityId)));
				}
				if (selectedTable === factions) return Promise.resolve(factionRows.slice(0, limit));
				if (selectedTable === agreements) {
					agreementLimits.push(limit);
					return Promise.resolve(agreementRows.slice(0, limit));
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
		agreementOrders,
		agreementLimits,
		entityLimits,
		storyEntryConditions,
		storyEntryLimits,
		patchProposalConditions,
		continuityWarningConditions,
		requestedIds,
		baseEntities,
		recentEntriesDesc,
		requestedBeliefs,
		aliasRows,
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
	it('orders unresolved agreements by scene aliases, action and due state before limiting the fetch', async () => {
		const { db, requestedIds, agreementOrders, agreementLimits } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const ctx = await loadTurnContext('story_1', requestedIds, [], 'Ask about the permits.');
		expect(ctx.agreements).toHaveLength(TURN_CONTEXT_AGREEMENT_LIMIT);
		expect(agreementLimits).toEqual([TURN_CONTEXT_AGREEMENT_LIMIT]);
		expect(dbMocks.inArray).toHaveBeenCalledWith(agreements.status, ['active', 'contested']);
		const score = (agreementOrders[0][0] as { column: SQL }).column;
		const query = new PgDialect().sqlToQuery(score);
		expect(query.params).toEqual(expect.arrayContaining(['npc scene', 'scene npc', 'the scene witness', 'permits', 42]));
		expect(query.sql).toContain('scheduled_turn');
		expect(agreementOrders[0][1]).toEqual({ kind: 'desc', column: agreements.updatedAt });
	});

	it('explicitly loads scene entities, the story location, and their NPC beliefs outside broad context limits', async () => {
		const { db, beliefConditions, entityLimits, requestedIds } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1', ['npc_present'], ['npc_scene']);

		expect(ctx.entities.map((entity) => entity.id)).toEqual(['npc_present', 'npc_scene', 'loc_hall']);
		expect(ctx.entities.find((entity) => entity.id === 'npc_scene')?.state).toMatchObject({
			aliases: ['The Scene Witness'],
		});
		expect(ctx.beliefs.map((belief) => belief.believerEntityId)).toEqual(['npc_present', 'npc_scene']);
		expect(beliefConditions.some((condition) => conditionIncludesInArray(condition, npcBeliefs.believerEntityId, ['npc_present', 'npc_scene']))).toBe(true);
		expect(conditionArray(beliefConditions[0], npcBeliefs.believerEntityId)).not.toContain('loc_hall');
		expect(dbMocks.desc).toHaveBeenCalledWith(npcBeliefs.updatedAt);
		expect(entityLimits).toEqual([TURN_CONTEXT_ENTITY_LIMIT, requestedIds.length, 1]);
	});

	it('loads returning actors beliefs by canonical presence and scene aliases without browser cast hints', async () => {
		const { db, baseEntities, recentEntriesDesc, requestedBeliefs, aliasRows, beliefConditions } = createDbMock();
		baseEntities.push({ id: 'npc_returning', storyId: 'story_1', type: 'character', name: 'Tala', state: { present: false } });
		baseEntities.push({ id: 'npc_distant', storyId: 'story_1', type: 'character', name: 'Distant King', state: { present: false } });
		aliasRows.push({ id: 'alias_returning', storyId: 'story_1', entityId: 'npc_returning', alias: 'The Ferryman', normalizedAlias: 'the ferryman', sourceEntryIds: ['entry_1'] });
		recentEntriesDesc[0].content = 'The Ferryman steps into the hall and closes the door. You remember the Distant King.';
		requestedBeliefs.push({ id: 'belief_tala', storyId: 'story_1', believerEntityId: 'npc_returning', subjectEntityId: null, belief: 'The agreed password is copper dawn.', confidence: 0.9 });
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1');

		expect(ctx.beliefs.map((belief) => belief.believerEntityId)).toEqual(['npc_present', 'npc_returning']);
		expect(conditionArray(beliefConditions[0], npcBeliefs.believerEntityId)).not.toContain('npc_distant');
		expect(ctx.entities.find((entity) => entity.id === 'npc_returning')?.state.present).toBe(false);
	});
	it('loads a named NPC belief when the player calls them into the scene', async () => {
		const { db, baseEntities, requestedBeliefs, beliefConditions } = createDbMock();
		baseEntities.push({ id: 'npc_called', storyId: 'story_1', type: 'character', name: 'Tala', state: { present: false } });
		requestedBeliefs.push({ id: 'belief_called', storyId: 'story_1', believerEntityId: 'npc_called', subjectEntityId: null,
			belief: 'The password is copper dawn.', confidence: 0.9 });
		dbMocks.getDb.mockReturnValue(db);
		const ctx = await loadTurnContext('story_1', [], [], 'I call for Tala.');
		expect(ctx.beliefs.some(belief => belief.believerEntityId === 'npc_called')).toBe(true);
		expect(conditionArray(beliefConditions[0], npcBeliefs.believerEntityId)).toContain('npc_called');
	});

	it('ranks factions after loading the full story roster, including records beyond the former page of 80', async () => {
		const { db } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const ctx = await loadTurnContext('story_1');
		expect(ctx.factions).toHaveLength(85);
		expect(ctx.factions.at(-1)?.id).toBe('faction_85');
	});

	it('keeps a narrated returning actor ahead of a crowded stale browser cast', async () => {
		const { db, baseEntities, recentEntriesDesc, requestedBeliefs, beliefConditions } = createDbMock();
		const staleIds = Array.from({ length: 32 }, (_, index) => `npc_old_${index}`);
		for (const id of staleIds) baseEntities.push({ id, storyId: 'story_1', type: 'character', name: `Old ${id}`, state: { present: false } });
		baseEntities.push({ id: 'npc_tala', storyId: 'story_1', type: 'character', name: 'Tala', state: { present: false } });
		recentEntriesDesc[0].content = 'Tala stands beside you at the river.';
		requestedBeliefs.push({ id: 'belief_tala', storyId: 'story_1', believerEntityId: 'npc_tala', subjectEntityId: null, belief: 'The crossing is paid for.', confidence: 0.9 });
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1', staleIds);

		expect(ctx.beliefs.some((belief) => belief.believerEntityId === 'npc_tala')).toBe(true);
		expect(conditionArray(beliefConditions[0], npcBeliefs.believerEntityId)).toHaveLength(32);
	});

	it('loads the newest 100 dialogue exchanges in chronological order', async () => {
		const { db, storyEntryConditions, storyEntryLimits } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const ctx = await loadTurnContext('story_1');

		expect(ctx.recentEntries.map((entry) => entry.id)).toEqual(['entry_1', 'entry_2']);
		expect(storyEntryLimits).toEqual([NARRATOR_RECENT_ENTRY_LIMIT]);
		expect(storyEntryConditions.some((condition) => conditionIncludesInArray(
			condition,
			storyEntries.type,
			['user_action', 'narration'],
		))).toBe(true);
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

describe('filterNarrativeContextEntries', () => {
	it('removes structured and legacy OOC turns with their paired replies', () => {
		const entries = [
			{ id: 'canon_user', type: 'user_action', content: 'Open the door.', metadata: {}, parentId: null },
			{ id: 'canon_reply', type: 'narration', content: 'The door opens.', metadata: {}, parentId: 'canon_user' },
			{ id: 'gm_control', type: 'user_action', content: '> GM: reset to the emperor\'s offer.', metadata: {}, parentId: null },
			{ id: 'gm_plain', type: 'user_action', content: 'Gm the wedding is today.', metadata: {}, parentId: null },
			{ id: 'gm_plain_reply', type: 'narration', content: 'The wedding is today.', metadata: {}, parentId: 'gm_plain' },
			{ id: 'canon_gm_mention', type: 'user_action', content: 'I tell the GM of the merchant guild that the levy is late.', metadata: {}, parentId: null },
			{ id: 'canon_gm_reply', type: 'narration', content: 'The guild master closes his ledger.', metadata: {}, parentId: 'canon_gm_mention' },
			{ id: 'gm_control_reply', type: 'narration', content: 'I will reset it.', metadata: {}, parentId: 'gm_control' },
			{ id: 'legacy_ooc', type: 'user_action', content: 'OOC: we are in Asshai.', metadata: {}, parentId: null },
			{ id: 'legacy_reply', type: 'narration', content: 'Understood.', metadata: {}, parentId: 'legacy_ooc' },
			{ id: 'pov_command', type: 'user_action', content: '/pov The Veiled Daughter | weighs the offer.', metadata: { actionType: 'pov' }, parentId: null },
			{ id: 'pov_gm_research', type: 'user_action', content: '/pov Gm research the necklace.', metadata: {}, parentId: null },
			{ id: 'pov_narration', type: 'narration', content: 'Behind the veil, the emperor\'s daughter studies the foreign king.', metadata: { actionType: 'pov' }, parentId: 'pov_command' },
			{ id: 'marked_ooc', type: 'user_action', content: 'Fix that.', metadata: { actionType: 'ooc', nonCanon: true }, parentId: null },
			{ id: 'marked_reply', type: 'narration', content: 'Fixed.', metadata: { actionType: 'ooc', nonCanon: true }, parentId: 'marked_ooc' },
		] as Array<typeof storyEntries.$inferSelect>;

		expect(filterNarrativeContextEntries(entries).map((entry) => entry.id)).toEqual([
			'canon_user', 'canon_reply', 'canon_gm_mention', 'canon_gm_reply', 'pov_narration',
		]);
	});
});
