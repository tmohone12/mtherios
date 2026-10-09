import { describe, expect, it } from 'vitest';
import { strategicWorldFrameSchema } from '../sdk/schemas/strategicWorldBrain';
import { finalizeStrategicWorldFrame } from './strategicWorldFrame';
import type { StrategicWorldBrainInput } from '../context/strategicWorldBrainInput';

describe('finalizeStrategicWorldFrame', () => {
	it('fills stable ids and enforces the active plot budget', () => {
		const parsed = strategicWorldFrameSchema.parse({
			arcNumber: 2,
			publicSummary: 'Pressure rises.',
			plotCards: [
				{ title: 'Crown', kind: 'main_plot', urgency: 'immediate', sourceRefs: [{ sourceType: 'entry', sourceId: 'entry_1', label: 'Opening' }], pressureBeats: Array.from({ length: 5 }, (_, i) => ({ title: `Beat ${i}`, body: 'Pressure.' })) },
				{ title: 'Second Crown', kind: 'main_plot', urgency: 'immediate', sourceRefs: [{ sourceType: 'entry', sourceId: 'entry_1', label: 'Opening' }] },
				{ title: 'Debt', kind: 'subplot', urgency: 'emerging', sourceRefs: [{ sourceType: 'entry', sourceId: 'entry_1', label: 'Opening' }] },
				{ title: 'Rumor', kind: 'subplot', urgency: 'emerging', sourceRefs: [{ sourceType: 'entry', sourceId: 'entry_1', label: 'Opening' }] },
				{ title: 'Spare', kind: 'subplot', urgency: 'simmer' },
				{ title: 'Sixth', kind: 'subplot', urgency: 'simmer' },
				{ title: 'Discarded', kind: 'subplot', urgency: 'simmer' },
			],
			activationPlan: { activateNow: ['Crown', 'Second Crown', 'Debt', 'Rumor'], keepDormant: ['Spare'] },
			plotBrainWritePlan: { timelineEvents: [{ title: 'Duplicate', body: 'Do not keep.', plotCardId: 'Crown' }] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [{ arcNumber: 2 }],
			recentEntries: [{ id: 'entry_1' }],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards).toHaveLength(6);
		expect(frame.plotCards[0].id).toBe('plot_story_alpha_3_crown_1');
		expect(frame.plotCards[0].pressureBeats).toHaveLength(3);
		expect(frame.activationPlan.activateNow).toEqual([
			'plot_story_alpha_3_crown_1',
			'plot_story_alpha_3_debt_3',
			'plot_story_alpha_3_rumor_4',
		]);
		expect(frame.activationPlan.keepDormant).toEqual(['plot_story_alpha_3_spare_5']);
		expect(frame.plotBrainWritePlan.timelineEvents).toEqual([]);
	});

	it('recovers canon evidence and a bound antagonist without overriding an explicitly quiet frame', () => {
		const parsed = strategicWorldFrameSchema.parse({
			mainPlots: [{ title: 'The Hunt', linkedThreadIds: ['thread_hunt'] }],
			antagonistCandidates: [{
				id: 'ant_arke', name: 'Arke', role: 'primary_antagonist', motive: 'Find Vael',
				actorEntityId: 'entity_arke', plausibilityScore: 85, dramaticScore: 90, agencyRisk: 30,
				evidenceRefs: [{ sourceType: 'thread', sourceId: 'thread_hunt', label: 'The Hunt' }],
			}],
			plotCards: [{ id: 'plot_hunt', title: 'The Hunt', kind: 'main_plot', urgency: 'immediate', pressure: 90 }],
			activationPlan: { activateNow: [] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [],
			knownEntityIds: ['entity_arke'],
			knownFactionIds: [],
			knownThreadIds: ['thread_hunt'],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.activationPlan.activateNow).toEqual([]);
		expect(frame.plotCards[0].sourceRefs).toEqual([{ sourceType: 'thread', sourceId: 'thread_hunt', label: 'The Hunt' }]);
		expect(frame.plotCards[0].antagonistCandidateIds).toEqual(['ant_arke']);
	});

	it('keeps a semantically adjacent card dormant when its antagonist has no canon evidence', () => {
		const parsed = strategicWorldFrameSchema.parse({
			antagonistCandidates: [{
				id: 'ant_agent', name: "The Empress's Agent", role: 'pressure_actor',
				actorFactionId: 'faction_leng', motive: 'Break the alliance', method: 'Sabotage the egg',
			}],
			plotCards: [{
				id: 'plot_sabotage', title: 'Shadow over the egg',
				logline: 'An agent plans to sabotage the dragon egg during the ceremony.',
				antagonistCandidateIds: ['ant_agent'],
			}],
			activationPlan: { activateNow: ['plot_sabotage'] },
		});
		const input = {
			story: { id: 'story_alpha' }, trigger: 'manual', currentArc: null,
			currentArcChapters: [], recentArcs: [],
			recentEntries: [{ id: 'entry_egg', content: 'The dragon egg is displayed while the court discusses a future ceremony and the Leng embassy watches.' }],
			characters: [], factions: [{ id: 'faction_leng' }], storyThreads: [],
			knownEntityIds: [], knownFactionIds: ['faction_leng'], knownThreadIds: [],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].antagonistCandidateIds).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual([]);
	});

	it('keeps only a known durable story-thread identity and recovers it from legacy evidence', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [
				{ id: 'renamed', storyThreadId: 'thread_hunt', title: 'The Hunter Changes Course' },
				{ id: 'legacy', title: 'The Old Hunt', sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_hunt', label: 'The Hunt' }] },
				{ id: 'invented', storyThreadId: 'thread_invented', title: 'Unsupported Thread' },
			],
			activationPlan: { activateNow: ['renamed', 'legacy', 'invented'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [],
			knownThreadIds: ['thread_hunt'],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);
		const cards = frame.plotCards as Array<{ storyThreadId?: string | null }>;

		expect(cards.map(card => card.storyThreadId)).toEqual(['thread_hunt', 'thread_hunt', null]);
		expect(frame.activationPlan.activateNow).toEqual(['renamed', 'legacy']);
	});

	it('recovers a durable thread from the previous card id or unique title when the model omits it', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [
				{ id: 'plot_hunt', title: 'The Hunter Changes Course' },
				{ id: 'new_debt_id', title: 'The Old Debt' },
			],
			activationPlan: { activateNow: ['plot_hunt', 'new_debt_id'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [],
			storyThreads: [
				{ id: 'thread_hunt', description: 'The Hunt' },
				{ id: 'thread_debt', description: 'The Old Debt' },
			],
			knownThreadIds: ['thread_hunt', 'thread_debt'],
			previousStrategicFrame: {
				plotCards: [
					{ id: 'plot_hunt', storyThreadId: 'thread_hunt', title: 'The Hunt', sourceRefs: [] },
					{ id: 'plot_debt', storyThreadId: 'thread_debt', title: 'The Old Debt', sourceRefs: [] },
				],
			},
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards.map(card => card.storyThreadId)).toEqual(['thread_hunt', 'thread_debt']);
		expect(frame.plotCards.map(card => card.sourceRefs[0]?.sourceId)).toEqual(['thread_hunt', 'thread_debt']);
	});

	it('does not resurrect a terminal previous thread outside the canonical allowlist', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [{ id: 'plot_retired', title: 'The Retired Hunt' }],
			activationPlan: { activateNow: ['plot_retired'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [],
			storyThreads: [{ id: 'thread_retired', description: 'The Retired Hunt', status: 'closed' }],
			knownThreadIds: [],
			previousStrategicFrame: {
				plotCards: [{ id: 'plot_retired', storyThreadId: 'thread_retired', title: 'The Retired Hunt', sourceRefs: [] }],
			},
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].storyThreadId).toBeNull();
		expect(frame.activationPlan.activateNow).toEqual([]);
	});

	it('does not treat a source-free story thread as activating evidence', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [{ id: 'plot_invented', storyThreadId: 'thread_invented', title: 'The Invented Threat' }],
			activationPlan: { activateNow: ['plot_invented'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [],
			storyThreads: [{ id: 'thread_invented', description: 'A source-free generated theory.', status: 'open' }],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].storyThreadId).toBeNull();
		expect(frame.plotCards[0].sourceRefs).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual([]);
	});

	it('does not treat a known actor as evidence for semantically unsupported pressure', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [
				{ id: 'plot_rias', title: 'Rias asks for an answer', actorEntityIds: ['entity_rias'] },
				{ id: 'plot_orphan', title: 'Unsupported pressure' },
			],
			activationPlan: { activateNow: ['plot_rias', 'plot_orphan'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [
				{ id: 'entry_old', content: 'Rias attends an ordinary council session.' },
				{ id: 'entry_latest', content: 'The player studies a quiet training yard.' },
			],
			knownEntityIds: ['entity_rias'],
			knownFactionIds: [],
			knownThreadIds: [],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].sourceRefs).toEqual([]);
		expect(frame.plotCards[1].sourceRefs).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual([]);
	});

	it('keeps a target-only card inactive when its actor is not canon-bound', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [{
				id: 'plot_unknown_hunter',
				title: 'An unknown hunter targets Rias',
				actorEntityIds: ['entity_unknown'],
				targetEntityIds: ['entity_rias'],
			}],
			activationPlan: { activateNow: ['plot_unknown_hunter'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [{ id: 'entry_latest' }],
			knownEntityIds: ['entity_rias'],
			knownFactionIds: [],
			knownThreadIds: [],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].actorEntityIds).toEqual([]);
		expect(frame.plotCards[0].targetEntityIds).toEqual(['entity_rias']);
		expect(frame.plotCards[0].sourceRefs).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual([]);
	});

	it('does not turn a supported scene topic into evidence for an unsupported twist', () => {
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [
				{
					id: 'plot_marriage_offer',
					title: 'The Emperor Offers His Daughter',
					logline: 'The court weighs the emperor daughter marriage alliance.',
					kind: 'main_plot',
					urgency: 'emerging',
					sourceRefs: [{ sourceType: 'entry', sourceId: 'entry_canon', label: 'The accepted offer' }],
				},
				{
					id: 'plot_poison_twist',
					title: 'Poison at the Imperial Marriage',
					logline: 'A hidden assassin uses the emperor daughter wedding alliance to poison Mei Lin.',
					kind: 'subplot',
				},
			],
			activationPlan: { activateNow: ['plot_marriage_offer', 'plot_poison_twist'] },
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentChapters: [],
			recentArcs: [],
			recentEntries: [
				{ id: 'entry_canon', content: 'The emperor offers his daughter Mei Lin in marriage, and the court accepts the alliance.' },
				{ id: 'entry_latest', content: 'The family continues its private discussion without incident.' },
			],
			characters: [],
			factions: [],
			storyThreads: [],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.plotCards[0].sourceRefs).toEqual([
			{ sourceType: 'entry', sourceId: 'entry_canon', label: 'The accepted offer' },
		]);
		expect(frame.plotCards[1].sourceRefs).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual(['plot_marriage_offer']);
	});

	it('makes active, dormant, and retired cards disjoint with terminal state taking priority', () => {
		const sourceRefs = [{ sourceType: 'entry' as const, sourceId: 'entry_1', label: 'Current canon' }];
		const parsed = strategicWorldFrameSchema.parse({
			plotCards: [
				{ id: 'plot_active', title: 'Active Plot', sourceRefs },
				{ id: 'plot_retired', title: 'Retired Plot', sourceRefs },
				{ id: 'plot_dormant', title: 'Dormant Plot', lifecycleStage: 'dormant', sourceRefs },
				{ id: 'plot_resolved', title: 'Resolved Plot', lifecycleStage: 'resolved', sourceRefs },
				{ id: 'plot_closing', storyThreadId: 'thread_closing', title: 'Closing Plot', sourceRefs },
			],
			activationPlan: {
				activateNow: ['plot_active', 'plot_retired', 'plot_dormant', 'plot_resolved', 'plot_closing'],
				keepDormant: ['plot_active', 'plot_retired', 'plot_dormant'],
				retireOrMerge: ['plot_retired'],
			},
			plotBrainWritePlan: {
				storyThreadUpdates: [{ threadId: 'thread_closing', status: 'closed' }],
			},
		});
		const input = {
			story: { id: 'story_alpha' },
			trigger: 'manual',
			currentArc: null,
			currentArcChapters: [],
			recentArcs: [],
			recentEntries: [{ id: 'entry_1', content: 'Current canon supports these plot cards.' }],
			knownThreadIds: ['thread_closing'],
			previousStrategicFrame: null,
		} as unknown as StrategicWorldBrainInput;

		const frame = finalizeStrategicWorldFrame(input, parsed as never);

		expect(frame.activationPlan.activateNow).toEqual(['plot_active']);
		expect(frame.activationPlan.keepDormant).toEqual(['plot_dormant']);
		expect(frame.activationPlan.retireOrMerge).toEqual(['plot_retired', 'plot_resolved', 'plot_closing']);
		expect(new Set([
			...frame.activationPlan.activateNow,
			...frame.activationPlan.keepDormant,
			...frame.activationPlan.retireOrMerge,
		]).size).toBe(5);
	});
});
