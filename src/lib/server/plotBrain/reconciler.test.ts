import { describe, expect, it, vi } from 'vitest';
import {
	applyPlotBrainReconciliationPlan,
	buildPlotBrainReconciliationPlan,
	retirePlotBrainFrame,
	type PlotBrainReconciliationPlan,
} from './reconciler';
import type { StrategicWorldFrame } from '$lib/types';
import { npcEventLinks, patchProposals, stories, storyEvents, storyThreads } from '$lib/server/db/schema';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const baseFrame = {
	id: 'frame_1',
	storyId: 'story_alpha',
	arcNumber: 3,
	trigger: 'manual_debug_run',
	chapterRange: { from: 7, to: 9 },
	createdAt: 0,
	continuityAssessment: { summary: '', unresolvedContinuityRisks: [], staleThreads: [], contradictionsToReview: [] },
	worldMood: { politicalTemperature: 'tense' },
	publicSummary: 'Bread prices are tense.',
	hiddenStrategicSummary: 'A flour ring is creating pressure.',
	mainPlots: [],
	subplots: [],
	factionGoalUpdates: [],
	schemeDirectives: [],
	strategicClocks: [],
	factionOperations: [],
	warPressureCard: null,
	rumorSeeds: [],
	worldEventSuggestions: [],
	fastWorldSimInstructions: '',
	narratorPromptCard: '',
	canonPatchSuggestions: [],
	tensionSeeds: [],
	antagonistCandidates: [],
	activationPlan: { activateNow: ['plot_flour_ring'], keepDormant: [], retireOrMerge: [], rationale: 'Market scene is active.' },
	plotBrainWritePlan: { storyThreadCreates: [], storyThreadUpdates: [], timelineEvents: [], patchProposals: [] },
} satisfies Partial<StrategicWorldFrame>;

function makeFrame(overrides: Partial<StrategicWorldFrame> = {}): StrategicWorldFrame {
	return { ...baseFrame, plotCards: [], ...overrides } as unknown as StrategicWorldFrame;
}

function makeCard(overrides: Partial<StrategicWorldFrame['plotCards'][number]> = {}): StrategicWorldFrame['plotCards'][number] {
	return {
		id: 'plot_card',
		title: 'Plot Card',
		logline: 'Pressure builds.',
		lifecycleStage: 'simmer',
		pressure: 50,
		urgency: 'emerging',
		actorEntityIds: [],
		actorFactionIds: [],
		targetEntityIds: [],
		targetFactionIds: [],
		goal: '',
		motive: '',
		method: '',
		stakes: '',
		playerTouchpoints: [],
		pressureBeats: [],
		ignoredOutcome: '',
		sourceRefs: [],
		antiRailroadNotes: [],
		...overrides,
	} as unknown as StrategicWorldFrame['plotCards'][number];
}

function makeBeat(overrides: Partial<StrategicWorldFrame['plotCards'][number]['pressureBeats'][number]> = {}) {
	return {
		delayTurns: 2,
		title: 'Pressure rises',
		body: 'The situation gets worse.',
		urgency: 'emerging' as const,
		visibility: 'player_known' as const,
		actorEntityIds: [],
		targetEntityIds: [],
		locationIds: [],
		factionIds: [],
		memoryImpact: {},
		...overrides,
	};
}

function sqlExpressionIncludes(value: unknown, expected: unknown, seen = new WeakSet<object>()): boolean {
	if (value === expected) return true;
	if (Array.isArray(value)) return value.some(item => sqlExpressionIncludes(item, expected, seen));
	if (typeof value === 'string' && typeof expected === 'string') return value.includes(expected);
	if (!value || typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);

	const record = value as { queryChunks?: unknown[]; value?: unknown; conditions?: unknown[] };
	if (record.value === expected) return true;
	if (Array.isArray(record.value) && record.value.includes(expected)) return true;
	if (Array.isArray(record.queryChunks) && record.queryChunks.some(chunk => sqlExpressionIncludes(chunk, expected, seen))) {
		return true;
	}
	if (Array.isArray(record.conditions) && record.conditions.some(condition => sqlExpressionIncludes(condition, expected, seen))) {
		return true;
	}

	return Object.values(record).some(child => sqlExpressionIncludes(child, expected, seen));
}

function compiledSql(value: unknown) {
	return new PgDialect().sqlToQuery(value as SQL);
}

describe('buildPlotBrainReconciliationPlan', () => {
	it('turns activated plot cards into story threads, scheduled pressure beats, npc links, and metadata', () => {
		const frame = {
			...baseFrame,
			plotCards: [{
				id: 'plot_flour_ring',
				title: 'The Flour Ring',
				logline: 'Merchants hide flour and blame the watch.',
				kind: 'economic_pressure',
				lifecycleStage: 'simmer',
				pressure: 66,
				urgency: 'emerging',
				visibility: 'rumored',
				actorEntityIds: ['npc_mara'],
				actorFactionIds: ['faction_merchants'],
				antagonistCandidateIds: ['ant_mara'],
				targetEntityIds: ['npc_baker'],
				targetFactionIds: ['faction_watch'],
				locationIds: ['loc_market'],
				goal: 'Raise prices before the river fleet arrives.',
				motive: 'Protect monopoly margins.',
				method: 'Hide sacks and spread coordinated rumors.',
				stakes: 'The poor blame the watch for hunger.',
				playerTouchpoints: ['identical invoices', 'bakers whisper about locked warehouses'],
				clueTrail: [{ clue: 'Two bakers use the same phrase.', delivery: 'rumor', truth: 'The rumor was coordinated.', visibility: 'subtle', evidenceRefs: [] }],
				pressureBeats: [{
					delayTurns: 2,
					title: 'Bread prices rise before dawn',
					body: 'Bakers raise prices before the public notice is posted.',
					urgency: 'emerging',
					visibility: 'player_known',
					actorEntityIds: ['npc_mara'],
					targetEntityIds: ['npc_baker'],
					locationIds: ['loc_market'],
					factionIds: ['faction_merchants'],
					memoryImpact: { pressure: 'market' },
				}],
				ignoredOutcome: 'The watch is blamed for scarcity.',
				successOutcome: 'The ring is exposed.',
				failureOutcome: 'The ring tightens control.',
				partialOutcome: 'One warehouse is exposed while the patron escapes.',
				sourceRefs: [
					{ sourceType: 'entry', sourceId: 'entry_7', label: 'Market riot scene' },
					{ sourceType: 'chapter', sourceId: 'chapter_7', label: 'Market riot chapter' },
					{ sourceType: 'world_event', sourceId: 'event_7', label: 'Market riot event' },
				],
				continuityRisks: ['Do not reveal patron without evidence.'],
				antiRailroadNotes: ['Offer clues and costs, never forced travel.'],
			}],
		} as unknown as StrategicWorldFrame;

		const plan = buildPlotBrainReconciliationPlan({ frame, currentTurn: 10, now: '2026-07-06T00:00:00.000Z' });

		expect(plan.storyThreads).toHaveLength(1);
		const threadId = plan.storyThreads[0].id;
		expect(plan.storyThreads[0]).toMatchObject({
			storyId: 'story_alpha',
			status: 'open',
			significance: 'major',
			relatedFactionIds: ['faction_merchants', 'faction_watch'],
			relatedEntityIds: ['npc_mara', 'npc_baker'],
			sourceEntryIds: ['entry_7'],
			sourceEventIds: ['event_7'],
		});
		expect(threadId).toMatch(/^plot_thread_story_alpha_the_flour_ring_[a-f0-9]{16}$/);
		expect(plan.storyThreads[0].description).toContain('The Flour Ring');
		expect(plan.storyThreads[0].description).toContain('Goal: Raise prices');
		expect(plan.storyThreads[0].description).toContain('Agency guard: Offer clues and costs');

		const eventId = plan.storyEvents[0].id;
		expect(eventId).toMatch(/^plot_event_story_alpha_plot_thread_story_alpha_the_flour_ring_[a-f0-9]{16}_[a-f0-9]{16}$/);
		expect(plan.storyEvents[0]).toMatchObject({
			storyId: 'story_alpha',
			type: 'clue_discovery',
			status: 'scheduled',
			title: 'Bread prices rise before dawn',
			scheduledTurn: 12,
			threadIds: [threadId],
			visibility: 'player_known',
			sourceEntryIds: ['entry_7'],
		});
		expect(plan.storyEvents[0].metadata).toMatchObject({
			plotBrain: true,
			plotCardId: 'plot_flour_ring',
			lifecycleStage: 'simmer',
		});
		expect(plan.npcEventLinks).toEqual(expect.arrayContaining([
			expect.objectContaining({
				eventId,
				npcEntityId: 'npc_mara',
				role: 'actor',
			}),
			expect.objectContaining({
				eventId,
				npcEntityId: 'npc_baker',
				role: 'target',
			}),
		]));
	});

	it('durably retires active pressure, pending drafts, events, and threads after a player veto', async () => {
		const updates: Array<{ table: unknown; payload: Record<string, unknown>; condition: unknown }> = [];
		const deletes: Array<{ table: unknown; condition: unknown }> = [];
		const tx = {
			select: vi.fn(() => ({
				from: () => ({
					where: () => ({
						limit: async () => [{
							id: 'story_alpha',
							serverVersion: 12,
							metadata: {
								plotBrain: {
									active: true,
									lastFrameId: 'frame_1',
									pendingFrameId: 'frame_pending',
									pendingFrame: { id: 'frame_pending' },
									lastFrame: {
										mainPlots: [{ title: 'The Flour Ring' }],
										plotCards: [{ storyThreadId: 'thread_imported', title: 'Bread Before Dawn', logline: 'Prices rise in secret.' }],
									},
								},
							},
						}],
					}),
				}),
			})),
			update: vi.fn((table: unknown) => ({
				set: (payload: Record<string, unknown>) => ({
					where: (condition: unknown) => ({
						returning: async () => {
							updates.push({ table, payload, condition });
							if (table === storyEvents) return [{ id: 'event_1' }, { id: 'event_2' }];
							return [{ id: 'row_1' }];
						},
					}),
				}),
			})),
			delete: vi.fn((table: unknown) => ({
				where: async (condition: unknown) => {
					deletes.push({ table, condition });
					return [];
				},
			})),
		};

		const result = await retirePlotBrainFrame({
			storyId: 'story_alpha',
			currentTurn: 20,
			serverVersion: 12,
			reason: 'OOC: drop this plot.',
			now: '2026-08-22T00:00:00.000Z',
		}, { db: tx as never });

		expect(result).toEqual({
			retiredStoryThreads: 1,
			retiredStoryEvents: 2,
			retiredPlotDirectives: ['The Flour Ring', 'Bread Before Dawn', 'Prices rise in secret.'],
			quietUntilTurn: 25,
		});
		const storyUpdate = updates.find(update => update.table === stories)?.payload;
		expect(storyUpdate?.metadata).toMatchObject({
			plotBrain: {
				active: false,
				quietUntilTurn: 25,
				retirementReason: 'OOC: drop this plot.',
				retiredFrameId: 'frame_1',
			},
		});
		expect((storyUpdate?.metadata as { plotBrain: Record<string, unknown> }).plotBrain).not.toHaveProperty('pendingFrame');
		expect(updates).toEqual(expect.arrayContaining([
			expect.objectContaining({ table: storyEvents, payload: expect.objectContaining({ status: 'cancelled' }) }),
			expect.objectContaining({ table: storyThreads, payload: expect.objectContaining({ status: 'closed' }) }),
		]));
		const threadRetirement = updates.find(update => update.table === storyThreads);
		expect(sqlExpressionIncludes(threadRetirement?.condition, 'thread_imported')).toBe(true);
		expect(sqlExpressionIncludes(threadRetirement?.condition, 'plot_thread_story_alpha_')).toBe(false);
		expect(deletes.some(item => item.table === npcEventLinks && sqlExpressionIncludes(item.condition, 'event_1'))).toBe(true);
	});

	it('activates no cards when activateNow is empty', () => {
		const frame = makeFrame({
			plotCards: [makeCard()],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: '' },
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyThreads).toHaveLength(0);
		expect(plan.storyEvents).toHaveLength(0);
		expect(plan.lifecycle).toMatchObject({
			storyId: 'story_alpha',
			activeThreadIds: [],
			desiredEventIds: [],
		});
		expect(plan.warnings).toContain('No plot cards were activated; reconciliation produced no new story threads.');
	});

	it('does not reconcile terminal, dormant, or terminally updated cards as active pressure', () => {
		const frame = makeFrame({
			plotCards: [
				makeCard({ id: 'plot_active', title: 'Active Plot', pressureBeats: [makeBeat({ title: 'Active beat' })] }),
				makeCard({ id: 'plot_resolved', title: 'Resolved Plot', storyThreadId: 'thread_resolved', lifecycleStage: 'resolved', pressureBeats: [makeBeat({ title: 'Resolved beat' })] } as never),
				makeCard({ id: 'plot_dormant', title: 'Dormant Plot', storyThreadId: 'thread_dormant', lifecycleStage: 'dormant', pressureBeats: [makeBeat({ title: 'Dormant beat' })] } as never),
				makeCard({ id: 'plot_closing', title: 'Closing Plot', storyThreadId: 'thread_closing', pressureBeats: [makeBeat({ title: 'Closing beat' })] } as never),
			],
			activationPlan: {
				activateNow: ['plot_active', 'plot_resolved', 'plot_dormant', 'plot_closing'],
				keepDormant: [],
				retireOrMerge: [],
				rationale: '',
			},
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [{ threadId: 'thread_closing', status: 'closed', reason: 'The chapter resolved it.' }],
				timelineEvents: [],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });
		const activeThreadId = plan.storyThreads[0].id;

		expect(activeThreadId).toMatch(/^plot_thread_story_alpha_active_plot_[a-f0-9]{16}$/);
		expect(plan.storyEvents).toHaveLength(1);
		expect(plan.storyEvents[0]).toMatchObject({ title: 'Active beat', threadIds: [activeThreadId] });
		expect(plan.lifecycle.activeThreadIds).toEqual([activeThreadId]);
		expect(plan.lifecycle.dormantThreadIds).toEqual(['thread_dormant']);
		expect(plan.lifecycle.retiredThreadIds).toEqual(['thread_resolved', 'thread_closing']);
	});

	it('keeps activated cards with blank IDs distinct', () => {
		const frame = makeFrame({
			plotCards: [
				makeCard({ id: '', title: 'Shared Plot', pressureBeats: [makeBeat({ title: 'First beat' })] }),
				makeCard({ id: ' ', title: 'Shared Plot', pressureBeats: [makeBeat({ title: 'Second beat' })] }),
			],
			activationPlan: { activateNow: ['Shared Plot'], keepDormant: [], retireOrMerge: [], rationale: '' },
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		const threadIds = plan.storyThreads.map(row => row.id);
		expect(threadIds[0]).toMatch(/^plot_thread_story_alpha_shared_plot_1_[a-f0-9]{16}$/);
		expect(threadIds[1]).toMatch(/^plot_thread_story_alpha_shared_plot_2_[a-f0-9]{16}$/);
		expect(new Set(threadIds).size).toBe(2);
		expect(plan.storyEvents).toHaveLength(2);
		expect(plan.storyEvents[0].id).not.toBe(plan.storyEvents[1].id);
		expect(plan.storyEvents[0].id).toMatch(/^plot_event_story_alpha_plot_thread_story_alpha_shared_plot_1_/);
		expect(plan.storyEvents[1].id).toMatch(/^plot_event_story_alpha_plot_thread_story_alpha_shared_plot_2_/);
	});

	it('hashes raw story and card keys so punctuation-equivalent slugs stay distinct', () => {
		const sameStory = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [
					makeCard({ id: 'card_one', title: 'A-B' }),
					makeCard({ id: 'card_two', title: 'A B' }),
				],
				activationPlan: { activateNow: ['card_one', 'card_two'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const scopedCard = makeCard({ pressureBeats: [makeBeat()] });
		const scopedFrame = {
			plotCards: [scopedCard],
			activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
		};
		const firstStory = buildPlotBrainReconciliationPlan({ frame: makeFrame({ ...scopedFrame, storyId: 'story-a' }) });
		const secondStory = buildPlotBrainReconciliationPlan({ frame: makeFrame({ ...scopedFrame, storyId: 'story_a' }) });

		expect(sameStory.storyThreads).toHaveLength(2);
		expect(sameStory.storyThreads[0].id).not.toBe(sameStory.storyThreads[1].id);
		expect(sameStory.storyThreads.map(row => row.id)).toEqual([
			expect.stringMatching(/^plot_thread_story_alpha_a_b_[a-f0-9]{16}$/),
			expect.stringMatching(/^plot_thread_story_alpha_a_b_[a-f0-9]{16}$/),
		]);
		expect(firstStory.storyThreads[0].id).not.toBe(secondStory.storyThreads[0].id);
		expect(firstStory.storyEvents[0].id).not.toBe(secondStory.storyEvents[0].id);
	});

	it('keeps semantic event identity across regenerated frames and card ids', () => {
		const frame = makeFrame({
			plotCards: [makeCard({ pressureBeats: [makeBeat()] })],
			activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
		});
		const first = buildPlotBrainReconciliationPlan({ frame });
		const secondCard = makeCard({ id: 'regenerated_card_id', title: 'Plot Card', pressureBeats: [makeBeat()] });
		const second = buildPlotBrainReconciliationPlan({
			frame: {
				...frame,
				id: 'frame_2',
				plotCards: [secondCard],
				activationPlan: { ...frame.activationPlan, activateNow: ['regenerated_card_id'] },
			},
		});

		expect(second.storyThreads[0].id).toBe(first.storyThreads[0].id);
		expect(second.storyEvents[0].id).toBe(first.storyEvents[0].id);
	});

	it('keeps a committed beat and inserts genuinely new pressure at the same stage and index', async () => {
		const first = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ storyThreadId: 'thread_durable', pressureBeats: [makeBeat({
					title: 'The first demand',
					body: 'The envoy demands the eastern gate.',
				})] } as never)],
				activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const later = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				id: 'frame_2',
				plotCards: [makeCard({ storyThreadId: 'thread_durable', pressureBeats: [makeBeat({
					title: 'The second demand',
					body: 'The envoy now demands the river fleet.',
				})] } as never)],
				activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const committedEventId = first.storyEvents[0].id;
		const newEventId = later.storyEvents[0].id;
		const insertedEventIds: string[] = [];
		let retirementCondition: unknown;
		const tx = {
			insert: vi.fn((table: unknown) => ({
				values: (payload: unknown) => ({
					onConflictDoUpdate: () => ({
						returning: async () => table === storyThreads
							? (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: (row as { id: string }).id }))
							: [],
					}),
					onConflictDoNothing: () => ({
						returning: async () => {
							if (table === storyEvents) {
								const rows = Array.isArray(payload) ? payload : [payload];
								insertedEventIds.push(...rows.map(row => (row as { id: string }).id));
								return rows.map(row => ({ id: (row as { id: string }).id }));
							}
							return [];
						},
					}),
				}),
			})),
			update: vi.fn((table: unknown) => ({
				set: (payload: Record<string, unknown>) => ({
					where: (condition: unknown) => ({
						returning: async () => {
							if (table === storyEvents && payload.status === 'cancelled') retirementCondition = condition;
							return [];
						},
					}),
				}),
			})),
			delete: vi.fn(() => ({ where: async () => [] })),
		};

		const result = await applyPlotBrainReconciliationPlan(later, { db: tx as never });

		expect(newEventId).not.toBe(committedEventId);
		expect(insertedEventIds).toEqual([newEventId]);
		expect(insertedEventIds).not.toContain(committedEventId);
		expect(result).toMatchObject({ retiredStoryEvents: 0, storyEvents: 1 });
		const retirement = compiledSql(retirementCondition);
		expect(retirement.params).toEqual(expect.arrayContaining(['scheduled', 'due']));
		expect(retirement.params).not.toContain('committed');
	});

	it('reuses a durable story thread when a regenerated card is renamed', () => {
		const first = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ id: 'old_card', title: 'The Volantene Schism', storyThreadId: 'thread_volantis' } as never)],
				activationPlan: { activateNow: ['old_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const second = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ id: 'new_card', title: 'The Ashen Throne', storyThreadId: 'thread_volantis' } as never)],
				activationPlan: { activateNow: ['new_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});

		expect(first.storyThreads[0].id).toBe('thread_volantis');
		expect(second.storyThreads[0].id).toBe('thread_volantis');
	});

	it('keeps a durable thread but gives paraphrased pressure a new event identity', () => {
		const first = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({
					id: 'old_card', title: 'Summons Delivered', storyThreadId: 'thread_customs',
					pressureBeats: [makeBeat({ title: 'Final warning', body: 'The customs officer delivers an ultimatum.' })],
				} as never)],
				activationPlan: { activateNow: ['old_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const second = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({
					id: 'new_card', title: 'Dawn Revocation', storyThreadId: 'thread_customs',
					pressureBeats: [makeBeat({ title: 'Second warning', body: 'At dawn, the same official repeats the demand.' })],
				} as never)],
				activationPlan: { activateNow: ['new_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});

		expect(second.storyThreads[0].id).toBe(first.storyThreads[0].id);
		expect(second.storyEvents[0].id).not.toBe(first.storyEvents[0].id);
	});

	it('maps an explicit retire action to the durable story thread', () => {
		const plan = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ storyThreadId: 'thread_old_plot' } as never)],
				activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: ['plot_card'], rationale: 'The chapter resolved it.' },
			}),
		});

		expect(plan.storyThreads).toEqual([]);
		expect(plan.lifecycle.retiredThreadIds).toEqual(['thread_old_plot']);
	});

	it('deduplicates a pressure beat repeated in the write plan', () => {
		const beat = makeBeat();
		const frame = makeFrame({
			plotCards: [makeCard({ pressureBeats: [beat] })],
			activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [],
				timelineEvents: [{ ...beat, plotCardId: 'plot_card', sourceRefs: [] }],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyEvents).toHaveLength(1);
		expect(plan.warnings).toContain('Ignored 1 duplicate timeline event(s).');
	});

	it('deduplicates semantically identical active beats despite punctuation and timing differences', () => {
		const beat = makeBeat();
		const frame = makeFrame({
			plotCards: [makeCard({ pressureBeats: [beat] })],
			activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [],
				timelineEvents: [{
					...beat,
					delayTurns: 9,
					title: ' PRESSURE—RISES! ',
					body: 'The situation gets worse...',
					plotCardId: 'plot_card',
					sourceRefs: [],
				}],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyEvents).toHaveLength(1);
		expect(plan.warnings).toContain('Ignored 1 duplicate timeline event(s).');
	});

	it('ignores write-plan events that are not linked to an activated plot card', () => {
		const frame = makeFrame({
			plotCards: [
				makeCard({ id: 'plot_active' }),
				makeCard({ id: 'plot_dormant', title: 'Dormant Plot' }),
			],
			activationPlan: { activateNow: ['plot_active'], keepDormant: ['plot_dormant'], retireOrMerge: [], rationale: '' },
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [],
				timelineEvents: [{ ...makeBeat({ title: 'Dormant beat' }), plotCardId: 'plot_dormant', sourceRefs: [] }],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyEvents).toEqual([]);
		expect(plan.lifecycle.dormantThreadIds).toEqual([
			expect.stringMatching(/^plot_thread_story_alpha_dormant_plot_[a-f0-9]{16}$/),
		]);
		expect(plan.warnings).toContain('Ignored 1 timeline event(s) not linked to an activated plot card.');
	});

	it('records the story scope and rejects blank thread updates', () => {
		const frame = makeFrame({
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [
					{ threadId: ' thread_1 ', status: 'open', description: 'Invented rewrite.', reason: 'Still active.' },
					{ threadId: ' ', status: 'closed', reason: 'Invalid.' },
				],
				timelineEvents: [],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyThreadUpdates).toEqual([
			expect.objectContaining({
				storyId: 'story_alpha',
				threadId: 'thread_1',
				updates: expect.not.objectContaining({ description: expect.anything() }),
			}),
		]);
		expect(plan.warnings).toContain('Ignored 1 story thread update(s) with blank IDs.');
		expect(plan.warnings).toContain('Ignored 1 Plot Director thread description rewrite(s); canonical thread text is evidence-owned.');
	});

	it('retires an explicitly selected thread and reactivates only a desired cancelled event', async () => {
		const insertedCounts = new Map<unknown, number>([
			[storyThreads, 1],
			[storyEvents, 0],
			[npcEventLinks, 2],
			[patchProposals, 1],
		]);
		const updatePayloads: Array<{ table: unknown; payload: Record<string, unknown>; condition: unknown }> = [];
		const conflictUpdates: Array<{ table: unknown; config: unknown }> = [];
		const insertPayloads: Array<{ table: unknown; payload: unknown }> = [];
		const deletes: Array<{ table: unknown; condition: unknown }> = [];
		let scheduledEventUpdates = 0;
		const tx = {
			insert: vi.fn((table: unknown) => ({
				values: (payload: unknown) => {
					insertPayloads.push({ table, payload });
					return {
					onConflictDoUpdate: (config: unknown) => {
						conflictUpdates.push({ table, config });
						return {
							returning: async () => table === storyThreads
								? (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: (row as { id: string }).id }))
								: Array.from({ length: insertedCounts.get(table) ?? 0 }, (_, id) => ({ id })),
						};
					},
					onConflictDoNothing: () => ({
						returning: async () => Array.from({ length: insertedCounts.get(table) ?? 0 }, (_, id) => ({ id })),
					}),
					};
				},
			})),
			delete: vi.fn((table: unknown) => ({
				where: async (condition: unknown) => {
					deletes.push({ table, condition });
					return [];
				},
			})),
			update: vi.fn((table: unknown) => ({
				set: (payload: Record<string, unknown>) => {
					return {
						where: (condition: unknown) => ({
							returning: async () => {
								updatePayloads.push({ table, payload, condition });
								if (table === storyEvents && payload.status === 'cancelled') return [{ id: 'old_event_1' }, { id: 'old_event_2' }];
								if (table === storyThreads && payload.status === 'closed') return [{ id: 'old_thread' }];
								if (table === storyEvents && payload.status === 'scheduled') {
									scheduledEventUpdates += 1;
									if (scheduledEventUpdates === 2) return [{ id: 'plot_event_due' }];
									if (scheduledEventUpdates === 3) return [{ id: activeEvent.id }];
									return [];
								}
								return [{ id: 'thread_1' }];
							},
						}),
					};
				},
			})),
		};
		const activeEvent = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ pressureBeats: [makeBeat()] })],
				activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
			currentTurn: 8,
			now: '2026-08-11T00:00:00.000Z',
			serverVersion: 8,
		}).storyEvents[0];
		const dueEvent = {
			...activeEvent,
			id: 'plot_event_due',
			title: 'Updated envoy deadline',
			body: 'The envoy now arrives after the private audience.',
			scheduledTurn: 11,
			actorEntityIds: ['npc_envoy'],
		};
		const plan = {
			lifecycle: {
				storyId: 'story_alpha',
				activeThreadIds: activeEvent.threadIds,
				retiredThreadIds: ['old_thread'],
				desiredEventIds: [activeEvent.id, dueEvent.id],
				now: '2026-08-11T00:00:00.000Z',
				serverVersion: 8,
			},
			storyThreads: [{ id: activeEvent.threadIds?.[0] }],
			storyThreadUpdates: [{ storyId: 'story_alpha', threadId: 'thread_1', updates: {} }],
			storyEvents: [activeEvent, dueEvent],
			npcEventLinks: [
				{ id: 'npc_link_b', storyId: 'story_alpha', eventId: activeEvent.id, npcEntityId: 'npc_b' },
				{ id: 'npc_link_envoy', storyId: 'story_alpha', eventId: dueEvent.id, npcEntityId: 'npc_envoy' },
			],
			patchProposals: [{}],
			warnings: [],
		} as unknown as PlotBrainReconciliationPlan;

		const result = await applyPlotBrainReconciliationPlan(plan, { db: tx as never });

		expect(result).toEqual({
			retiredStoryThreads: 1,
			retiredStoryEvents: 2,
			reactivatedStoryEvents: 1,
			storyThreads: 1,
			storyThreadUpdates: 1,
			storyEvents: 0,
			npcEventLinks: 2,
			patchProposals: 1,
			warnings: [],
		});
		expect(updatePayloads).toEqual(expect.arrayContaining([
			expect.objectContaining({ table: storyEvents, payload: expect.objectContaining({ status: 'cancelled', serverVersion: 8 }) }),
			expect.objectContaining({ table: storyThreads, payload: expect.objectContaining({ status: 'closed', closureReason: 'Retired or merged by Plot Director activation plan.' }) }),
			expect.objectContaining({
				table: storyEvents,
				payload: expect.objectContaining({ status: 'scheduled', occurredTurn: null, serverVersion: 8 }),
			}),
		]));
		const refresh = updatePayloads.find(update => update.table === storyEvents
			&& update.payload.status === 'scheduled'
			&& sqlExpressionIncludes(update.condition, dueEvent.id)
			&& sqlExpressionIncludes(update.condition, 'due'));
		expect(sqlExpressionIncludes(refresh?.condition, storyEvents.status)).toBe(true);
		expect(sqlExpressionIncludes(refresh?.condition, 'scheduled')).toBe(true);
		expect(sqlExpressionIncludes(refresh?.condition, 'due')).toBe(true);
		expect(refresh?.payload).toEqual(expect.objectContaining({
			title: dueEvent.title,
			body: dueEvent.body,
			scheduledTurn: dueEvent.scheduledTurn,
		}));
		const reactivation = updatePayloads.find(update => update.table === storyEvents
			&& update.payload.status === 'scheduled'
			&& sqlExpressionIncludes(update.condition, 'cancelled'));
		expect(sqlExpressionIncludes(reactivation?.condition, storyEvents.status)).toBe(true);
		expect(sqlExpressionIncludes(reactivation?.condition, 'cancelled')).toBe(true);
		expect(sqlExpressionIncludes(reactivation?.condition, 'due')).toBe(false);
		expect(reactivation?.payload.scheduledTurn).toBe(activeEvent.scheduledTurn);
		const threadUpsert = conflictUpdates.find(update => update.table === storyThreads);
		expect(sqlExpressionIncludes(threadUpsert?.config, storyThreads.status)).toBe(true);
		expect(sqlExpressionIncludes(threadUpsert?.config, 'closed')).toBe(true);
		expect(sqlExpressionIncludes(threadUpsert?.config, 'abandoned')).toBe(true);
		expect(sqlExpressionIncludes(threadUpsert?.config, storyThreads.sourceEntryIds)).toBe(true);
		expect(sqlExpressionIncludes(threadUpsert?.config, storyThreads.sourceEventIds)).toBe(true);
		expect(sqlExpressionIncludes(threadUpsert?.config, 'select distinct value')).toBe(true);
		expect(deletes.some(item => item.table === npcEventLinks && sqlExpressionIncludes(item.condition, activeEvent.id))).toBe(true);
		expect(deletes.some(item => item.table === npcEventLinks && sqlExpressionIncludes(item.condition, 'old_event_1'))).toBe(true);
		expect(deletes.some(item => item.table === npcEventLinks && sqlExpressionIncludes(item.condition, dueEvent.id))).toBe(true);
		expect(insertPayloads.find(item => item.table === npcEventLinks)?.payload).toEqual([
			expect.objectContaining({ eventId: activeEvent.id, npcEntityId: 'npc_b' }),
			expect.objectContaining({ eventId: dueEvent.id, npcEntityId: 'npc_envoy' }),
		]);
	});

	it('does not restore pressure when an active card conflicts with a terminal story thread', async () => {
		const plan = buildPlotBrainReconciliationPlan({
			frame: makeFrame({
				plotCards: [makeCard({ storyThreadId: 'thread_finished', pressureBeats: [makeBeat()] } as never)],
				activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
			}),
		});
		const updates: Array<{ table: unknown; payload: Record<string, unknown> }> = [];
		const insertedTables: unknown[] = [];
		let threadConflict: unknown;
		const tx = {
			insert: vi.fn((table: unknown) => ({
				values: (_payload: unknown) => ({
					onConflictDoUpdate: (config: unknown) => {
						threadConflict = config;
						return { returning: async () => [] };
					},
					onConflictDoNothing: () => {
						insertedTables.push(table);
						return { returning: async () => [] };
					},
				}),
			})),
			update: vi.fn((table: unknown) => ({
				set: (payload: Record<string, unknown>) => ({
					where: (_condition: unknown) => ({
						returning: async () => {
							updates.push({ table, payload });
							return table === storyEvents && payload.status === 'cancelled' ? [{ id: 'old_pressure' }] : [];
						},
					}),
				}),
			})),
			delete: vi.fn(() => ({ where: async () => [] })),
		};

		const result = await applyPlotBrainReconciliationPlan(plan, { db: tx as never });

		expect(sqlExpressionIncludes(threadConflict, storyThreads.status)).toBe(true);
		expect(sqlExpressionIncludes(threadConflict, 'closed')).toBe(true);
		expect(sqlExpressionIncludes(threadConflict, 'abandoned')).toBe(true);
		expect(updates).toContainEqual({ table: storyEvents, payload: expect.objectContaining({ status: 'cancelled' }) });
		expect(updates.some(update => update.table === storyEvents && update.payload.status === 'scheduled')).toBe(false);
		expect(insertedTables).not.toContain(storyEvents);
		expect(result).toMatchObject({
			retiredStoryEvents: 1,
			reactivatedStoryEvents: 0,
			storyThreads: 0,
			storyEvents: 0,
		});
	});

	it('leaves an unrelated older thread open when it is absent from the new spotlight', async () => {
		const updates: Array<{ table: unknown; payload: Record<string, unknown>; condition: unknown }> = [];
		const tx = {
			update: vi.fn((table: unknown) => ({
				set: (payload: Record<string, unknown>) => ({
					where: (condition: unknown) => ({
						returning: async () => {
							updates.push({ table, payload, condition });
							return [];
						},
					}),
				}),
			})),
		};
		const plan = {
			lifecycle: {
				storyId: 'story_alpha',
				activeThreadIds: ['thread_current'],
				dormantThreadIds: ['thread_dormant'],
				retiredThreadIds: [],
				desiredEventIds: [],
				now: '2026-08-24T00:00:00.000Z',
				serverVersion: 9,
			},
			storyThreads: [],
			storyThreadUpdates: [],
			storyEvents: [],
			npcEventLinks: [],
			patchProposals: [],
			warnings: [],
		} satisfies PlotBrainReconciliationPlan;

		const result = await applyPlotBrainReconciliationPlan(plan, { db: tx as never });

		expect(result.retiredStoryThreads).toBe(0);
		expect(updates.some(update => update.table === storyThreads)).toBe(false);
		const eventRetirement = updates.find(update => update.table === storyEvents && update.payload.status === 'cancelled');
		expect(sqlExpressionIncludes(eventRetirement?.condition, 'thread_current')).toBe(true);
		expect(sqlExpressionIncludes(eventRetirement?.condition, 'thread_dormant')).toBe(true);
		expect(sqlExpressionIncludes(eventRetirement?.condition, 'thread_unrelated')).toBe(false);
	});
});
