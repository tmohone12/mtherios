import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	entities,
	entityAliases,
	factionProjects,
	patchProposals,
	sourceRefs,
	storyEvents,
	stories,
} from '$lib/server/db/schema';
import { canonDriftSourceRefKey, isInvalidSourceRefForRepair, isUnsafeMemoryNodeForRepair, mergeCharacterReferenceState, mergeMergedFromHistory, mergeRecords, reviewPatchProposal, stripMergedIntoMetadata } from './canonRepair';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueBackendJob: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: dbMocks.enqueueBackendJob,
	enqueueStoryVaultSyncJob: dbMocks.enqueueStoryVaultSyncJob,
}));

const characterReferenceProposal = {
	id: 'proposal_ser_olyvar',
	storyId: 'story_1',
	proposalType: 'character_reference_review',
	targetTable: 'entities',
	targetRecordId: 'unresolved_character_ser_olyvar',
	proposedBy: 'llm',
	operations: [{
		op: 'review',
		path: '/entities/character',
		value: {
			name: 'Ser Olyvar',
			description: 'A knight mentioned only in passing by the crowd.',
			status: 'active',
			visibility: 'player_known',
			state: {
				traits: ['unverified'],
				present: false,
			},
		},
	}],
	reason: 'Turn referenced unresolved character Ser Olyvar.',
	suggestion: 'Review this character reference before creating a new canonical record.',
	status: 'needs_review',
	decision: null,
	validatedBy: null,
	affectedEntityIds: [],
	confidence: 0.52,
	sourceEntryIds: ['entry_whisper'],
	sourceEventIds: [],
	sourcePatchIds: ['patch_whisper'],
	metadata: {
		sourceType: 'unresolved_character_reference',
		sourceName: 'Ser Olyvar',
	},
	serverVersion: 1,
	createdAt: '2026-06-13T00:00:00.000Z',
	updatedAt: '2026-06-13T00:00:00.000Z',
};

const dueFactionProjectProposal: typeof patchProposals.$inferSelect = {
	id: 'proposal_due_project_project_harbor_blockade',
	storyId: 'story_1',
	proposalType: 'faction_project_due_resolution',
	targetTable: 'faction_projects',
	targetRecordId: 'project_harbor_blockade',
	proposedBy: 'faction_project_auditor',
	operations: [
		{
			op: 'replace',
			path: '/faction_projects/project_harbor_blockade/status',
			value: 'completed',
		},
		{
			op: 'add',
			path: '/story_events',
			value: {
				type: 'faction_move',
				status: 'proposed',
				title: 'Harbor Compact: Blockade the harbor before the wedding fleet arrives',
				body: 'Due faction project can resolve: Blockade the harbor before the wedding fleet arrives.',
				factionIds: ['faction_harbor'],
				visibility: 'secret',
				createdTurn: 12,
				metadata: {
					sourceType: 'due_faction_project_audit',
					projectId: 'project_harbor_blockade',
					project: 'Blockade the harbor before the wedding fleet arrives',
					progress: 0.65,
					priority: 8,
					costs: [{ key: 'coin', required: 40, available: 100, resourceId: 'res_coin' }],
					gains: { pressure: 'Control food prices' },
					risks: ['Smugglers defect'],
				},
			},
		},
	],
	reason: 'Faction project "Blockade the harbor before the wedding fleet arrives" is due on turn 10.',
	suggestion: 'Review and apply this proposal to resolve the due faction project and create a faction movement event.',
	status: 'pending',
	decision: null,
	validatedBy: null,
	affectedEntityIds: [],
	confidence: 0.78,
	sourceEntryIds: ['entry_order'],
	sourceEventIds: ['event_pact'],
	sourcePatchIds: ['patch_project'],
	metadata: {
		sourceType: 'due_faction_project_audit',
		projectId: 'project_harbor_blockade',
		project: 'Blockade the harbor before the wedding fleet arrives',
		progress: 0.65,
		priority: 8,
		costs: [{ key: 'coin', required: 40, available: 100, resourceId: 'res_coin' }],
		gains: { pressure: 'Control food prices' },
		risks: ['Smugglers defect'],
	},
	serverVersion: 4,
	createdAt: '2026-06-13T00:00:00.000Z',
	updatedAt: '2026-06-13T00:00:00.000Z',
};

function createDbMock(options: {
	patchProposalRows?: Array<typeof patchProposals.$inferSelect>;
	entityRows?: Array<typeof entities.$inferSelect>;
	aliasRows?: Array<typeof entityAliases.$inferSelect>;
} = {}) {
	type DbSource = 'root' | 'tx';
	const insertCalls: Array<{ source: DbSource; table: unknown; value: unknown }> = [];
	const updateCalls: Array<{ source: DbSource; table: unknown; value: Record<string, unknown> }> = [];

	function createConnection(source: DbSource) {
		let selectedTable: unknown;

		const selectChain = {
			from: vi.fn((table: unknown) => {
				selectedTable = table;
				return selectChain;
			}),
			where: vi.fn(() => {
				if (selectedTable === entityAliases) return Promise.resolve(options.aliasRows ?? []);
				return selectChain;
			}),
			limit: vi.fn(() => {
				if (selectedTable === patchProposals) return Promise.resolve(options.patchProposalRows ?? [characterReferenceProposal]);
				if (selectedTable === entities) return Promise.resolve(options.entityRows ?? []);
				return Promise.resolve([]);
			}),
		};
		const select = vi.fn(() => selectChain);

		const insert = vi.fn((table: unknown) => ({
			values: vi.fn((value: unknown) => {
				insertCalls.push({ source, table, value });
				return {
					onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
					returning: vi.fn().mockResolvedValue([value]),
				};
			}),
		}));

		const update = vi.fn((table: unknown) => ({
			set: vi.fn((value: Record<string, unknown>) => ({
				where: vi.fn(() => {
					updateCalls.push({ source, table, value });
					return {
						returning: vi.fn().mockResolvedValue(table === stories
							? [{ serverVersion: 2 }]
							: table === factionProjects
								? [{ id: 'project_harbor_blockade', status: value.status }]
								: [value]),
					};
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

	return { db, insertCalls, updateCalls };
}

beforeEach(() => {
	dbMocks.getDb.mockReset();
	dbMocks.enqueueBackendJob.mockReset();
	dbMocks.enqueueStoryVaultSyncJob.mockReset();
	dbMocks.enqueueBackendJob.mockResolvedValue(undefined);
	dbMocks.enqueueStoryVaultSyncJob.mockResolvedValue(undefined);
});

describe('reviewPatchProposal', () => {
	it('classifies source-ref and unsafe-memory rows for canon drift cleanup', () => {
		expect(isInvalidSourceRefForRepair({
			sourceType: '',
			sourceId: '',
			targetTable: '',
			targetRecordId: '',
		} as any)).toBe(true);
		expect(canonDriftSourceRefKey({
			sourceType: 'story_entry',
			sourceId: 'entry_1',
			targetTable: 'entities',
			targetRecordId: 'entity_1',
			targetRecordField: 'state',
			sourceField: 'characters',
		} as any)).toBe('story_entry\u001fentry_1\u001fentities\u001fentity_1\u001fstate\u001fcharacters');
		expect(isUnsafeMemoryNodeForRepair({
			title: 'Transcript context removed',
			content: 'Player deleted a poisoned context message.',
			summary: 'Player deleted a poisoned context message.',
		} as any)).toBe(true);
	});

	it('keeps the kept entity state when merging duplicate records', () => {
		expect(mergeRecords(
			{ present: true, assets: ['bad imported ledger'], title: 'Consort' },
			{ present: false, assets: [], name: 'Aurion Balaerys' },
		)).toEqual({
			present: false,
			assets: [],
			title: 'Consort',
			name: 'Aurion Balaerys',
		});
	});

	it('merges approved character-reference state without erasing existing memory', () => {
		expect(mergeCharacterReferenceState(
			{
				traits: ['wary'],
				appearance: 'Scar over left brow.',
				present: false,
				eventMemory: { did: ['guarded the bridge'], saw: ['the oath'] },
			},
			{
				traits: ['witness'],
				appearance: '   ',
				present: true,
				eventMemory: { did: ['guarded the bridge', 'warned the heir'], knew: ['secret route'] },
			},
		)).toEqual({
			traits: ['wary', 'witness'],
			appearance: 'Scar over left brow.',
			present: true,
			eventMemory: {
				did: ['guarded the bridge', 'warned the heir'],
				saw: ['the oath'],
				knew: ['secret route'],
			},
		});
	});

	it('keeps approved character event memory bounded to newest facts', () => {
		const merged = mergeCharacterReferenceState(
			{
				eventMemory: {
					did: Array.from({ length: 16 }, (_, index) => `old deed ${index + 1}`),
				},
			},
			{
				eventMemory: {
					did: ['new deed 1', 'new deed 2'],
				},
			},
		);

		expect((merged.eventMemory as Record<string, string[]>).did).toEqual([
			'old deed 3',
			'old deed 4',
			'old deed 5',
			'old deed 6',
			'old deed 7',
			'old deed 8',
			'old deed 9',
			'old deed 10',
			'old deed 11',
			'old deed 12',
			'old deed 13',
			'old deed 14',
			'old deed 15',
			'old deed 16',
			'new deed 1',
			'new deed 2',
		]);
	});

	it('removes merged-away metadata from active merged entities', () => {
		expect(stripMergedIntoMetadata({
			mergedInto: 'entity_keep',
			mergedAt: '2026-06-18T00:00:00.000Z',
			origin: 'manual',
		})).toEqual({
			mergedAt: '2026-06-18T00:00:00.000Z',
			origin: 'manual',
		});
	});

	it('keeps full merged-from history across repeated entity merges', () => {
		expect(mergeMergedFromHistory(
			{ mergedFrom: [{ entityId: 'entity_consort', name: 'Consort' }] },
			{ mergedFrom: { entityId: 'entity_aegon', name: 'Aegon Targaryen 6th' } },
			{ entityId: 'entity_duplicate', name: 'Aurion Balaerys', status: 'inactive' },
		)).toEqual([
			{ entityId: 'entity_consort', name: 'Consort' },
			{ entityId: 'entity_aegon', name: 'Aegon Targaryen 6th' },
			{ entityId: 'entity_duplicate', name: 'Aurion Balaerys', status: 'inactive' },
		]);
	});

	it('turns an approved character reference review into canonical character evidence', async () => {
		const { db, insertCalls, updateCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_ser_olyvar',
			decision: 'approved',
			reviewer: 'human',
			notes: 'Promote this reference into canon.',
		});

		const entityInsert = insertCalls.find((call) => call.table === entities)?.value as Record<string, unknown> | undefined;
		const sourceRefInsert = insertCalls.find((call) => call.table === sourceRefs)?.value as Record<string, unknown> | undefined;
		const proposalUpdate = updateCalls.find((call) => call.table === patchProposals)?.value;

		expect(entityInsert).toMatchObject({
			id: 'entity_ser_olyvar',
			storyId: 'story_1',
			type: 'character',
			name: 'Ser Olyvar',
			description: 'A knight mentioned only in passing by the crowd.',
			status: 'active',
			visibility: 'player_known',
			state: {
				traits: ['unverified'],
				present: false,
			},
			sourceEntryIds: ['entry_whisper'],
			sourcePatchIds: ['patch_whisper', 'proposal_ser_olyvar'],
			serverVersion: 2,
		});
		expect(sourceRefInsert).toMatchObject({
			storyId: 'story_1',
			sourceType: 'patch_proposal',
			sourceId: 'proposal_ser_olyvar',
			targetTable: 'entities',
			targetRecordId: 'entity_ser_olyvar',
			sourceField: 'character_reference_review',
			confidence: 0.52,
			serverVersion: 2,
		});
		expect(proposalUpdate).toMatchObject({
			status: 'applied',
			decision: 'approved',
			affectedEntityIds: ['entity_ser_olyvar'],
			metadata: expect.objectContaining({
				reviewNotes: 'Promote this reference into canon.',
				appliedEntityId: 'entity_ser_olyvar',
				appliedOperations: [
					expect.objectContaining({
						op: 'create',
						table: 'entities',
						recordId: 'entity_ser_olyvar',
					}),
				],
			}),
		});
		expect(result).toMatchObject({
			storyId: 'story_1',
			proposalId: 'proposal_ser_olyvar',
			status: 'applied',
			decision: 'approved',
			application: {
				appliedCount: 1,
				affectedEntityIds: ['entity_ser_olyvar'],
				appliedOperations: [
					expect.objectContaining({
						op: 'create',
						table: 'entities',
						recordId: 'entity_ser_olyvar',
					}),
				],
			},
		});
		expect(dbMocks.enqueueStoryVaultSyncJob).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			serverVersion: 2,
			payload: expect.objectContaining({
				source: 'canon_repair',
				index: true,
			}),
		}));
	});

	it('rejects approved title-only character references instead of creating canon junk', async () => {
		const titleProposal: typeof patchProposals.$inferSelect = {
			...characterReferenceProposal,
			id: 'proposal_consort',
			targetRecordId: 'unresolved_character_consort',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'Consort',
					description: 'A title mistaken for a character.',
					status: 'active',
					visibility: 'player_known',
					state: {},
				},
			}],
			metadata: {
				sourceType: 'chapter_character_reference',
				sourceName: 'Consort',
			},
		};
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [titleProposal],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_consort',
			decision: 'approved',
			reviewer: 'human',
			notes: 'This should not become canon.',
		});

		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
		const proposalUpdate = updateCalls.find((call) => call.table === patchProposals)?.value;
		expect(proposalUpdate).toMatchObject({
			status: 'rejected',
			decision: 'rejected',
			metadata: expect.objectContaining({
				rejectionReason: 'Title-only character reference "Consort" cannot become canon.',
			}),
		});
		expect(result).toMatchObject({
			status: 'rejected',
			decision: 'rejected',
			application: {
				appliedCount: 0,
			},
		});
	});

	it('applies an approved character reference to an existing character alias instead of creating a duplicate', async () => {
		const aliasProposal: typeof patchProposals.$inferSelect = {
			...characterReferenceProposal,
			id: 'proposal_quiet_olyvar',
			targetRecordId: 'unresolved_character_the_quiet_olyvar',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'The Quiet Olyvar',
					description: 'A tavern alias for the knight who witnessed the bridge oath.',
					status: 'active',
					visibility: 'player_known',
					state: {
						traits: ['witness'],
						eventMemory: {
							did: ['warned the heir'],
						},
						present: true,
					},
				},
			}],
			reason: 'Turn referenced unresolved character The Quiet Olyvar.',
			sourceEntryIds: ['entry_alias'],
			sourcePatchIds: ['patch_alias'],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'The Quiet Olyvar',
			},
		};
		const existingCharacter: typeof entities.$inferSelect = {
			id: 'entity_ser_olyvar',
			storyId: 'story_1',
			type: 'character',
			name: 'Ser Olyvar',
			description: 'A wary knight already known to canon.',
			status: 'active',
			visibility: 'player_known',
			state: {
				traits: ['wary'],
				eventMemory: {
					did: ['kept the bridge oath'],
				},
				present: false,
			},
			metadata: {
				createdFrom: 'manual_review',
			},
			sourceEntryIds: ['entry_canon'],
			sourceEventIds: ['event_canon'],
			sourcePatchIds: ['patch_canon'],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const aliasRow: typeof entityAliases.$inferSelect = {
			id: 'alias_quiet_olyvar',
			storyId: 'story_1',
			entityId: 'entity_ser_olyvar',
			alias: 'The Quiet Olyvar',
			normalizedAlias: 'the quiet olyvar',
			sourceEntryIds: ['entry_alias_old'],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [aliasProposal],
			entityRows: [existingCharacter],
			aliasRows: [aliasRow],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_quiet_olyvar',
			decision: 'approved',
			reviewer: 'human',
			notes: 'This is Olyvar under an alias.',
		});

		const entityInsert = insertCalls.find((call) => call.table === entities)?.value;
		const entityUpdate = updateCalls.find((call) => call.table === entities)?.value;
		const sourceRefInsert = insertCalls.find((call) => call.table === sourceRefs)?.value as Record<string, unknown> | undefined;
		const proposalUpdate = updateCalls.find((call) => call.table === patchProposals)?.value;

		expect(entityInsert).toBeUndefined();
		expect(entityUpdate).toMatchObject({
			description: 'A wary knight already known to canon.',
			status: 'active',
			visibility: 'player_known',
			state: {
				traits: ['wary', 'witness'],
				eventMemory: {
					did: ['kept the bridge oath', 'warned the heir'],
				},
				present: true,
			},
			metadata: expect.objectContaining({
				createdFrom: 'manual_review',
				approvedFromProposal: 'proposal_quiet_olyvar',
			}),
			sourceEntryIds: ['entry_canon', 'entry_alias'],
			sourceEventIds: ['event_canon'],
			sourcePatchIds: ['patch_canon', 'patch_alias', 'proposal_quiet_olyvar'],
			serverVersion: 2,
		});
		expect(sourceRefInsert).toMatchObject({
			storyId: 'story_1',
			sourceType: 'patch_proposal',
			sourceId: 'proposal_quiet_olyvar',
			targetTable: 'entities',
			targetRecordId: 'entity_ser_olyvar',
			sourceField: 'character_reference_review',
			serverVersion: 2,
		});
		expect(proposalUpdate).toMatchObject({
			status: 'applied',
			decision: 'approved',
			affectedEntityIds: ['entity_ser_olyvar'],
			metadata: expect.objectContaining({
				reviewNotes: 'This is Olyvar under an alias.',
				appliedEntityId: 'entity_ser_olyvar',
				appliedOperations: [
					expect.objectContaining({
						op: 'update',
						table: 'entities',
						recordId: 'entity_ser_olyvar',
					}),
				],
			}),
		});
		expect(result.application).toMatchObject({
			affectedEntityIds: ['entity_ser_olyvar'],
			appliedOperations: [
				expect.objectContaining({
					op: 'update',
					table: 'entities',
					recordId: 'entity_ser_olyvar',
				}),
			],
		});
	});

	it('applies approved character context draft proposals to canonical character state', async () => {
		const contextProposal: typeof patchProposals.$inferSelect = {
			id: 'proposal_mira_context',
			storyId: 'story_1',
			proposalType: 'character_context_update',
			targetTable: 'entities',
			targetRecordId: 'entity_mira',
			proposedBy: 'llm',
			operations: [{
				op: 'replace',
				path: '/characters/entity_mira/state',
				value: {
					currentLocation: 'Yin harbor counting room',
					currentAction: 'guarding the ledger',
					goals: ['protect Aurion'],
					eventMemory: {
						knows: ['the ledger names Zhen'],
					},
				},
			}],
			reason: 'Refresh Mira from recent harbor context.',
			suggestion: 'Review this NPC update before applying it to canon.',
			status: 'pending',
			decision: null,
			validatedBy: null,
			affectedEntityIds: ['entity_mira'],
			confidence: 0.75,
			sourceEntryIds: ['entry_harbor'],
			sourceEventIds: ['event_harbor'],
			sourcePatchIds: ['patch_harbor'],
			metadata: { sourceType: 'character_context_update' },
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const existingCharacter: typeof entities.$inferSelect = {
			id: 'entity_mira',
			storyId: 'story_1',
			type: 'character',
			name: 'Mira',
			description: 'A harbor broker.',
			status: 'active',
			visibility: 'player_known',
			state: {
				goals: ['keep the trading post open'],
				eventMemory: {
					saw: ['Mira saw the old oath sworn.'],
					knew: ['Mira knew the market code.'],
				},
			},
			metadata: { createdFrom: 'manual' },
			sourceEntryIds: ['entry_canon'],
			sourceEventIds: [],
			sourcePatchIds: ['patch_canon'],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [contextProposal],
			entityRows: [existingCharacter],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_mira_context',
			decision: 'approved',
			reviewer: 'human',
			notes: 'Looks right.',
		});

		const entityUpdate = updateCalls.find((call) => call.table === entities)?.value;
		const sourceRefInsert = insertCalls.find((call) => call.table === sourceRefs)?.value as Record<string, unknown> | undefined;
		const proposalUpdate = updateCalls.find((call) => call.table === patchProposals)?.value;

		expect(entityUpdate).toMatchObject({
			state: {
				currentLocation: 'Yin harbor counting room',
				currentAction: 'guarding the ledger',
				goals: ['keep the trading post open', 'protect Aurion'],
				eventMemory: {
					saw: ['Mira saw the old oath sworn.'],
					knew: ['Mira knew the market code.'],
					knows: ['the ledger names Zhen'],
				},
			},
			metadata: {
				createdFrom: 'manual',
				updatedFromProposal: 'proposal_mira_context',
				updatedFromProposalType: 'character_context_update',
			},
			sourceEntryIds: ['entry_canon', 'entry_harbor'],
			sourceEventIds: ['event_harbor'],
			sourcePatchIds: ['patch_canon', 'patch_harbor', 'proposal_mira_context'],
			serverVersion: 2,
		});
		expect(sourceRefInsert).toMatchObject({
			storyId: 'story_1',
			sourceType: 'patch_proposal',
			sourceId: 'proposal_mira_context',
			targetTable: 'entities',
			targetRecordId: 'entity_mira',
			targetRecordField: 'state',
			sourceField: 'character_context_update',
			serverVersion: 2,
		});
		expect(proposalUpdate).toMatchObject({
			status: 'applied',
			decision: 'approved',
			affectedEntityIds: ['entity_mira'],
			metadata: expect.objectContaining({
				reviewNotes: 'Looks right.',
				appliedEntityId: 'entity_mira',
				appliedOperations: [
					expect.objectContaining({
						op: 'update',
						table: 'entities',
						recordId: 'entity_mira',
						field: 'state',
					}),
				],
			}),
		});
		expect(result.application).toMatchObject({
			appliedCount: 1,
			affectedEntityIds: ['entity_mira'],
			appliedOperations: [
				expect.objectContaining({
					op: 'update',
					table: 'entities',
					recordId: 'entity_mira',
				}),
			],
		});
		expect(dbMocks.enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			type: 'index_canonical_records',
			dedupeKey: 'canon-repair-index-story_1-2-entity_mira',
			payload: expect.objectContaining({
				recordTypes: ['entities'],
				recordId: 'entity_mira',
				reason: 'canon_repair',
				serverVersion: 2,
			}),
		}));
	});

	it('applies approved contained-name character references to the existing character', async () => {
		const variantProposal: typeof patchProposals.$inferSelect = {
			...characterReferenceProposal,
			id: 'proposal_xanda_qarth',
			targetRecordId: 'unresolved_character_xanda_of_qarth',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'Xanda of Qarth',
					description: 'A mistaken long-form reference to Xanda.',
					status: 'active',
					visibility: 'player_known',
					state: {
						eventMemory: { saw: ['tested Aurion at dinner'] },
					},
				},
			}],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'Xanda of Qarth',
			},
		};
		const existingCharacter: typeof entities.$inferSelect = {
			id: 'entity_xanda',
			storyId: 'story_1',
			type: 'character',
			name: 'Xanda',
			description: 'A pureborn YiTish girl of high status.',
			status: 'active',
			visibility: 'player_known',
			state: { eventMemory: { did: ['hosted Aurion for dinner'] } },
			metadata: { createdFrom: 'manual' },
			sourceEntryIds: ['entry_old'],
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [variantProposal],
			entityRows: [existingCharacter],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_xanda_qarth',
			decision: 'approved',
			reviewer: 'human',
			notes: 'This is Xanda.',
		});

		expect(insertCalls.find((call) => call.table === entities)).toBeUndefined();
		const entityUpdate = updateCalls.find((call) => call.table === entities)?.value;
		expect(entityUpdate).toMatchObject({
			state: {
				eventMemory: {
					did: ['hosted Aurion for dinner'],
					saw: ['tested Aurion at dinner'],
				},
			},
			sourceEntryIds: ['entry_old', 'entry_whisper'],
			sourcePatchIds: ['patch_whisper', 'proposal_xanda_qarth'],
		});
		expect(result.application).toMatchObject({
			affectedEntityIds: ['entity_xanda'],
			metadata: {
				appliedEntityId: 'entity_xanda',
				appliedEntityName: 'Xanda of Qarth',
			},
		});
	});

	it('applies approved due faction project proposals without losing audit context', async () => {
		const { db, insertCalls, updateCalls } = createDbMock({
			patchProposalRows: [dueFactionProjectProposal],
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: 'proposal_due_project_project_harbor_blockade',
			decision: 'approved',
			reviewer: 'human',
			notes: 'Resolve this faction move.',
		});

		const projectUpdate = updateCalls.find((call) => call.table === factionProjects)?.value;
		const eventInsert = insertCalls.find((call) => call.table === storyEvents)?.value as Record<string, unknown> | undefined;
		const proposalUpdate = updateCalls.find((call) => call.table === patchProposals)?.value;

		expect(projectUpdate).toMatchObject({
			status: 'completed',
			sourcePatchIds: ['patch_project', 'proposal_due_project_project_harbor_blockade'],
			serverVersion: 2,
		});
		expect(eventInsert).toMatchObject({
			id: 'event_proposal_due_project_project_harbor_blockade',
			storyId: 'story_1',
			type: 'faction_move',
			status: 'committed',
			title: 'Harbor Compact: Blockade the harbor before the wedding fleet arrives',
			factionIds: ['faction_harbor'],
			visibility: 'secret',
			createdTurn: 12,
			occurredTurn: 12,
			sourceEntryIds: ['entry_order'],
			sourcePatchIds: ['patch_project', 'proposal_due_project_project_harbor_blockade'],
			metadata: {
				sourceType: 'patch_proposal_application',
				auditSourceType: 'due_faction_project_audit',
				proposalId: 'proposal_due_project_project_harbor_blockade',
				projectId: 'project_harbor_blockade',
				project: 'Blockade the harbor before the wedding fleet arrives',
				progress: 0.65,
				priority: 8,
				costs: [{ key: 'coin', required: 40, available: 100, resourceId: 'res_coin' }],
				gains: { pressure: 'Control food prices' },
				risks: ['Smugglers defect'],
			},
		});
		expect(proposalUpdate).toMatchObject({
			status: 'applied',
			decision: 'approved',
			metadata: expect.objectContaining({
				reviewNotes: 'Resolve this faction move.',
				appliedOperations: [
					expect.objectContaining({ table: 'faction_projects', recordId: 'project_harbor_blockade' }),
					expect.objectContaining({ table: 'story_events', recordId: 'event_proposal_due_project_project_harbor_blockade' }),
				],
			}),
		});
		expect(result.application).toMatchObject({
			appliedCount: 2,
			appliedOperations: [
				expect.objectContaining({ table: 'faction_projects', recordId: 'project_harbor_blockade' }),
				expect.objectContaining({ table: 'story_events', recordId: 'event_proposal_due_project_project_harbor_blockade' }),
			],
		});
	});
});
