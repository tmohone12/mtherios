import { describe, expect, it, vi } from 'vitest';
import {
	applyPlotBrainReconciliationPlan,
	buildPlotBrainReconciliationPlan,
	type PlotBrainReconciliationPlan,
} from './reconciler';
import type { StrategicWorldFrame } from '$lib/types';
import { npcEventLinks, patchProposals, storyEvents, storyThreads } from '$lib/server/db/schema';

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
		expect(plan.storyThreads[0]).toMatchObject({
			id: 'plot_thread_story_alpha_plot_flour_ring',
			storyId: 'story_alpha',
			status: 'open',
			significance: 'major',
			relatedFactionIds: ['faction_merchants', 'faction_watch'],
			relatedEntityIds: ['npc_mara', 'npc_baker'],
			sourceEntryIds: ['entry_7'],
			sourceEventIds: ['event_7'],
		});
		expect(plan.storyThreads[0].description).toContain('The Flour Ring');
		expect(plan.storyThreads[0].description).toContain('Goal: Raise prices');
		expect(plan.storyThreads[0].description).toContain('Agency guard: Offer clues and costs');

		expect(plan.storyEvents[0]).toMatchObject({
			id: 'plot_event_story_alpha_frame_1_plot_flour_ring_0',
			storyId: 'story_alpha',
			type: 'clue_discovery',
			status: 'scheduled',
			title: 'Bread prices rise before dawn',
			scheduledTurn: 12,
			threadIds: ['plot_thread_story_alpha_plot_flour_ring'],
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
				eventId: 'plot_event_story_alpha_frame_1_plot_flour_ring_0',
				npcEntityId: 'npc_mara',
				role: 'actor',
			}),
			expect.objectContaining({
				eventId: 'plot_event_story_alpha_frame_1_plot_flour_ring_0',
				npcEntityId: 'npc_baker',
				role: 'target',
			}),
		]));
	});

	it('activates no cards when activateNow is empty', () => {
		const frame = makeFrame({
			plotCards: [makeCard()],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: '' },
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyThreads).toHaveLength(0);
		expect(plan.storyEvents).toHaveLength(0);
		expect(plan.warnings).toContain('No plot cards were activated; reconciliation produced no new story threads.');
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

		expect(plan.storyThreads.map(row => row.id)).toEqual([
			'plot_thread_story_alpha_shared_plot_1',
			'plot_thread_story_alpha_shared_plot_2',
		]);
		expect(plan.storyEvents.map(row => row.id)).toEqual([
			'plot_event_story_alpha_frame_1_shared_plot_1_0',
			'plot_event_story_alpha_frame_1_shared_plot_2_0',
		]);
	});

	it('keeps thread identity but schedules fresh beats for a new frame', () => {
		const frame = makeFrame({
			plotCards: [makeCard({ pressureBeats: [makeBeat()] })],
			activationPlan: { activateNow: ['plot_card'], keepDormant: [], retireOrMerge: [], rationale: '' },
		});
		const first = buildPlotBrainReconciliationPlan({ frame });
		const second = buildPlotBrainReconciliationPlan({ frame: { ...frame, id: 'frame_2' } });

		expect(second.storyThreads[0].id).toBe(first.storyThreads[0].id);
		expect(second.storyEvents[0].id).not.toBe(first.storyEvents[0].id);
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

	it('records the story scope and rejects blank thread updates', () => {
		const frame = makeFrame({
			plotBrainWritePlan: {
				storyThreadCreates: [],
				storyThreadUpdates: [
					{ threadId: ' thread_1 ', status: 'open', reason: 'Still active.' },
					{ threadId: ' ', status: 'closed', reason: 'Invalid.' },
				],
				timelineEvents: [],
				patchProposals: [],
			},
		});

		const plan = buildPlotBrainReconciliationPlan({ frame });

		expect(plan.storyThreadUpdates).toEqual([
			expect.objectContaining({ storyId: 'story_alpha', threadId: 'thread_1' }),
		]);
		expect(plan.warnings).toContain('Ignored 1 story thread update(s) with blank IDs.');
	});

	it('uses a supplied transaction and reports only rows actually changed', async () => {
		const insertedCounts = new Map<unknown, number>([
			[storyThreads, 0],
			[storyEvents, 1],
			[npcEventLinks, 0],
			[patchProposals, 1],
		]);
		const where = vi.fn(() => ({ returning: async () => [{ id: 'thread_1' }] }));
		const tx = {
			insert: vi.fn((table: unknown) => ({
				values: () => ({
					onConflictDoUpdate: () => ({
						returning: async () => Array.from({ length: insertedCounts.get(table) ?? 0 }, (_, id) => ({ id })),
					}),
					onConflictDoNothing: () => ({
						returning: async () => Array.from({ length: insertedCounts.get(table) ?? 0 }, (_, id) => ({ id })),
					}),
				}),
			})),
			update: vi.fn(() => ({ set: () => ({ where }) })),
		};
		const plan = {
			storyThreads: [{}],
			storyThreadUpdates: [{ storyId: 'story_alpha', threadId: 'thread_1', updates: {} }],
			storyEvents: [{}, {}],
			npcEventLinks: [{}],
			patchProposals: [{}],
			warnings: [],
		} as unknown as PlotBrainReconciliationPlan;

		const result = await applyPlotBrainReconciliationPlan(plan, { db: tx as never });

		expect(result).toEqual({
			storyThreads: 0,
			storyThreadUpdates: 1,
			storyEvents: 1,
			npcEventLinks: 0,
			patchProposals: 1,
			warnings: [],
		});
		expect(where).toHaveBeenCalledOnce();
	});
});
