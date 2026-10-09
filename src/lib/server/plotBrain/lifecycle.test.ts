import { describe, expect, it } from 'vitest';
import {
	collectRetiredPlotDirectives,
	playerRequestsPlotRetirement,
	plotBrainLifecycleState,
} from './lifecycle';

const frame = {
	mainPlots: [{ title: 'The Ashen Crown', summary: 'A blockade tightens.' }],
	plotCards: [{ id: 'plot_ashen', title: 'Ash at the Gate', logline: 'The gate closes at dusk.' }],
};

describe('Plot Director lifecycle', () => {
	it('distinguishes fresh, stale, pending, and quiet campaign states', () => {
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 8 } }, 10)).toMatchObject({
			fresh: true,
			shouldPlan: false,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 8, needsDevelopment: true } }, 10)).toMatchObject({
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 8 } }, 16)).toMatchObject({
			fresh: true,
			shouldPlan: false,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 8 } }, 17)).toMatchObject({
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { lastFrame: frame } }, 10)).toMatchObject({
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 8 } }, 21)).toMatchObject({
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: frame, lastFrameTurn: 1 } }, 50)).toMatchObject({
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: false, lastFrame: frame, quietUntilTurn: 15 } }, 12)).toMatchObject({
			quiet: true,
			shouldPlan: false,
		});
		expect(plotBrainLifecycleState({ plotBrain: { active: false, lastFrame: frame, quietUntilTurn: 15 } }, 16)).toMatchObject({
			quiet: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: { pendingFrameId: 'frame_pending' } }, 16)).toMatchObject({
			hasPendingFrame: true,
			hasStoredPendingFrame: true,
			shouldPlan: false,
		});
		expect(plotBrainLifecycleState({ plotBrain: {
			pendingFrameId: 'frame_stale',
			pendingBaseServerVersion: 8,
		} }, 16, undefined, 9)).toMatchObject({
			hasPendingFrame: false,
			hasStoredPendingFrame: true,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: {
			lastFrame: frame,
			lastFrameTurn: 8,
			needsDevelopment: true,
			pendingFrameId: 'frame_pending',
		} }, 10)).toMatchObject({
			fresh: false,
			hasStoredPendingFrame: true,
			shouldPlan: false,
		});
	});

	it('recognizes explicit player vetoes without treating ordinary plot discussion as a command', () => {
		expect(playerRequestsPlotRetirement('OOC: please drop this plot. I am not interested in it.')).toBe(true);
		expect(playerRequestsPlotRetirement("Don't continue the current storyline.")).toBe(true);
		expect(playerRequestsPlotRetirement('This plot is not working.')).toBe(true);
		expect(playerRequestsPlotRetirement('Skip the harbor nonsense. This is done and going in circles.')).toBe(true);
		expect(playerRequestsPlotRetirement('Quit repeating this pressure and move on.')).toBe(true);
		expect(playerRequestsPlotRetirement('I ask Mara how she plans to stop the coup.')).toBe(false);
		expect(playerRequestsPlotRetirement('The plot thickens when the bell rings.')).toBe(false);
	});

	it('replans an imported frame whose active ids match no card or durable thread', () => {
		const imported = {
			...frame,
			plotCards: [{ ...frame.plotCards[0], id: 'import_a05', storyThreadId: 'thread_revenge' }],
			activationPlan: { activateNow: ['plot_nyessos_revenge'], keepDormant: [], retireOrMerge: [] },
		};

		expect(plotBrainLifecycleState({ plotBrain: { active: true, lastFrame: imported, lastFrameTurn: 9 } }, 10)).toMatchObject({
			active: false,
			fresh: false,
			shouldPlan: true,
		});
		expect(plotBrainLifecycleState({ plotBrain: {
			active: true,
			lastFrame: { ...imported, activationPlan: { ...imported.activationPlan, activateNow: ['thread_revenge'] } },
			lastFrameTurn: 9,
		} }, 10)).toMatchObject({ active: true, fresh: true, shouldPlan: false });
	});

	it('keeps compact, deduplicated directives so regenerated frames cannot reskin a vetoed plot', () => {
		expect(collectRetiredPlotDirectives(frame, ['The Ashen Crown'])).toEqual([
			'The Ashen Crown',
			'Ash at the Gate',
			'The gate closes at dusk.',
		]);
	});
});
