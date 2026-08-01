import { describe, expect, it } from 'vitest';
import { runPlotBrainPlanCommand } from './serviceCommands';
import type { StrategicWorldBrainInput } from '$lib/services/ai/context/strategicWorldBrainInput';
import type { StrategicWorldFrame } from '$lib/types';
import type { PlotBrainReconciliationPlan } from '$lib/server/plotBrain/reconciler';

const input = {
	story: { id: 'story_alpha', title: 'Ashen Crown', description: null, genre: null, templateId: null, mode: 'adventure' },
	trigger: 'manual',
	currentArc: null,
	recentArcs: [],
	relevantOlderArcs: [],
	currentArcChapters: [],
	recentChapters: [],
	recentEntries: [],
	factions: [],
	characters: [],
	activeSchemes: [],
	recentlyResolvedSchemes: [],
	storyThreads: [],
	worldEvents: [],
	rumors: [],
	agreements: [],
	factionActions: [],
	playerLedger: null,
	playerReputation: null,
	previousStrategicFrame: null,
	mode: 'adventure',
	pov: 'second',
	tense: 'present',
	timeTracker: null,
} as unknown as StrategicWorldBrainInput;

const frame = {
	id: 'frame_alpha',
	storyId: 'story_alpha',
	arcId: null,
	arcNumber: 0,
	trigger: 'manual',
	chapterRange: { from: 0, to: 0 },
	createdAt: 1,
	continuityAssessment: { summary: '', unresolvedContinuityRisks: [], staleThreads: [], contradictionsToReview: [] },
	worldMood: { politicalTemperature: 'tense' },
	publicSummary: 'Public pressure rises.',
	hiddenStrategicSummary: 'Hidden pressure rises.',
	mainPlots: [],
	subplots: [],
	factionGoalUpdates: [],
	schemeDirectives: [],
	strategicClocks: [],
	factionOperations: [],
	warPressureCard: null,
	rumorSeeds: [],
	worldEventSuggestions: [],
	fastWorldSimInstructions: 'Make pressure visible through clues.',
	narratorPromptCard: 'Do not railroad.',
	canonPatchSuggestions: [],
	tensionSeeds: [],
	antagonistCandidates: [],
	plotCards: [{ id: 'card_1', title: 'The Glass Debt' }],
	activationPlan: { activateNow: ['card_1'], keepDormant: [], retireOrMerge: [], rationale: 'manual test' },
	plotBrainWritePlan: { storyThreadCreates: [], storyThreadUpdates: [], timelineEvents: [], patchProposals: [] },
} as unknown as StrategicWorldFrame;

describe('runPlotBrainPlanCommand', () => {
	it('loads context, calls the strategic brain, reconciles the frame, and returns review counts', async () => {
		const calls: string[] = [];
		const result = await runPlotBrainPlanCommand({ storyId: 'story_alpha', trigger: 'manual', execute: false }, {
			loadInput: async (args) => {
				calls.push(`load:${args.storyId}:${args.trigger}`);
				return input;
			},
			planner: { plan: async (actualInput) => {
				calls.push(`plan:${actualInput.story.id}`);
				return frame;
			} },
			buildPlan: (actual) => {
				calls.push(`reconcile:${actual.frame.id}:${actual.currentTurn}`);
				return {
					storyThreads: [{ id: 'thread_1' }],
					storyThreadUpdates: [],
					storyEvents: [{ id: 'event_1' }],
					npcEventLinks: [{ id: 'link_1' }],
					patchProposals: [{ id: 'patch_1' }],
					warnings: [],
				} as unknown as PlotBrainReconciliationPlan;
			},
			applyPlan: async () => {
				throw new Error('review-only mode should not apply writes');
			},
			persistFrame: async ({ frame: persistedFrame, status }) => {
				calls.push(`persist:${persistedFrame.id}:${status}`);
			},
		});

		expect(calls).toEqual(['load:story_alpha:manual', 'plan:story_alpha', 'reconcile:frame_alpha:0', 'persist:frame_alpha:pending']);
		expect(result).toEqual(expect.objectContaining({
			ok: true,
			storyId: 'story_alpha',
			frameId: 'frame_alpha',
			executed: false,
			plotCardCount: 1,
			threadCount: 1,
			eventCount: 1,
			npcEventLinkCount: 1,
			proposalCount: 1,
		}));
	});

	it('applies the reconciler plan only when execute is true', async () => {
		const calls: string[] = [];
		const result = await runPlotBrainPlanCommand({ storyId: 'story_alpha', trigger: 'manual', execute: true, currentTurn: 9 }, {
			loadInput: async () => input,
			planner: { plan: async () => frame },
			buildPlan: () => ({
				storyThreads: [],
				storyThreadUpdates: [],
				storyEvents: [],
				npcEventLinks: [],
				patchProposals: [],
				warnings: ['quiet board'],
			} as unknown as PlotBrainReconciliationPlan),
			applyPlan: async (plan) => {
				calls.push(`apply:${plan.warnings.join(',')}`);
				return { storyThreads: 0, storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: plan.warnings };
			},
			persistFrame: async ({ frame: persistedFrame, serverVersion }) => {
				calls.push(`persist:${persistedFrame.id}:${serverVersion}`);
			},
		});

		expect(calls).toEqual(['apply:quiet board', 'persist:frame_alpha:2']);
		expect(result).toEqual(expect.objectContaining({
			executed: true,
			applied: expect.objectContaining({ warnings: ['quiet board'] }),
		}));
	});

	it('applies the exact stored draft without calling the planner again', async () => {
		const calls: string[] = [];
		const result = await runPlotBrainPlanCommand({ storyId: 'story_alpha', execute: true, frameId: 'frame_alpha' }, {
			loadInput: async () => { throw new Error('exact apply should not reload planning context'); },
			planner: { plan: async () => { throw new Error('exact apply should not regenerate'); } },
			loadDraft: async (storyId, frameId) => {
				calls.push(`draft:${storyId}:${frameId}`);
				return { frame, currentTurn: 12, baseServerVersion: 4, serverVersion: 4 };
			},
			buildPlan: ({ currentTurn }) => {
				calls.push(`reconcile:${currentTurn}`);
				return { storyThreads: [], storyThreadUpdates: [], storyEvents: [], npcEventLinks: [], patchProposals: [], warnings: [] } as unknown as PlotBrainReconciliationPlan;
			},
			applyPlan: async () => {
				calls.push('apply');
				return { storyThreads: 0, storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: [] };
			},
			persistFrame: async ({ status, serverVersion }) => { calls.push(`persist:${status}:${serverVersion}`); },
		});

		expect(calls).toEqual(['draft:story_alpha:frame_alpha', 'reconcile:12', 'apply', 'persist:applied:5']);
		expect(result).toEqual(expect.objectContaining({ executed: true, pending: false, frameId: 'frame_alpha', currentTurn: 12 }));
	});
});
