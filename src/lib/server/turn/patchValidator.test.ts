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

const entityRows = [
	{ id: 'entity_valen', storyId: 'story_1', type: 'character', name: 'Valen' },
	{ id: 'entity_mira', storyId: 'story_1', type: 'character', name: 'Mira' },
	{ id: 'entity_watch', storyId: 'story_1', type: 'faction', name: 'The Watch' },
];

function createDbMock(options: { story?: typeof storyRow | null } = {}) {
	const insertCalls: Array<{ table: unknown; value: unknown }> = [];
	const storyUpdates: Array<Record<string, unknown>> = [];
	const selectedStory = options.story === undefined ? storyRow : options.story;
	let selectedTable: unknown;

	const selectChain = {
		from: vi.fn((table: unknown) => {
			selectedTable = table;
			return selectChain;
		}),
		where: vi.fn(() => selectChain),
		limit: vi.fn(() => {
			if (selectedTable === stories) return Promise.resolve(selectedStory ? [selectedStory] : []);
			if (selectedTable === entities) return Promise.resolve(entityRows);
			return Promise.resolve([]);
		}),
	};
	const select = vi.fn(() => selectChain);

	const insert = vi.fn((table: unknown) => ({
		values: vi.fn((value: unknown) => {
			insertCalls.push({ table, value });
			return {
				onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
			};
		}),
	}));

	const update = vi.fn((table: unknown) => ({
		set: vi.fn((value: Record<string, unknown>) => ({
			where: vi.fn(() => {
				if (table === stories) storyUpdates.push(value);
				return Promise.resolve(undefined);
			}),
		})),
	}));

	return {
		db: { insert, select, update },
		insertCalls,
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
		const { db, insertCalls } = createDbMock({ story: null });
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

		expect(insertCalls).toEqual([]);
		expect(dbMocks.enqueueTurnProjectionJobs).not.toHaveBeenCalled();
	});

	it('emits committed timeline defaults, resolved agreement npc links, and advances story turn', async () => {
		const { db, insertCalls, storyUpdates } = createDbMock();
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
				worldTime: 'Twilight of Ashes',
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
});
