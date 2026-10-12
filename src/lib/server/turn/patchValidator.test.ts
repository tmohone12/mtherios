import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	agreements,
	continuityWarnings,
	entities,
	factions,
	factionMemberships,
	facts,
	memoryNodes,
	npcEventLinks,
	patchProposals,
	relationships,
	sourceRefs,
	statePatches,
	stories,
	storyEntries,
	storyEvents,
	worldClocks,
	worldTimeChanges,
} from '$lib/server/db/schema';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { applyValidatedTurnUpdate, parseTurnUpdate } from './patchValidator';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueTurnProjectionJobs: vi.fn(),
	enqueueFactionCadenceJob: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueTurnProjectionJobs: dbMocks.enqueueTurnProjectionJobs,
	enqueueFactionCadenceJob: dbMocks.enqueueFactionCadenceJob,
}));

const storyRow = {
	id: 'story_1',
	currentTurn: 7,
	currentWorldTime: 'Twilight of Ashes',
	currentLocationId: 'entity_bridge',
	metadata: { campaignTone: 'wary' },
};
type TestStoryRow = Omit<typeof storyRow, 'currentWorldTime' | 'currentLocationId'> & {
	currentWorldTime: string | null;
	currentLocationId: string | null;
};

const entityRows = [
	{ id: 'entity_valen', storyId: 'story_1', type: 'character', name: 'Valen' },
	{ id: 'entity_mira', storyId: 'story_1', type: 'character', name: 'Mira' },
	{ id: 'entity_bridge', storyId: 'story_1', type: 'location', name: 'Ash Bridge', state: { current: true } },
	{ id: 'entity_watch', storyId: 'story_1', type: 'faction', name: 'The Watch' },
];

const factionRows = [
	{ id: 'faction_watch', storyId: 'story_1', entityId: 'entity_watch', name: 'The Watch' },
];

function createDbMock(options: {
	story?: TestStoryRow | null;
	patchProposalRows?: Array<typeof patchProposals.$inferSelect>;
	entityRows?: Array<Record<string, unknown>>;
	factionRows?: Array<Record<string, unknown>>;
	membershipRows?: Array<Record<string, unknown>>;
	persistEntities?: boolean;
	relationshipRows?: Array<typeof relationships.$inferSelect>;
	agreementRows?: Array<typeof agreements.$inferSelect>;
	sourcePositions?: number[];
	sceneSourceEntries?: Array<{ id?: string; position?: number; type: string; content: string; metadata: Record<string, unknown> }>;
} = {}) {
	type DbSource = 'root' | 'tx';
	const insertCalls: Array<{ source: DbSource; table: unknown; value: unknown }> = [];
	const updateCalls: Array<{ source: DbSource; table: unknown; value: Record<string, unknown> }> = [];
	const deleteCalls: Array<{ source: DbSource; table: unknown }> = [];
	const selectLocks: Array<{ source: DbSource; table: unknown; strength: string }> = [];
	const storyUpdates: Array<Record<string, unknown>> = [];
	const selectedStory = options.story === undefined ? storyRow : options.story;
	const selectedEntities = [...(options.entityRows ?? entityRows)];
	const selectedFactions = [...(options.factionRows ?? factionRows)];

	function createConnection(source: DbSource) {
		let selectedTable: unknown;
		let selectedFields: Record<string, unknown> | undefined;
		let sourceRead = 0;

		const selectChain = {
			from: vi.fn((table: unknown) => {
				selectedTable = table;
				return selectChain;
			}),
			where: vi.fn(() => selectChain),
			orderBy: vi.fn(() => selectChain),
			for: vi.fn((strength: string) => {
				selectLocks.push({ source, table: selectedTable, strength });
				return selectChain;
			}),
			limit: vi.fn(() => {
				if (selectedTable === stories) return Promise.resolve(selectedStory ? [selectedStory] : []);
				if (selectedTable === entities) return Promise.resolve(selectedEntities);
				if (selectedTable === factions) return Promise.resolve(selectedFactions);
				if (selectedTable === factionMemberships) return Promise.resolve(options.membershipRows ?? []);
				if (selectedTable === relationships) return Promise.resolve(options.relationshipRows ?? []);
				if (selectedTable === agreements) return Promise.resolve(options.agreementRows ?? []);
				if (selectedTable === storyEntries) {
					if (selectedFields?.metadata) return Promise.resolve(options.sceneSourceEntries ?? []);
					const position = options.sourcePositions?.[sourceRead++];
					return Promise.resolve(position === undefined ? [] : [{ position }]);
				}
				if (selectedTable === patchProposals) return Promise.resolve(options.patchProposalRows ?? []);
				return Promise.resolve([]);
			}),
		};
		const select = vi.fn((fields?: Record<string, unknown>) => { selectedFields = fields; return selectChain; });

		const insert = vi.fn((table: unknown) => ({
			values: vi.fn((value: unknown) => {
				insertCalls.push({ source, table, value });
				if (options.persistEntities && (table === entities || table === factions)) {
					const records = table === entities ? selectedEntities : selectedFactions;
					const row = value as Record<string, unknown>;
					const index = records.findIndex(record => record.id === row.id);
					if (index < 0) records.push(row);
					else records[index] = row;
				}
				return {
					onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
					onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
				};
			}),
		}));

		const update = vi.fn((table: unknown) => ({
			set: vi.fn((value: Record<string, unknown>) => ({
				where: vi.fn(() => {
					updateCalls.push({ source, table, value });
					if (table === stories) storyUpdates.push(value);
					return Promise.resolve(undefined);
				}),
			})),
		}));

		const deleteFn = vi.fn((table: unknown) => ({
			where: vi.fn(() => {
				deleteCalls.push({ source, table });
				return Promise.resolve(undefined);
			}),
		}));

		return { delete: deleteFn, insert, select, update };
	}

	const tx = createConnection('tx');
	const db = {
		...createConnection('root'),
		transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
	};

	return {
		db,
		tx,
		insertCalls,
		updateCalls,
		deleteCalls,
		selectLocks,
		storyUpdates,
	};
}

beforeEach(() => {
	dbMocks.getDb.mockReset();
	dbMocks.enqueueTurnProjectionJobs.mockReset();
	dbMocks.enqueueTurnProjectionJobs.mockResolvedValue(undefined);
	dbMocks.enqueueFactionCadenceJob.mockReset();
	dbMocks.enqueueFactionCadenceJob.mockResolvedValue(null);
});

describe('applyValidatedTurnUpdate', () => {
	it('retains the same compact deltas with or without the extraction envelope', () => {
		const update = { timeline_events: [{ title: 'A refusal heard', type: 'reveal', status: 'committed', actor_claims: [{ text: 'Mira heard the refusal.', known_by: ['Mira'], kind: 'learned', evidence: 'Mira heard the refusal.' }] }] };
		expect(parseTurnUpdate(update)).toEqual(parseTurnUpdate({ update }));
		expect(parseTurnUpdate(update).update.timeline_events[0].actor_claims).toHaveLength(1);
		expect(parseTurnUpdate({ timeline_events: 'invalid' }).warnings.length).toBeGreaterThan(0);
		expect(parseTurnUpdate({ update: { timeline_events: 'invalid' } }).warnings.length).toBeGreaterThan(0);
	});
	it.each([
		['canonical', {}, true],
		['noncanon', { nonCanon: true }, false],
		['parallel', { narrativeMode: 'parallel_pov', povCharacter: 'Mira' }, false],
	])('only persists sourced campaign facts for %s primary narration', async (_name, metadata, expected) => {
		const evidence = 'The royal betrothal was annulled.';
		const mock = createDbMock({ sceneSourceEntries: [{ id: 'narration_state', position: 20, type: 'narration', content: evidence, metadata }] });
		dbMocks.getDb.mockReturnValue(mock.db);
		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1', playerEntryId: 'player_state', assistantEntryId: 'narration_state', narration: evidence,
			update: worldStateUpdateSchema.parse({ campaign_state: [{ key: 'royal_betrothal', kind: 'current', statement: evidence, evidence, expected_source_entry_id: null }] }),
			parseWarnings: [], retrievedMemoryIds: [], serverVersion: 21,
		});
		expect(mock.updateCalls.some(call => call.table === stories && 'metadata' in call.value)).toBe(expected);
		expect(mock.insertCalls.find(call => call.table === statePatches)?.value).toMatchObject({ sourceEntryIds: ['player_state', 'narration_state'] });
		if (!expected) expect(result.warnings.join(' ')).toContain('Campaign state skipped');
	});
	const independentMove = 'Mira asked her merchant cousin to take her younger brother aboard.';
	const agencyState = { currentGoal: 'Keep her brother out of royal service.', currentPlan: 'Secure an apprenticeship before the appointment.', lastIndependentAction: independentMove, nextOpportunity: 'The cousin returns tomorrow; meet him.', constraint: 'She will not openly accuse her husband.' };
	const applyAgency = (character: Record<string, unknown>, extra: Partial<Parameters<typeof applyValidatedTurnUpdate>[0]> = {}) => applyValidatedTurnUpdate({
		storyId: 'story_1', playerEntryId: 'agency_player', assistantEntryId: 'agency_narration', narration: independentMove,
		update: worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', entityId: 'entity_mira', ...character }] }),
		parseWarnings: [], retrievedMemoryIds: [], serverVersion: 21, ...extra,
	});
	it('persists NPC intent and source-linked independent moves atomically with replay-stable event IDs', async () => {
		const mock = createDbMock({ persistEntities: true, sceneSourceEntries: [{ id: 'agency_narration', type: 'narration', content: independentMove, metadata: {} }] });
		dbMocks.getDb.mockReturnValue(mock.db);
		const update = { ...agencyState, independentActionEvidence: independentMove, independentActionVisibility: 'secret' };
		await applyAgency(update);
		await applyAgency(update);
		const character = mock.insertCalls.find(call => call.table === entities)?.value as Record<string, unknown>;
		expect(character).toMatchObject({ state: { ...agencyState, nextOpportunityRecordedAt: 'Twilight of Ashes' }, sourceEntryIds: ['agency_narration'] });
		const moves = mock.insertCalls.filter(call => call.table === storyEvents).map(call => call.value as Record<string, unknown>).filter(event => (event.metadata as Record<string, unknown>).sourceType === 'npc_independent_action');
		expect(moves).toHaveLength(2);
		expect(new Set(moves.map(event => event.id)).size).toBe(1);
		expect(moves[0]).toMatchObject({ status: 'committed', body: independentMove, actorEntityIds: ['entity_mira'], visibility: 'secret', occurredTurn: 7, scheduledTurn: null, sourceEntryIds: ['agency_narration'], memoryImpact: { independentNpcAction: true, evidence: independentMove } });
		expect(mock.insertCalls.filter(call => call.table === npcEventLinks).flatMap(call => call.value as Record<string, unknown>[])).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: moves[0].id, npcEntityId: 'entity_mira', role: 'actor', visibility: 'secret' })]));
		expect(mock.insertCalls.every(call => call.source === 'tx')).toBe(true);
		expect(dbMocks.enqueueTurnProjectionJobs).toHaveBeenCalledWith(expect.objectContaining({ eventIds: expect.arrayContaining([moves[0].id]) }));
	});
	it('clears resolved intent without deleting its independent move history', async () => {
		const mock = createDbMock({ entityRows: [{ ...entityRows[1], state: { ...agencyState, nextOpportunityRecordedAt: 'Yesterday' } }] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await applyAgency({ currentGoal: null, currentPlan: null, nextOpportunity: null, constraint: null });
		expect((mock.insertCalls.find(call => call.table === entities)?.value as Record<string, unknown>).state).toMatchObject({ currentGoal: null, currentPlan: null, lastIndependentAction: independentMove, nextOpportunity: null, nextOpportunityRecordedAt: null, constraint: null });
		expect(mock.deleteCalls.some(call => call.table === storyEvents)).toBe(false);
	});
	it('stores a future plan and opportunity without manufacturing a completed or scheduled move', async () => {
		const mock = createDbMock();
		dbMocks.getDb.mockReturnValue(mock.db);
		await applyAgency({ currentGoal: agencyState.currentGoal, currentPlan: agencyState.currentPlan, nextOpportunity: agencyState.nextOpportunity });
		const events = mock.insertCalls.filter(call => call.table === storyEvents).map(call => call.value as Record<string, unknown>);
		expect(events).toHaveLength(1);
		expect(events[0].title).toBe('Turn resolved');
	});
	it('retains a late independent move without regressing the newer NPC plan or last-action pointer', async () => {
		const newer = { currentGoal: 'Protect the new apprenticeship.', currentPlan: 'Pay the indenture.', lastIndependentAction: 'Mira signed the indenture.', nextOpportunity: 'The ship sails at dawn.', constraint: 'No public accusation.' };
		const mock = createDbMock({ entityRows: [{ ...entityRows[1], state: newer }], sceneSourceEntries: [{ id: 'agency_narration', type: 'narration', content: independentMove, metadata: {} }] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await applyAgency({ ...agencyState, independentActionEvidence: independentMove }, { mode: 'supplemental', timelineTurn: 3, suppressCurrentNpcAgency: true, narration: '' });
		expect((mock.insertCalls.find(call => call.table === entities)?.value as Record<string, unknown>).state).toMatchObject(newer);
		expect(mock.insertCalls.filter(call => call.table === storyEvents).map(call => call.value)).toEqual(expect.arrayContaining([expect.objectContaining({ body: independentMove, occurredTurn: 3, status: 'committed' })]));
	});
	it.each([
		['unsupported action', 'Mira burned the royal appointment.', independentMove, {}],
		['invented evidence', 'Mira burned the royal appointment.', 'Mira burned the royal appointment.', {}],
		['non-canon narration', independentMove, independentMove, { nonCanon: true }],
	])('withholds a completed move based on %s', async (_reason, action, evidence, metadata) => {
		const mock = createDbMock({ sceneSourceEntries: [{ id: 'agency_narration', type: 'narration', content: independentMove, metadata }] });
		dbMocks.getDb.mockReturnValue(mock.db);
		const result = await applyAgency({ lastIndependentAction: action, independentActionEvidence: evidence });
		expect((mock.insertCalls.find(call => call.table === entities)?.value as Record<string, unknown>).state).not.toHaveProperty('lastIndependentAction');
		expect(mock.insertCalls.filter(call => call.table === storyEvents).map(call => call.value as Record<string, unknown>).some(event => (event.metadata as Record<string, unknown>).sourceType === 'npc_independent_action')).toBe(false);
		expect(result.warnings.join(' ')).toContain('Independent move for Mira was not saved');
	});
	const introduction = 'Tala Venn, a courier sworn to The Watch, delivers the sealed dispatch.';
	const newNpc = { name: 'Tala Venn', description: 'A courier delivering a sealed dispatch.', background: 'A courier sworn to The Watch.',
		creation_evidence: introduction, faction_tags: ['The Watch'], faction_evidence: [{ faction: 'The Watch', quote: introduction }] };
	const autoCreate = (characters: unknown[] = [newNpc]) => applyValidatedTurnUpdate({
		storyId: 'story_1', playerEntryId: 'action', assistantEntryId: 'resolution', narration: introduction,
		update: worldStateUpdateSchema.parse({ characters }), parseWarnings: [], retrievedMemoryIds: [], serverVersion: 20,
	});
	const source = { id: 'resolution', type: 'narration', content: introduction, metadata: {} };
	it('automatically creates a sourced NPC and faction membership in one transaction, reusing identity on replay', async () => {
		const mock = createDbMock({ persistEntities: true, sceneSourceEntries: [source], membershipRows: [] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await autoCreate();
		const created = mock.insertCalls.find(call => call.table === entities)?.value as Record<string, unknown>;
		expect(created).toMatchObject({ name: 'Tala Venn', sourceEntryIds: ['resolution'], metadata: { sourceType: 'gm_auto_character', creationEvidence: introduction } });
		const membership = mock.insertCalls.find(call => call.table === factionMemberships)?.value as Record<string, unknown>;
		expect(membership).toMatchObject({ entityId: created.id, factionId: 'faction_watch', sourceEntryIds: ['resolution'], status: 'active' });
		expect(mock.updateCalls.find(call => call.table === entities)?.value.state).toMatchObject({ factionTags: ['The Watch'] });
		expect(mock.insertCalls.filter(call => [entities, factionMemberships, sourceRefs].includes(call.table as never)).every(call => call.source === 'tx')).toBe(true);
		await autoCreate();
		expect(new Set(mock.insertCalls.filter(call => call.table === entities).map(call => (call.value as Record<string, unknown>).id)).size).toBe(1);
		expect(new Set(mock.insertCalls.filter(call => call.table === factionMemberships).map(call => (call.value as Record<string, unknown>).id)).size).toBe(1);
	});
	it.each([
		['unquoted invention', { ...newNpc, creation_evidence: 'Tala Venn is the powerful captain of The Watch.' }, source],
		['missing source', newNpc, { ...source, id: 'different_entry' }],
		['non-canon source', newNpc, { ...source, metadata: { nonCanon: true } }],
		['wrong explicit identity', { ...newNpc, entityId: 'other_story_entity' }, source],
	])('withholds %s and retains a review candidate', async (_label, character, evidenceSource) => {
		const mock = createDbMock({ persistEntities: true, sceneSourceEntries: [evidenceSource] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await autoCreate([character]);
		expect(mock.insertCalls.filter(call => call.table === entities || call.table === factionMemberships)).toHaveLength(0);
		const proposals = mock.insertCalls.filter(call => call.table === patchProposals).flatMap(call => call.value as Record<string, unknown>[]);
		expect(proposals).toEqual(expect.arrayContaining([expect.objectContaining({ proposalType: 'character_reference_review', status: 'needs_review' })]));
	});
	it('leaves ambiguous names for review without creating or overwriting either person', async () => {
		const mock = createDbMock({ entityRows: [
			{ id: 'tala_one', storyId: 'story_1', type: 'character', name: 'Tala Venn' },
			{ id: 'tala_two', storyId: 'story_1', type: 'character', name: 'Tala Venn' },
		], sceneSourceEntries: [source] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await autoCreate();
		expect(mock.insertCalls.filter(call => call.table === entities)).toHaveLength(0);
		expect(mock.insertCalls.some(call => call.table === patchProposals)).toBe(true);
	});
	it('saves the character but withholds unsupported and ambiguous affiliations', async () => {
		const mock = createDbMock({ persistEntities: true, sceneSourceEntries: [source], factionRows: [
			...factionRows, { ...factionRows[0], id: 'duplicate_watch' },
		] });
		dbMocks.getDb.mockReturnValue(mock.db);
		const result = await autoCreate([{ ...newNpc, faction_tags: ['The Watch', 'Secret Guild'], faction_evidence: [
			...newNpc.faction_evidence, { faction: 'Secret Guild', quote: 'Tala Venn commands the Secret Guild.' },
		] }]);
		expect(mock.insertCalls.some(call => call.table === entities)).toBe(true);
		expect(mock.insertCalls.filter(call => call.table === factionMemberships)).toHaveLength(0);
		expect((mock.insertCalls.find(call => call.table === entities)?.value as any).state.factionTags).toBeUndefined();
		expect(result.warnings.filter(warning => warning.startsWith('Faction affiliation'))).toHaveLength(2);
	});
	it('links an existing unresolved membership instead of adding a second member row', async () => {
		const mock = createDbMock({ persistEntities: true, sceneSourceEntries: [source], membershipRows: [
			{ id: 'unresolved_tala', factionId: 'faction_watch', entityId: null, status: 'active', metadata: { memberNameOrId: 'Tala Venn' }, sourceEntryIds: ['earlier'] },
		] });
		dbMocks.getDb.mockReturnValue(mock.db);
		await autoCreate();
		expect(mock.insertCalls.find(call => call.table === factionMemberships)?.value).toMatchObject({
			id: 'unresolved_tala', sourceEntryIds: ['earlier', 'resolution'], metadata: { unresolvedCharacterReference: false },
		});
	});
	const promise = {
		id: 'promise_1', storyId: 'story_1', category: 'promise', parties: ['Valen', 'Mira'],
		terms: 'Return the silver bell before dawn.', status: 'active', secrecy: 'secret', consequences: [],
		sourceEntryIds: ['original_promise'], sourceEventIds: ['original_event'], sourcePatchIds: ['original_patch'],
		serverVersion: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
	} as typeof agreements.$inferSelect;
	const applyAgreement = (change: Record<string, unknown>) => applyValidatedTurnUpdate({
		storyId: 'story_1', playerEntryId: 'action', assistantEntryId: 'resolution',
		narration: 'Mira returns the silver bell and releases Valen from the vow.',
		update: worldStateUpdateSchema.parse({ agreements: [change] }), parseWarnings: [], retrievedMemoryIds: [], serverVersion: 20,
	});
	it.each([['fulfill', 'fulfilled'], ['annul', 'annulled'], ['break', 'broken'], ['expire', 'expired'], ['supersede', 'superseded']])('applies %s to the canonical obligation and retains its private source history', async (action, status) => {
		const { db, updateCalls, insertCalls } = createDbMock({ agreementRows: [promise], sourcePositions: [200, 2] });
		dbMocks.getDb.mockReturnValue(db);
		await applyAgreement({ action, id: promise.id, terms: 'A resolution summary must not replace original terms.', parties: ['Wrong party'], secrecy: 'public' });
		expect(updateCalls.find(call => call.table === agreements)?.value).toMatchObject({
			status, terms: promise.terms, secrecy: 'secret', sourceEntryIds: ['original_promise', 'resolution'],
		});
		expect(insertCalls.filter(call => call.table === agreements)).toHaveLength(0);
		expect(insertCalls.find(call => call.table === storyEvents && (call.value as { type: string }).type === 'agreement')?.value).toMatchObject({
			visibility: 'secret', sourceEntryIds: ['resolution'], metadata: { agreementId: promise.id, previousAgreement: promise, currentAgreement: { status } },
		});
	});
	it('revises the current terms without losing the original terms or publishing a secret', async () => {
		const { db, updateCalls, insertCalls } = createDbMock({ agreementRows: [promise], sourcePositions: [200, 2] });
		dbMocks.getDb.mockReturnValue(db);
		await applyAgreement({ action: 'update', id: promise.id, terms: 'Return the silver bell next week.' });
		expect(updateCalls.find(call => call.table === agreements)?.value).toMatchObject({ status: 'active', secrecy: 'secret', terms: 'Return the silver bell next week.' });
		expect(insertCalls.find(call => call.table === storyEvents && (call.value as { type: string }).type === 'agreement')?.value).toMatchObject({ metadata: { previousAgreement: { terms: promise.terms } } });
	});
	it.each([
		{ rows: [promise], change: { action: 'fulfill', id: 'wrong-id' }, positions: [200, 2] },
		{ rows: [promise, { ...promise, id: 'promise_2' }], change: { action: 'fulfill', parties: ['Mira', 'Valen'], category: 'promise' }, positions: [200, 2] },
		{ rows: [{ ...promise, storyId: 'foreign_story' }], change: { action: 'fulfill', id: promise.id }, positions: [200, 2] },
		{ rows: [{ ...promise, status: 'fulfilled' }], change: { action: 'update', id: promise.id, terms: 'Owe it again' }, positions: [200, 2] },
		{ rows: [promise], change: { action: 'update', id: promise.id, terms: 'Obsolete terms' }, positions: [2, 200] },
		{ rows: [promise], change: { action: 'fulfill', id: promise.id }, positions: [] },
		{ rows: [{ ...promise, sourceEntryIds: ['resolution'] }], change: { action: 'update', id: promise.id }, positions: [200, 200] },
	])('does not guess, revive, or replay an agreement ($change.action)', async ({ rows, change, positions }) => {
		const { db, updateCalls, insertCalls } = createDbMock({ agreementRows: rows, sourcePositions: positions });
		dbMocks.getDb.mockReturnValue(db);
		const result = await applyAgreement(change);
		expect(updateCalls.filter(call => call.table === agreements)).toHaveLength(0);
		expect(insertCalls.filter(call => call.table === storyEvents && (call.value as { type: string }).type === 'agreement')).toHaveLength(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});
	it.each([undefined, 'missing_id', 'entity_mira_a'])('does not guess between duplicate names or mismatched IDs (%s)', async entityId => {
		const rows = [
			{ id: 'entity_mira_a', storyId: 'story_1', type: 'character', name: 'Mira', status: 'active', state: {} },
			{ id: 'entity_mira_b', storyId: 'story_1', type: 'character', name: 'Mira', status: 'active', state: {} },
		];
		const { db, insertCalls } = createDbMock({ entityRows: rows });
		dbMocks.getDb.mockReturnValue(db);
		await applyValidatedTurnUpdate({ storyId: 'story_1', playerEntryId: 'user', assistantEntryId: 'reply', narration: 'The stranger waits.', update: worldStateUpdateSchema.parse({ characters: [{ name: entityId === 'entity_mira_a' ? 'Someone Else' : 'Mira', entityId, personality: 'Invented' }] }), parseWarnings: [], retrievedMemoryIds: [], serverVersion: 20 });
		expect(insertCalls.filter(call => call.table === entities)).toHaveLength(0);
	});
	it('requires concrete evidence for nonzero affinity shifts and enforces bounds', () => {
		expect(() => worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', affinity_delta: 3 }] })).toThrow('affinity_reason');
		expect(() => worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', affinity_delta: 21, affinity_reason: 'Major betrayal.' }] })).toThrow();
		expect(worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', affinity_delta: 0 }] }).characters[0]?.affinity_delta).toBe(0);
		expect(worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', affinity_delta: -4, affinity_reason: 'The player broke the harbor promise.' }] }).characters[0]).toMatchObject({ affinity_delta: -4 });
	});

	it('throws before applying a patch when the story is missing', async () => {
		const { db, insertCalls, updateCalls, selectLocks } = createDbMock({ story: null });
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({});

		await expect(applyValidatedTurnUpdate({
			storyId: 'missing_story',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Nothing should be persisted.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		})).rejects.toThrow('Story not found: missing_story');

		expect(db.transaction).toHaveBeenCalledTimes(1);
		expect(selectLocks).toEqual([
			expect.objectContaining({ source: 'tx', table: stories, strength: 'update' }),
		]);
		expect(insertCalls).toEqual([]);
		expect(updateCalls).toEqual([]);
		expect(dbMocks.enqueueTurnProjectionJobs).not.toHaveBeenCalled();
	});

	it('can apply inside a caller-owned transaction without opening or projecting before commit', async () => {
		const { tx, selectLocks } = createDbMock();
		dbMocks.getDb.mockImplementation(() => {
			throw new Error('caller-owned transaction should not open a root connection');
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '',
			update: worldStateUpdateSchema.parse({}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
			mode: 'supplemental',
		}, {
			transaction: tx as any,
			enqueueProjectionJobs: false,
		});

		expect(result).toEqual({ eventIds: [], patchIds: [], memoryNodeIds: [], warnings: [], effects: [] });
		expect(selectLocks).toEqual([
			expect.objectContaining({ source: 'tx', table: stories, strength: 'update' }),
		]);
		expect(dbMocks.getDb).not.toHaveBeenCalled();
		expect(dbMocks.enqueueTurnProjectionJobs).not.toHaveBeenCalled();
	});

	it('emits committed timeline defaults, resolved agreement npc links, and advances story turn', async () => {
		const { db, tx, insertCalls, updateCalls, selectLocks, storyUpdates } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			player_reputation: 'honored',
			agreements: [
				{
					action: 'create',
					parties: ['Valen', 'Mira', 'The Watch', 'Unknown Envoy'],
					category: 'oath',
					terms: 'Guard the ash bridge together.',
					secrecy: 'known',
					consequences: ['Crossing remains open'],
				},
			],
			story_beats: [
				{
					title: 'Ash bridge secured',
					description: 'The crossing holds for another night.',
					significance: 'major',
				},
			],
			time_delta: 'one hour after the oath',
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Valen and Mira seal the bridge oath while the crowd watches.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: ['mem_old'],
			serverVersion: 12,
		});

		expect(db.transaction).toHaveBeenCalledTimes(1);
		expect(db.select).not.toHaveBeenCalled();
		expect(db.insert).not.toHaveBeenCalled();
		expect(db.update).not.toHaveBeenCalled();
		expect(tx.select).toHaveBeenCalled();
		expect(insertCalls.every(call => call.source === 'tx')).toBe(true);
		expect(updateCalls.every(call => call.source === 'tx')).toBe(true);
		expect(selectLocks).toEqual([
			expect.objectContaining({ source: 'tx', table: stories, strength: 'update' }),
			expect.objectContaining({ source: 'tx', table: worldClocks, strength: 'update' }),
		]);
		// The stated duration is the classifier's proposal; the clock applies it once for this turn.
		expect(insertCalls.find(call => call.table === worldTimeChanges)?.value).toMatchObject({ opKey: 'turn:entry_assistant', status: 'applied',
			kind: 'advance', proposer: 'classifier', requestedMinutes: 60, appliedMinutes: 60, beforeLabel: 'Twilight of Ashes', afterLabel: 'Twilight of Ashes (+1h)' });

		const patchInsert = insertCalls.find(call => call.table === statePatches)?.value as { id: string };
		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const agreementEvent = eventInserts.find(event => event.type === 'agreement');
		const linkInsert = insertCalls.find(call => call.table === npcEventLinks)?.value as Array<Record<string, unknown>>;
		const metadataUpdate = storyUpdates.find(updatePayload => updatePayload.metadata);
		const turnUpdate = storyUpdates.find(updatePayload => updatePayload.currentTurn === 8);
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const factInserts = insertCalls.filter(call => call.table === facts);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);
		const warningInserts = insertCalls.filter(call => call.table === continuityWarnings);
		const memoryInserts = insertCalls.filter(call => call.table === memoryNodes);

		expect(result.eventIds).toEqual(eventInserts.map(event => event.id));
		expect(result.memoryNodeIds).toEqual([]);
		expect(eventInserts).toHaveLength(3);
		expect(memoryInserts).toEqual([]);
		for (const event of eventInserts) {
			expect(event).toMatchObject({
				status: 'committed',
				createdTurn: 7,
				occurredTurn: 7,
				scheduledTurn: null,
				worldTime: 'Twilight of Ashes (+1h)',
				locationIds: [],
				memoryImpact: {},
				serverVersion: 12,
			});
		}
		expect(eventInserts.find(event => event.title === 'Turn resolved')).toMatchObject({
			visibility: 'player_known',
			sourceEntryIds: ['entry_player', 'entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			metadata: {},
		});
		expect(agreementEvent).toMatchObject({
			visibility: 'player_known',
			actorEntityIds: ['entity_valen'],
			targetEntityIds: ['entity_mira'],
			factionIds: ['faction_watch'],
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			metadata: { agreement: update.agreements[0] },
		});
		expect(eventInserts.find(event => event.title === 'Ash bridge secured')).toMatchObject({
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			metadata: { significance: 'major' },
		});
		expect(factInserts).toEqual([]);
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(warningInserts).toEqual([]);
		expect(result.warnings).toContain('Character reference "Unknown Envoy" was not created as canon; add it manually if this should become a character.');
		expect(linkInsert).toEqual([
			expect.objectContaining({
				storyId: 'story_1',
				eventId: agreementEvent?.id,
				npcEntityId: 'entity_valen',
				role: 'actor',
				visibility: 'player_known',
				sourceEntryIds: ['entry_assistant'],
				sourcePatchIds: [patchInsert.id],
				serverVersion: 12,
			}),
			expect.objectContaining({
				storyId: 'story_1',
				eventId: agreementEvent?.id,
				npcEntityId: 'entity_mira',
				role: 'target',
				visibility: 'player_known',
				sourceEntryIds: ['entry_assistant'],
				sourcePatchIds: [patchInsert.id],
				serverVersion: 12,
			}),
		]);
		expect(linkInsert.map(link => link.eventId)).not.toContain(eventInserts.find(event => event.title === 'Turn resolved')?.id);
		expect(linkInsert.map(link => link.eventId)).not.toContain(eventInserts.find(event => event.title === 'Ash bridge secured')?.id);
		expect(metadataUpdate?.metadata).toEqual({
			campaignTone: 'wary',
			playerReputation: 'honored',
			playerReputationUpdatedAt: expect.any(String),
			playerReputationUpdatedTurn: 7,
		});
		expect(turnUpdate).toMatchObject({
			currentTurn: 8,
			currentWorldTime: 'Twilight of Ashes (+1h)',
			currentLocationId: 'entity_bridge',
			serverVersion: 12,
			updatedAt: expect.any(String),
		});
		if (turnUpdate?.metadata) {
			expect(turnUpdate.metadata).toEqual(metadataUpdate?.metadata);
		}
		expect(dbMocks.enqueueTurnProjectionJobs).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			eventIds: result.eventIds,
			patchIds: [patchInsert.id],
			serverVersion: 12,
		}));
	});

	it('links resolved character updates to the base turn event memory', async () => {
		const { db, insertCalls, updateCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			characters: [
				{
					name: 'Valen',
					description: 'Valen refuses to yield the ash bridge.',
					traits: ['defiant'],
					present: true,
				},
				{
					name: 'Mira',
					description: 'Mira watches Valen with new caution.',
					traits: ['wary'],
					present: true,
				},
			],
		});

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Valen and Mira face each other at the bridge.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 18,
		});

		const turnEvent = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>)
			.find(event => event.title === 'Turn resolved');
		const turnEventUpdate = updateCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value)
			.find(value => Array.isArray(value.actorEntityIds));
		const linkInserts = insertCalls
			.filter(call => call.table === npcEventLinks)
			.flatMap(call => call.value as Array<Record<string, unknown>>);

		expect(turnEventUpdate).toMatchObject({
			actorEntityIds: ['entity_valen', 'entity_mira'],
			serverVersion: 18,
		});
		expect(linkInserts).toEqual([
			expect.objectContaining({
				storyId: 'story_1',
				eventId: turnEvent?.id,
				npcEntityId: 'entity_valen',
				role: 'actor',
				visibility: 'player_known',
				sourceEntryIds: ['entry_player', 'entry_assistant'],
				serverVersion: 18,
			}),
			expect.objectContaining({
				storyId: 'story_1',
				eventId: turnEvent?.id,
				npcEntityId: 'entity_mira',
				role: 'actor',
				visibility: 'player_known',
				sourceEntryIds: ['entry_player', 'entry_assistant'],
				serverVersion: 18,
			}),
		]);
	});

	it('persists rich state for established characters without dropping old event memory', async () => {
		const { db, insertCalls } = createDbMock({
			entityRows: [
				{
					id: 'entity_mira',
					storyId: 'story_1',
					type: 'character',
					name: 'Mira',
					description: 'A harbor negotiator.',
					status: 'active',
					state: {
						bio: 'A former captain.',
						appearance: 'Grey eyes',
						isPresent: false,
						relationship: {
							level: 42,
							status: 'trusted broker',
							history: [{ description: 'Mira kept the old bargain.', entryId: 'entry_old', timestamp: 1 }],
						},
						eventMemory: {
							did: ['Mira hid the old map.'],
							saw: ['Mira saw Valen hesitate at the bridge.'],
						},
					},
					metadata: {},
					sourceEntryIds: [],
					sourceEventIds: [],
					sourcePatchIds: [],
					createdAt: 'earlier',
				},
				...entityRows.filter((entity) => entity.id !== 'entity_mira'),
			],
		});
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			characters: [{
				name: 'Mira',
				entityId: 'entity_mira',
				aliases: ['The Harbor Broker'],
				present: true,
				relationship: 'wary ally',
				presentation: 'salt-stained blue cloak and ink-dark fingertips',
				personality: 'Patient and exacting',
				background: 'raised around harbor ledgers and old smuggling routes',
				currentLocation: 'Ash Bridge counting room',
				currentAction: 'holding the bridge bargain together while watching Valen',
				emotionalState: 'controlled fear under professional calm',
				party_member: true,
				party_role: 'Face',
				affinity_delta: -7,
				affinity_reason: 'The player publicly endangered Mira\'s brother to force the bargain.',
				goals: ['keep the bridge bargain alive'],
				speechStyle: 'quiet, exact, with clipped harbor idioms',
				eventMemory: {
					did: ['Mira swore not to sell Valen out.', 'promise: Armor polishing before dawn.'],
					knew: ['Mira knows the bridge bargain has a hidden witness.'],
				},
			}],
		});

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Mira steadies herself and answers in the old harbor cant.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 19,
		});

		const entityInsert = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.id === 'entity_mira');
		const state = entityInsert?.state as Record<string, unknown>;
		const memory = state.eventMemory as Record<string, string[]>;

		expect(state).toMatchObject({
			isPresent: true,
			present: true,
			bio: 'A former captain.',
			appearance: 'Grey eyes',
			presentation: 'salt-stained blue cloak and ink-dark fingertips',
			currentLocation: 'Ash Bridge counting room',
			currentAction: 'holding the bridge bargain together while watching Valen',
			emotionalState: 'controlled fear under professional calm',
			partyMember: true,
			partyRole: 'Face',
			currentDisposition: 'wary ally',
				relationship: expect.objectContaining({
					level: 35,
					status: 'wary ally',
				}),
			motivations: ['keep the bridge bargain alive'],
			goals: ['keep the bridge bargain alive'],
		});
		const relationship = state.relationship as Record<string, unknown>;
		expect(relationship.history).toEqual([
			expect.objectContaining({ description: 'Mira kept the old bargain.', entryId: 'entry_old', timestamp: 1 }),
			expect.objectContaining({ delta: -7, entryId: 'entry_assistant', timestamp: expect.any(Number) }),
		]);
		expect(state).not.toHaveProperty('affinityDelta');
		expect(state).not.toHaveProperty('affinityReason');
		expect(memory.did).toEqual(['Mira hid the old map.', 'Mira swore not to sell Valen out.']);
		expect(memory.did).not.toContain('promise: Armor polishing before dawn.');
		expect(memory.saw).toEqual(['Mira saw Valen hesitate at the bridge.']);
		expect(memory.knew).toEqual(['Mira knows the bridge bargain has a hidden witness.']);
	});

	it('clears contradictory stale presence when an extracted actor is explicitly present', async () => {
		const { db, updateCalls } = createDbMock({
			entityRows: [
				{ id: 'entity_valen', storyId: 'story_1', type: 'character', name: 'Valen', status: 'active', state: { present: true, currentLocation: 'Ash Bridge' } },
				{ id: 'entity_mira', storyId: 'story_1', type: 'character', name: 'Mira', status: 'active', state: { present: true, isPresent: true, currentLocation: 'Distant Tower' } },
				{ id: 'entity_bridge', storyId: 'story_1', type: 'location', name: 'Ash Bridge', state: { current: true } },
			],
		});
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Valen remains at Ash Bridge while Mira is still far away.',
			update: worldStateUpdateSchema.parse({ characters: [{ name: 'Valen', present: true }] }),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 20,
		});

		expect(updateCalls.some((call) => call.table === entities
			&& call.value.state
			&& (call.value.state as Record<string, unknown>).present === false
			&& (call.value.state as Record<string, unknown>).currentLocation === 'Distant Tower')).toBe(true);
	});

	it('uses the narration header as the event, story clock, and fallback current location', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({
			story: { ...storyRow, currentWorldTime: null, currentLocationId: null },
		});
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			time_delta: 'Dawn after the fire',
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[ 🕰️ Time 06:15 | 🗓️ Day, Ember Moon 8, 299 AC | 📍 Location - Ember Courtyard | [Weather] Clear, 18 C ]\nAsh light finds the courtyard.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const turnUpdate = storyUpdates.find(updatePayload => updatePayload.currentTurn === 8);
		const locationInsert = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.type === 'location' && value.name === 'Ember Courtyard');

		expect(result.eventIds).toEqual(eventInserts.map(event => event.id));
		expect(eventInserts).toHaveLength(1);
		expect(eventInserts[0]).toMatchObject({
			title: 'Turn resolved',
			worldTime: 'Day Ember Moon 8, 299 AC | 06:15',
			createdTurn: 7,
			occurredTurn: 7,
		});
		expect(turnUpdate).toMatchObject({
			currentTurn: 8,
			currentWorldTime: 'Day Ember Moon 8, 299 AC | 06:15',
			currentLocationId: locationInsert?.id,
		});
		expect(locationInsert).toMatchObject({
			state: { current: true },
			sourceEntryIds: ['entry_assistant'],
		});
	});

	it.each(['turn', 'supplemental'] as const)('preserves primary location, clock and presence during %s parallel extraction', async (mode) => {
		const { db, insertCalls, updateCalls, storyUpdates } = createDbMock({
			sceneSourceEntries: [{ type: 'narration', content: '', metadata: { narrativeMode: 'parallel_pov', parallelPov: { character: 'Mira' } } }],
			entityRows: [
				{ id: 'entity_mira', storyId: 'story_1', type: 'character', name: 'Mira', status: 'active', state: { present: false, isPresent: false } },
				...entityRows.filter(row => row.id !== 'entity_mira'),
			],
		});
		dbMocks.getDb.mockReturnValue(db);
		await applyValidatedTurnUpdate({
			storyId: 'story_1', playerEntryId: 'entry_player', assistantEntryId: 'entry_assistant', mode,
			narration: '[ Time 06:15 | Day 3 | Location - Yin Hall | Weather Clear ]\nMira meets the envoy.',
			update: worldStateUpdateSchema.parse({
				characters: [{ name: 'Mira', entityId: 'entity_mira', present: true, currentLocation: 'Yin Hall', currentAction: 'Meeting an envoy' }],
				locations: [{ name: 'Yin Hall', current: true, description: 'A public reception hall.' }],
			}),
			parseWarnings: [], retrievedMemoryIds: [], serverVersion: 22,
		});
		const canonicalEntities = insertCalls.filter(call => call.table === entities).map(call => call.value as Record<string, unknown>);
		expect(canonicalEntities.find(row => row.id === 'entity_mira')?.state).toMatchObject({ present: false, isPresent: false, currentLocation: 'Yin Hall', currentAction: 'Meeting an envoy' });
		const hall = canonicalEntities.find(row => row.name === 'Yin Hall');
		expect(hall).toMatchObject({ description: 'A public reception hall.', sourceEntryIds: ['entry_assistant'] });
		expect(hall?.state).not.toHaveProperty('current');
		expect(updateCalls.filter(call => call.table === entities)).toHaveLength(0);
		if (mode === 'turn') {
			expect(storyUpdates).toContainEqual(expect.objectContaining({ currentTurn: 8, currentLocationId: 'entity_bridge', currentWorldTime: 'Twilight of Ashes' }));
			expect(insertCalls.find(call => call.table === storyEvents)?.value).toMatchObject({ metadata: { narrativeMode: 'parallel_pov' }, worldTime: 'Day 3 | 06:15' });
			expect(updateCalls).toContainEqual(expect.objectContaining({ table: storyEvents, value: expect.objectContaining({ locationId: hall?.id }) }));
		} else {
			expect(storyUpdates).toHaveLength(0);
		}
	});

	it.each([undefined, 'unknown_room'])('queues ambiguous or invalid-id locations without creating another duplicate (%s)', async (entityId) => {
		const { db, insertCalls, storyUpdates } = createDbMock({ entityRows: [
			...entityRows,
			{ id: 'room_1', storyId: 'story_1', type: 'location', name: 'Volantis — Aurion’s Chambers' },
			{ id: 'room_2', storyId: 'story_1', type: 'location', name: "Volantis - Aurion's Chambers" },
		] });
		dbMocks.getDb.mockReturnValue(db);
		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1', playerEntryId: 'entry_player', assistantEntryId: 'entry_assistant',
			narration: 'The chamber is quiet.',
			update: worldStateUpdateSchema.parse({ locations: [{ entityId, name: "Volantis - Aurion's Chambers", current: true }] }),
			parseWarnings: [], retrievedMemoryIds: [], serverVersion: 22,
		});
		expect(insertCalls.filter(call => call.table === entities)).toHaveLength(0);
		expect(insertCalls.some(call => call.table === patchProposals)).toBe(true);
		expect(result.warnings.some(warning => warning.includes('identity review'))).toBe(true);
		expect(storyUpdates).toContainEqual(expect.objectContaining({ currentLocationId: 'entity_bridge' }));
	});

	it('reuses an explicit location id and preserves omitted routes and region', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({ entityRows: [
			{ id: 'room_2', storyId: 'story_1', type: 'location', name: 'Chambers', state: { region: 'Volantis', connections: [{ targetName: 'Hall' }] } },
			{ id: 'room_1', storyId: 'story_1', type: 'location', name: 'Chambers' },
		] });
		dbMocks.getDb.mockReturnValue(db);
		await applyValidatedTurnUpdate({
			storyId: 'story_1', playerEntryId: 'entry_player', assistantEntryId: 'entry_assistant', narration: 'The room is quiet.',
			update: worldStateUpdateSchema.parse({ locations: [{ entityId: 'room_2', name: 'Chambers', current: true }] }),
			parseWarnings: [], retrievedMemoryIds: [], serverVersion: 22,
		});
		expect(insertCalls.find(call => call.table === entities)?.value).toMatchObject({ id: 'room_2', state: { current: true, region: 'Volantis', connections: [{ targetName: 'Hall' }] } });
		expect(storyUpdates).toContainEqual(expect.objectContaining({ currentLocationId: 'room_2' }));
	});

	it('keeps a specific scene location separate from its parent place', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({
			story: { ...storyRow, currentLocationId: 'entity_volantis' },
			entityRows: [
				{ id: 'entity_volantis', storyId: 'story_1', type: 'location', name: 'Volantis', state: { current: true } },
			],
		});
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[ Time 05:03 | Day 1, Eleventh Moon 296 AC | Location - The Lower Yard, Belaerys Manse, Volantis | Weather Clear ]\nDawn reaches the yard.',
			update: worldStateUpdateSchema.parse({}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 13,
		});

		const locationInsert = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.type === 'location' && value.name === 'The Lower Yard, Belaerys Manse, Volantis');
		expect(locationInsert?.id).not.toBe('entity_volantis');
		expect(storyUpdates.find(value => value.currentLocationId === locationInsert?.id)).toBeTruthy();
	});

	it('parses the live emoji scene header after placeholders have been replaced', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({
			story: { ...storyRow, currentWorldTime: null, currentLocationId: null },
		});
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[🕰️ Time 15:05 | 🗓️ Sunday, Silver Moon 12, 299 AC | 📍 Chaos Breaker, Sky Castle | ☀️ Clear]\nThe engines settle into a low hum.',
			update: worldStateUpdateSchema.parse({}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		const event = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.title === 'Turn resolved');
		const location = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.type === 'location' && value.name === 'Chaos Breaker, Sky Castle');
		expect(event?.worldTime).toBe('Day Sunday, Silver Moon 12, 299 AC | 15:05');
		expect(storyUpdates.find(value => value.currentTurn === 8)).toMatchObject({
			currentWorldTime: 'Day Sunday, Silver Moon 12, 299 AC | 15:05',
			currentLocationId: location?.id,
		});
	});

	it('treats time_delta as an elapsed duration, never as a clock label, and preserves location state without a new anchor', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({
			story: { ...storyRow, currentWorldTime: null },
			entityRows: [entityRows[2], ...entityRows.filter(row => row.id !== 'entity_bridge')],
		});
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Ash light finds the bridge.',
			update: worldStateUpdateSchema.parse({
				time_delta: '  Dawn after the fire  ',
				locations: [{ name: 'Ash Bridge', description: 'The old crossing remains occupied.' }],
			}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		const bridgeInsert = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.id === 'entity_bridge');
		expect(bridgeInsert?.state).toMatchObject({ current: true });
		expect(storyUpdates.find(value => value.currentTurn === 8)).toMatchObject({
			currentWorldTime: null,
			currentLocationId: 'entity_bridge',
		});
		expect(insertCalls.some(call => call.table === worldTimeChanges || call.table === worldClocks)).toBe(false);
	});

	it('uses a known header location during empty supplemental extraction even when its clock is unknown', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[ Time unknown | Day unknown | Location - Lantern Docks | Weather Clear, 17 C ]\nThe lamps burn above the water.',
			update: worldStateUpdateSchema.parse({}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
			mode: 'supplemental',
			timelineTurn: 7,
		});

		const locationInsert = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.find(value => value.type === 'location' && value.name === 'Lantern Docks');
		expect(result).toMatchObject({ eventIds: [], patchIds: [], memoryNodeIds: [] });
		expect(locationInsert?.state).toMatchObject({ current: true });
		expect(storyUpdates.find(value => value.currentLocationId === locationInsert?.id)).toMatchObject({
			currentWorldTime: 'Twilight of Ashes',
			currentLocationId: locationInsert?.id,
		});
		expect(storyUpdates.some(value => 'currentTurn' in value)).toBe(false);
	});

	it('lets the last extracted current location win and clears stale current flags', async () => {
		const { db, insertCalls, updateCalls, storyUpdates } = createDbMock({
			entityRows: [
				...entityRows,
				{ id: 'entity_old_gate', storyId: 'story_1', type: 'location', name: 'Old Gate', state: { current: true, marker: 'old-gate' } },
				{ id: 'entity_hall', storyId: 'story_1', type: 'location', name: 'Moonlit Hall', state: { current: false } },
				{ id: 'entity_tower', storyId: 'story_1', type: 'location', name: 'North Tower', state: { current: false } },
			],
		});
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			locations: [
				{ name: 'Moonlit Hall', current: true },
				{ name: 'North Tower', current: true },
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[ Time 22:40 | Day 9, Ember Moon, 299 AC | Location - Header Road | Weather Rain, 12 C ]\nThe party reaches the tower.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		const locationInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>)
			.filter(value => value.type === 'location');
		const hall = locationInserts.find(value => value.id === 'entity_hall');
		const tower = locationInserts.find(value => value.id === 'entity_tower');
		const clearedStates = updateCalls
			.filter(call => call.table === entities)
			.map(call => call.value.state as Record<string, unknown>)
			.filter(state => state?.current === false);

		expect(hall?.state).toMatchObject({ current: false });
		expect(tower?.state).toMatchObject({ current: true });
		expect(locationInserts.some(value => value.name === 'Header Road')).toBe(false);
		expect(clearedStates).toEqual(expect.arrayContaining([
			expect.objectContaining({ current: false }),
			expect.objectContaining({ current: false, marker: 'old-gate' }),
		]));
		expect(storyUpdates.find(value => value.currentTurn === 8)).toMatchObject({
			currentWorldTime: 'Day 9, Ember Moon, 299 AC | 22:40',
			currentLocationId: 'entity_tower',
		});
		expect(result.warnings).toContain('Multiple current locations extracted; kept the last one (North Tower).');
	});

	it('preserves story anchors when narration starts with OOC instead of the required header', async () => {
		const { db, storyUpdates } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: '[OOC: repairing context]\n[ Time 07:30 | Day 10, Ember Moon, 299 AC | Location - Wrong Place | Weather Clear, 17 C ]',
			update: worldStateUpdateSchema.parse({ time_delta: 'one day' }),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		// The second-line header is not a header; the classifier's stated day still passes.
		expect(storyUpdates.find(value => value.currentTurn === 8)).toMatchObject({
			currentWorldTime: 'Twilight of Ashes (+1d)',
			currentLocationId: 'entity_bridge',
		});
	});

	it('keeps unknown agreement parties out of canon and reports a warning', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			agreements: [
				{
					action: 'create',
					parties: ['Valen', 'The Watch', 'Unknown Envoy'],
					category: 'oath',
					terms: 'Hold the ash road until dawn.',
					secrecy: 'known',
					consequences: ['The bridge remains closed'],
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Valen binds The Watch and an unknown envoy to hold the road.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 20,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const agreementEvent = eventInserts.find(event => event.type === 'agreement');
		const agreementRecord = insertCalls.find(call => call.table === agreements)?.value as Record<string, unknown>;
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(entityInserts).toEqual([]);
		expect(agreementEvent).toMatchObject({
			actorEntityIds: ['entity_valen'],
			targetEntityIds: [],
			factionIds: ['faction_watch'],
			metadata: {
				agreement: expect.objectContaining({
					parties: ['Valen', 'The Watch', 'Unknown Envoy'],
				}),
			},
		});
		expect(agreementRecord).toMatchObject({
			parties: ['Valen', 'The Watch', 'Unknown Envoy'],
		});
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(result.warnings).toContain('Character reference "Unknown Envoy" was not created as canon; add it manually if this should become a character.');
	});

	it('persists delayed timeline events with npc links and no review proposals', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			timeline_events: [
				{
					title: 'Watch blockade matures',
					description: 'The Watch will close the ash road unless the oath is honored.',
					type: 'faction_move',
					status: 'scheduled',
					delay_turns: 2,
					visibility: 'secret',
					actor_names: ['Valen'],
					target_names: ['Mira'],
					faction_names: ['The Watch'],
					location_name: 'Ash Bridge',
					memory_impact: { rumor: 'road closure whispers' },
					reason: 'The oath created a delayed faction consequence.',
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The oath buys time, not peace.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 14,
		});

		const patchInsert = insertCalls.find(call => call.table === statePatches)?.value as { id: string };
		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const scheduled = eventInserts.find(event => event.title === 'Watch blockade matures');
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);
		const linkInsert = insertCalls
			.filter(call => call.table === npcEventLinks)
			.flatMap(call => call.value as Array<Record<string, unknown>>);

		expect(result.eventIds).toContain(scheduled?.id);
		expect(scheduled).toMatchObject({
			type: 'faction_move',
			status: 'scheduled',
			title: 'Watch blockade matures',
			body: 'The Watch will close the ash road unless the oath is honored.',
			actorEntityIds: ['entity_valen'],
			targetEntityIds: ['entity_mira'],
			locationId: 'entity_bridge',
			locationIds: ['entity_bridge'],
			factionIds: ['faction_watch'],
			visibility: 'secret',
			createdTurn: 7,
			occurredTurn: null,
			scheduledTurn: 9,
			worldTime: 'Twilight of Ashes',
			memoryImpact: { rumor: 'road closure whispers' },
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			serverVersion: 14,
		});
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(linkInsert).toEqual(expect.arrayContaining([
			expect.objectContaining({
				eventId: scheduled?.id,
				npcEntityId: 'entity_valen',
				role: 'actor',
				visibility: 'secret',
			}),
			expect.objectContaining({
				eventId: scheduled?.id,
				npcEntityId: 'entity_mira',
				role: 'target',
				visibility: 'secret',
			}),
		]));
	});

	it('keeps unknown timeline event character names out of canon and reports warnings', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			timeline_events: [
				{
					title: 'Oath witness hunted',
					description: 'A hooded envoy will search for the unknown oath witness before the road closes.',
					type: 'faction_move',
					status: 'scheduled',
					delay_turns: 1,
					visibility: 'secret',
					actor_names: ['Hooded Envoy'],
					target_names: ['Valen', 'Oath Witness'],
					faction_names: ['The Watch'],
					location_name: 'Ash Bridge',
					reason: 'The Watch needs leverage before enforcing the blockade.',
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'A hooded envoy moves quietly to find the oath witness before the blockade matures.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 18,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const scheduled = eventInserts.find(event => event.title === 'Oath witness hunted');
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(entityInserts).toEqual([]);
		expect(scheduled).toMatchObject({
			actorEntityIds: [],
			targetEntityIds: ['entity_valen'],
			factionIds: ['faction_watch'],
			metadata: expect.objectContaining({
				actorNames: ['Hooded Envoy'],
				targetNames: ['Valen', 'Oath Witness'],
			}),
		});
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(result.warnings).toEqual(expect.arrayContaining([
			'Character reference "Hooded Envoy" was not created as canon; add it manually if this should become a character.',
			'Character reference "Oath Witness" was not created as canon; add it manually if this should become a character.',
		]));
	});

	it('keeps unknown faction members out of canon and reports a warning', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			lorebook_entries: [
				{
					name: 'The Watch',
					type: 'faction',
					description: 'A disciplined faction guarding the ash roads.',
					known_members: ['Valen', 'Oath Witness'],
					faction_goals: [{ description: 'Hold the Ash Bridge', priority: 8 }],
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The Watch leans on Valen and an oath witness to keep the bridge closed.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 19,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const membershipInserts = insertCalls
			.filter(call => call.table === factionMemberships)
			.map(call => call.value as Record<string, unknown>);
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(entityInserts.every(entity => entity.type !== 'character')).toBe(true);
		expect(membershipInserts).toEqual(expect.arrayContaining([
			expect.objectContaining({
				factionId: 'faction_entity_watch',
				entityId: 'entity_valen',
				role: 'leader-or-member',
			}),
			expect.objectContaining({
				factionId: 'faction_entity_watch',
				entityId: null,
				role: 'member',
				metadata: expect.objectContaining({ memberNameOrId: 'Oath Witness' }),
			}),
		]));
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(result.warnings).toContain('Character reference "Oath Witness" was not created as canon; add it manually if this should become a character.');
	});

	it('keeps unknown model-extracted characters out of canon and reports a warning', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			characters: [
				{
					name: 'Ser Olyvar',
					description: 'A knight mentioned only in passing by the crowd.',
					traits: ['unverified'],
					present: false,
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Someone in the crowd mutters the name Ser Olyvar, but nobody steps forward.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 15,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(entityInserts).toEqual([]);
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(result.warnings).toContain('Character reference "Ser Olyvar" was not created as canon; add it manually if this should become a character.');
	});

	it('normalizes extracted relationship strength and updates an existing edge instead of duplicating it', async () => {
		const existingRelationship = {
			id: 'rel_mira_valen',
			storyId: 'story_1',
			sourceEntityId: 'entity_mira',
			targetEntityId: 'entity_valen',
			type: 'allied-with',
			label: 'uneasy allies',
			strength: 0.2,
			bidirectional: true,
			metadata: {},
			sourceEntryIds: ['entry_old'],
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 10,
			createdAt: 'earlier',
			updatedAt: 'earlier',
		} as any;
		const { db, insertCalls, updateCalls } = createDbMock({ relationshipRows: [existingRelationship] });
		dbMocks.getDb.mockReturnValue(db);

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Mira and Valen openly renew their alliance.',
			update: worldStateUpdateSchema.parse({
				relationships: [{
					sourceName: 'Mira',
					targetName: 'Valen',
					type: 'allied-with',
					label: 'renewed alliance',
					strength: 80,
					bidirectional: true,
				}],
			}),
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 18,
		});

		expect(insertCalls.filter((call) => call.table === relationships)).toEqual([]);
		expect(updateCalls.find((call) => call.table === relationships)?.value).toMatchObject({
			label: 'renewed alliance',
			strength: 0.8,
			bidirectional: true,
			sourceEntryIds: ['entry_old', 'entry_assistant'],
		});
	});

	it('keeps unknown relationship and conversation characters out of canon and reports warnings', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			relationships: [
				{
					sourceName: 'Ser Olyvar',
					targetName: 'Valen',
					type: 'serves',
					label: 'sworn blade',
					strength: 35,
				},
			],
			conversations: [
				{
					npcName: 'Lady Nym',
					topicSummary: 'She heard the player name the hidden patron.',
					playerRevealed: ['The hidden patron sent the raven.'],
					npcLearned: ['The patron may be nearby.'],
				},
			],
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Ser Olyvar is named as Valen\'s sworn blade, and Lady Nym is said to have overheard the patron rumor.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 16,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(entityInserts).toEqual([]);
		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
		expect(result.warnings).toEqual(expect.arrayContaining([
			'Character reference "Ser Olyvar" was not created as canon; add it manually if this should become a character.',
			'Character reference "Lady Nym" was not created as canon; add it manually if this should become a character.',
		]));
	});

	it('reports repeated unresolved character references without creating review debt', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			characters: [
				{
					name: 'Ser Olyvar',
					description: 'A knight mentioned only in passing by the crowd.',
					traits: ['unverified'],
					present: false,
				},
			],
			relationships: [
				{
					sourceName: 'Ser Olyvar',
					targetName: 'Valen',
					type: 'serves',
					label: 'sworn blade',
					strength: 35,
				},
			],
			conversations: [
				{
					npcName: 'Ser Olyvar',
					topicSummary: 'He may know why the bridge oath matters.',
					playerRevealed: ['The bridge oath still binds Valen.'],
					npcLearned: ['Valen may be under pressure.'],
				},
			],
		});

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Ser Olyvar is mentioned as a sworn blade and possible witness, but he is not established in canon.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 17,
		});

		const proposalInserts = insertCalls.filter(call => call.table === patchProposals);
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(proposalInserts).toEqual([]);
		expect(sourceRefInserts).toEqual([]);
	});

	it('skips title-only character names instead of creating review debt', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			characters: [{
				name: 'Consort',
				description: 'A court title attached to Aurion.',
				present: true,
			}],
		});

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The court calls Aurion the Consort, but it is only a title.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 17,
		});

		const entityInserts = insertCalls
			.filter(call => call.table === entities)
			.map(call => call.value as Record<string, unknown>);
		const proposals = insertCalls
			.filter(call => call.table === patchProposals)
			.flatMap(call => call.value as Array<Record<string, unknown>>)
			.filter((proposal) => proposal.proposalType === 'character_reference_review');

		expect(entityInserts.some((entity) => entity.name === 'Consort')).toBe(false);
		expect(proposals.some((proposal) => proposal.targetRecordId === 'unresolved_character_consort')).toBe(false);
	});

	it('does not update existing unresolved review proposals during normal turns', async () => {
		const existingProposal: typeof patchProposals.$inferSelect = {
			id: 'proposal_existing_olyvar',
			storyId: 'story_1',
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId: 'unresolved_character_ser_olyvar',
			proposedBy: 'narration',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					storyId: 'story_1',
					type: 'character',
					name: 'Ser Olyvar',
					description: 'First unresolved mention.',
					status: 'active',
					visibility: 'player_known',
					state: {},
				},
			}],
			reason: 'Turn referenced unresolved character Ser Olyvar.',
			suggestion: 'Review this character reference before creating a new canonical record.',
			status: 'needs_review',
			decision: null,
			validatedBy: null,
			affectedEntityIds: [],
			confidence: 0.52,
			sourceEntryIds: ['entry_old_assistant'],
			sourceEventIds: [],
			sourcePatchIds: ['patch_old'],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'Ser Olyvar',
				sourceFields: ['characters'],
			},
			serverVersion: 16,
			createdAt: '2026-06-13T18:00:00.000Z',
			updatedAt: '2026-06-13T18:00:00.000Z',
		};
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [existingProposal] });
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			conversations: [
				{
					npcName: 'Ser Olyvar',
					topicSummary: 'The player asks whether he witnessed the bridge oath.',
					playerRevealed: ['The oath may still matter.'],
					npcLearned: ['The player is looking for oath witnesses.'],
				},
			],
		});

		await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The name Ser Olyvar comes up again as a possible oath witness.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 17,
		});

		const proposalInserts = insertCalls
			.filter(call => call.table === patchProposals)
			.flatMap(call => call.value as Array<Record<string, unknown>>);
		const proposalUpdate = updateCalls.find(call => call.table === patchProposals)?.value;
		const sourceRefInserts = insertCalls.filter(call => call.table === sourceRefs);

		expect(proposalInserts.some(proposal =>
			proposal.proposalType === 'character_reference_review'
			&& proposal.targetRecordId === 'unresolved_character_ser_olyvar'
		)).toBe(false);
		expect(proposalUpdate).toBeUndefined();
		expect(sourceRefInserts).toEqual([]);
	});

	it('keeps persisted transaction results and reports projection enqueue warnings', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		dbMocks.enqueueTurnProjectionJobs.mockRejectedValue(new Error('outbox unavailable'));
		const update = worldStateUpdateSchema.parse({});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The turn persists before projection work is queued.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		expect(db.transaction).toHaveBeenCalledTimes(1);
		expect(insertCalls.some(call => call.source === 'tx' && call.table === statePatches)).toBe(false);
		expect(result.patchIds).toHaveLength(0);
		expect(result.warnings).toEqual(['Queued projection jobs failed: outbox unavailable']);
	});

	it('does not persist anything for an empty supplemental state extraction', async () => {
		const { db, insertCalls, updateCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'The deferred classifier found no extra state.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 13,
			mode: 'supplemental',
			timelineTurn: 7,
		});

		expect(result).toEqual({
			eventIds: [],
			patchIds: [],
			memoryNodeIds: [],
			warnings: [],
			effects: [],
		});
		expect(insertCalls).toEqual([]);
		expect(updateCalls).toEqual([]);
		expect(dbMocks.enqueueTurnProjectionJobs).not.toHaveBeenCalled();
	});

	it('applies supplemental extraction without duplicating base turn artifacts or advancing the turn', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			story_beats: [
				{
					title: 'Ash bridge secured',
					description: 'The crossing holds for another night.',
					significance: 'major',
				},
			],
			time_delta: 'one hour after the oath',
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Valen and Mira seal the bridge oath while the crowd watches.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: ['mem_old'],
			serverVersion: 13,
			mode: 'supplemental',
			timelineTurn: 7,
		});

		const patchInsert = insertCalls.find(call => call.table === statePatches)?.value as { id: string };
		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const memoryInserts = insertCalls.filter(call => call.table === memoryNodes);

		expect(result.eventIds).toEqual(eventInserts.map(event => event.id));
		expect(result.patchIds).toEqual([patchInsert.id]);
		expect(result.memoryNodeIds).toEqual([]);
		expect(eventInserts).toHaveLength(1);
		expect(eventInserts[0]).toMatchObject({
			type: 'reveal',
			title: 'Ash bridge secured',
			createdTurn: 7,
			occurredTurn: 7,
			worldTime: 'Twilight of Ashes (+1h)',
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			serverVersion: 13,
		});
		expect(eventInserts.find(event => event.title === 'Turn resolved')).toBeUndefined();
		expect(memoryInserts).toEqual([]);
		expect(storyUpdates.find(updatePayload => 'currentTurn' in updatePayload)).toBeUndefined();
		// The inline turn applied no time; the deferred classifier duration applies once under the turn's op key.
		expect(storyUpdates.filter(updatePayload => updatePayload.currentWorldTime)).toEqual([expect.objectContaining({ currentWorldTime: 'Twilight of Ashes (+1h)' })]);
		expect(insertCalls.find(call => call.table === worldTimeChanges)?.value).toMatchObject({ opKey: 'turn:entry_assistant', sourceTurn: 7, proposer: 'classifier' });
		expect(dbMocks.enqueueTurnProjectionJobs).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			eventIds: result.eventIds,
			patchIds: [patchInsert.id],
			memoryNodeIds: [],
			serverVersion: 13,
		}));
	});
});
