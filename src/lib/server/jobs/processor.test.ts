import { describe, expect, it, vi } from 'vitest';
import * as summaryGeneration from './summaryGeneration';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { backendJobTypes, shouldQueueTurnStoryVaultSync, turnStateExtractionDedupeKey, turnStateSourceFingerprint } from './outbox';
import { selectStoryMemory } from '$lib/services/ai/context/storyMemorySelector';
import { eligibleFactionMoveVariants } from '$lib/server/factions/autonomy';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import {
	backendJobStatusEventData,
	backendJobManualClaimWhere,
	buildDeferredStateExtractionPrompt,
	buildFactionMovePlan,
	chooseFactionTarget,
	canonicalFactionIdentity,
	deferredExtractionAppliedReceipt,
	deferredExtractionTerminalReceiptStatus,
	deferredExtractionSourcePairError,
	deferredExtractionStoryLockSql,
	factionMoveWakesPlotDirector,
	factionCanReceiveCharacterTagSync,
	hasCurrentStoryFactionSimulationMetadata,
	factionProjectIsReady,
	factionCanStartAutonomousProject,
	factionProjectPausesAmbient,
	factionIsOperational,
	factionIsCurrentEra,
	repeatsFactionMove,
	inferFactionDoctrine,
	isWorldSimEligibleFaction,
	isExplicitDynasticParticipant,
	selectFactionWorldTickCandidates,
	buildArcMemoryFields,
	buildArcSummary,
	buildSagaMemoryFields,
	buildEventMemoryNodeValues,
	chapterCharacterContextPatch,
	chapterCharacterContextProposalValues,
	chapterCharacterNamesMatch,
	chapterCharacterSummaryContextPatch,
	chapterMemoryEntityIds,
	buildChapterMemoryDigest,
	buildChapterSummary,
	isNarrativeChapterEvent,
	canonicalArcOpenThreadIds,
	classifyBackendJobFailure,
	chapterCharacterReferenceCandidates,
	refreshChapterCharacterContextProposalValues,
	refreshChapterCharacterReferenceEvidence,
	replaceCharacterContextOperationState,
	isSupersededJobFailure,
	plotBrainJobIsSuperseded,
	plotBrainJobSkipReason,
	preserveDurableDeferredState,
	projectionFingerprint,
	projectionSourceEntriesMatch,
	projectionSourceEventsMatch,
	stableId,
	worldTickEventId,
	selectArcRollupBatches,
	renderSagaSummary,
	sagaSourceForArc,
	selectSagaRollupBatches,
	SAGA_ROLLUP_ARCS,
	shouldAutoApplyChapterCharacterContext,
	shouldProjectEventToMemory,
	stalePlotBrainPendingFrameId,
	storyVaultFollowupVersion,
	summarizeBackendJobs,
	summarizeChapterMemoryWithLlm,
	summarizeMemoryStageFreshness,
} from './processor';

function compiledSql(value: SQL) {
	return new PgDialect().sqlToQuery(value);
}

describe('projection source revalidation', () => {
	it('accepts the loaded source snapshot and rejects changed or missing evidence', () => {
		const entries = [{ id: 'entry_1', position: 1, content: 'The gate opens.', serverVersion: 4 }];
		expect(projectionSourceEntriesMatch(entries, [...entries])).toBe(true);
		expect(projectionSourceEntriesMatch(entries, [{ ...entries[0], content: 'The gate stays closed.' }])).toBe(false);
		expect(projectionSourceEntriesMatch(entries, [])).toBe(false);

		const events = [{ id: 'event_1', status: 'committed', title: 'Gate opened', body: 'The gate opens.', sourceEntryIds: ['entry_1'], serverVersion: 4 }];
		expect(projectionSourceEventsMatch(events, [...events])).toBe(true);
		expect(projectionSourceEventsMatch(events, [{ ...events[0], sourceEntryIds: ['entry_2'] }])).toBe(false);
		expect(projectionSourceEventsMatch(events, [])).toBe(false);
	});
});

describe('recurring NPC candidate evidence', () => {
	it('accumulates chapter sources without replacing edited draft fields or forgetting its first chapter', () => {
		const evidence = refreshChapterCharacterReferenceEvidence({
			proposal: { sourceEntryIds: ['entry_1'], sourceEventIds: ['event_1'], confidence: 0.82, metadata: { chapterId: 'chapter_1', sourceName: 'Mara', sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio', quote: 'Reviewed proof.' }] } } },
			sourceEntryIds: ['entry_1', 'entry_9'], sourceEventIds: ['event_9'], chapterId: 'chapter_3', chapterNumber: 3, confidence: 0.72,
		});
		expect(evidence).toEqual({ sourceEntryIds: ['entry_1', 'entry_9'], sourceEventIds: ['event_1', 'event_9'], confidence: 0.82, metadata: { chapterId: 'chapter_1', sourceName: 'Mara', sourceChapterIds: ['chapter_1', 'chapter_3'], latestChapterId: 'chapter_3', latestChapterNumber: 3, sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio', quote: 'Reviewed proof.' }] } } });
		expect(evidence).not.toHaveProperty('operations');
		expect(evidence).not.toHaveProperty('status');
	});
});

describe('manual background job claims', () => {
	it('atomically claims only due, unlocked, runnable jobs below their attempt limit', () => {
		const claimedAt = '2026-08-31T21:30:00.000Z';
		const guard = compiledSql(backendJobManualClaimWhere('job_1', claimedAt));

		expect(guard.sql).toContain('"backend_jobs"."id" =');
		expect(guard.sql).toContain('"backend_jobs"."status" in');
		expect(guard.sql).toContain('"backend_jobs"."run_after" <=');
		expect(guard.sql).toContain('"backend_jobs"."attempt_count" < "backend_jobs"."max_attempts"');
		expect(guard.sql).toContain('"backend_jobs"."locked_at" is null');
		expect(guard.sql).toContain('"backend_jobs"."locked_by" is null');
		expect(guard.params).toEqual(['job_1', 'queued', 'retry', claimedAt]);
	});
});

describe('deferred extraction receipt outcomes', () => {
	it('preserves truthful terminal status for skipped and idempotently completed outcomes', () => {
		expect(deferredExtractionTerminalReceiptStatus({ status: 'skipped_source_invalid' })).toBe('skipped');
		expect(deferredExtractionTerminalReceiptStatus({ status: 'classifier_disabled' })).toBe('skipped');
		expect(deferredExtractionTerminalReceiptStatus({ status: 'no_changes' })).toBe('succeeded');
		expect(deferredExtractionTerminalReceiptStatus({ status: 'already_applied' })).toBe('succeeded');
		expect(deferredExtractionTerminalReceiptStatus({ status: 'applied' })).toBe('succeeded');
	});
});

describe('faction world ticks', () => {
	it('keeps passive lore taxonomy out of the background faction simulator', () => {
		const loreOnly = { goals: [], memberEntityIds: [], territoryIds: [], metadata: { originalState: { type: 'faction' } } } as any;
		expect(factionIsOperational(loreOnly)).toBe(false);
		expect(factionIsOperational({ ...loreOnly, goals: ['protect the river trade'] })).toBe(true);
		expect(factionIsOperational({ ...loreOnly, pressure: 1 })).toBe(true);
		expect(factionIsOperational(loreOnly, true)).toBe(true);
	});

	it('wakes Plot Director only for major faction shocks or completed autonomous projects', () => {
		expect(factionMoveWakesPlotDirector({ urgency: 'medium' })).toBe(false);
		expect(factionMoveWakesPlotDirector({ urgency: 'high' })).toBe(true);
		expect(factionMoveWakesPlotDirector({ urgency: 'critical' })).toBe(true);
		expect(factionMoveWakesPlotDirector({ urgency: 'low', autonomousProjectCompleted: true })).toBe(true);
		expect(factionMoveWakesPlotDirector({ urgency: 'low', autonomousProjectCompleted: false })).toBe(false);
	});

	it('repairs existing tagged factions that lack active-story simulation metadata', () => {
		expect(hasCurrentStoryFactionSimulationMetadata({ currentStoryEvidence: true, worldSimEnabled: true, worldSimPromoted: true, factionType: 'feudal_house' })).toBe(true);
		expect(hasCurrentStoryFactionSimulationMetadata({ currentStoryEvidence: true, worldSimEnabled: true, factionType: 'feudal_house' })).toBe(false);
		expect(hasCurrentStoryFactionSimulationMetadata({ worldSimEnabled: true, factionType: 'feudal_house' })).toBe(false);
		expect(hasCurrentStoryFactionSimulationMetadata({ currentStoryEvidence: true, worldSimEnabled: true })).toBe(false);
	});

	it('keeps imported scratch-lore factions searchable but out of world simulation until explicitly promoted', () => {
		const scratchFaction = {
			id: 'veil_scratch_faction_house_x',
			entityId: 'scratch_entity',
			metadata: { scratchSeed: true, veilFoundationImport: true },
			status: 'active',
		} as any;
		const scratchEntity = {
			id: 'scratch_entity',
			status: 'active',
			state: {},
			metadata: { scratchSeed: true },
		} as any;
		const entityById = new Map([['scratch_entity', scratchEntity]]);
		expect(factionCanReceiveCharacterTagSync(scratchFaction)).toBe(false);
		expect(factionCanReceiveCharacterTagSync({ id: 'faction_tag_story_house_x', metadata: { sourceType: 'character_faction_tag' } } as any)).toBe(true);
		expect(factionIsCurrentEra(scratchFaction, entityById)).toBe(false);
		expect(factionIsCurrentEra({
			...scratchFaction,
			metadata: {
				...scratchFaction.metadata,
				currentStoryEvidence: true,
				worldSimEnabled: true,
				worldSimPromoted: true,
				factionType: 'feudal_house',
			},
		}, entityById)).toBe(true);
	});

	it('keeps role and culture tag factions passive until an explicit promotion', () => {
		const generated = {
			id: 'faction_tag_story_valyrian',
			status: 'active',
			metadata: {
				sourceType: 'character_faction_tag',
				currentStoryEvidence: true,
				worldSimEnabled: true,
				factionType: 'culture',
			},
		};
		expect(isWorldSimEligibleFaction(generated)).toBe(false);
		expect(isWorldSimEligibleFaction({ id: 'faction_tag_story_old_blood', metadata: { worldSimEnabled: true } })).toBe(false);
		expect(isWorldSimEligibleFaction({
			...generated,
			metadata: { ...generated.metadata, worldSimPromoted: true },
		})).toBe(true);
	});

	it('resolves linked and merged faction rows to one canonical simulation identity', () => {
		expect(canonicalFactionIdentity({
			id: 'faction_tag_house_belaerys',
			metadata: { canonicalFactionId: 'faction_house_belaerys' },
		})).toBe('faction_house_belaerys');
		expect(canonicalFactionIdentity({
			id: 'faction_alias',
			metadata: {},
		}, {
			state: { linkedFactionId: 'faction_house_belaerys' },
		})).toBe('faction_house_belaerys');
	});

	it('turns pressure into a concrete project step and delayed public signal', () => {
		const plan = buildFactionMovePlan({
			factionName: 'Ash Court',
			pressure: 82,
			goal: { goal: 'control the river trade' },
			project: { id: 'project_embargo', project: 'establish a covert embargo', progress: 0.4 },
		});

		expect(plan.action).toContain('establish a covert embargo');
		expect(plan.motivation).toBe('control the river trade');
		expect(plan.urgency).toBe('high');
		expect(plan.delayTurns).toBe(2);
		expect(plan.projectProgressAfter).toBeCloseTo(0.58);
		expect(plan.publicSignal).not.toContain('covert embargo');
	});

	it('gives successive low-pressure project advances distinct retry-stable event IDs', () => {
		let progress = 0.1;
		const ids: string[] = [];
		for (let turn = 12; turn <= 48; turn += 4) {
			const plan = buildFactionMovePlan({
				factionId: 'ash_court', factionName: 'Ash Court', pressure: 0, currentTurn: turn,
				project: { id: 'river_project', project: 'Secure the river route', progress },
			});
			const input = { storyId: 'story', factionId: 'ash_court', currentTurn: turn,
				pressureBand: 0, jevEnabled: false, projectOrGoalId: 'river_project', plan };
			const eventId = worldTickEventId(input);
			expect(worldTickEventId(input)).toBe(eventId);
			ids.push(eventId);
			progress = plan.projectProgressAfter!;
		}
		expect(new Set(ids).size).toBe(ids.length);
		expect(progress).toBe(1);
	});
	it('prefers a goal-linked or recently affected faction over arbitrary rotation', () => {
		type Faction = Parameters<typeof chooseFactionTarget>[0]['faction'];
		const faction = (id: string, name: string) => ({ id, name, status: 'active', metadata: {},
			entityId: null, allies: [], enemies: [], territoryIds: [] }) as unknown as Faction;
		const ash = faction('ash', 'Ash Court');
		const blue = faction('blue', 'Blue Harbor');
		const red = faction('red', 'Red House');
		const base = { faction: ash, factionKind: 'generic' as const, factions: [blue, red],
			doctrineByFactionId: new Map(), entityById: new Map(), currentTurn: 12 };
		expect(chooseFactionTarget({ ...base, goalText: 'secure a treaty with Red House' })?.id).toBe('red');
		expect(chooseFactionTarget({ ...base, recentEvents: [{ id: 'public_move', factionIds: ['ash', 'blue'], visibility: 'player_known', status: 'committed' }] })?.id).toBe('blue');
		expect(chooseFactionTarget({ ...base, goalText: 'treaty' })).toBeNull();
		expect(chooseFactionTarget({ ...base, goalText: 'treaty', recentEvents: [{ id: 'hidden_move', factionIds: ['ash', 'blue'], visibility: 'secret', status: 'committed' }] })).toBeNull();
		expect(chooseFactionTarget({ ...base, goalText: 'treaty', recentEvents: [{ id: 'distant_move', factionIds: ['distant', 'red'], visibility: 'player_known', status: 'committed' }] })).toBeNull();
		expect(chooseFactionTarget({ ...base, preferredFactionId: 'red' })?.id).toBe('red');
	});
	it('does not reissue the same unsupported faction move as a new event', () => {
		const plan = { action: 'Pureborn recruits observers around House Tyrell.', projectId: null, targetFactionIds: ['tyrell'] };
		const prior = { metadata: { sourceType: 'terminal_world_sim_tick', factionId: 'pureborn',
			action: plan.action, projectId: null, targetFactionIds: ['tyrell'] } };
		expect(repeatsFactionMove(plan, 'pureborn', {}, [prior] as never)).toBe(true);
		expect(repeatsFactionMove({ ...plan, targetFactionIds: ['spicers'] }, 'pureborn', {}, [prior] as never)).toBe(false);
		expect(repeatsFactionMove(plan, 'spicers', {}, [prior] as never)).toBe(false);
		expect(repeatsFactionMove({ ...plan, projectId: 'active_project' }, 'pureborn', {}, [prior] as never)).toBe(false);
	});
	it('keeps a targetless faction move inside its own organization', () => {
		expect(eligibleFactionMoveVariants('commercial', false, false)).toEqual([{ actionType: 'internal', projectKind: null }]);
		const plan = buildFactionMovePlan({ factionName: 'Spicers', factionKind: 'commercial', pressure: 16,
			goal: { goal: 'Improve influence over commerce and civic decisions' }, allowProjectStart: false,
			variant: { actionType: 'intelligence', projectKind: null } });
		expect(plan.actionType).toBe('internal');
		expect(plan.action).toContain('Spicers reorganizes personnel and resources');
		expect(plan.action).not.toContain('useful counterpart');
		expect(plan.targetFactionIds).toEqual([]);
	});

	it('classifies faction doctrine from explicit metadata before conservative name inference', () => {
		expect(inferFactionDoctrine({ name: 'The Black Ledger', metadata: { factionType: 'merchant guild' } })).toBe('commercial');
		expect(inferFactionDoctrine({ name: 'The Veiled Hand', metadata: { archetype: 'spy network' } })).toBe('intrigue_network');
		expect(inferFactionDoctrine({ name: 'House Martell' })).toBe('feudal_house');
		expect(inferFactionDoctrine({ name: 'The Seven', entityDescription: 'A dominant organized faith.' })).toBe('faith');
	});

	it('lets a feudal house open a typed marriage project without making the match immediately binding', () => {
		const plan = buildFactionMovePlan({
			factionId: 'house_red',
			factionName: 'House Red',
			factionKind: 'feudal_house',
			pressure: 0,
			currentTurn: 12,
			fallbackGoals: ['secure a dynastic marriage'],
			targetFaction: { id: 'house_blue', name: 'House Blue' },
			participantPair: {
				subjectEntityId: 'red_heir',
				subjectName: 'Rhea Red',
				targetEntityId: 'blue_heir',
				targetName: 'Beren Blue',
			},
		});

		expect(plan.actionType).toBe('dynastic');
		expect(plan.projectKind).toBe('marriage_negotiation');
		expect(plan.action).toContain('Rhea Red');
		expect(plan.startProject?.targetFactionId).toBe('house_blue');
		expect(plan.projectProgressAfter).toBe(0.1);
	});

	it('keeps long world-tick and project ids distinct across turns and targets', () => {
		const longFactionId = `faction_${'dragonstone_lineage_'.repeat(12)}`;
		expect(stableId('event_world_tick', ['story', longFactionId, 'goal', '0', '12']))
			.not.toBe(stableId('event_world_tick', ['story', longFactionId, 'goal', '0', '13']));

		const first = buildFactionMovePlan({
			factionId: longFactionId,
			factionName: 'House Longname',
			factionKind: 'feudal_house',
			pressure: 0,
			currentTurn: 12,
			fallbackGoals: ['secure a dynastic marriage'],
			targetFaction: { id: `target_${'red_'.repeat(30)}`, name: 'House Red' },
		});
		const second = buildFactionMovePlan({
			factionId: longFactionId,
			factionName: 'House Longname',
			factionKind: 'feudal_house',
			pressure: 0,
			currentTurn: 13,
			fallbackGoals: ['secure a dynastic marriage'],
			targetFaction: { id: `target_${'blue_'.repeat(30)}`, name: 'House Blue' },
		});
		expect(first.startProject?.id).not.toBe(second.startProject?.id);
	});

	it('fingerprints projection inputs deterministically and changes when source evidence changes', () => {
		const first = projectionFingerprint({ compiler: 'chapter-projection-v1', sourceEntryIds: ['entry_1'], summary: 'A' });
		const same = projectionFingerprint({ compiler: 'chapter-projection-v1', sourceEntryIds: ['entry_1'], summary: 'A' });
		const changed = projectionFingerprint({ compiler: 'chapter-projection-v1', sourceEntryIds: ['entry_1'], summary: 'B' });
		expect(first).toMatch(/^[a-f0-9]{32}$/);
		expect(same).toBe(first);
		expect(changed).not.toBe(first);
	});

	it('stops an unverified marriage project short of irreversible completion', () => {
		const plan = buildFactionMovePlan({
			factionName: 'House Red',
			factionKind: 'feudal_house',
			pressure: 90,
			currentTurn: 20,
			targetFaction: { id: 'house_blue', name: 'House Blue' },
			project: {
				id: 'marriage_project',
				project: 'Negotiate a dynastic marriage with House Blue',
				progress: 0.85,
				metadata: { actionType: 'dynastic', projectKind: 'marriage_negotiation' },
			},
		});

		expect(plan.projectProgressAfter).toBe(0.9);
		expect(plan.consequences.join(' ')).toContain('No binding match');
	});

	it('advances a ready project without pressure and otherwise rotates one quiet faction', () => {
		const factions = [
			{ id: 'a', name: 'House A', pressure: 0, metadata: {} },
			{ id: 'b', name: 'House B', pressure: 0, metadata: {} },
			{ id: 'c', name: 'House C', pressure: 0, metadata: {} },
		];
		expect(selectFactionWorldTickCandidates({
			factions,
			minimumPressure: 70,
			readyProjectFactionIds: new Set(['b']),
			allowAmbient: false,
			currentTurn: 9,
		})).toEqual([factions[1]]);
		expect(selectFactionWorldTickCandidates({
			factions,
			minimumPressure: 70,
			allowAmbient: true,
			currentTurn: 9,
			rotationKey: 'story',
		})).toHaveLength(1);
		expect(selectFactionWorldTickCandidates({
			factions: factions.map((faction, index) => ({ ...faction, pressure: index * 10 })),
			minimumPressure: 70,
			allowAmbient: true,
			currentTurn: 10,
		})).toMatchObject([{ id: 'c', pressure: 20 }]);
		expect(selectFactionWorldTickCandidates({
			factions: [{ ...factions[0], pressure: 58, metadata: { lastWorldSimTickTurn: 8 } },
				{ ...factions[1], pressure: 16 }],
			minimumPressure: 70, allowAmbient: true, currentTurn: 10,
		})).toMatchObject([{ id: 'b' }]);
		expect(selectFactionWorldTickCandidates({
			factions: [{ ...factions[0], pressure: 58, metadata: { lastWorldSimTickTurn: 8 } },
				{ ...factions[1], pressure: 16 }],
			minimumPressure: 50, allowAmbient: true, currentTurn: 10,
		})).toMatchObject([{ id: 'b' }]);
	});

	it('prioritizes active-story factions for ambient turns', () => {
		const factions = [
			{ id: 'lore', name: 'Ancient Lore House', pressure: 0, metadata: {} },
			{ id: 'current', name: 'Current House', pressure: 0, metadata: { currentStoryEvidence: true } },
		];
		expect(selectFactionWorldTickCandidates({
			factions,
			minimumPressure: 70,
			allowAmbient: true,
			currentTurn: 10,
			rotationKey: 'story',
		})).toEqual([factions[1]]);
	});

	it('auto-advances only active autonomous projects that are due', () => {
		const base = {
			status: 'active',
			dueTurn: 9,
			metadata: { sourceType: 'autonomous_faction_project', nextActionTurn: 9 },
		} as any;
		expect(factionProjectIsReady(base, 9)).toBe(true);
		expect(factionProjectIsReady({ ...base, status: 'planned' }, 9)).toBe(false);
		expect(factionProjectIsReady({ ...base, metadata: {} }, 9)).toBe(false);
		expect(factionProjectIsReady({ ...base, metadata: { worldSimEnabled: true } }, 9)).toBe(true);
		expect(factionProjectIsReady({ ...base, metadata: { sourceType: 'autonomous_faction_project', nextActionTurn: 10 } }, 9)).toBe(false);
		expect(factionProjectPausesAmbient({ ...base, metadata: { sourceType: 'autonomous_faction_project', nextActionTurn: 10 } }, 9)).toBe(true);
		expect(factionProjectPausesAmbient({ ...base, metadata: {} }, 9)).toBe(false);
	});

	it('requires explicit adult, alive, active-era, unmarried, non-player kinship evidence', () => {
		const membership = { role: 'daughter', metadata: { activeEra: true, maritalStatus: 'unmarried' } };
		const entity = { status: 'active', state: { adult: true, lifeStatus: 'alive', relationship: { status: 'neutral' } }, metadata: {} };
		expect(isExplicitDynasticParticipant({ membership, entity })).toBe(true);
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, state: { ...entity.state, relationship: { status: 'self' } } } })).toBe(false);
		expect(isExplicitDynasticParticipant({ membership: { ...membership, metadata: { activeEra: true } }, entity })).toBe(false);
	});

	it('lets any explicit dynastic disqualifier override stale positive metadata', () => {
		const membership = {
			role: 'daughter',
			metadata: { adult: true, age: 24, activeEra: true, lifeStatus: 'alive', maritalStatus: 'unmarried' },
		};
		const entity = { status: 'active', state: {}, metadata: {} };
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, state: { age: 16 } } })).toBe(false);
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, state: { activeEra: false } } })).toBe(false);
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, state: { lifeStatus: 'dead' } } })).toBe(false);
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, state: { maritalStatus: 'married' } } })).toBe(false);
		expect(isExplicitDynasticParticipant({ membership, entity: { ...entity, status: 'archived' } })).toBe(false);
	});

	it.each([
		{ state: { relationship: 'self' }, metadata: {} },
		{ state: { relationship: { status: 'player_character' } }, metadata: {} },
		{ state: { isProtagonist: true }, metadata: {} },
		{ state: { currentDisposition: 'self' }, metadata: {} },
		{ state: { playerPrompt: 'You are this character.' }, metadata: {} },
		{ state: {}, metadata: { relationship: 'player_character' } },
		{ state: {}, metadata: { playerPrompt: 'Player-controlled.' } },
		{ state: {}, metadata: { originalMetadata: { relationship: 'self' } } },
	])('never selects a player character as a dynastic participant: %#', ({ state, metadata }) => {
		const membership = { role: 'daughter', metadata: { activeEra: true, maritalStatus: 'unmarried' } };
		const entity = {
			status: 'active',
			state: { adult: true, lifeStatus: 'alive', ...state },
			metadata,
		};
		expect(isExplicitDynasticParticipant({ membership, entity })).toBe(false);
	});
});

describe('turn state extraction jobs', () => {
	it('short-circuits stale-lock retries from the transactionally stored apply receipt', () => {
		const receipt = {
			assistantEntryId: 'entry_assistant',
			serverVersion: 42,
			operationCount: 3,
			suppressedTransientState: true,
			noChanges: false,
			eventIds: ['event_offer'],
			patchIds: ['patch_offer'],
			memoryNodeIds: [],
			warnings: ['durable facts preserved'],
			appliedAt: '2026-08-31T22:00:00.000Z',
		};
		const job = {
			payload: { assistantEntryId: 'entry_assistant' },
			metadata: { deferredExtractionApplyReceipt: receipt },
		};

		expect(deferredExtractionAppliedReceipt(job as any)).toEqual(receipt);
		expect(deferredExtractionAppliedReceipt({
			...job,
			payload: { assistantEntryId: 'replacement_entry' },
		} as any)).toBeNull();
	});

	it('does not reuse an apply receipt when a repaired source revision has changed', () => {
		const receipt = {
			assistantEntryId: 'entry_assistant',
			serverVersion: 42,
			operationCount: 1,
			suppressedTransientState: false,
			noChanges: false,
			eventIds: [],
			patchIds: ['patch_1'],
			memoryNodeIds: [],
			warnings: [],
			appliedAt: '2026-08-31T22:00:00.000Z',
			sourceFingerprint: turnStateSourceFingerprint('old action', 'old narration'),
		};

		expect(deferredExtractionAppliedReceipt({
			payload: { assistantEntryId: 'entry_assistant', sourceFingerprint: turnStateSourceFingerprint('new action', 'new narration') },
			metadata: { deferredExtractionApplyReceipt: receipt },
		} as any)).toBeNull();
		expect(deferredExtractionAppliedReceipt({
			payload: { assistantEntryId: 'entry_assistant', sourceFingerprint: receipt.sourceFingerprint },
			metadata: { deferredExtractionApplyReceipt: receipt },
		} as any)).toEqual(receipt);
	});

	it('uses the story-entry advisory lock for the final extraction recheck and apply', () => {
		const lock = compiledSql(deferredExtractionStoryLockSql('story_1'));

		expect(lock.sql).toContain('pg_advisory_xact_lock');
		expect(lock.sql).toContain('hashtextextended');
		expect(lock.params).toEqual(['mtherios:story-entry:story_1']);
	});

	it('exposes a stable background job type and dedupe key', () => {
		expect(backendJobTypes).toContain('extract_turn_state');
		expect(turnStateExtractionDedupeKey({ assistantEntryId: 'entry_assistant' })).toBe('turn-state-entry_assistant');
	});

	it('uses one compact recovery prompt instead of replaying the full schema prompt', () => {
		const responseSchema = {
			type: 'object',
			properties: { update: { type: 'object', properties: { characters: { type: 'array' } } } },
		};
		const first = buildDeferredStateExtractionPrompt({
			playerText: 'I hand Mira the seal.',
			narration: 'Mira accepts it.',
			responseSchema,
			attemptCount: 1,
		});
		const retry = buildDeferredStateExtractionPrompt({
			playerText: 'I hand Mira the seal.',
			narration: 'Mira accepts it.',
			responseSchema,
			attemptCount: 2,
			lastError: 'Classifier returned an empty state extraction response.',
		});

		expect(first.compactRecovery).toBe(false);
		expect(first.prompt).toContain('The server validates the complete schema');
		expect(retry.compactRecovery).toBe(true);
		expect(retry.prompt).toContain('Compact recovery attempt 2.');
		expect(retry.prompt).toContain('empty state extraction response');
		expect(retry.prompt).not.toContain('exact JSON Schema');
		// Both carry the gameplay effects instruction (about 2,400 characters) in addition to identity rules.
		expect(first.prompt.length).toBeLessThan(11_000);
		expect(retry.prompt.length).toBeLessThan(11_000);
		expect(retry.prompt).toContain('GAMEPLAY EFFECTS');
		for (const result of [first, retry]) {
			expect(result.prompt).toContain('creation_evidence');
			expect(result.prompt).toContain('faction_evidence');
		}
	});

	it('skips deferred extraction when its exact canonical source pair was deleted, changed, or marked non-canon', () => {
		const input = {
			playerEntryId: 'entry_player',
			assistantEntryId: 'entry_assistant',
			playerText: 'I hand Mira the seal.',
			narration: 'Mira accepts the seal.',
		};
		const entries = [
			{ id: 'entry_player', type: 'user_action', content: input.playerText, parentId: null, metadata: {} },
			{ id: 'entry_assistant', type: 'narration', content: input.narration, parentId: 'entry_player', metadata: {} },
		];

		expect(deferredExtractionSourcePairError({ ...input, entries })).toBeNull();
		expect(deferredExtractionSourcePairError({ ...input, entries: entries.slice(0, 1) })).toBe('source_entries_missing');
		expect(deferredExtractionSourcePairError({
			...input,
			entries: [entries[0], { ...entries[1], content: 'A replacement narration.' }],
		})).toBe('source_entry_content_changed');
		expect(deferredExtractionSourcePairError({
			...input,
			entries: [entries[0], { ...entries[1], metadata: { nonCanon: true } }],
		})).toBe('source_entries_non_canon');
	});

	it('keeps durable old-turn facts but removes transient state after a later canonical turn', () => {
		const agency = worldStateUpdateSchema.parse({ characters: [{ name: 'Mira', currentGoal: 'Old goal', currentPlan: 'Old plan', nextOpportunity: 'Tomorrow', constraint: 'Old constraint', lastIndependentAction: 'Mira asked her cousin for a berth.', independentActionEvidence: 'Mira asked her cousin for a berth.' }] });
		const oldMove = preserveDurableDeferredState(agency).characters[0];
		expect(oldMove).toMatchObject({ lastIndependentAction: 'Mira asked her cousin for a berth.', independentActionEvidence: 'Mira asked her cousin for a berth.' });
		for (const field of ['currentGoal', 'currentPlan', 'nextOpportunity', 'constraint']) expect(oldMove).not.toHaveProperty(field);
		const update = worldStateUpdateSchema.parse({
			characters: [{
				name: 'Mira',
				present: true,
				relationship: 'wary',
				currentLocation: 'Old Hall',
				currentAction: 'Waiting by the old door',
				emotionalState: 'anxious',
				background: 'Keeper of the imperial seal.',
				affinity_delta: 2,
				affinity_reason: 'The player protected her secret.',
				eventMemory: { saw: ['The emperor offered his daughter.'] },
			}],
			locations: [{ name: 'Old Hall', current: true, region: 'Imperial Keep' }],
			items: [{ name: 'Imperial Seal', description: 'Black iron and ruby.', equipped: true, location: 'Old Hall' }],
			time_delta: 'one hour later',
			mood: 'tense',
			player_reputation: 'favored',
			player_ledger: 'owed one audience',
			story_beats: [{ title: 'Dynastic offer', description: 'The emperor offered his daughter.' }],
		});

		const protectedUpdate = preserveDurableDeferredState(update);

		expect(protectedUpdate.characters).toEqual([
			expect.objectContaining({
				name: 'Mira',
				background: 'Keeper of the imperial seal.',
				affinity_delta: 2,
				eventMemory: expect.objectContaining({ saw: ['The emperor offered his daughter.'] }),
			}),
		]);
		expect(protectedUpdate.characters[0]).not.toHaveProperty('present');
		expect(protectedUpdate.characters[0]?.relationship).toBeNull();
		expect(protectedUpdate.characters[0]).not.toHaveProperty('currentLocation');
		expect(protectedUpdate.characters[0]).not.toHaveProperty('currentAction');
		expect(protectedUpdate.characters[0]).not.toHaveProperty('emotionalState');
		expect(protectedUpdate.locations).toEqual([
			expect.objectContaining({ name: 'Old Hall', region: 'Imperial Keep' }),
		]);
		expect(protectedUpdate.locations[0]).not.toHaveProperty('current');
		expect(protectedUpdate.locations[0]).not.toHaveProperty('connections');
		expect(protectedUpdate.items).toEqual([
			expect.objectContaining({ name: 'Imperial Seal', description: 'Black iron and ruby.' }),
		]);
		expect(protectedUpdate.items[0]).not.toHaveProperty('equipped');
		expect(protectedUpdate.items[0]).not.toHaveProperty('location');
		expect(protectedUpdate.time_delta).toBeNull();
		expect(protectedUpdate.player_reputation).toBeNull();
		expect(protectedUpdate.story_beats).toHaveLength(1);
	});

	it('drops a stale character patch that contains only current-scene state', () => {
		const update = worldStateUpdateSchema.parse({
			characters: [{
				name: 'Mira',
				present: true,
				currentAction: 'Waiting in the old scene',
				emotionalState: 'uneasy',
			}],
		});

		expect(preserveDurableDeferredState(update).characters).toEqual([]);
	});

	it('drops stale absolute relationship and faction state instead of regressing newer canon', () => {
		const update = worldStateUpdateSchema.parse({
			relationships: [{
				sourceName: 'Mira',
				targetName: 'Valen',
				type: 'allied-with',
				label: 'old strained alliance',
				strength: 20,
				bidirectional: true,
			}],
			lorebook_entries: [{
				name: 'House Mira',
				type: 'faction',
				description: 'An earlier, now obsolete faction snapshot.',
				faction_goals: [{ description: 'Old campaign goal' }],
				faction_resources: { military: 10, wealth: 20 },
				territory: ['Old Hall'],
			}],
		});

		const protectedUpdate = preserveDurableDeferredState(update);

		expect(protectedUpdate.relationships).toEqual([]);
		expect(protectedUpdate.lorebook_entries).toEqual([]);
	});
});

describe('retired job types', () => {
	it('keeps continuity_audit readable for older rows', () => {
		expect(backendJobTypes).toContain('continuity_audit');
		expect(backendJobTypes).toContain('plan_plot_brain');
	});
});

describe('turn story vault sync cadence', () => {
	it('does not queue generated wiki sync on every turn by default', () => {
		expect(shouldQueueTurnStoryVaultSync(11, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(12, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(15, 5)).toBe(true);
	});

	it('can disable automatic turn wiki sync', () => {
		expect(shouldQueueTurnStoryVaultSync(20, 0)).toBe(false);
	});
});

describe('story vault sync catch-up', () => {
	it('queues the current backend version when the manifest trails canon', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 101,
			manifestVersion: 100,
		})).toBe(101);
	});

	it('queues a follow-up when no manifest exists yet', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 7,
			manifestVersion: null,
		})).toBe(7);
	});

	it('does not queue when the manifest is current or newer', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 12,
		})).toBeNull();
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 13,
		})).toBeNull();
	});
});

describe('job status summaries', () => {
	it('separates checkpoint, consolidation and optional index freshness', () => {
		const base = {
			attemptCount: 1,
			maxAttempts: 3,
			runAfter: '2026-06-05T20:00:00.000Z',
			lockedAt: null,
			lockedBy: null,
			createdAt: '2026-06-05T19:00:00.000Z',
			updatedAt: '2026-06-05T20:00:00.000Z',
		};
		const freshness = summarizeMemoryStageFreshness([
			{ ...base, id: 'checkpoint', storyId: 'story_1', type: 'refresh_scene_checkpoint', status: 'complete', lastError: null },
			{ ...base, id: 'chapter', storyId: 'story_1', type: 'summarize_chapter', status: 'complete', lastError: null },
			{ ...base, id: 'arc', storyId: 'story_1', type: 'rollup_arc', status: 'retry', lastError: 'Projection dependency changed; stale source.' },
			{ ...base, id: 'embed', storyId: 'story_1', type: 'embed_memory_nodes', status: 'failed', lastError: 'Invalid embedding response schema.' },
		]);

		expect(freshness.checkpoint).toMatchObject({ status: 'current', completedCount: 1, activeCount: 0, failedCount: 0 });
		expect(freshness.consolidation).toMatchObject({ status: 'updating', completedCount: 1, activeCount: 1, failedCount: 0 });
		expect(freshness.optionalIndex).toMatchObject({ status: 'attention', completedCount: 0, activeCount: 0, failedCount: 1 });
		expect(summarizeBackendJobs([]).memoryStageFreshness.optionalIndex.status).toBe('unknown');
	});

	it('classifies active failures by story, stage, cause, retryability and source version', () => {
		const base = {
			attemptCount: 3,
			maxAttempts: 3,
			runAfter: '2026-06-05T20:00:00.000Z',
			lockedAt: null,
			lockedBy: null,
			createdAt: '2026-06-05T19:00:00.000Z',
			updatedAt: '2026-06-05T20:00:00.000Z',
		};
		const stats = summarizeBackendJobs([
			{ ...base, id: 'job_balance', storyId: 'story_1', type: 'extract_turn_state', status: 'failed', lastError: 'Server LLM request failed (402): Insufficient Balance', payload: { serverVersion: 42 } },
			{ ...base, id: 'job_schema', storyId: 'story_1', type: 'extract_turn_state', status: 'failed', lastError: 'Classifier returned an invalid state extraction response.', payload: { sourceVersion: 43 } },
			{ ...base, id: 'job_stale', storyId: 'story_2', type: 'summarize_chapter', status: 'retry', lastError: 'Projection dependency changed; stale source.', metadata: { serverVersion: 9 } },
		]);

		expect(classifyBackendJobFailure('Insufficient Balance')).toEqual({ cause: 'provider_account', retryable: false });
		expect(stats.failureClasses).toEqual(expect.arrayContaining([
			expect.objectContaining({ storyId: 'story_1', type: 'extract_turn_state', cause: 'provider_account', count: 1, sourceVersions: [42], retryable: false }),
			expect.objectContaining({ storyId: 'story_1', type: 'extract_turn_state', cause: 'provider_output', count: 1, sourceVersions: [43], retryable: false }),
			expect.objectContaining({ storyId: 'story_2', type: 'summarize_chapter', cause: 'stale_source', count: 1, sourceVersions: [9], retryable: true }),
		]));
		expect(stats.recentFailures).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'job_schema', failureCause: 'provider_output', sourceVersion: 43 }),
		]));
	});

	it('treats an older failed job as superseded by a newer complete job in the same story/type family', () => {
		const latestCompletedCreatedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			createdAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedCreatedAt)).toBe(true);
	});

	it('does not supersede newer failures or failures from another job family', () => {
		const latestCompletedCreatedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			createdAt: '2026-06-05 21:00:00.000+00',
		}, latestCompletedCreatedAt)).toBe(false);
		expect(isSupersededJobFailure({
			storyId: 'story_2',
			type: 'sync_story_vault',
			status: 'failed',
			createdAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedCreatedAt)).toBe(false);
	});

	it('does not let a late replay of an older job hide a newer failed job', () => {
		const rows = [
			{
				id: 'job_old_replayed',
				storyId: 'story_1',
				type: 'extract_turn_state',
				status: 'complete',
				attemptCount: 1,
				maxAttempts: 3,
				runAfter: '2026-06-05T22:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: null,
				createdAt: '2026-06-05T18:00:00.000Z',
				updatedAt: '2026-06-05T22:00:00.000Z',
			},
			{
				id: 'job_newer_failed',
				storyId: 'story_1',
				type: 'extract_turn_state',
				status: 'failed',
				attemptCount: 3,
				maxAttempts: 3,
				runAfter: '2026-06-05T20:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: 'Old schema response.',
				createdAt: '2026-06-05T20:00:00.000Z',
				updatedAt: '2026-06-05T20:10:00.000Z',
			},
		];

		expect(summarizeBackendJobs(rows).failed).toBe(1);
		expect(summarizeBackendJobs(rows).failedByType).toEqual({ extract_turn_state: 1 });
		expect(summarizeBackendJobs(rows).memoryProcessing).toEqual({ complete: 1, failed: 1, waiting: 0, running: 0 });
	});

	it('keeps failed source-specific memory jobs visible after a later turn succeeds', () => {
		for (const type of ['extract_turn_state', 'create_memory_nodes_from_events', 'embed_memory_nodes']) {
			expect(isSupersededJobFailure({ storyId: 'story_1', type, status: 'failed', createdAt: '2026-06-05T19:00:00.000Z' },
				new Map([[`story_1:${type}`, '2026-06-05T20:00:00.000Z']]))).toBe(false);
		}
	});

	it('does not count superseded failures as active startup failures', () => {
		const rows = [
			{
				id: 'job_old_failed',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'failed',
				attemptCount: 3,
				maxAttempts: 3,
				runAfter: '2026-06-05T19:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: 'Missing column before migration.',
				createdAt: '2026-06-05T18:59:00.000Z',
				updatedAt: '2026-06-05T19:00:00.000Z',
			},
			{
				id: 'job_new_complete',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'complete',
				attemptCount: 1,
				maxAttempts: 3,
				runAfter: '2026-06-05T20:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: null,
				createdAt: '2026-06-05T20:00:00.000Z',
				updatedAt: '2026-06-05T20:10:00.000Z',
			},
		];

		expect(summarizeBackendJobs(rows).failed).toBe(0);
		expect(summarizeBackendJobs(rows).failedByType).toEqual({});
		expect(summarizeBackendJobs(rows).recentFailures).toEqual([]);
	});

	it('treats a successfully applied Plot Director frame as recovery from an older failed planner job', () => {
		const rows = [{
			id: 'job_old_plot_failure',
			storyId: 'story_1',
			type: 'plan_plot_brain',
			status: 'failed',
			attemptCount: 3,
			maxAttempts: 3,
			runAfter: '2026-06-05T19:00:00.000Z',
			lockedAt: null,
			lockedBy: null,
			lastError: 'Planner timed out.',
			createdAt: '2026-06-05T18:59:00.000Z',
			updatedAt: '2026-06-05T19:00:00.000Z',
		}];

		const recovered = summarizeBackendJobs(rows, new Map([
			['story_1:plan_plot_brain', '2026-06-05T20:00:00.000Z'],
		]));

		expect(recovered.failed).toBe(0);
		expect(recovered.failedByType).toEqual({});
		expect(recovered.recentFailures).toEqual([]);
	});
});

describe('background Plot Director jobs', () => {
	it('skips routine plans from older turns but preserves the latest and shock jobs', () => {
		expect(plotBrainJobIsSuperseded({
			id: 'job_plan_plot_brain_plot_brain_scheduled_refresh_story_1_turn_11',
			payload: { trigger: 'scheduled_refresh' },
		}, 12)).toBe(true);
		expect(plotBrainJobIsSuperseded({
			id: 'job_plan_plot_brain_current',
			payload: { trigger: 'scheduled_refresh', scheduledForTurn: 12 },
		}, 12)).toBe(false);
		expect(plotBrainJobIsSuperseded({
			id: 'job_plan_plot_brain_old_shock_turn_11',
			payload: { trigger: 'faction_shock', scheduledForTurn: 11 },
		}, 12)).toBe(false);
	});

	it('blocks fresh review drafts but lets exact stale drafts be regenerated under CAS', () => {
		expect(plotBrainJobSkipReason({ fresh: false, hasPendingFrame: true, hasStoredPendingFrame: true, quiet: false }, false)).toBe('pending_frame');
		expect(plotBrainJobSkipReason({ fresh: false, hasPendingFrame: false, hasStoredPendingFrame: true, quiet: false }, false, true)).toBeNull();
		expect(stalePlotBrainPendingFrameId({ plotBrain: {
			pendingFrameId: 'frame_stale', pendingFrame: { id: 'frame_stale' }, pendingBaseServerVersion: 8,
		} }, 9)).toBe('frame_stale');
		expect(stalePlotBrainPendingFrameId({ plotBrain: {
			pendingFrameId: 'frame_fresh', pendingFrame: { id: 'frame_fresh' }, pendingBaseServerVersion: 9,
		} }, 9)).toBeNull();
		expect(stalePlotBrainPendingFrameId({ plotBrain: {
			pendingFrameId: 'frame_a', pendingFrame: { id: 'frame_b' }, pendingBaseServerVersion: 8,
		} }, 9)).toBeNull();
		expect(plotBrainJobSkipReason({ fresh: false, hasPendingFrame: false, hasStoredPendingFrame: false, quiet: true }, false)).toBe('quiet_period');
		expect(plotBrainJobSkipReason({ fresh: false, hasPendingFrame: false, hasStoredPendingFrame: false, quiet: true }, false, true)).toBeNull();
		expect(plotBrainJobSkipReason({ fresh: true, hasPendingFrame: false, hasStoredPendingFrame: false, quiet: false }, true)).toBe('already_planned');
		expect(plotBrainJobSkipReason({ fresh: true, hasPendingFrame: false, hasStoredPendingFrame: false, quiet: false }, false)).toBeNull();
	});
});

describe('job status stream events', () => {
	it('builds a compact job status payload for the control-surface stream', () => {
		expect(backendJobStatusEventData({
			id: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			attemptCount: 2,
			maxAttempts: 3,
		}, 'completed', {
			result: { status: 'applied', patchIds: ['patch_1'] },
		})).toEqual({
			jobId: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			status: 'completed',
			attemptCount: 2,
			maxAttempts: 3,
			result: { status: 'applied', patchIds: ['patch_1'] },
		});
	});
});

describe('transcript chapter generation', () => {
	it('sends complete turns and event provenance without extracted prose or fallback keywords', async () => {
		const entries = Array.from({ length: 20 }, (_, index) => [
			{ id: `player-${index}`, storyId: 'story', type: 'user_action', content: `I ask question ${index} and require a conditional answer.`, position: index * 2 + 1, parentId: null, metadata: {} },
			{ id: `answer-${index}`, storyId: 'story', type: 'narration', content: `The envoy answers question ${index}. ${'The negotiations continue. '.repeat(120)} Final condition ${index}: the ship may leave only after payment.`, position: index * 2 + 2, parentId: `player-${index}`, metadata: {} },
		]).flat() as Parameters<typeof summarizeChapterMemoryWithLlm>[0];
		const events = [{
			id: 'event-provenance', status: 'committed', type: 'reveal',
			title: 'INVENTED_FUTURE_CORONATION', body: 'Viserys accepted the crown ten chapters later.',
			actorEntityIds: ['wrong-actor'], targetEntityIds: ['wrong-target'], threadIds: ['thread-harbor'],
			sourceEntryIds: ['player-0', 'answer-0'], metadata: {},
		}] as Parameters<typeof summarizeChapterMemoryWithLlm>[1];
		const generated = {
			title: 'The envoy sets conditions', narrative: 'The envoy answers each question at the harbor, holding to the same payment condition while the talks draw toward a decision.', endingScene: 'The envoy remains at the harbor.',
			accounts: entries.filter(entry => entry.type === 'narration').map(entry => ({ sourceId: entry.id, summary: `The envoy answered ${entry.id} and required payment.` })),
			characters: [{ name: 'The envoy', entityId: undefined, bullets: ['Required payment before departure.'] }],
			openThreads: ['Payment remains due.'], locations: ['The harbor'], keywords: ['payment', 'payment'],
			threadChanges: [], newThreads: [], model: 'fixture',
		};
		const generate = vi.spyOn(summaryGeneration, 'generateChronologicalMemory').mockResolvedValue(generated);
		try {
			const digest = await summarizeChapterMemoryWithLlm(entries, events, {
				title: 'FALLBACK_TITLE', summary: 'FALLBACK_SUMMARY', keywords: ['FALLBACK_EVENT_KEYWORD'],
				keyCharacters: ['FALLBACK_CHARACTER'], keyLocations: ['FALLBACK_LOCATION'],
				plotThreads: ['FALLBACK_THREAD'], emotionalTone: 'FALLBACK_TONE', source: 'deterministic',
			}, []);
			expect(generate).toHaveBeenCalledTimes(1);
			const request = generate.mock.calls[0][0];
			expect(request.sources.map(source => source.id)).toEqual(generated.accounts.map(account => account.sourceId));
			for (let index = 0; index < 20; index++) {
				expect(request.sources[index].text).toContain(entries[index * 2].content);
				expect(request.sources[index].text).toContain(entries[index * 2 + 1].content);
			}
			expect(JSON.parse(request.evidence!.split('\n')[0])).toEqual({
				eventId: 'event-provenance', sourceEntryIds: ['player-0', 'answer-0'], threadIds: ['thread-harbor'],
			});
			expect(JSON.stringify(request)).not.toMatch(/INVENTED_FUTURE_CORONATION|Viserys|wrong-actor|wrong-target|FALLBACK_/);
			expect(digest.keywords).toEqual(['payment']);
			expect(digest.keyCharacters).toEqual(['The envoy']);
			expect(digest.plotThreads).toEqual(['Payment remains due.']);
			expect(JSON.stringify(digest)).not.toMatch(/INVENTED_FUTURE_CORONATION|Viserys|FALLBACK_/);
		} finally {
			generate.mockRestore();
		}
	});

	it('does not let a manual project strand or replace autonomous progression', () => {
		const manual = { factionId: 'house_a', status: 'active', metadata: {} } as const;
		const autonomous = { factionId: 'house_a', status: 'active', metadata: { sourceType: 'autonomous_faction_project', nextActionTurn: 12 } } as const;
		expect(factionCanStartAutonomousProject([manual], 'house_a')).toBe(true);
		expect(factionProjectIsReady({ ...manual, dueTurn: 10 }, 12)).toBe(false);
		expect(factionCanStartAutonomousProject([manual, autonomous], 'house_a')).toBe(false);
		expect(factionProjectIsReady({ ...autonomous, dueTurn: null }, 11)).toBe(false);
		expect(factionProjectIsReady({ ...autonomous, dueTurn: null }, 12)).toBe(true);
		expect(factionCanStartAutonomousProject([manual, { ...autonomous, status: 'completed' }], 'house_a')).toBe(true);
	});
	it('includes campaign topic versions in extraction and recovery and preserves source-versioned durable deltas', () => {
		const fact = { key: 'yin_betrothal', kind: 'current' as const, statement: 'The Yin betrothal was annulled.', evidence: 'The Yin betrothal was annulled.', sourceEntryId: 'entry_20', sourcePosition: 20 };
		for (const attemptCount of [1, 2]) {
			const result = buildDeferredStateExtractionPrompt({ playerText: 'Continue.', narration: fact.statement, responseSchema: {}, attemptCount, campaignMetadata: { campaignState: [fact] } });
			expect(result.prompt).toContain('"expected_source_entry_id":"entry_20"');
		}
		const delta = { ...fact, expected_source_entry_id: 'entry_20' };
		const update = worldStateUpdateSchema.parse({ campaign_state: [delta] });
		expect(preserveDurableDeferredState(update).campaign_state).toEqual(update.campaign_state);
	});
});

describe('deterministic chapter summaries', () => {
	it('excludes OOC control pairs and cancelled or non-canon events from chapter memory', () => {
		const entries = [
			{ id: 'entry_safe_1', type: 'user_action', content: 'I order the unloading to continue.', position: 1, metadata: {} },
			{ id: 'narration_safe_1', type: 'narration', content: 'Dockhands roll the next barrels ashore.', position: 2, parentId: 'entry_safe_1', metadata: {} },
			{ id: 'entry_ooc', type: 'user_action', content: 'OOC: rewrite the harbor as a ritual.', position: 3, metadata: { actionType: 'ooc', nonCanon: true } },
			{ id: 'narration_ooc', type: 'narration', content: 'The harbor invents a water tithe.', position: 4, parentId: 'entry_ooc', metadata: { actionType: 'ooc', nonCanon: true } },
			{ id: 'entry_safe_2', type: 'user_action', content: 'I ask for the unloading tally.', position: 5, metadata: {} },
			{ id: 'narration_safe_2', type: 'narration', content: 'Daeron reports steady progress.', position: 6, parentId: 'entry_safe_2', metadata: {} },
		] as any[];
		const events = [
			{ id: 'event_safe', status: 'committed', type: 'scheme', title: 'Unloading continues', body: 'Cargo continues ashore.', sourceEntryIds: ['narration_safe_2'], metadata: {}, actorEntityIds: [], targetEntityIds: [], threadIds: [] },
			{ id: 'event_cancelled', status: 'cancelled', type: 'reveal', title: 'Asshai\'s Hunger Revealed', body: 'Invented pressure.', sourceEntryIds: ['narration_ooc'], metadata: {}, actorEntityIds: [], targetEntityIds: [], threadIds: [] },
			{ id: 'event_ooc', status: 'committed', type: 'scheme', title: 'Water tithe', body: 'Invented pressure.', sourceEntryIds: ['narration_ooc'], metadata: { nonCanon: true, actionType: 'ooc' }, actorEntityIds: [], targetEntityIds: [], threadIds: [] },
		] as any[];

		const summary = buildChapterSummary(entries, events);

		expect(summary).toContain('unloading to continue');
		expect(summary).toContain('Daeron reports steady progress');
		expect(summary).toContain('Unloading continues');
		expect(summary).not.toMatch(/\bOOC\b/i);
		expect(summary).not.toContain('water tithe');
		expect(summary).not.toContain('Hunger Revealed');
		expect(isNarrativeChapterEvent(events[0])).toBe(true);
		expect(isNarrativeChapterEvent(events[1])).toBe(false);
		expect(isNarrativeChapterEvent(events[2])).toBe(false);
	});

	it('excludes slash command text while keeping its canonical narration', () => {
		const digest = buildChapterMemoryDigest(7, [
			{ id: 'entry_pov', type: 'user_action', content: '/pov The Veiled Daughter | weighs the offer.', position: 1, metadata: { actionType: 'pov' } },
			{ id: 'narration_pov', type: 'narration', content: 'Behind the veil, the emperor\'s daughter studies the foreign king.', position: 2, parentId: 'entry_pov', metadata: { actionType: 'pov' } },
		] as any[], []);

		expect(`${digest.title}\n${digest.summary}`).not.toContain('/pov');
		expect(digest.title).toContain('Behind the veil');
		expect(digest.summary).toContain('emperor\'s daughter studies the foreign king');
	});

	it('covers the beginning, middle, and ending of a full chapter window', () => {
		const entries = Array.from({ length: 12 }, (_, index) => ({
			id: `entry_${index + 1}`,
			type: index % 2 === 0 ? 'user_action' : 'narration',
			content: [
				'Opening beat: Aurion is still angry that House Balaerys sent him east.',
				'Early beat: the heat of Yin presses against the trading post.',
				'Early beat: Ser Davos and Malyrio fall into watchful silence.',
				'Middle beat: Xanda sends a lapis-sealed dinner invitation.',
				'Middle beat: the Copper Court feels rich, dangerous, and unfamiliar.',
				'Middle beat sentinel: Aurion admits the exile wound still has teeth.',
				'Middle beat: Xanda listens with polished courtly interest.',
				'Late beat: honeyed locusts arrive with the warning of poison.',
				'Late beat: Aurion jokes that Xanda may smile while deciding to kill him.',
				'Late beat sentinel: Aurion eats the locusts anyway.',
				'Ending beat: Xanda laughs and becomes more intrigued.',
				'Ending beat sentinel: romance, manipulation, and political danger remain open.',
			][index],
			position: index + 1,
		})) as any[];

		const summary = buildChapterSummary(entries, []);

		expect(summary).toContain('Opening beat: Aurion is still angry');
		expect(summary).toContain('Middle beat: Xanda sends a lapis-sealed dinner invitation.');
		expect(summary).toContain('Late beat: honeyed locusts arrive with the warning of poison.');
		expect(summary).toContain('Ending beat sentinel: romance, manipulation, and political danger remain open.');
		expect(summary).toContain('Time passed in this chapter: not established.');
		expect(summary).not.toContain('more transcript entries are covered by this checkpoint');
	});

	it('writes a continuity rollup with source coverage and tracked entity ids', () => {
		const entries = [
			{
				id: 'entry_62',
				type: 'user_action',
				content: '> I say, "Yes, Aelyx\'s younger better-looking brother."',
				position: 62,
			},
			{
				id: 'entry_63',
				type: 'narration',
				content: '[ Time 15:30 | Day 3, Seventh Moon, 295 AC | Location The Black Walls - Fountain of the First Flame | Weather Sweltering, 34 C ] Aerene teases Aurion while Serala watches from the fountain.',
				position: 63,
			},
			{
				id: 'entry_64',
				type: 'user_action',
				content: '> I ask, "Dragonlord blood?"',
				position: 64,
			},
			{
				id: 'entry_65',
				type: 'narration',
				content: '[ Time 15:31 | Day 3, Seventh Moon, 295 AC | Location The Black Walls - Fountain of the First Flame | Weather Sweltering, 34 C ] Serala explains that House Balaerys is still remembered for dragonlord blood and relics.',
				position: 65,
			},
		] as any[];
		const events = [
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[1].content,
				actorEntityIds: ['npc_serala'],
			},
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[3].content,
				actorEntityIds: ['npc_serala'],
			},
		] as any[];

		const summary = buildChapterSummary(entries, events);

		expect(summary).toContain('[CHECKPOINT = Chapter checkpoint covering transcript positions 62-65.]');
		expect(summary).toContain('[SOURCE COVERAGE =');
		expect(summary).toContain('- Transcript positions 62-65.');
		expect(summary).toContain('- 4 entries covered.');
		expect(summary).toContain('- 2 source event records.');
		expect(summary).toContain('[CURRENT SCENE = Day 3, Seventh Moon, 295 AC | 15:31 | The Black Walls - Fountain of the First Flame | Sweltering, 34 C]');
		expect(summary).toContain('[RECENT STORY STATE =');
		expect(summary).toContain('- The player character says, "Yes, Aelyx\'s younger better-looking brother."');
		expect(summary).toContain('- Serala explains that House Balaerys is still remembered for dragonlord blood and relics.');
		expect(summary).toContain('- Time passed in this chapter: a minute or less.');
		expect(summary).toContain('[CHARACTER STATE =');
		expect(summary).toContain('Serala [npc_serala]:');
		expect(summary).toContain('[ACTIVE THREADS =');
		expect(summary).toContain('[TONE TO CONTINUE = Continue from the established scene pressure, character choices, and unresolved consequences.]');
		expect(summary).not.toContain('Terminal checkpoint');
		expect(summary).not.toContain('[IMPORTANT STRINGS=');
		expect(summary).not.toContain('- - Turn resolved');
		expect(summary).not.toContain('Transcript trace:');
		expect(summary).not.toContain('not established by deterministic terminal checkpoint');
	});

	it('builds typed memory fields for the chapter editor and retrieval', () => {
		const entries = [
			{
				id: 'entry_91',
				type: 'narration',
				content: '[ Time 15:30 | Day Tenth Moon, 296 AC | Location Yi Ti, Yin, the Merchants’ Quarter, the Balaerys Trading Post | Weather Sweltering heat, 36 C ] Aurion arrives beneath date palms while Ser Davos and Malyrio watch the crowds.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda sends an invitation sealed in lapis-blue wax and draws Aurion toward dinner at the Copper Court.',
				position: 92,
			},
		] as any[];
		const events = [
			{
				type: 'scene_transition',
				title: 'Aurion reaches the Balaerys Trading Post in Yin',
				body: entries[0].content,
				actorEntityIds: ['pc_aurion', 'npc_ser_davos', 'npc_malyrio'],
				metadata: { location: 'Yi Ti, Yin, the Merchants’ Quarter' },
			},
			{
				type: 'relationship_shift',
				title: 'Xanda tests Aurion with courtly dinner politics',
				body: entries[1].content,
				actorEntityIds: ['pc_aurion', 'npc_xanda'],
				threadIds: ['thread_xanda_dinner'],
			},
		] as any[];

		const digest = buildChapterMemoryDigest(3, entries, events);

		expect(digest.title).toContain('Aurion reaches');
		expect(digest.summary).toContain('[CHARACTER STATE =');
		expect(digest.keyCharacters).toEqual(expect.arrayContaining(['Aurion', 'Ser Davos', 'Malyrio', 'Xanda']));
		expect(digest.keyLocations).toEqual(expect.arrayContaining(['Yi Ti, Yin, the Merchants’ Quarter']));
		expect(digest.keywords).toEqual(expect.arrayContaining(['relationship shift', 'scene transition']));
		expect(digest.plotThreads).toEqual(expect.arrayContaining(['thread_xanda_dinner', 'Xanda tests Aurion with courtly dinner politics']));
		expect(digest.emotionalTone).not.toBe('');
	});

	it('retains every distinct beat in deterministic chapter inspection', () => {
		const entries = Array.from({ length: 15 }, (_, index) => ({
			id: `entry_${index + 1}`,
			type: 'narration',
			content: `Readable beat ${index + 1}: Aurion and Zhen move through a distinct court consequence that must stay legible.`,
			position: index + 1,
		})) as any[];

		const summary = buildChapterSummary(entries, []);
		for (let index = 1; index <= 15; index++) expect(summary).toContain(`Readable beat ${index}:`);
		expect(summary).not.toContain('Opening:');

	});
});

describe('deterministic arc summaries', () => {
	it('filters chapter thread history against the canonical end-of-arc status', () => {
		expect(canonicalArcOpenThreadIds([
			{ metadata: { openThreadIds: ['thread_crown'] }, openThreads: ['The Crown'] },
			{ metadata: { openThreadIds: ['thread_crown', 'thread_debt'] }, openThreads: ['The Crown', 'The Debt'] },
		] as any[], [
			{ id: 'thread_crown', status: 'closed' },
			{ id: 'thread_debt', status: 'open' },
		])).toEqual(['thread_debt']);
	});

	it('selects every full uncovered chapter batch for arc catch-up', () => {
		const chapters = Array.from({ length: 15 }, (_, index) => ({ id: `chapter_${index + 1}` }));
		const batches = selectArcRollupBatches(chapters, [{ chapterIds: ['chapter_1', 'chapter_2', 'chapter_3', 'chapter_4', 'chapter_5'] }], 5);

		expect(batches.map((batch) => batch.map((chapter) => chapter.id))).toEqual([
			['chapter_6', 'chapter_7', 'chapter_8', 'chapter_9', 'chapter_10'],
			['chapter_11', 'chapter_12', 'chapter_13', 'chapter_14', 'chapter_15'],
		]);
	});

	it('rolls chapter summaries into a cohesive arc overview instead of a chapter list', () => {
		const chapterSummary = buildChapterSummary([
			{
				id: 'entry_91',
				type: 'narration',
				content: 'Aurion reaches Yin under heat, incense, silk, trade-gold, and foreign perfume.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda draws him into dinner politics at the Copper Court.',
				position: 92,
			},
			{
				id: 'entry_93',
				type: 'narration',
				content: 'Arc-summary sentinel: the dinner may become romance, manipulation, political danger, or all three.',
				position: 93,
			},
		] as any[], [{
			type: 'relationship_shift',
			title: 'Xanda tests Aurion with courtly dinner politics',
			body: 'Xanda tests Aurion with courtly dinner politics.',
			actorEntityIds: ['pc_aurion', 'npc_xanda'],
			targetEntityIds: [],
			threadIds: ['thread_xanda_dinner'],
		}] as any[]);

		const summary = buildArcSummary([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: ['thread_xanda_dinner'],
		}] as any[]);

		expect(summary).toContain('Arc overview:');
		expect(summary).toContain('Arc-summary sentinel: the dinner may become romance');
		expect(summary).toContain('Character movement:');
		expect(summary).toContain('- Aurion:');
		expect(summary).toContain('Open threads:');
		expect(summary).not.toMatch(/^Chapter \d+/);
		expect(summary).not.toContain('[CHECKPOINT = Chapter checkpoint');
		expect(summary).not.toContain('...');
	});

	it('rolls only full uncovered arc batches into bounded saga memory', () => {
		const arcs = Array.from({ length: 11 }, (_, index) => ({ id: `arc_${index + 1}` }));
		const batches = selectSagaRollupBatches(arcs, [{ arcIds: ['arc_1', 'arc_2', 'arc_3', 'arc_4', 'arc_5'] }], 5);
		expect(batches.map((batch) => batch.map((arc) => arc.id))).toEqual([
			['arc_6', 'arc_7', 'arc_8', 'arc_9', 'arc_10'],
		]);
		// Two arcs (about twenty chapters) per saga: twelve arcs make six sagas.
		expect(SAGA_ROLLUP_ARCS).toBe(2);
		expect(selectSagaRollupBatches(arcs, [{ arcIds: ['arc_1', 'arc_2'] }])).toHaveLength(4);
	});

	it('gives the saga writer each arc in full with its chapter range, and stores the saga as sections', () => {
		const arc = { id: 'arc_3', number: 3, title: 'The Doom', summary: `Arc overview:\n${'Aegon walks out of Valyria. '.repeat(400)}tail sentinel`, chapterIds: [],
			sourceEventIds: [], openThreadIds: [], metadata: { startChapterNumber: 21, endChapterNumber: 30 } } as any;
		expect(sagaSourceForArc(arc)).toEqual({ id: 'arc_3', label: 'Arc 3: The Doom (chapters 21-30)', text: arc.summary });
		const text = renderSagaSummary({ period: '296-297 AC', sections: [{ heading: 'Apotheosis', text: 'Aegon emerged from the Between.' }, { heading: 'Love and Law', text: 'The betrothal collapsed.' }],
			consequence: 'Aegon was remade.', continuity: ['The red egg is not one of the three.'], openThreads: ["The second blade's debt."] });
		expect(text).toBe([
			'Period: 296-297 AC',
			'Apotheosis\nAegon emerged from the Between.',
			'Love and Law\nThe betrothal collapsed.',
			'Saga consequence: Aegon was remade.',
			'Continuity:\n- The red egg is not one of the three.',
			"Open threads:\n- The second blade's debt.",
		].join('\n\n'));
	});

	it('keeps saga fields source-derived and preserves lingering thread evidence', () => {
		const arcs = [{
			id: 'arc_1', number: 1, title: 'The Gate', summary: 'The gate opened.', chapterIds: ['chapter_1'],
			sourceEventIds: ['event_1'], openThreadIds: ['thread_1'], metadata: {
				keyFactionShifts: ['The Watch mobilized.'], majorPowerChanges: ['The gate changed hands.'],
				unresolvedThreads: ['The debt remains.'], emotionalProgression: 'tense', trackedEntityIds: ['mara'],
			},
		}] as any;
		const fields = buildSagaMemoryFields(arcs);
		expect(fields).toMatchObject({ keyFactionShifts: ['The Watch mobilized.'], majorPowerChanges: ['The gate changed hands.'], lingeringThreads: ['thread_1', 'The debt remains.'], trackedEntityIds: ['mara'], overallTone: 'tense' });
	});

	it('derives the editable arc fields from covered chapter memory', () => {
		const chapterSummary = buildChapterSummary([
			{
				id: 'entry_91',
				type: 'narration',
				content: 'Aurion reaches Yin under heat, incense, silk, trade-gold, and foreign perfume.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda draws him into dinner politics at the Copper Court.',
				position: 92,
			},
			{
				id: 'entry_93',
				type: 'narration',
				content: 'Arc-field sentinel: Xanda may become ally, lover, rival, threat, or all of them.',
				position: 93,
			},
		] as any[], [{
			type: 'relationship_shift',
			title: 'Xanda tests Aurion with courtly dinner politics',
			body: 'Xanda tests Aurion with courtly dinner politics.',
			actorEntityIds: ['pc_aurion', 'npc_xanda'],
			targetEntityIds: [],
			threadIds: ['thread_xanda_dinner'],
		}] as any[]);

		const fields = buildArcMemoryFields([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: ['Aurion accepts the danger of Xanda dinner politics'],
			promisesDebtsOaths: [],
			openThreads: ['thread_xanda_dinner'],
			metadata: { emotionalTone: 'courtly danger, flirtation, and exile ache' },
		}] as any[]);

		expect(fields.keyPlotPoints.join('\n')).toContain('Chapter 7 (Dinner in Yin):');
		expect(fields.keyPlotPoints.join('\n')).toContain('Arc-field sentinel: Xanda may become ally');
		expect(fields.characterArcs).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'Aurion' }),
			expect.objectContaining({ name: 'Xanda' }),
		]));
		expect(fields.unresolvedThreads).toEqual(expect.arrayContaining([
			'thread_xanda_dinner',
			'Xanda tests Aurion with courtly dinner politics',
		]));
		expect(fields.emotionalProgression).toBe('courtly danger, flirtation, and exile ache');
	});

	it('preserves full arc source fields instead of clipping away ending facts', () => {
		const chapterSummary = [
			'[CHECKPOINT = Chapter checkpoint covering transcript positions 1-40.]',
			'[RECENT STORY STATE =',
			`- Arc-rollup opening fact survives. ${'raw checkpoint wall '.repeat(1000)} Arc-rollup tail sentinel.`,
			']',
			'[CHARACTER STATE =',
			`Aurion [pc_aurion]:\n- ${'heavy character detail '.repeat(200)} character tail sentinel.`,
			']',
			'[ACTIVE THREADS =',
			`- thread opening ${'thread filler '.repeat(200)} thread tail sentinel`,
			']',
		].join('\n');

		const fields = buildArcMemoryFields([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: [],
			metadata: {},
		}] as any[]);
		const summary = buildArcSummary([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: [],
			metadata: {},
		}] as any[]);

		expect(summary).toContain('Arc-rollup opening fact survives.');
		expect(summary).toContain('Arc-rollup tail sentinel');
		expect(summary).not.toContain('...');
		expect(fields.characterArcs[0]?.development).toContain('character tail sentinel');
		expect(fields.unresolvedThreads.join(' ')).toContain('thread tail sentinel');
		expect(fields.keyPlotPoints.join(' ')).toContain('Arc-rollup tail sentinel');
	});

	it('carries structured chapter knowledge and relationship reasons into sourced arc memory without prose duplication', () => {
		const chapter = {
			id: 'chapter_secret', number: 1, title: 'The crossing', sceneOutcome: 'The party crossed the river.',
			irreversibleChanges: [], promisesDebtsOaths: [], openThreads: [], metadata: {},
			npcKnowledgeChanges: [{ npc: 'Maera', learned: 'The silver key opens the chapel crypt only after sunset.' }],
			relationshipChanges: ['Maera trusts Aurion because he rescued her daughter at the bridge.'],
			sourceEntryIds: ['entry_key', 'entry_rescue'], sourceEventIds: ['event_rescue'],
		};
		const fields = buildArcMemoryFields([chapter]);
		expect(fields.characterArcs).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'Maera', development: expect.stringContaining('The silver key opens the chapel crypt only after sunset.'), sourceChapterIds: ['chapter_secret'], sourceEntryIds: ['entry_key', 'entry_rescue'], sourceEventIds: ['event_rescue'] }),
			expect.objectContaining({ name: 'Relationships', development: expect.stringContaining('Maera trusts Aurion because he rescued her daughter at the bridge.') }),
		]));
		expect(buildArcSummary([chapter])).toContain('The silver key opens the chapel crypt only after sunset.');
		expect(buildArcSummary([chapter])).toContain('Maera trusts Aurion because he rescued her daughter at the bridge.');
	});

	it('keeps recent structured knowledge ahead of old portrayal and preserves chronological attribution', () => {
		const chapters = Array.from({ length: 6 }, (_, index) => ({
			id: `chapter_${index + 1}`, number: index + 1, title: '', sceneOutcome: '[CHARACTER STATE =\nMaera:\n- She wore silver robes.\n]',
			irreversibleChanges: [], promisesDebtsOaths: [], openThreads: [], metadata: {},
			npcKnowledgeChanges: [{ npc: 'Maera', knows: index === 5 ? 'The old report was false: the envoy is alive in the abbey.' : `Earlier report ${index + 1}.` }],
			relationshipChanges: [], sourceEntryIds: [`entry_${index + 1}`], sourceEventIds: [],
		}));
		const memory = buildArcMemoryFields(chapters).characterArcs.find((item) => item.name === 'Maera')!;
		expect(memory.development).toMatch(/^Chapter 6: learned The old report was false: the envoy is alive in the abbey\./);
		expect(memory.development).not.toContain('Earlier report 1.');
		expect(memory.development).not.toContain('silver robes');
		expect(memory.sourceChapterIds).toEqual(['chapter_6', 'chapter_5', 'chapter_4', 'chapter_3']);
	});

	it('carries canonical chapter character tags into arc rollups', () => {
		const firstChapterEntityIds = chapterMemoryEntityIds({
			eventEntityIds: ['npc_event_actor'],
			keyCharacters: ['Kiba Yuuto', 'Red Dragon Emperor'],
			canonicalCharacters: [
				{ id: 'npc_kiba', name: 'Yuuto Kiba', state: {}, metadata: {} },
				{ id: 'npc_issei', name: 'Issei Hyoudou', state: { aliases: ['Red Dragon Emperor'] }, metadata: {} },
				{ id: 'npc_rias', name: 'Rias Gremory', state: {}, metadata: {} },
			] as any[],
		});
		const fields = buildArcMemoryFields([
			{
				number: 1,
				title: 'First',
				sceneOutcome: 'Kiba keeps watch.',
				irreversibleChanges: [],
				promisesDebtsOaths: [],
				openThreads: [],
				metadata: { trackedEntityIds: firstChapterEntityIds },
			},
			{
				number: 2,
				title: 'Second',
				sceneOutcome: 'Rias takes command.',
				irreversibleChanges: [],
				promisesDebtsOaths: [],
				openThreads: [],
				metadata: { trackedEntityIds: ['npc_rias', 'npc_kiba'] },
			},
		] as any[]);

		expect(firstChapterEntityIds).toEqual(['npc_event_actor', 'npc_kiba', 'npc_issei']);
		expect(fields.trackedEntityIds).toEqual(['npc_event_actor', 'npc_kiba', 'npc_issei', 'npc_rias']);
	});

	it('selects story memory using current and legacy character metadata', () => {
		const selected = selectStoryMemory([
			{ id: 'chapter_legacy', number: 1, title: 'First', sceneOutcome: 'Old consequence.', metadata: { legacyCharacters: ['Akeno Himejima'] } },
			{ id: 'chapter_current', number: 2, title: 'Second', sceneOutcome: 'New consequence.', metadata: { characters: ['Rias Gremory'] } },
		], [
			{ id: 'arc_tracked', number: 1, title: 'First Arc', summary: 'Long consequence.', metadata: { trackedEntityIds: ['npc_kiba'] } },
		], {
			query: 'Akeno Himejima Rias Gremory npc_kiba',
			recentCount: 0,
			relevantCount: 3,
			resurfacedCount: 0,
			tokenBudget: 800,
		});

		expect(selected.selectedIds).toEqual(expect.arrayContaining([
			'chapter:chapter_legacy',
			'chapter:chapter_current',
			'arc:arc_tracked',
		]));
	});
});

describe('event memory projection hygiene', () => {
	it('does not project deleted transcript correction events into durable memory', () => {
		expect(shouldProjectEventToMemory({
			type: 'correction',
			title: 'Transcript context removed',
			body: 'Player deleted a poisoned context message.',
		} as any)).toBe(false);
		expect(shouldProjectEventToMemory({
			type: 'promise',
			title: 'Gate promise',
			body: 'Arlan promised to open the postern gate.',
		} as any)).toBe(true);
	});

	it('projects timeline events with factions, temporal metadata, and memory-impact importance', () => {
		const values = buildEventMemoryNodeValues({
			id: 'event_secret_pact',
			storyId: 'story_balaerys',
			type: 'agreement',
			status: 'scheduled',
			title: 'A secret pact ripens',
			body: 'The harbor families will reveal their pact when the moon turns.',
			actorEntityIds: ['npc_xanda'],
			targetEntityIds: ['npc_aurion'],
			locationId: 'loc_harbor',
			locationIds: ['loc_harbor'],
			factionIds: ['faction_copper_court'],
			threadIds: ['thread_harbor_pact'],
			visibility: 'secret',
			createdTurn: 11,
			occurredTurn: null,
			scheduledTurn: 14,
			worldTime: 'Third night of the moon',
			memoryImpact: {
				importance: 0.97,
				emotionalValence: -0.35,
				emotions: ['dread', 'anticipation'],
				durability: 'long_term',
				requiresReflection: true,
			},
			sourceEntryIds: ['entry_11'],
			sourcePatchIds: ['patch_11'],
			metadata: { source: 'timeline_test' },
			serverVersion: 22,
			createdAt: '2026-06-28T10:00:00.000Z',
			updatedAt: '2026-06-28T10:05:00.000Z',
		} as any, {
			jobId: 'job_memory_projection',
			updatedAt: '2026-06-28T10:10:00.000Z',
		});

		expect(values).toMatchObject({
			id: 'mem_event_event_secret_pact',
			storyId: 'story_balaerys',
			type: 'plot_ledger',
			keywords: ['agreement', 'scheduled', 'long_term', 'requires_reflection'],
			entityIds: ['npc_xanda', 'npc_aurion'],
			factionIds: ['faction_copper_court'],
			threadIds: ['thread_harbor_pact'],
			locationId: 'loc_harbor',
			importance: 0.97,
			sourceEntryIds: ['entry_11'],
			sourceEventIds: ['event_secret_pact'],
			sourcePatchIds: ['patch_11'],
			serverVersion: 22,
			createdAt: '2026-06-28T10:00:00.000Z',
			updatedAt: '2026-06-28T10:10:00.000Z',
		});
		expect(values.metadata).toMatchObject({
			sourceType: 'event_projection',
			jobId: 'job_memory_projection',
			memoryKind: 'prospective',
			status: 'scheduled',
			validFromTurn: 11,
			occurredTurn: null,
			scheduledTurn: 14,
			worldTime: 'Third night of the moon',
			emotionalValence: -0.35,
			emotions: ['dread', 'anticipation'],
			durability: 'long_term',
			requiresReflection: true,
		});
	});
});

describe('chapter character reference candidates', () => {
	it('keeps important unresolved chapter characters and skips duplicates or one-off mentions', () => {
		const candidates = chapterCharacterReferenceCandidates({
			digest: {
				title: 'Xanda tests Aurion',
				summary: 'Aurion dines with Xanda while the boy-guide fades back into the Copper Court.',
				keywords: [],
				keyCharacters: ['Aurion', 'Xanda', 'Boy-guide', 'Consort', 'Dancer', 'Jogos Nhai warrior', 'the fire-wyrm', 'Vermillion Zhen Lian'],
				keyLocations: [],
				plotThreads: [],
				emotionalTone: 'courtly danger',
				source: 'llm',
			},
			events: [
				{
					id: 'event_1',
					title: 'Xanda invites Aurion to dinner',
					body: 'The invitation pulls Aurion into Xanda’s orbit.',
				},
				{
					id: 'event_2',
					title: 'Xanda tests Aurion with honeyed locusts',
					body: 'Xanda laughs when Aurion eats despite the warning.',
				},
				{
					id: 'event_3',
					title: 'Boy-guide haggles with the innkeep',
					body: 'The boy-guide runs ahead through the Copper Court.',
				},
				{
					id: 'event_4',
					title: 'Consort rumor spreads',
					body: 'The court calls Aurion the Consort, and the Consort title echoes through the hall.',
				},
				{
					id: 'event_5',
					title: 'Consort title repeated',
					body: 'The Consort is only a title attached to Aurion, not a separate person.',
				},
				{
					id: 'event_6',
					title: 'Dancer crosses the room',
					body: 'The dancer and the Dancer are role labels in the court scene.',
				},
				{
					id: 'event_7',
					title: 'Jogos Nhai warrior threatens the gate',
					body: 'The Jogos Nhai warrior remains an unnamed role, not a durable NPC.',
				},
				{
					id: 'event_8',
					title: 'The fire-wyrm is named',
					body: 'The fire-wyrm is a beast label, not a person in this chapter.',
				},
			],
			existingNames: ['Aurion', 'Vermillion Zhen Lian'],
		});

		expect(candidates.map((candidate) => candidate.name)).toEqual(['Xanda']);
		expect(candidates[0].sourceEventIds).toEqual(['event_1', 'event_2']);
	});
});

describe('chapter character context patches', () => {
	it('applies automatic character continuity on every completed chapter', () => {
		expect(shouldAutoApplyChapterCharacterContext(0)).toBe(false);
		expect(shouldAutoApplyChapterCharacterContext(1)).toBe(true);
		expect(shouldAutoApplyChapterCharacterContext(2)).toBe(true);
		expect(shouldAutoApplyChapterCharacterContext(3)).toBe(true);
		expect(shouldAutoApplyChapterCharacterContext(4)).toBe(true);
	});

	it('replaces only the audited character state operation before batch apply', () => {
		const operations = replaceCharacterContextOperationState([
			{ op: 'replace', path: '/characters/npc_xanda/state', value: { currentAction: 'old' } },
			{ op: 'review', path: '/unrelated', value: { keep: true } },
		], {
			currentAction: 'kept deterministic action',
			currentDisposition: 'new durable disposition',
		});

		expect(operations).toEqual([
			{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'kept deterministic action',
					currentDisposition: 'new durable disposition',
				},
			},
			{ op: 'review', path: '/unrelated', value: { keep: true } },
		]);
	});

	it('adds chapter history without replaying old location, action, or sheet state', () => {
		const patch = chapterCharacterContextPatch({
			entityId: 'npc_xanda',
			currentState: {
				relationship: 'testing Aurion',
				currentLocation: 'New camp',
				currentAction: 'Resting',
				playerSheet: { hitPoints: { current: 3, max: 10 } },
				eventMemory: { saw: ['Xanda watched Aurion enter the Copper Court.'] },
			},
			digest: {
				title: 'Dinner in Yin',
				summary: 'Xanda tests Aurion with dinner politics.',
				keywords: [],
				keyCharacters: ['Xanda', 'Aurion'],
				keyLocations: ['The Copper Court'],
				plotThreads: [],
				emotionalTone: 'courtly danger',
				source: 'llm',
			},
			events: [
				{
					id: 'event_1',
					type: 'relationship_shift',
					title: 'Xanda tests Aurion with honeyed locusts',
					body: 'Xanda laughs when Aurion eats despite the warning.',
					actorEntityIds: ['npc_xanda'],
					targetEntityIds: ['pc_aurion'],
				},
			] as any[],
		});

		expect(patch?.sourceEventIds).toEqual(['event_1']);
		expect(patch?.state).toEqual({
			eventMemory: {
				saw: [],
				did: ['relationship_shift: Xanda tests Aurion with honeyed locusts - Xanda laughs when Aurion eats despite the warning.'],
			},
		});
	});

	it('falls back to chapter character summaries when extracted events lack entity ids', () => {
		expect(chapterCharacterNamesMatch('Yuuto Kiba', 'Kiba Yuuto')).toBe(true);
		expect(chapterCharacterNamesMatch('Kaelion', 'Kaelion Primoris')).toBe(true);
		const patch = chapterCharacterSummaryContextPatch({
			entityName: 'Yuuto Kiba',
			currentState: { currentLocation: 'New camp', isPresent: false, eventMemory: { did: ['Chapter 18: guarded the church perimeter.'] } },
			digest: {
				title: 'The Rescue',
				summary: [
					'[CHARACTER STATE =',
					'Kiba Yuuto [unknown_entity]: Fought in the rescue with a holy sword and kept watch over Kaelion.',
					'Rias Gremory [unknown_entity]: Led the rescue against orders.',
					']',
				].join('\n'),
				keywords: [],
				keyCharacters: ['Kiba Yuuto', 'Rias Gremory'],
				keyLocations: [],
				plotThreads: [],
				emotionalTone: 'aftermath',
				source: 'llm',
			},
			chapterNumber: 19,
			events: [{ id: 'event_unlinked', actorEntityIds: [], targetEntityIds: [] }] as any[],
		});

		expect(patch).toMatchObject({
			sourceEventIds: ['event_unlinked'],
			state: {
				eventMemory: {
					did: [
						'Chapter 19: Fought in the rescue with a holy sword and kept watch over Kaelion.',
					],
				},
			},
		});
		expect(patch?.state).not.toHaveProperty('currentLocation');
		expect(patch?.state).not.toHaveProperty('isPresent');
	});

	it('builds a reusable review proposal payload for chapter character refreshes', () => {
		const values = chapterCharacterContextProposalValues({
			storyId: 'story_balaerys',
			entityId: 'npc_xanda',
			entityName: 'Xanda',
			chapterId: 'chapter_7',
			chapterNumber: 7,
			chapterTitle: 'Dinner in Yin',
			patch: {
				state: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
				sourceEventIds: ['event_dinner'],
				did: ['tested Aurion at dinner'],
				saw: [],
			},
			sourceEntryIds: ['entry_91', 'entry_92'],
			serverVersion: 12,
			now: '2026-06-18T12:00:00.000Z',
		});

		expect(values).toMatchObject({
			id: 'proposal_chapter_character_context_story_balaerys_chapter_7_npc_xanda',
			proposalType: 'character_context_update',
			targetRecordId: 'npc_xanda',
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
			}],
			reason: 'Xanda appears in chapter 7: Dinner in Yin.',
			sourceEntryIds: ['entry_91', 'entry_92'],
			sourceEventIds: ['event_dinner'],
			metadata: {
				sourceType: 'chapter_character_context',
				characterName: 'Xanda',
				chapterId: 'chapter_7',
				chapterNumber: 7,
			},
		});
	});

	it('refreshes pending chapter character context proposals instead of losing newer evidence', () => {
		const values = chapterCharacterContextProposalValues({
			storyId: 'story_balaerys',
			entityId: 'npc_xanda',
			entityName: 'Xanda',
			chapterId: 'chapter_8',
			chapterNumber: 8,
			chapterTitle: 'After the Dinner',
			patch: {
				state: {
					currentAction: 'pressing Aurion after dinner',
					eventMemory: { did: ['pressed Aurion after dinner'] },
				},
				sourceEventIds: ['event_new'],
				did: ['pressing Aurion after dinner'],
				saw: [],
			},
			sourceEntryIds: ['entry_new'],
			serverVersion: 13,
			now: '2026-06-18T13:00:00.000Z',
		});

		const refreshed = refreshChapterCharacterContextProposalValues({
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
			}],
			sourceEntryIds: ['entry_old'],
			sourceEventIds: ['event_old'],
			metadata: { firstChapterId: 'chapter_7', chapterId: 'chapter_7' },
		}, values);

		expect(refreshed).toMatchObject({
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'pressing Aurion after dinner',
					eventMemory: {
						did: ['tested Aurion at dinner', 'pressed Aurion after dinner'],
						saw: [],
						knew: [],
					},
				},
			}],
			sourceEntryIds: ['entry_old', 'entry_new'],
			sourceEventIds: ['event_old', 'event_new'],
			metadata: {
				firstChapterId: 'chapter_7',
				chapterId: 'chapter_8',
				chapterNumber: 8,
				refreshedFromChapterId: 'chapter_8',
				refreshedFromChapterNumber: 8,
			},
			serverVersion: 13,
			updatedAt: '2026-06-18T13:00:00.000Z',
		});
	});
});
