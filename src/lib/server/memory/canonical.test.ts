import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	arcs,
	chapters,
	entities,
	entityAliases,
	contextCheckpoints,
	memoryNodes,
	patchProposals,
	relationships,
	shelves,
	sourceRefs,
	stories,
} from '$lib/server/db/schema';
import type { SyncOperation } from '$lib/contracts/memory';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: vi.fn().mockResolvedValue('job_scene'),
	enqueueImportProjectionJobs: vi.fn(),
	enqueueStoryVaultSyncJob: dbMocks.enqueueStoryVaultSyncJob,
	enqueueTurnProjectionJobs: vi.fn(),
}));

vi.mock('$lib/server/wiki/storyVault', () => ({
	deleteStoryVaultArtifacts: vi.fn(),
}));

vi.mock('$lib/server/engine/projections', () => ({
	getCampaignProjection: vi.fn(),
}));

vi.mock('$lib/server/engine/canonicalSearch', () => ({
	searchCanonicalWorld: vi.fn().mockResolvedValue({ results: [] }),
}));

import { assertSyncOpReplayMatches, listBackendShelves, listBackendStories, normalizeBootstrapOptions, restoreBackendStory, revertToContextCheckpoint, updateBackendShelf, upsertBackendArcFromLocal, upsertBackendChapterFromLocal, upsertBackendEntityFromEntry } from './canonical';
import { readableMemorySummary, summarizeMtheriosMemoryForRollup } from '$lib/services/ai/context/mtheriosSummaryFormat';

type PatchProposalRow = typeof patchProposals.$inferSelect;

const baseOp: SyncOperation = {
	id: 'op_replay_1',
	storyId: 'story_1',
	type: 'turn_command',
	clientVersion: 4,
	clientCreatedAt: '2026-05-31T00:00:00.000Z',
	payload: {
		clientTurnId: 'turn_1',
		playerText: 'Open the postern gate.',
		entryId: 'entry_1',
		position: 7,
		clientContext: {
			scene: 'inner keep',
			flags: ['night', 'alarm'],
		},
	},
};

function makeCharacterReferenceProposal(id: string, name: string, sourceEntryId: string, sourcePatchId: string): PatchProposalRow {
	return {
		id,
		storyId: 'story_1',
		proposalType: 'character_reference_review',
		targetTable: 'entities',
		targetRecordId: `unresolved_character_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
		proposedBy: 'llm',
		operations: [{
			op: 'review',
			path: '/entities/character',
			value: {
				name,
				description: `${name} was referenced by narration but not yet promoted to canon.`,
			},
		}],
		reason: `Turn referenced unresolved character ${name}.`,
		suggestion: 'Review before creating a canonical character record.',
		status: 'needs_review',
		decision: null,
		validatedBy: null,
		affectedEntityIds: [],
		confidence: 0.62,
		sourceEntryIds: [sourceEntryId],
		sourceEventIds: [],
		sourcePatchIds: [sourcePatchId],
		metadata: {
			sourceType: 'unresolved_character_reference',
			sourceName: name,
		},
		serverVersion: 1,
		createdAt: '2026-06-13T00:00:00.000Z',
		updatedAt: '2026-06-13T00:00:00.000Z',
	};
}

function createDbMock(options: {
	patchProposalRows?: PatchProposalRow[];
	entityRows?: Array<Record<string, unknown>>;
	chapterRows?: Array<Record<string, unknown>>;
	arcRows?: Array<Record<string, unknown>>;
	shelfRows?: Array<Record<string, unknown>>;
	storyRows?: Array<Record<string, unknown>>;
	storyUpdateReturning?: Array<Record<string, unknown>>;
} = {}) {
	const insertCalls: Array<{ table: unknown; value: Record<string, unknown> }> = [];
	const updateCalls: Array<{ table: unknown; value: Record<string, unknown> }> = [];

	function rowsFor(table: unknown): unknown[] {
		if (table === stories) return options.storyRows ?? [{ id: 'story_1', serverVersion: 1 }];
		if (table === entities) return options.entityRows ?? [];
		if (table === chapters) return options.chapterRows ?? [];
		if (table === arcs) return options.arcRows ?? [];
		if (table === entityAliases) return [];
		if (table === relationships) return [];
		if (table === patchProposals) return options.patchProposalRows ?? [];
		if (table === shelves) return options.shelfRows ?? [];
		return [];
	}

	const db = {
		select: vi.fn(() => {
			let selectedTable: unknown;
			const chain = {
				from: vi.fn((table: unknown) => {
					selectedTable = table;
					return chain;
				}),
				where: vi.fn(() => chain),
				orderBy: vi.fn(() => chain),
				limit: vi.fn(() => Promise.resolve(rowsFor(selectedTable))),
				then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rowsFor(selectedTable)).then(resolve, reject),
			};
			return chain;
		}),
		insert: vi.fn((table: unknown) => ({
			values: vi.fn((value: Record<string, unknown>) => {
				insertCalls.push({ table, value });
				return {
					onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
					onConflictDoUpdate: vi.fn(() => ({
						returning: vi.fn().mockResolvedValue([value]),
					})),
					returning: vi.fn().mockResolvedValue([value]),
				};
			}),
		})),
		update: vi.fn((table: unknown) => ({
			set: vi.fn((value: Record<string, unknown>) => ({
				where: vi.fn(() => {
					updateCalls.push({ table, value });
					return {
						returning: vi.fn().mockResolvedValue(table === stories
							? options.storyUpdateReturning ?? [{ serverVersion: 2 }]
							: [value]),
					};
				}),
			})),
		})),
		delete: vi.fn(() => ({
			where: vi.fn().mockResolvedValue(undefined),
		})),
	};

	return { db, insertCalls, updateCalls };
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.enqueueStoryVaultSyncJob.mockResolvedValue('job_vault_sync');
});

describe('sync operation replay guard', () => {
	it('allows exact replays even when JSON object keys arrive in a different order', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 4,
			payload: {
				position: 7,
				entryId: 'entry_1',
				playerText: 'Open the postern gate.',
				clientContext: {
					flags: ['night', 'alarm'],
					scene: 'inner keep',
				},
				clientTurnId: 'turn_1',
			},
		})).not.toThrow();
	});

	it('rejects reused sync op IDs that point at different command content', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 4,
			payload: {
				...baseOp.payload,
				playerText: 'Open the river gate instead.',
			},
		})).toThrow('Sync operation id collision');
	});

	it('rejects reused sync op IDs that drift across story, type, or client version', () => {
		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_2',
			type: 'turn_command',
			clientVersion: 4,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');

		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'state_correction',
			clientVersion: 4,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');

		expect(() => assertSyncOpReplayMatches(baseOp, {
			storyId: 'story_1',
			type: 'turn_command',
			clientVersion: 5,
			payload: baseOp.payload,
		})).toThrow('Sync operation id collision');
	});
});

describe('backend bootstrap projection limits', () => {
	it('defaults to bounded control-surface slices instead of broad history/world loads', () => {
		expect(normalizeBootstrapOptions()).toEqual({
			entryLimit: 80,
			entityLimit: 200,
			relationshipLimit: 200,
			factionLimit: 80,
			factionMembershipLimit: 160,
			factionResourceLimit: 160,
			factionGoalLimit: 160,
			factionProjectLimit: 160,
			agreementLimit: 80,
			npcBeliefLimit: 80,
			threadLimit: 80,
			chapterLimit: 80,
			arcLimit: 80,
			sagaLimit: 40,
			eventLimit: 80,
			patchLimit: 80,
			memoryNodeLimit: 80,
		});
	});

	it('clamps bootstrap limits so a control surface cannot request a giant campaign blob', () => {
		expect(normalizeBootstrapOptions({
			entryLimit: 10000,
			entityLimit: 9999,
			memoryNodeLimit: 9999,
			npcBeliefLimit: -5,
			sagaLimit: 0,
		})).toEqual(expect.objectContaining({
			entryLimit: 200,
			entityLimit: 200,
			memoryNodeLimit: 200,
			npcBeliefLimit: 0,
			sagaLimit: 0,
		}));
	});
});

describe('backend shelf updates', () => {
	it('preserves existing shelf metadata when only tags are patched', async () => {
		const { db, updateCalls } = createDbMock({
			shelfRows: [{
				id: 'shelf_1',
				name: 'Glassmarket',
				slug: 'glassmarket',
				description: null,
				genre: null,
				coverImageUrl: null,
				settings: {},
				metadata: { source: 'seed', tags: ['old'] },
				serverVersion: 1,
				createdAt: '2026-07-06T00:00:00.000Z',
				updatedAt: '2026-07-06T00:00:00.000Z',
			}],
		});
		dbMocks.getDb.mockReturnValue(db);

		await updateBackendShelf('shelf_1', { tags: ['new'] });

		expect(updateCalls.find((call) => call.table === shelves)?.value).toMatchObject({
			metadata: { source: 'seed', tags: ['new'] },
		});
	});
});

describe('backend canonical entity writes', () => {
	it('validates capability notes before making any database writes', async () => {
		const { db, insertCalls, updateCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		await expect(upsertBackendEntityFromEntry('story_1', { id: 'player', type: 'character', name: 'Mira', state: { playerCapabilities: { abilities: ['x'.repeat(301)], buffs: [] } } })).rejects.toThrow();
		expect(insertCalls).toEqual([]);
		expect(updateCalls).toEqual([]);
	});

	it.each([{ abilities: ['Keen senses'], buffs: ['Cold ward until dawn'] }, { abilities: [], buffs: [] }])('persists capability lists including explicit clears %#', async playerCapabilities => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		await upsertBackendEntityFromEntry('story_1', { id: 'player', type: 'character', name: 'Mira', state: { playerCapabilities } });
		expect(insertCalls.find(call => call.table === entities)?.value).toMatchObject({ state: { playerCapabilities } });
	});

	it('rejects title-only character names from local canon writes', async () => {
		const { db } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		await expect(upsertBackendEntityFromEntry('story_1', {
			type: 'character',
			name: 'Consort',
			description: 'A title, not a character.',
			state: { type: 'character' },
		})).rejects.toThrow('Add it as an alias/title on an existing character instead');
	});

	it('applies matching unresolved character reference proposals when a human creates the character', async () => {
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [
				makeCharacterReferenceProposal('proposal_ser_olyvar', 'Ser Olyvar', 'entry_ser', 'patch_ser'),
				makeCharacterReferenceProposal('proposal_quiet_olyvar', 'The Quiet Olyvar', 'entry_alias', 'patch_alias'),
				makeCharacterReferenceProposal('proposal_lady_nym', 'Lady Nym', 'entry_nym', 'patch_nym'),
			],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await upsertBackendEntityFromEntry('story_1', {
			id: 'entity_ser_olyvar',
			type: 'character',
			name: 'Ser Olyvar',
			description: 'A knight the player deliberately promoted after review.',
			aliases: ['The Quiet Olyvar'],
			sourceEntryIds: ['entry_manual_note'],
			sourcePatchIds: ['patch_manual'],
			state: { type: 'character' },
			createdBy: 'user',
		});

		const entityInsert = insertCalls.find((call) => call.table === entities)?.value;
		const sourceRefInserts = insertCalls.filter((call) => call.table === sourceRefs).map((call) => call.value);
		const proposalUpdates = updateCalls.filter((call) => call.table === patchProposals).map((call) => call.value);

		expect(entityInsert).toMatchObject({
			id: 'entity_ser_olyvar',
			type: 'character',
			name: 'Ser Olyvar',
			sourceEntryIds: ['entry_manual_note', 'entry_ser', 'entry_alias'],
			sourcePatchIds: ['patch_manual', 'patch_ser', 'proposal_ser_olyvar', 'patch_alias', 'proposal_quiet_olyvar'],
		});
		expect(proposalUpdates).toHaveLength(2);
		expect(proposalUpdates).toEqual([
			expect.objectContaining({
				status: 'applied',
				decision: 'approved',
				validatedBy: 'entity_upsert',
				affectedEntityIds: ['entity_ser_olyvar'],
				metadata: expect.objectContaining({
					resolvedByEntityUpsert: true,
					resolvedEntityId: 'entity_ser_olyvar',
					resolvedEntityName: 'Ser Olyvar',
				}),
			}),
			expect.objectContaining({
				status: 'applied',
				decision: 'approved',
				validatedBy: 'entity_upsert',
				affectedEntityIds: ['entity_ser_olyvar'],
			}),
		]);
		expect(sourceRefInserts).toEqual([
			expect.objectContaining({
				storyId: 'story_1',
				sourceType: 'patch_proposal',
				sourceId: 'proposal_ser_olyvar',
				targetTable: 'entities',
				targetRecordId: 'entity_ser_olyvar',
				sourceField: 'character_reference_review',
			}),
			expect.objectContaining({
				storyId: 'story_1',
				sourceType: 'patch_proposal',
				sourceId: 'proposal_quiet_olyvar',
				targetTable: 'entities',
				targetRecordId: 'entity_ser_olyvar',
				sourceField: 'character_reference_review',
			}),
		]);
		expect(result).toMatchObject({
			resolvedCharacterReferences: [
				{ proposalId: 'proposal_ser_olyvar', name: 'Ser Olyvar', entityId: 'entity_ser_olyvar' },
				{ proposalId: 'proposal_quiet_olyvar', name: 'The Quiet Olyvar', entityId: 'entity_ser_olyvar' },
			],
		});
	});
});

describe('backend chapter character references', () => {
	it('creates review-only character proposals from manual chapter character lists', async () => {
		const { db, insertCalls } = createDbMock({
			entityRows: [{
				id: 'entity_aurion',
				storyId: 'story_1',
				type: 'character',
				name: 'Aurion',
				status: 'active',
				sourceEntryIds: [],
				sourceEventIds: [],
				sourcePatchIds: [],
				metadata: {},
			}],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await upsertBackendChapterFromLocal('story_1', {
			id: 'chapter_yin_dinner',
			number: 12,
			title: 'Dinner in Yin',
			summary: 'Aurion dines with Xanda beneath lapis-blue seals while the Golden Dragon title follows him through the room.',
			characters: ['Aurion', 'Xanda', 'Golden Dragon'],
			sourceEntryIds: ['entry_1', 'entry_2'],
			sourceEventIds: ['event_xanda_1', 'event_xanda_2'],
		});

		const proposalInserts = insertCalls
			.filter((call) => call.table === patchProposals)
			.map((call) => call.value);
		const sourceRefInserts = insertCalls
			.filter((call) => call.table === sourceRefs)
			.map((call) => call.value);

		expect(result.chapter).toMatchObject({
			id: 'chapter_yin_dinner',
			sceneOutcome: expect.stringContaining('Aurion dines with Xanda'),
		});
		expect(insertCalls.some((call) => call.table === chapters)).toBe(true);
		expect(insertCalls.some((call) => call.table === memoryNodes)).toBe(true);
		expect(proposalInserts).toEqual([
			expect.objectContaining({
				proposalType: 'character_reference_review',
				targetRecordId: 'unresolved_character_xanda',
				proposedBy: 'chapter_command',
				reason: 'Xanda is listed as a key character in chapter 12.',
				sourceEntryIds: ['entry_1', 'entry_2'],
				sourceEventIds: ['event_xanda_1', 'event_xanda_2'],
				metadata: expect.objectContaining({
					sourceType: 'chapter_character_reference',
					sourceName: 'Xanda',
					chapterId: 'chapter_yin_dinner',
				}),
			}),
		]);
		expect(sourceRefInserts).toEqual(expect.arrayContaining([
			expect.objectContaining({
				sourceType: 'chapter',
				sourceId: 'chapter_yin_dinner',
				targetTable: 'patch_proposals',
				targetRecordId: 'proposal_chapter_character_story_1_xanda',
				sourceField: 'characters',
			}),
		]));
	});

	it('accepts a hand-written arc only over saved chapters that no other arc covers', async () => {
		const write = async (options: Parameters<typeof createDbMock>[0], chapterIds: string[], id = 'arc_new') => {
			const { db, insertCalls } = createDbMock(options);
			dbMocks.getDb.mockReturnValue(db);
			await upsertBackendArcFromLocal('story_1', { id, title: 'Season', summary: 'The court shifts.', chapterIds });
			return insertCalls.filter((call) => call.table === arcs).map((call) => call.value);
		};
		const saved = [{ id: 'ch_1' }, { id: 'ch_2' }, { id: 'ch_3' }];
		await expect(write({ chapterRows: saved }, ['ch_1', 'ch_2'])).resolves.toEqual([expect.objectContaining({ chapterIds: ['ch_1', 'ch_2'] })]);
		await expect(write({ chapterRows: saved }, ['ch_1', 'ch_1'])).rejects.toThrow('listed once');
		await expect(write({ chapterRows: [{ id: 'ch_1' }] }, ['ch_1', 'ch_missing'])).rejects.toThrow('not saved in this story: ch_missing');
		await expect(write({ chapterRows: saved, arcRows: [{ id: 'arc_1', number: 1, chapterIds: ['ch_2', 'ch_3'] }] }, ['ch_1', 'ch_2']))
			.rejects.toThrow('already belong to arc 1');
		// Editing an existing arc without changing its chapters stays possible after a chapter was deleted.
		await expect(write({ chapterRows: [], arcRows: [{ id: 'arc_1', number: 1, chapterIds: ['ch_gone'] }] }, ['ch_gone'], 'arc_1')).resolves.toHaveLength(1);
	});

	it('keeps the stored chapter account when an edit sends back its unchanged display summary', async () => {
		const stored = '[CHECKPOINT = Chapter 12 checkpoint.]\n[SOURCE COVERAGE =\n- positions 1-40\n]\n[RECENT STORY STATE =\n- Aurion dines with Xanda beneath lapis-blue seals.\n]\n[CHARACTER STATE =\nXanda [entity_xanda]:\n- watches the Golden Dragon title.\n]';
		const existing = { id: 'chapter_yin_dinner', storyId: 'story_1', number: 12, title: 'Dinner', sceneOutcome: stored, metadata: {}, sourceEntryIds: [], sourceEventIds: [] };
		for (const [summary, expected] of [
			[summarizeMtheriosMemoryForRollup(stored), stored],
			[readableMemorySummary(stored), stored],
			['Aurion leaves the dinner early.', 'Aurion leaves the dinner early.'],
		]) {
			const { db, insertCalls } = createDbMock({ chapterRows: [existing] });
			dbMocks.getDb.mockReturnValue(db);
			await upsertBackendChapterFromLocal('story_1', { id: 'chapter_yin_dinner', number: 12, title: 'Dinner in Yin', summary, characters: [] });
			const chapterWrite = insertCalls.find((call) => call.table === chapters)!.value as { sceneOutcome: string; title: string };
			expect(chapterWrite).toMatchObject({ sceneOutcome: expected, title: 'Dinner in Yin' });
		}
	});

	it('adds later chapter evidence to existing character review proposals', async () => {
		const existingProposal = makeCharacterReferenceProposal('proposal_xanda_review', 'Xanda', 'entry_old', 'patch_old');
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [existingProposal],
			entityRows: [{
				id: 'entity_aurion',
				storyId: 'story_1',
				type: 'character',
				name: 'Aurion',
				status: 'active',
				sourceEntryIds: [],
				sourceEventIds: [],
				sourcePatchIds: [],
				metadata: {},
			}],
		});
		dbMocks.getDb.mockReturnValue(db);

		await upsertBackendChapterFromLocal('story_1', {
			id: 'chapter_xanda_second',
			number: 13,
			title: 'The Lapis Invitation',
			summary: 'Xanda tests Aurion over honeyed locusts and court danger.',
			characters: ['Aurion', 'Xanda'],
			sourceEntryIds: ['entry_new'],
			sourceEventIds: ['event_new'],
		});

		const proposalInserts = insertCalls
			.filter((call) => call.table === patchProposals)
			.map((call) => call.value);
		const proposalUpdates = updateCalls
			.filter((call) => call.table === patchProposals)
			.map((call) => call.value);
		const sourceRefInserts = insertCalls
			.filter((call) => call.table === sourceRefs)
			.map((call) => call.value);

		expect(proposalInserts).toEqual([]);
		expect(proposalUpdates).toEqual([
			expect.objectContaining({
				sourceEntryIds: ['entry_old', 'entry_new'],
				sourceEventIds: ['event_new'],
				metadata: expect.objectContaining({
					sourceName: 'Xanda',
					chapterReferences: [{ chapterId: 'chapter_xanda_second', chapterNumber: 13 }],
				}),
				confidence: 0.72,
			}),
		]);
		expect(sourceRefInserts).toEqual(expect.arrayContaining([
			expect.objectContaining({
				sourceType: 'chapter',
				sourceId: 'chapter_xanda_second',
				targetTable: 'patch_proposals',
				targetRecordId: 'proposal_xanda_review',
				sourceField: 'characters',
			}),
		]));
	});
});

describe('context checkpoint restore', () => {
	it('restores large source ref snapshots in bounded insert batches', async () => {
		const sourceRefRows = Array.from({ length: 2501 }, (_, index) => ({
			id: `source_ref_${index}`,
			storyId: 'story_1',
			sourceType: 'entry',
			sourceId: `entry_${index}`,
			targetTable: 'entities',
			targetRecordId: `entity_${index}`,
			targetRecordField: null,
			sourceField: null,
			confidence: 1,
			rationale: null,
			notes: null,
			serverVersion: 1,
			createdAt: '2026-06-14T00:00:00.000Z',
			updatedAt: '2026-06-14T00:00:00.000Z',
		}));
		const sourceRefInsertBatches: unknown[][] = [];
		const checkpoint = {
			id: 'checkpoint_large_refs',
			storyId: 'story_1',
			label: 'Before restore',
			reason: null,
			entryPosition: 99,
			currentTurn: 12,
			snapshot: {
				version: 1,
				story: {
					id: 'story_1',
					currentLocationId: null,
					currentTurn: 12,
					currentWorldTime: null,
					metadata: {},
				},
				tables: {
					sourceRefs: sourceRefRows,
				},
			},
			metadata: {},
			serverVersion: 5,
			createdAt: '2026-06-14T00:00:00.000Z',
			updatedAt: '2026-06-14T00:00:00.000Z',
		};

		const tx = {
			select: vi.fn(() => {
				let selectedTable: unknown;
				const chain = {
					from: vi.fn((table: unknown) => {
						selectedTable = table;
						return chain;
					}),
					where: vi.fn(() => chain),
					limit: vi.fn(() => Promise.resolve(selectedTable === contextCheckpoints ? [checkpoint] : [])),
				};
				return chain;
			}),
			update: vi.fn((table: unknown) => ({
				set: vi.fn(() => ({
					where: vi.fn(() => ({
						returning: vi.fn().mockResolvedValue(table === stories ? [{ serverVersion: 42 }] : []),
					})),
				})),
			})),
			delete: vi.fn(() => ({
				where: vi.fn().mockResolvedValue(undefined),
			})),
			insert: vi.fn((table: unknown) => ({
				values: vi.fn((value: unknown) => {
					const rows = Array.isArray(value) ? value : [value];
					if (table === sourceRefs) {
						if (rows.length > 1000) throw new Error('too many bind parameters');
						sourceRefInsertBatches.push(rows);
					}
					return {};
				}),
			})),
		};
		dbMocks.getDb.mockReturnValue({
			transaction: vi.fn(async (callback) => callback(tx)),
		});

		const result = await revertToContextCheckpoint('story_1', {
			checkpointId: 'checkpoint_large_refs',
			reason: 'test restore',
		});

		expect(result.restoredCounts.sourceRefs).toBe(2501);
		expect(sourceRefInsertBatches.map((rows) => rows.length)).toEqual([1000, 1000, 501]);
		expect(dbMocks.enqueueStoryVaultSyncJob).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			serverVersion: 42,
			reason: 'context-checkpoint-revert',
		}));
	});
});

describe('backend story archive lifecycle', () => {
	it('excludes archived stories from shelf counts and canon totals', async () => {
		const shelf = {
			id: 'shelf_default',
			name: 'Default Shelf',
			slug: 'default_shelf',
			description: null,
			genre: null,
			coverImageUrl: null,
			settings: {},
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
		};
		const results = [
			[shelf],
			[shelf],
			[
				{ id: 'story_live', metadata: {} },
				{ id: 'story_archived', metadata: { archived: true } },
			],
			[{ count: 7 }],
			[{ count: 2 }],
		];
		let selectIndex = 0;
		const db = {
			select: vi.fn(() => {
				const rows = results[selectIndex++] ?? [];
				const chain: Record<string, unknown> = {};
				chain.from = vi.fn(() => chain);
				chain.where = vi.fn(() => chain);
				chain.orderBy = vi.fn(() => chain);
				chain.limit = vi.fn(() => Promise.resolve(rows));
				chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
				return chain;
			}),
		};
		dbMocks.getDb.mockReturnValue(db);

		const [summary] = await listBackendShelves();

		expect(summary).toMatchObject({ storyCount: 1, canonRecordCount: 7, sourceCount: 2 });
	});

	it('listBackendStories excludes archived stories by default and includes them when asked', async () => {
		const { db } = createDbMock({
			storyRows: [
				{ id: 'story_live', title: 'Live Campaign', metadata: {}, serverVersion: 3 },
				{ id: 'story_archived', title: 'Old Campaign', metadata: { archived: true, archivedAt: '2026-08-01T00:00:00.000Z' }, serverVersion: 2 },
			],
		});
		dbMocks.getDb.mockReturnValue(db);

		const active = await listBackendStories();
		expect(active.map((story) => story.id)).toEqual(['story_live']);

		const withArchived = await listBackendStories({ includeArchived: true });
		expect(withArchived.map((story) => story.id)).toEqual(['story_live', 'story_archived']);
	});

	it('restoreBackendStory clears archive metadata and bumps the server version', async () => {
		const { db, updateCalls } = createDbMock({
			storyUpdateReturning: [{ id: 'story_archived', serverVersion: 3 }],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await restoreBackendStory('story_archived');

		expect(result).toEqual({ ok: true, storyId: 'story_archived', serverVersion: 3 });
		const call = updateCalls.find((entry) => entry.table === stories);
		expect(call).toBeDefined();
	});

	it('restoreBackendStory throws for an unknown story', async () => {
		const { db } = createDbMock({
			storyUpdateReturning: [],
		});
		dbMocks.getDb.mockReturnValue(db);

		await expect(restoreBackendStory('story_missing')).rejects.toThrow('Story not found: story_missing');
	});
});
