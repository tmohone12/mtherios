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

	it('recovers canon evidence, an active main plot, and a bound antagonist', () => {
		const parsed = strategicWorldFrameSchema.parse({
			mainPlots: [{ title: 'The Hunt', linkedThreadIds: ['thread_hunt'] }],
			antagonistCandidates: [{
				id: 'ant_arke', name: 'Arke', role: 'primary_antagonist', motive: 'Find Vael',
				actorEntityId: 'entity_arke', plausibilityScore: 85, dramaticScore: 90, agencyRisk: 30,
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

		expect(frame.activationPlan.activateNow).toEqual(['plot_hunt']);
		expect(frame.plotCards[0].sourceRefs).toEqual([{ sourceType: 'thread', sourceId: 'thread_hunt', label: 'The Hunt' }]);
		expect(frame.plotCards[0].antagonistCandidateIds).toEqual(['ant_arke']);
	});
});
