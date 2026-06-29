import { describe, expect, it } from 'vitest';
import {
	chapterDeleteResponseSchema,
	continuityWarningSchema,
	entityCommandResponseSchema,
	factSchema,
	gmTimelineBriefSchema,
	memoryNodeSchema,
	patchProposalSchema,
	sourceRefSchema,
	npcEventLinkSchema,
	storyEventSchema,
	turnResponseSchema,
} from './memory';

describe('timeline contracts', () => {
	it('accepts legacy memory nodes whose metadata is JSON but not an object', () => {
		const node = memoryNodeSchema.parse({
			id: 'mem_legacy_array_metadata',
			storyId: 'story_1',
			type: 'episodic',
			title: 'Legacy node',
			content: 'A legacy memory node imported with array metadata.',
			keywords: [],
			entityIds: [],
			factionIds: [],
			threadIds: [],
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			metadata: [],
			createdAt: '2026-06-14T00:00:00.000Z',
			updatedAt: '2026-06-14T00:00:00.000Z',
		});

		expect(node.metadata).toEqual([]);
	});

	it('normalizes imported lore memory node types from terminal bootstraps', () => {
		for (const type of ['seed_index', 'source_attribution', 'source_digest']) {
			const node = memoryNodeSchema.parse({
				id: `mem_${type}`,
				storyId: 'story_1',
				type,
				title: 'Imported lore source',
				content: 'Imported lore source details.',
				createdAt: '2026-06-14T00:00:00.000Z',
				updatedAt: '2026-06-14T00:00:00.000Z',
			});

			expect(node.type).toBe('canonical');
		}
	});

	it('normalizes imported lore policy memory nodes from terminal bootstraps', () => {
		const node = memoryNodeSchema.parse({
			id: 'memory_pre296_spoiler_boundary_policy',
			storyId: 'story_1',
			type: 'seed_policy',
			title: 'Pre-296 AC spoiler boundary',
			content: 'Do not use post-cutoff events unless the campaign reaches them organically.',
			createdAt: '2026-06-25T00:00:00.000Z',
			updatedAt: '2026-06-25T00:00:00.000Z',
		});

		expect(node.type).toBe('procedural');
	});

	it('normalizes imported lore events from terminal bootstraps', () => {
		const event = storyEventSchema.parse({
			id: 'event_imported_lore',
			storyId: 'story_1',
			type: 'imported_lore_event',
			title: 'Imported lore event',
			body: 'A lore import event captured from the terminal database.',
			serverVersion: 1,
			createdAt: '2026-06-14T00:00:00.000Z',
			updatedAt: '2026-06-14T00:00:00.000Z',
		});

		expect(event.type).toBe('imported_memory');
	});

	it('parses legacy story events with Task 2 defaults', () => {
		const event = storyEventSchema.parse({
			id: 'event_legacy_raven',
			storyId: 'story_1',
			type: 'rumor',
			title: 'A raven arrives from the coast',
			body: 'A late raven warns that the coastal watch has gone quiet.',
			actorEntityIds: ['npc_watch_captain'],
			targetEntityIds: [],
			locationId: 'loc_coastal_watch',
			threadIds: ['thread_border_alarms'],
			visibility: 'player_known',
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: [],
			metadata: {},
			serverVersion: 3,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(event.status).toBe('committed');
		expect(event.locationIds).toEqual([]);
		expect(event.factionIds).toEqual([]);
		expect(event.createdTurn).toBe(0);
		expect(event.occurredTurn).toBeNull();
		expect(event.scheduledTurn).toBeNull();
		expect(event.worldTime).toBeNull();
		expect(event.memoryImpact).toEqual({});
	});

	it('parses scheduled story events with world time and NPC-visible metadata', () => {
		const event = storyEventSchema.parse({
			id: 'event_marriage_alliance',
			storyId: 'story_1',
			type: 'alliance',
			status: 'scheduled',
			title: 'House Vhalor marriage pact',
			body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
			actorEntityIds: ['npc_vhalor_heir'],
			targetEntityIds: ['npc_maeris_heir'],
			locationId: 'loc_harbor_keep',
			locationIds: ['loc_harbor_keep'],
			factionIds: ['faction_vhalor', 'faction_maeris'],
			threadIds: ['thread_trade_war'],
			visibility: 'secret',
			createdTurn: 4,
			occurredTurn: null,
			scheduledTurn: 6,
			worldTime: '17th day of the 9th moon, 296 AC',
			memoryImpact: { relationship: 'alliance' },
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			metadata: { inWorldDelayTurns: 2 },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(event.status).toBe('scheduled');
		expect(event.scheduledTurn).toBe(6);
		expect(event.factionIds).toEqual(['faction_vhalor', 'faction_maeris']);
	});

	it('parses NPC-event links used as character memory evidence', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_1',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'actor',
			visibility: 'secret',
			evidenceStrength: 0.9,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('actor');
		expect(link.evidenceStrength).toBe(0.9);
	});

	it('defaults optional NPC-event link evidence fields', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_defaults',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('affected');
		expect(link.visibility).toBe('player_known');
		expect(link.evidenceStrength).toBe(0.75);
		expect(link.sourceEntryIds).toEqual([]);
		expect(link.sourcePatchIds).toEqual([]);
	});

	it('parses knowledge-oriented NPC-event links', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_knower',
			storyId: 'story_1',
			eventId: 'event_secret_alliance',
			npcEntityId: 'npc_spymaster',
			role: 'knower',
			visibility: 'secret',
			evidenceStrength: 0.8,
			sourceEntryIds: ['entry_7'],
			sourcePatchIds: ['patch_7'],
			serverVersion: 13,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('knower');
	});

	it('parses compact GM timeline briefs', () => {
		const brief = gmTimelineBriefSchema.parse({
			storyId: 'story_1',
			currentTurn: 6,
			currentWorldTime: '17th day of the 9th moon, 296 AC',
			dueEvents: [{
				id: 'event_marriage_alliance',
				type: 'alliance',
				status: 'due',
				title: 'House Vhalor marriage pact',
				body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
				turnsUntilDue: 0,
				worldTime: '17th day of the 9th moon, 296 AC',
				npcEntityIds: ['npc_vhalor_heir', 'npc_maeris_heir'],
				factionIds: ['faction_vhalor', 'faction_maeris'],
				locationIds: ['loc_harbor_keep'],
				visibility: 'secret',
			}],
			recentEvents: [{
				id: 'event_raven_warning',
				type: 'rumor',
				status: 'committed',
				title: 'Raven warning received',
				body: 'A raven warning reached the harbor keep earlier today.',
				worldTime: '17th day of the 9th moon, 296 AC',
				npcEntityIds: ['npc_watch_captain'],
				factionIds: ['faction_vhalor'],
				locationIds: ['loc_harbor_keep'],
				visibility: 'player_known',
			}],
			scheduledEvents: [],
			npcEvents: [{
				npcEntityId: 'npc_vhalor_heir',
				eventIds: ['event_marriage_alliance'],
				summary: 'House Vhalor marriage pact: the heir knows this marriage changes fleet loyalties.',
				visibility: 'secret',
			}],
		});

		expect(brief.dueEvents[0].turnsUntilDue).toBe(0);
		expect(brief.recentEvents[0].turnsUntilDue).toBeNull();
		expect(brief.npcEvents[0].summary).toContain('fleet loyalties');
		expect(brief.npcEvents[0].eventIds).toEqual(['event_marriage_alliance']);
	});

	it('parses continuity ledger records with provenance and review metadata', () => {
		const sourceRef = sourceRefSchema.parse({
			id: 'sourceref_1',
			storyId: 'story_1',
			sourceType: 'state_patch',
			sourceId: 'patch_1',
			targetTable: 'facts',
			targetRecordId: 'fact_1',
			targetRecordField: 'statement',
			sourceField: 'manual_edit',
			confidence: 0.95,
			rationale: 'Manual review tied the change to a specific patch.',
			notes: 'Checked during merge.',
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});
		const fact = factSchema.parse({
			id: 'fact_1',
			storyId: 'story_1',
			type: 'observation',
			subjectEntityId: 'entity_mara',
			targetEntityId: null,
			title: 'Mara and the black key',
			statement: 'Mara now carries the black key.',
			confidence: 0.9,
			status: 'active',
			visibility: 'player_known',
			firstSeenEntryId: 'entry_1',
			sourceEntryIds: ['entry_1'],
			sourceEventIds: ['event_1'],
			sourcePatchIds: ['patch_1'],
			metadata: { sourceType: 'story_text_example' },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});
		const proposal = patchProposalSchema.parse({
			id: 'proposal_1',
			storyId: 'story_1',
			proposalType: 'fact_upsert',
			targetTable: 'facts',
			targetRecordId: 'fact_1',
			proposedBy: 'narration',
			operations: [{
				op: 'upsert',
				path: '/facts/fact_1',
				value: { id: 'fact_1', statement: 'Mara now carries the black key.' },
			}],
			reason: 'Narration states that Mara now carries the black key.',
			suggestion: 'Merge after review.',
			status: 'pending',
			decision: null,
			validatedBy: null,
			affectedEntityIds: ['entity_mara'],
			confidence: 0.9,
			sourceEntryIds: ['entry_1'],
			sourceEventIds: ['event_1'],
			sourcePatchIds: ['patch_1'],
			metadata: { sourceType: 'story_text_example' },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});
		const warning = continuityWarningSchema.parse({
			id: 'warning_1',
			storyId: 'story_1',
			warningType: 'turn_extraction',
			level: 'warning',
			title: 'Skipped relationship update',
			status: 'open',
			details: 'Skipped relationship because the target entity was missing.',
			entityIds: ['entity_mara'],
			factionIds: [],
			threadIds: [],
			actorIds: [],
			sourceEntryIds: ['entry_1'],
			sourceEventIds: ['event_1'],
			sourcePatchIds: ['patch_1'],
			resolutionNotes: null,
			resolvedBy: null,
			resolvedAt: null,
			metadata: { sourceType: 'story_text_example' },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(sourceRef.targetRecordField).toBe('statement');
		expect(fact.statement).toBe('Mara now carries the black key.');
		expect(proposal.affectedEntityIds).toEqual(['entity_mara']);
		expect(warning.level).toBe('warning');
	});

	it('rejects invalid story event statuses', () => {
		expect(() => storyEventSchema.parse({
			id: 'event_bad_status',
			storyId: 'story_1',
			type: 'rumor',
			status: 'archived',
			title: 'Bad status',
			body: 'This event should not parse.',
			actorEntityIds: [],
			targetEntityIds: [],
			locationId: null,
			threadIds: [],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});

	it('rejects invalid NPC-event link roles', () => {
		expect(() => npcEventLinkSchema.parse({
			id: 'npc_event_link_bad_role',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'instigator',
			visibility: 'secret',
			evidenceStrength: 0.9,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});

	it.each([-0.1, 1.1])('rejects out-of-range NPC-event evidence strength %s', (evidenceStrength) => {
		expect(() => npcEventLinkSchema.parse({
			id: `npc_event_link_bad_evidence_${evidenceStrength}`,
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'witness',
			visibility: 'secret',
			evidenceStrength,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});

	it('keeps compact turn performance diagnostics in backend turn responses', () => {
		const parsed = turnResponseSchema.parse({
			narration: 'The court falls silent.',
			entries: [],
			statePatchIds: [],
			eventIds: [],
			retrievedMemoryIds: [],
			serverVersion: 7,
			syncChanges: [],
			performance: {
				preparedCacheHit: true,
				prompt: {
					tokenEstimate: 1200,
					totalChars: 4800,
					messageCount: 8,
				},
				cache: {
					hitCount: 3,
					missCount: 1,
					tokenEstimate: 2400,
					segmentCount: 4,
				},
				generation: {
					operationCount: 1,
					durationMs: 900,
					requestTokens: 1000,
					responseTokens: 120,
					totalTokens: 1120,
				},
				slowTimings: [
					{ operation: 'turn.context_assembly', durationMs: 410 },
				],
			},
		});

		expect(parsed.performance).toEqual({
			preparedCacheHit: true,
			prompt: {
				tokenEstimate: 1200,
				totalChars: 4800,
				messageCount: 8,
			},
			cache: {
				hitCount: 3,
				missCount: 1,
				tokenEstimate: 2400,
				segmentCount: 4,
			},
			generation: {
				operationCount: 1,
				durationMs: 900,
				requestTokens: 1000,
				responseTokens: 120,
				totalTokens: 1120,
			},
			waterfall: {},
			topSpans: [],
			slowTimings: [
				{ operation: 'turn.context_assembly', durationMs: 410 },
			],
		});
	});

	it('keeps continuity and unresolved-reference counts in backend context receipts', () => {
		const parsed = turnResponseSchema.parse({
			narration: 'The court falls silent.',
			entries: [],
			statePatchIds: [],
			eventIds: [],
			retrievedMemoryIds: [],
			serverVersion: 7,
			syncChanges: [],
			contextReceipt: {
				turnId: 'turn_1',
				storyId: 'story_alpha',
				truncated: true,
				included: {
					recentEntries: 12,
					memoryNodes: 4,
					wikiChunks: 2,
					timelineEvents: 3,
					chapters: 4,
					arcs: 2,
					chaptersSuppressedByArcs: 9,
					chaptersSent: 4,
					arcsSent: 2,
					chaptersSuppressedByArc: 9,
					memoryNodesSent: 4,
					totalChars: 4800,
					totalTokens: 1120,
					facts: 5,
					patchProposals: 7,
					unresolvedCharacterReferences: 2,
					continuityWarnings: 1,
					factionSheets: ['faction_watch'],
				},
				skipped: [
					{ source: 'dynamic_context', reason: 'truncated_by_context_budget' },
				],
				unresolvedCharacterReferences: [
					{
						proposalId: 'proposal_hooded_envoy',
						name: 'Hooded Envoy',
						contextLabel: 'faction_member/Red Sails',
						reason: 'Faction member named in "Red Sails".',
						sourceEntryIds: ['entry_12'],
					},
				],
				continuityLedger: {
					facts: [
						{
							id: 'fact_red_sails_oath',
							statement: 'The Red Sails swore to blockade the harbor.',
							sourceEntryIds: ['entry_10'],
							sourcePatchIds: ['patch_fact_1'],
						},
					],
					patchProposals: [
						{
							id: 'proposal_harbor_blockade',
							status: 'pending',
							proposalType: 'turn_event',
							targetTable: 'events',
							targetRecordId: 'event_harbor_blockade',
							reason: 'Narration introduced a delayed blockade consequence.',
							sourceEntryIds: ['entry_11'],
							sourcePatchIds: ['patch_event_1'],
						},
					],
					warnings: [
						{
							id: 'warning_timeline_overlap',
							level: 'warning',
							status: 'open',
							title: 'Timeline overlap',
							sourceEntryIds: ['entry_12'],
							sourcePatchIds: ['patch_warning_1'],
						},
					],
				},
				cacheSegments: [
					{
						kind: 'prompt_system',
						cacheKey: 'engine-cache:story-alpha:prompt_system:stable',
						contentHash: 'hash-system',
						hit: true,
						invalidated: false,
						tokenEstimate: 640,
						dependencyCount: 2,
					},
				],
				budgets: {
					memoryTokensUsed: 1800,
					memoryTokensMax: 2400,
					wikiCharsUsed: 1200,
					wikiCharsMax: 6000,
				},
			},
		});

		expect(parsed.contextReceipt?.included).toMatchObject({
			facts: 5,
			chapters: 4,
			arcs: 2,
			chaptersSuppressedByArcs: 9,
			chaptersSent: 4,
			arcsSent: 2,
			chaptersSuppressedByArc: 9,
			memoryNodesSent: 4,
			totalChars: 4800,
			totalTokens: 1120,
			patchProposals: 7,
			unresolvedCharacterReferences: 2,
			continuityWarnings: 1,
		});
		expect(parsed.contextReceipt?.skipped).toEqual([
			{ source: 'dynamic_context', reason: 'truncated_by_context_budget' },
		]);
		expect(parsed.contextReceipt?.unresolvedCharacterReferences).toEqual([
			{
				proposalId: 'proposal_hooded_envoy',
				name: 'Hooded Envoy',
				contextLabel: 'faction_member/Red Sails',
				reason: 'Faction member named in "Red Sails".',
				sourceEntryIds: ['entry_12'],
			},
		]);
		expect(parsed.contextReceipt?.continuityLedger).toEqual({
			facts: [
				{
					id: 'fact_red_sails_oath',
					statement: 'The Red Sails swore to blockade the harbor.',
					sourceEntryIds: ['entry_10'],
					sourcePatchIds: ['patch_fact_1'],
				},
			],
			patchProposals: [
				{
					id: 'proposal_harbor_blockade',
					status: 'pending',
					proposalType: 'turn_event',
					targetTable: 'events',
					targetRecordId: 'event_harbor_blockade',
					reason: 'Narration introduced a delayed blockade consequence.',
					sourceEntryIds: ['entry_11'],
					sourcePatchIds: ['patch_event_1'],
				},
			],
			warnings: [
				{
					id: 'warning_timeline_overlap',
					level: 'warning',
					status: 'open',
					title: 'Timeline overlap',
					sourceEntryIds: ['entry_12'],
					sourcePatchIds: ['patch_warning_1'],
				},
			],
		});
		expect(parsed.contextReceipt?.cacheSegments).toEqual([
			{
				kind: 'prompt_system',
				cacheKey: 'engine-cache:story-alpha:prompt_system:stable',
				contentHash: 'hash-system',
				hit: true,
				invalidated: false,
				tokenEstimate: 640,
				dependencyCount: 2,
			},
		]);
	});
});

describe('entity command contracts', () => {
	it('preserves resolved character reference diagnostics when explicit character writes close review proposals', () => {
		const parsed = entityCommandResponseSchema.parse({
			storyId: 'story_1',
			serverVersion: 12,
			entity: { id: 'entity_ser_olyvar', type: 'character', name: 'Ser Olyvar' },
			resolvedCharacterReferences: [
				{ proposalId: 'proposal_ser_olyvar', name: 'Ser Olyvar', entityId: 'entity_ser_olyvar' },
			],
		});

		expect(parsed.resolvedCharacterReferences).toEqual([
			{ proposalId: 'proposal_ser_olyvar', name: 'Ser Olyvar', entityId: 'entity_ser_olyvar' },
		]);
	});
});

describe('chapter delete contracts', () => {
	it('preserves the arcs unwrapped by terminal chapter deletion', () => {
		const parsed = chapterDeleteResponseSchema.parse({
			storyId: 'story_1',
			serverVersion: 12,
			chapterId: 'chapter_1',
			deleted: true,
			unwrappedArcIds: ['arc_1'],
			unwrappedArcs: [
				{ id: 'arc_1', chapterIds: ['chapter_2'] },
			],
		});

		expect(parsed.unwrappedArcIds).toEqual(['arc_1']);
		expect(parsed.unwrappedArcs).toEqual([
			{ id: 'arc_1', chapterIds: ['chapter_2'] },
		]);
	});
});
