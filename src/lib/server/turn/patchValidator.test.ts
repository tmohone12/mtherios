import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entities, npcEventLinks, statePatches, stories, storyEvents } from '$lib/server/db/schema';
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
	metadata: { campaignTone: 'wary' },
};
type TestStoryRow = Omit<typeof storyRow, 'currentWorldTime'> & { currentWorldTime: string | null };

const entityRows = [
	{ id: 'entity_valen', storyId: 'story_1', type: 'character', name: 'Valen' },
	{ id: 'entity_mira', storyId: 'story_1', type: 'character', name: 'Mira' },
	{ id: 'entity_watch', storyId: 'story_1', type: 'faction', name: 'The Watch' },
];

function createDbMock(options: { story?: TestStoryRow | null } = {}) {
	type DbSource = 'root' | 'tx';
	const insertCalls: Array<{ source: DbSource; table: unknown; value: unknown }> = [];
	const updateCalls: Array<{ source: DbSource; table: unknown; value: Record<string, unknown> }> = [];
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
				if (selectedTable === entities) return Promise.resolve(entityRows);
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

		return { insert, select, update };
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

		expect(result.eventIds).toEqual(eventInserts.map(event => event.id));
		expect(eventInserts).toHaveLength(3);
		for (const event of eventInserts) {
			expect(event).toMatchObject({
				status: 'committed',
				createdTurn: 7,
				occurredTurn: 7,
				scheduledTurn: null,
				worldTime: 'Twilight of Ashes; one hour after the oath',
				locationIds: [],
				factionIds: [],
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
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			metadata: { agreement: update.agreements[0] },
		});
		expect(eventInserts.find(event => event.title === 'Ash bridge secured')).toMatchObject({
			sourceEntryIds: ['entry_assistant'],
			sourcePatchIds: [patchInsert.id],
			metadata: { significance: 'major' },
		});
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
		});
		expect(turnUpdate).toMatchObject({
			currentTurn: 8,
			currentWorldTime: 'Twilight of Ashes; one hour after the oath',
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

	it('uses time_delta as the event and story clock when the story has no current world time', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock({
			story: { ...storyRow, currentWorldTime: null },
		});
		dbMocks.getDb.mockReturnValue(db);
		const update = worldStateUpdateSchema.parse({
			time_delta: 'Dawn after the fire',
		});

		const result = await applyValidatedTurnUpdate({
			storyId: 'story_1',
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			narration: 'Ash light finds the courtyard.',
			update,
			parseWarnings: [],
			retrievedMemoryIds: [],
			serverVersion: 12,
		});

		const eventInserts = insertCalls
			.filter(call => call.table === storyEvents)
			.map(call => call.value as Record<string, unknown>);
		const turnUpdate = storyUpdates.find(updatePayload => updatePayload.currentTurn === 8);

		expect(result.eventIds).toEqual(eventInserts.map(event => event.id));
		expect(eventInserts).toHaveLength(1);
		expect(eventInserts[0]).toMatchObject({
			title: 'Turn resolved',
			worldTime: 'Dawn after the fire',
			createdTurn: 7,
			occurredTurn: 7,
		});
		expect(turnUpdate).toMatchObject({
			currentTurn: 8,
			currentWorldTime: 'Dawn after the fire',
		});
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
});
