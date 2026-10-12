import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	entities,
	entityAliases,
	factionProjects,
	factionResources,
	patchProposals,
	sourceRefs,
	storyEvents,
	storyEntries,
	stories,
} from '$lib/server/db/schema';
import { applyChapterScribeCharacterContextProposals, canonDriftSourceRefKey, isInvalidSourceRefForRepair, isUnsafeMemoryNodeForRepair, mergeCharacterReferenceState, mergeMergedFromHistory, mergeRecords, reviewPatchProposal, stripMergedIntoMetadata } from './canonRepair';
import { dueFactionProjectFingerprint } from '$lib/server/factions/projects';

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

function gmCharacterDraftProposal(input: {
	storyId?: string;
	id?: string;
	sourceName?: string;
	name?: string;
	aliases?: string[];
} = {}): typeof patchProposals.$inferSelect {
	const storyId = input.storyId ?? 'story_1';
	const proposalId = input.id ?? 'character_create_proposal_tala';
	const sourceName = input.sourceName ?? 'Tala Venn';
	const name = input.name ?? sourceName;
	return {
		...characterReferenceProposal,
		id: proposalId,
		storyId,
		targetRecordId: 'unresolved_character_tala_venn',
		proposedBy: 'gm_character_draft',
		operations: [{
			op: 'review',
			path: '/entities/character',
			value: {
				storyId,
				type: 'character',
				name,
				description: 'A harbor courier carrying dangerous evidence.',
				status: 'active',
				visibility: 'gm',
				aliases: input.aliases ?? [],
				state: {
					bio: 'Raised among the tide warehouses.',
					rank: 'Harbor courier',
					currentLocation: 'East Tide Warehouses',
					factionTags: ['Harbor Guild'],
				},
			},
		}],
		status: 'pending',
		metadata: {
			sourceType: 'gm_character_draft',
			sourceName,
		},
	};
}

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

const dueProject: typeof factionProjects.$inferSelect = { id: 'project_harbor_blockade', storyId: 'story_1', factionId: 'faction_harbor',
	project: 'Blockade the harbor before the wedding fleet arrives', status: 'active', progress: 1, costs: { coin: 40 },
	sourcePatchIds: ['patch_project'], sourceEntryIds: ['entry_order'], sourceEventIds: ['event_pact'], serverVersion: 4,
	dueTurn: 10, worldTime: null, priority: 8, visibility: 'secret', gains: {}, risks: [], metadata: {},
	createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z',
};
const dueResources: Array<typeof factionResources.$inferSelect> = [{ id: 'res_coin', storyId: 'story_1', factionId: 'faction_harbor', kind: 'coin', name: 'Coin',
	amount: 100, status: 'available', metadata: {}, serverVersion: 4, locationId: null, visibility: 'secret',
	sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z' }];
dueFactionProjectProposal.metadata = { ...dueFactionProjectProposal.metadata, auditFingerprint: dueFactionProjectFingerprint(dueProject, dueResources) };

function createDbMock(options: {
	patchProposalRows?: Array<typeof patchProposals.$inferSelect>;
	entityRows?: Array<typeof entities.$inferSelect>;
	sequentialEntityRows?: Array<typeof entities.$inferSelect>;
	aliasRows?: Array<typeof entityAliases.$inferSelect>;
	entryRows?: Array<typeof storyEntries.$inferSelect>;
	projectRows?: Array<typeof factionProjects.$inferSelect>;
	resourceRows?: Array<typeof factionResources.$inferSelect>;
} = {}) {
	type DbSource = 'root' | 'tx';
	const insertCalls: Array<{ source: DbSource; table: unknown; value: unknown }> = [];
	const updateCalls: Array<{ source: DbSource; table: unknown; value: Record<string, unknown> }> = [];
	const deleteCalls: Array<{ source: DbSource; table: unknown }> = [];
	const proposalRows = (options.patchProposalRows ?? [characterReferenceProposal]).map((row) => ({ ...row }));
	let entitySelection = 0;

	function createConnection(source: DbSource) {
		let selectedTable: unknown;

		const selectChain = {
			orderBy: () => selectChain,
			from: vi.fn((table: unknown) => {
				selectedTable = table;
				return selectChain;
			}),
			where: vi.fn(() => {
				if (selectedTable === entityAliases) return Promise.resolve(options.aliasRows ?? []);
				return selectChain;
			}),
			limit: vi.fn(() => {
				if (selectedTable === patchProposals) return Promise.resolve(proposalRows);
				if (selectedTable === entities && options.sequentialEntityRows) {
					const row = options.sequentialEntityRows[entitySelection++];
					return Promise.resolve(row ? [row] : []);
				}
				if (selectedTable === entities) return Promise.resolve(options.entityRows ?? []);
				return Promise.resolve([]);
			}),
			for: vi.fn(() => Promise.resolve(selectedTable === storyEntries ? options.entryRows ?? [] : selectedTable === patchProposals
				? proposalRows.filter((row) => ['pending', 'needs_review'].includes(row.status))
				: selectedTable === entities ? options.sequentialEntityRows ? [options.sequentialEntityRows[entitySelection++]].filter(Boolean) : (options.entityRows ?? [])
				: selectedTable === factionProjects ? options.projectRows ?? [dueProject]
				: selectedTable === factionResources ? options.resourceRows ?? dueResources : [])),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(selectedTable === entities ? options.entityRows ?? [] : []).then(resolve),
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
					if (table === patchProposals && typeof value.status === 'string') {
						for (const row of proposalRows) row.status = value.status;
					}
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
		const remove = vi.fn((table: unknown) => ({
			where: vi.fn(async () => {
				deleteCalls.push({ source, table });
			}),
		}));

		return { delete: remove, insert, select, update };
	}

	const tx = createConnection('tx');
	const db = {
		...createConnection('root'),
		transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
	};

	return { db, deleteCalls, insertCalls, updateCalls };
}

beforeEach(() => {
	dbMocks.getDb.mockReset();
	dbMocks.enqueueBackendJob.mockReset();
	dbMocks.enqueueStoryVaultSyncJob.mockReset();
	dbMocks.enqueueBackendJob.mockResolvedValue(undefined);
	dbMocks.enqueueStoryVaultSyncJob.mockResolvedValue(undefined);
});

describe('reviewPatchProposal', () => {
	it('creates a populated chapter candidate directly from its saved description', async () => {
		const proposal = structuredClone(characterReferenceProposal);
		proposal.proposedBy = 'chapter_scribe';
		const { db, insertCalls } = createDbMock({ patchProposalRows: [proposal] });
		dbMocks.getDb.mockReturnValue(db);
		const result = await reviewPatchProposal({ storyId: 'story_1', proposalId: proposal.id, decision: 'approved' });
		expect(result).toMatchObject({ status: 'applied', application: { appliedCount: 1 } });
		expect(insertCalls.find((call) => call.table === entities)?.value).toMatchObject({ name: 'Ser Olyvar', state: { bio: 'A knight mentioned only in passing by the crowd.' } });
	});

	it('uses the saved description of a populated LLM candidate without another API call', async () => {
		const { db, insertCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		const result = await reviewPatchProposal({ storyId: 'story_1', proposalId: characterReferenceProposal.id, decision: 'approved' });
		expect(result).toMatchObject({ status: 'applied', application: { appliedCount: 1 } });
		expect(insertCalls.find((call) => call.table === entities)?.value).toMatchObject({ state: { bio: 'A knight mentioned only in passing by the crowd.' } });
	});
	it('creates a manually completed chapter candidate without an extraction call', async () => {
		const proposal = gmCharacterDraftProposal();
		proposal.proposedBy = 'chapter_scribe';
		proposal.metadata = { sourceName: 'Tala Venn', sourceDraft: { mode: 'manual_review' } };
		const { db, insertCalls } = createDbMock({ patchProposalRows: [proposal] });
		dbMocks.getDb.mockReturnValue(db);
		const result = await reviewPatchProposal({ storyId: 'story_1', proposalId: proposal.id, decision: 'approved' });
		expect(result).toMatchObject({ status: 'applied', application: { appliedCount: 1 } });
		expect(insertCalls.find((call) => call.table === entities)?.value).toMatchObject({ name: 'Tala Venn', state: { bio: 'Raised among the tide warehouses.' } });
	});

	it('keeps an unfilled chapter placeholder from becoming a character', async () => {
		const proposal = gmCharacterDraftProposal();
		proposal.proposedBy = 'chapter_scribe';
		proposal.metadata = { sourceName: 'Tala Venn' };
		(proposal.operations[0].value as Record<string, unknown>).description = 'Tala Venn is important in this chapter checkpoint.';
		const { db, insertCalls } = createDbMock({ patchProposalRows: [proposal] });
		dbMocks.getDb.mockReturnValue(db);
		await expect(reviewPatchProposal({ storyId: 'story_1', proposalId: proposal.id, decision: 'approved' })).rejects.toThrow(/placeholder/);
		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
	});

	it('rejects a source draft whose biography only repeats the candidate name', async () => {
		const proposal = gmCharacterDraftProposal();
		proposal.proposedBy = 'chapter_scribe';
		proposal.metadata = { sourceName: 'Tala Venn', sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio' }], sourceSnapshot: { entries: [], events: [] } } };
		(proposal.operations[0].value as Record<string, unknown>).state = { bio: 'Tala Venn' };
		const { db, insertCalls } = createDbMock({ patchProposalRows: [proposal] });
		dbMocks.getDb.mockReturnValue(db);
		await expect(reviewPatchProposal({ storyId: 'story_1', proposalId: proposal.id, decision: 'approved' })).rejects.toThrow(/substantive biography/);
		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
	});
	it('refuses stale review versions before any canonical write', async () => {
		const { db, insertCalls, updateCalls } = createDbMock();
		dbMocks.getDb.mockReturnValue(db);
		await expect(reviewPatchProposal({ storyId: 'story_1', proposalId: characterReferenceProposal.id, decision: 'approved', expectedProposalVersion: 0 })).rejects.toThrow(/changed/);
		expect(insertCalls).toEqual([]);
		expect(updateCalls).toEqual([]);
	});

	it('updates the exact drafted character beyond 240 records and preserves unrelated current canon', async () => {
		const character = { id: 'npc_target', storyId: 'story_1', type: 'character', name: 'Tala Venn', description: 'A courier.', status: 'active', visibility: 'player_known', state: { appearance: 'Old scar.', knownFacts: ['The dock password.'] }, metadata: {}, sourceEntryIds: ['entry_old'], sourceEventIds: [], sourcePatchIds: [], serverVersion: 4, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' } as typeof entities.$inferSelect;
		const sourceProposal = gmCharacterDraftProposal();
		sourceProposal.proposedBy = 'chapter_scribe';
		sourceProposal.metadata = { sourceName: 'Old source spelling', sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio' }], sourceSnapshot: { entries: [], events: [] }, targetEntityId: character.id, targetServerVersion: 4 } };
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [sourceProposal], entityRows: [...Array.from({ length: 260 }, (_, index) => ({ ...character, id: `other_${index}`, name: `Other ${index}` })), character] });
		dbMocks.getDb.mockReturnValue(db);
		const result = await reviewPatchProposal({ storyId: 'story_1', proposalId: sourceProposal.id, decision: 'approved', expectedProposalVersion: sourceProposal.serverVersion });
		expect(result).toMatchObject({ status: 'applied', application: { affectedEntityIds: ['npc_target'] } });
		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
		expect(updateCalls.find((call) => call.table === entities)?.value).toMatchObject({ state: { appearance: 'Old scar.', knownFacts: ['The dock password.'], bio: 'Raised among the tide warehouses.' }, sourceEntryIds: ['entry_old', 'entry_whisper'] });
	});

	it.each(['duplicate', 'changed_target', 'new_match'])('blocks unsafe source identity resolution: %s', async (kind) => {
		const character = { id: 'npc_target', name: 'Tala Venn', storyId: 'story_1', type: 'character', state: {}, serverVersion: 5 } as typeof entities.$inferSelect;
		const sourceProposal = gmCharacterDraftProposal();
		sourceProposal.proposedBy = 'chapter_scribe';
		sourceProposal.metadata = { sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio' }], sourceSnapshot: { entries: [], events: [] }, targetEntityId: kind === 'new_match' ? null : character.id, targetServerVersion: kind === 'duplicate' ? 5 : 4 } };
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [sourceProposal], entityRows: kind === 'duplicate' ? [character, { ...character, id: 'another' }] : [character] });
		dbMocks.getDb.mockReturnValue(db);
		const application = reviewPatchProposal({ storyId: 'story_1', proposalId: sourceProposal.id, decision: 'approved' });
		if (kind === 'duplicate') expect(await application).toMatchObject({ status: 'rejected', application: { appliedCount: 0 } });
		else await expect(application).rejects.toThrow(/Rebuild/);
		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
		expect(updateCalls.some((call) => call.table === entities)).toBe(false);
	});

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
			id: 'entity_story_1_ser_olyvar',
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
			targetRecordId: 'entity_story_1_ser_olyvar',
			sourceField: 'character_reference_review',
			confidence: 0.52,
			serverVersion: 2,
		});
		expect(proposalUpdate).toMatchObject({
			status: 'applied',
			decision: 'approved',
			affectedEntityIds: ['entity_story_1_ser_olyvar'],
			metadata: expect.objectContaining({
				reviewNotes: 'Promote this reference into canon.',
				appliedEntityId: 'entity_story_1_ser_olyvar',
				appliedOperations: [
					expect.objectContaining({
						op: 'create',
						table: 'entities',
						recordId: 'entity_story_1_ser_olyvar',
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
				affectedEntityIds: ['entity_story_1_ser_olyvar'],
				appliedOperations: [
					expect.objectContaining({
						op: 'create',
						table: 'entities',
						recordId: 'entity_story_1_ser_olyvar',
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

	it('applies an affinity-only update without losing newer relationship history or stats', () => {
		const current = {
			relationship: { level: 10, status: 'trusted ally', history: [{ event: 'Rescued the player' }] },
			playerSheet: { hitPoints: { current: 3, max: 10 } },
			currentLocation: 'New camp',
		};
		expect(mergeCharacterReferenceState(current, { relationship: { level: 35 } })).toEqual({
			...current, relationship: { ...current.relationship, level: 35 },
		});
		expect(mergeCharacterReferenceState({ relationship: 'ally' }, { relationship: { level: 20 } }).relationship).toEqual({ status: 'ally', level: 20 });
	});

	it('uses the reviewed GM name and a story-scoped collision-safe entity id', async () => {
		const firstProposal = gmCharacterDraftProposal({
			id: 'character_create_proposal_shared',
			sourceName: 'Tala Venn',
			name: 'Tala Maren',
		});
		const first = createDbMock({ patchProposalRows: [firstProposal] });
		dbMocks.getDb.mockReturnValue(first.db);
		await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: firstProposal.id,
			decision: 'approved',
			reviewer: 'human',
		});
		const firstEntity = first.insertCalls.find((call) => call.table === entities)?.value as Record<string, unknown>;

		const secondProposal = gmCharacterDraftProposal({
			storyId: 'story_2',
			id: 'character_create_proposal_shared',
			sourceName: 'Tala Venn',
			name: 'Tala Venn',
		});
		const second = createDbMock({ patchProposalRows: [secondProposal] });
		dbMocks.getDb.mockReturnValue(second.db);
		await reviewPatchProposal({
			storyId: 'story_2',
			proposalId: secondProposal.id,
			decision: 'approved',
			reviewer: 'human',
		});
		const secondEntity = second.insertCalls.find((call) => call.table === entities)?.value as Record<string, unknown>;

		expect(firstEntity).toMatchObject({
			id: 'entity_story_1_character_create_proposal_shared',
			storyId: 'story_1',
			name: 'Tala Maren',
			visibility: 'gm',
		});
		expect(secondEntity).toMatchObject({
			id: 'entity_story_2_character_create_proposal_shared',
			storyId: 'story_2',
			name: 'Tala Venn',
			visibility: 'gm',
		});
		expect(firstEntity.id).not.toBe(secondEntity.id);
	});

	it('preserves existing aliases when a GM draft resolves to an existing character', async () => {
		const proposal = gmCharacterDraftProposal({ aliases: ['Tide Sparrow'] });
		const existing: typeof entities.$inferSelect = {
			id: 'entity_tala',
			storyId: 'story_1',
			type: 'character',
			name: 'Tala Venn',
			description: 'An established harbor courier.',
			status: 'active',
			visibility: 'gm',
			state: { knownFacts: ['The old quay code.'] },
			metadata: {},
			sourceEntryIds: ['entry_old'],
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const oldAlias: typeof entityAliases.$inferSelect = {
			id: 'alias_old_quay_runner',
			storyId: 'story_1',
			entityId: existing.id,
			alias: 'Old Quay Runner',
			normalizedAlias: 'old quay runner',
			sourceEntryIds: ['entry_old'],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const { db, insertCalls } = createDbMock({
			patchProposalRows: [proposal],
			entityRows: [existing],
			aliasRows: [oldAlias],
		});
		dbMocks.getDb.mockReturnValue(db);

		await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: proposal.id,
			decision: 'approved',
			reviewer: 'human',
		});

		const savedAliases = insertCalls
			.filter((call) => call.table === entityAliases)
			.map((call) => (call.value as Record<string, unknown>).alias);
		expect(savedAliases).toEqual(['Old Quay Runner', 'Tala Venn', 'Tide Sparrow']);
		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
	});

	it('rejects a malformed GM character draft instead of recording an empty approval', async () => {
		const malformed = {
			...gmCharacterDraftProposal(),
			operations: [{ op: 'review', path: '/entities/character', value: { name: 'Tala Venn', state: 'invalid' } }],
		} satisfies typeof patchProposals.$inferSelect;
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [malformed] });
		dbMocks.getDb.mockReturnValue(db);

		const result = await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: malformed.id,
			decision: 'approved',
			reviewer: 'human',
		});

		expect(insertCalls.some((call) => call.table === entities)).toBe(false);
		expect(updateCalls.find((call) => call.table === patchProposals)?.value).toMatchObject({
			status: 'rejected',
			decision: 'rejected',
			metadata: expect.objectContaining({
				rejectionReason: 'Malformed GM character draft payload cannot become canon.',
			}),
		});
		expect(result).toMatchObject({ status: 'rejected', decision: 'rejected' });
	});

	it('locks and consumes a review proposal only once', async () => {
		const proposal = gmCharacterDraftProposal();
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [proposal] });
		dbMocks.getDb.mockReturnValue(db);

		await reviewPatchProposal({
			storyId: 'story_1',
			proposalId: proposal.id,
			decision: 'approved',
			reviewer: 'human',
		});
		await expect(reviewPatchProposal({
			storyId: 'story_1',
			proposalId: proposal.id,
			decision: 'approved',
			reviewer: 'human',
		})).rejects.toThrow('no longer pending');

		expect(insertCalls.filter((call) => call.table === entities)).toHaveLength(1);
		expect(updateCalls.filter((call) => call.table === stories)).toHaveLength(1);
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
					bio: 'A harbor broker. Mira now guards the ledger at Yin.',
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

		// The authored description stays; what the proposal adds becomes a story development.
		expect(entityUpdate).not.toHaveProperty('description');
		expect((entityUpdate as { state: Record<string, unknown> }).state).not.toHaveProperty('bio');
		expect(entityUpdate).toMatchObject({
			state: {
				developments: ['Mira now guards the ledger at Yin.'],
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
	it('replaces the authored bio only when the reviewer writes an explicit retcon note', async () => {
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
					bio: 'A harbor broker. Mira now guards the ledger at Yin.',
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
			notes: 'retcon: Mira was never a broker; she guards the ledger.',
		});

		const entityUpdate = updateCalls.find((call) => call.table === entities)?.value as Record<string, unknown> | undefined;
		expect(entityUpdate).toMatchObject({
			description: 'A harbor broker. Mira now guards the ledger at Yin.',
			state: { bio: 'A harbor broker. Mira now guards the ledger at Yin.', background: 'A harbor broker. Mira now guards the ledger at Yin.' },
		});
		expect(entityUpdate?.state).not.toHaveProperty('developments');
		expect(result).toBeTruthy();
	});


	it('leaves a chapter refresh for review when the character changed during generation', async () => {
		const proposal = {
			...characterReferenceProposal,
			proposalType: 'character_context_update', proposedBy: 'chapter_scribe', targetRecordId: 'entity_a',
			metadata: { sourceType: 'chapter_character_context', chapterNumber: 3, characterUpdateBaseVersion: 1, sourceDraft: { targetEntityId: 'entity_a' } },
		} as typeof patchProposals.$inferSelect;
		const { db, updateCalls } = createDbMock({ patchProposalRows: [proposal], entityRows: [{ id: 'entity_a', serverVersion: 2 } as typeof entities.$inferSelect] });
		dbMocks.getDb.mockReturnValue(db);
		const result = await applyChapterScribeCharacterContextProposals({ storyId: 'story_1', proposalIds: [proposal.id] });
		expect(result.appliedCount).toBe(0);
		expect(updateCalls.filter(call => call.table === entities)).toHaveLength(0);
		expect(updateCalls.find(call => call.table === patchProposals)?.value).toMatchObject({ status: 'needs_review', metadata: { staleReason: expect.stringContaining('Character changed') } });
	});

	it('applies chapter-scribe character context proposals in one versioned batch', async () => {
		const chapterProposal = (id: string, entityId: string): typeof patchProposals.$inferSelect => ({
			...characterReferenceProposal,
			id,
			proposalType: 'character_context_update',
			targetRecordId: entityId,
			proposedBy: 'chapter_scribe',
			operations: [{
				op: 'replace',
				path: `/characters/${entityId}/state`,
				value: {
					currentAction: 'Old chapter action', currentLocation: 'Old location', isPresent: true,
					playerSheet: { hitPoints: { current: 10, max: 10 } },
					eventMemory: { did: [`updated from ${id}`] },
				},
			}],
			affectedEntityIds: [entityId],
			metadata: { sourceType: 'chapter_character_context', chapterNumber: 2 },
		});
		const character = (id: string): typeof entities.$inferSelect => ({
			id,
			storyId: 'story_1',
			type: 'character',
			name: id,
			description: null,
			status: 'active',
			visibility: 'player_known',
			state: { currentAction: 'Resting', currentLocation: 'New camp', isPresent: false, playerSheet: { hitPoints: { current: 3, max: 10 } } },
			metadata: {},
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		});
		const eligibleA = chapterProposal('proposal_chapter_a', 'entity_a');
		const eligibleB = chapterProposal('proposal_chapter_b', 'entity_b');
		const ineligible = {
			...chapterProposal('proposal_manual', 'entity_manual'),
			proposedBy: 'llm',
		} satisfies typeof patchProposals.$inferSelect;
		const { db, updateCalls } = createDbMock({
			patchProposalRows: [eligibleA, eligibleB, ineligible],
			sequentialEntityRows: [character('entity_a'), character('entity_b')],
			entryRows: eligibleA.sourceEntryIds.map(id => ({ id, storyId: 'story_1', type: 'narration', content: 'The original chapter events.', metadata: {} } as typeof storyEntries.$inferSelect)),
		});
		dbMocks.getDb.mockReturnValue(db);

		const result = await applyChapterScribeCharacterContextProposals({
			storyId: 'story_1',
			proposalIds: [eligibleA.id, eligibleB.id, ineligible.id],
			reviewer: 'chapter_scribe',
			notes: 'Automatic two-chapter character refresh.',
		});

		expect(result).toMatchObject({
			storyId: 'story_1',
			serverVersion: 2,
			proposalIds: [eligibleA.id, eligibleB.id],
			appliedCount: 2,
			affectedEntityIds: ['entity_a', 'entity_b'],
		});
		expect(updateCalls.filter((call) => call.table === stories)).toHaveLength(1);
		for (const update of updateCalls.filter(call => call.table === entities)) {
			expect(update.value.state).toMatchObject({
				currentAction: 'Resting', currentLocation: 'New camp', isPresent: false,
				playerSheet: { hitPoints: { current: 3, max: 10 } },
				eventMemory: { did: [expect.stringContaining('updated from proposal_chapter_')] },
			});
		}
		const proposalUpdates = updateCalls.filter((call) => call.table === patchProposals);
		expect(proposalUpdates).toHaveLength(2);
		expect(proposalUpdates.map((call) => call.value)).toEqual([
			expect.objectContaining({
				status: 'applied',
				decision: 'approved',
				validatedBy: 'chapter_scribe',
				serverVersion: 2,
				metadata: expect.objectContaining({
					reviewNotes: 'Automatic two-chapter character refresh.',
					reviewedBy: 'chapter_scribe',
				}),
			}),
			expect.objectContaining({
				status: 'applied',
				decision: 'approved',
				validatedBy: 'chapter_scribe',
				serverVersion: 2,
			}),
		]);
		expect(dbMocks.enqueueStoryVaultSyncJob).toHaveBeenCalledTimes(1);
		expect(dbMocks.enqueueBackendJob).toHaveBeenCalledTimes(2);
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

	it.each(['cancelled', 'failed', 'completed', 'blocked'])('does not revive a %s project from an old due proposal', async status => {
		const { db, insertCalls, updateCalls } = createDbMock({ patchProposalRows: [dueFactionProjectProposal],
			projectRows: [{ ...dueProject, status }] });
		dbMocks.getDb.mockReturnValue(db);
		await expect(reviewPatchProposal({ storyId: 'story_1', proposalId: dueFactionProjectProposal.id, decision: 'approved' }))
			.rejects.toThrow(/changed.*audit/i);
		expect(updateCalls.filter(call => call.table === factionProjects)).toEqual([]);
		expect(insertCalls.filter(call => call.table === storyEvents)).toEqual([]);
	});
	it('rejects changed resources and legacy due proposals without a reviewed snapshot', async () => {
		for (const options of [
			{ patchProposalRows: [dueFactionProjectProposal], resourceRows: [{ ...dueResources[0], amount: 1 }] },
			{ patchProposalRows: [{ ...dueFactionProjectProposal, metadata: { sourceType: 'due_faction_project_audit' } }] },
		]) {
			const { db, insertCalls } = createDbMock(options);
			dbMocks.getDb.mockReturnValue(db);
			await expect(reviewPatchProposal({ storyId: 'story_1', proposalId: dueFactionProjectProposal.id, decision: 'approved' }))
				.rejects.toThrow(/changed.*audit/i);
			expect(insertCalls.filter(call => call.table === storyEvents)).toEqual([]);
		}
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
