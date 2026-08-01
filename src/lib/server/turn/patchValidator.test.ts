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
	sourceRefs,
	statePatches,
	stories,
	storyEvents,
} from '$lib/server/db/schema';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { applyValidatedTurnUpdate } from './patchValidator';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueTurnProjectionJobs: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueTurnProjectionJobs: dbMocks.enqueueTurnProjectionJobs,
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
} = {}) {
	type DbSource = 'root' | 'tx';
	const insertCalls: Array<{ source: DbSource; table: unknown; value: unknown }> = [];
	const updateCalls: Array<{ source: DbSource; table: unknown; value: Record<string, unknown> }> = [];
	const deleteCalls: Array<{ source: DbSource; table: unknown }> = [];
	const selectLocks: Array<{ source: DbSource; table: unknown; strength: string }> = [];
	const storyUpdates: Array<Record<string, unknown>> = [];
	const selectedStory = options.story === undefined ? storyRow : options.story;

	function createConnection(source: DbSource) {
		let selectedTable: unknown;

		const selectChain = {
			from: vi.fn((table: unknown) => {
				selectedTable = table;
				return selectChain;
			}),
			where: vi.fn(() => selectChain),
			for: vi.fn((strength: string) => {
				selectLocks.push({ source, table: selectedTable, strength });
				return selectChain;
			}),
			limit: vi.fn(() => {
				if (selectedTable === stories) return Promise.resolve(selectedStory ? [selectedStory] : []);
				if (selectedTable === entities) return Promise.resolve(options.entityRows ?? entityRows);
				if (selectedTable === factions) return Promise.resolve(factionRows);
				if (selectedTable === patchProposals) return Promise.resolve(options.patchProposalRows ?? []);
				return Promise.resolve([]);
			}),
		};
		const select = vi.fn(() => selectChain);

		const insert = vi.fn((table: unknown) => ({
			values: vi.fn((value: unknown) => {
				insertCalls.push({ source, table, value });
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
});

describe('applyValidatedTurnUpdate', () => {
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
		]);

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
				worldTime: 'Twilight of Ashes',
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
			currentWorldTime: 'Twilight of Ashes',
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
				aliases: ['The Harbor Broker'],
				present: true,
				relationship: 'wary ally',
				appearance: 'salt-stained blue cloak and ink-dark fingertips',
				background: 'raised around harbor ledgers and old smuggling routes',
				currentLocation: 'Ash Bridge counting room',
				currentAction: 'holding the bridge bargain together while watching Valen',
				emotionalState: 'controlled fear under professional calm',
				goals: ['keep the bridge bargain alive'],
				speechStyle: 'quiet, exact, with clipped harbor idioms',
				eventMemory: {
					did: ['Mira swore not to sell Valen out.'],
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
			aliases: ['The Harbor Broker'],
			isPresent: true,
			present: true,
			bio: 'raised around harbor ledgers and old smuggling routes',
			appearance: 'salt-stained blue cloak and ink-dark fingertips',
			background: 'raised around harbor ledgers and old smuggling routes',
			currentLocation: 'Ash Bridge counting room',
			currentAction: 'holding the bridge bargain together while watching Valen',
			emotionalState: 'controlled fear under professional calm',
			currentDisposition: 'wary ally',
			relationship: {
				level: 42,
				status: 'wary ally',
				history: [{ description: 'Mira kept the old bargain.', entryId: 'entry_old', timestamp: 1 }],
			},
			motivations: ['keep the bridge bargain alive'],
			goals: ['keep the bridge bargain alive'],
			speechStyle: 'quiet, exact, with clipped harbor idioms',
		});
		expect(memory.did).toEqual(['Mira hid the old map.', 'Mira swore not to sell Valen out.']);
		expect(memory.saw).toEqual(['Mira saw Valen hesitate at the bridge.']);
		expect(memory.knew).toEqual(['Mira knows the bridge bargain has a hidden witness.']);
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

	it('uses time_delta only to initialize an empty clock and preserves location state without a new anchor', async () => {
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
			currentWorldTime: 'Dawn after the fire',
			currentLocationId: 'entity_bridge',
		});
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

		expect(storyUpdates.find(value => value.currentTurn === 8)).toMatchObject({
			currentWorldTime: 'Twilight of Ashes',
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
		expect(insertCalls.some(call => call.source === 'tx' && call.table === statePatches)).toBe(true);
		expect(result.patchIds).toHaveLength(1);
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
			worldTime: 'Twilight of Ashes',
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			serverVersion: 13,
		});
		expect(eventInserts.find(event => event.title === 'Turn resolved')).toBeUndefined();
		expect(memoryInserts).toEqual([]);
		expect(storyUpdates.find(updatePayload => 'currentTurn' in updatePayload)).toBeUndefined();
		expect(storyUpdates.find(updatePayload => updatePayload.currentWorldTime)).toBeUndefined();
		expect(dbMocks.enqueueTurnProjectionJobs).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			eventIds: result.eventIds,
			patchIds: [patchInsert.id],
			memoryNodeIds: [],
			serverVersion: 13,
		}));
	});
});
