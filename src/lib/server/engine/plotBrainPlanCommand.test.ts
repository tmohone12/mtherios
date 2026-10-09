import { describe, expect, it } from 'vitest';
import {
	persistStrategicPlotBrainFrame,
	runPlotBrainPlanCommand,
	selectStrategicAgreementRows,
	selectStrategicEventRows,
	selectStrategicFactionRows,
	selectStrategicRecentEntries,
	selectStrategicThreadRows,
	strategicTrigger,
} from './serviceCommands';
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

function sqlExpressionIncludes(value: unknown, expected: unknown, seen = new WeakSet<object>()): boolean {
	if (value === expected) return true;
	if (Array.isArray(value)) return value.some(item => sqlExpressionIncludes(item, expected, seen));
	if (typeof value === 'string' && typeof expected === 'string') return value.includes(expected);
	if (!value || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	return Object.values(value as Record<string, unknown>).some(child => sqlExpressionIncludes(child, expected, seen));
}

describe('runPlotBrainPlanCommand', () => {
	it('preserves scheduled and world-tick triggers for logs and generated frames', () => {
		expect(strategicTrigger('scheduled_refresh')).toBe('scheduled_refresh');
		expect(strategicTrigger('world_tick')).toBe('world_tick');
	});

	it('filters OOC correction pairs before taking the recent Plot Director transcript window', () => {
		const rows = [
			...Array.from({ length: 40 }, (_, index) => ({
				id: `ooc_${index}`, type: 'user_action', content: `GM: correction ${index}`,
				parentId: null, metadata: {},
			})),
			{ id: 'entry_canon', type: 'narration', content: 'The emperor offers his daughter.', parentId: null, metadata: {} },
		];

		expect(selectStrategicRecentEntries(rows as never).map(row => row.id)).toEqual(['entry_canon']);
	});

	it('filters scratch and unpromoted auto-tag factions before the top-40 Plot Director limit', () => {
		const rows = [
			...Array.from({ length: 40 }, (_, index) => ({
				id: `veil_scratch_${index}`, status: 'active', entityId: null,
				metadata: { scratchSeed: true },
			})),
			{ id: 'faction_house_belaerys', status: 'active', entityId: null, metadata: {} },
			{ id: 'faction_valyrian_tag', status: 'active', entityId: null, metadata: { sourceType: 'character_faction_tag' } },
		];

		expect(selectStrategicFactionRows(rows as never, new Map()).map(row => row.id)).toEqual(['faction_house_belaerys']);
	});

	it('excludes source-free threads plus non-canon and ineligible events', () => {
		const threads = [
			{ id: 'thread_grounded', sourceEntryIds: ['entry_1'], sourceEventIds: [], sourcePatchIds: [] },
			{ id: 'thread_invented', sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] },
		];
		const events = [
			{ id: 'signal_auto_tag', type: 'faction_signal', status: 'committed', factionIds: ['faction_auto'], metadata: { sourceType: 'terminal_world_sim_signal' } },
			{ id: 'move_real', type: 'faction_move', status: 'scheduled', factionIds: ['faction_real'], metadata: { sourceType: 'terminal_world_sim_tick' } },
			{ id: 'scene_event', type: 'reveal', status: 'committed', factionIds: ['faction_auto'], metadata: {} },
			{ id: 'player_background', type: 'scheme', status: 'committed', factionIds: [], actorEntityIds: ['player'], metadata: { sourceType: 'npc_independent_action' } },
			{ id: 'npc_background', type: 'scheme', status: 'committed', factionIds: [], actorEntityIds: ['npc'], metadata: { sourceType: 'npc_independent_action' } },
			{ id: 'cancelled_poison', type: 'faction_move', status: 'cancelled', factionIds: ['faction_real'], metadata: { sourceType: 'terminal_world_sim_tick' } },
			{ id: 'proposed_reveal', type: 'reveal', status: 'proposed', factionIds: [], metadata: {} },
			{ id: 'superseded_reveal', type: 'reveal', status: 'committed', factionIds: [], metadata: { superseded: true } },
			{ id: 'non_canon_reveal', type: 'reveal', status: 'committed', factionIds: [], metadata: { nonCanon: true } },
			{ id: 'ooc_reveal', type: 'reveal', status: 'committed', factionIds: [], metadata: { actionType: 'ooc' } },
		];

		expect(selectStrategicThreadRows(threads as never).map(row => row.id)).toEqual(['thread_grounded']);
		expect(selectStrategicEventRows(events as never, new Set(['faction_real']), 'player').map(row => row.id))
			.toEqual(['move_real', 'scene_event', 'npc_background']);
	});

	it('keeps only unresolved agreements in the Plot Director input', () => {
		const agreements = [
			{ id: 'active', status: 'active' },
			{ id: 'contested', status: 'contested' },
			{ id: 'fulfilled', status: 'fulfilled' },
			{ id: 'broken', status: 'broken' },
			{ id: 'archived', status: 'archived' },
		];

		expect(selectStrategicAgreementRows(agreements as never).map(row => row.id)).toEqual(['active', 'contested']);
	});

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

	it('passes the exact stale draft id into the pending-frame CAS replacement', async () => {
		const persisted: Array<Record<string, unknown>> = [];

		await runPlotBrainPlanCommand({
			storyId: 'story_alpha', trigger: 'manual', execute: false, replacePendingFrameId: 'frame_stale',
		}, {
			loadInput: async () => ({ ...input, story: { ...input.story, serverVersion: 4 } } as StrategicWorldBrainInput),
			planner: { plan: async () => frame },
			buildPlan: () => ({
				storyThreads: [], storyThreadUpdates: [], storyEvents: [], npcEventLinks: [], patchProposals: [], warnings: [],
			} as unknown as PlotBrainReconciliationPlan),
			persistFrame: async (value) => { persisted.push(value as unknown as Record<string, unknown>); },
		});

		expect(persisted).toEqual([
			expect.objectContaining({ status: 'pending', baseServerVersion: 4, replaceStalePendingFrameId: 'frame_stale' }),
		]);
	});

	it('regenerates and applies a stale background draft under the exact pending-frame CAS', async () => {
		const calls: string[] = [];

		await runPlotBrainPlanCommand({
			storyId: 'story_alpha', trigger: 'scheduled_refresh', execute: true, replacePendingFrameId: 'frame_stale',
		}, {
			loadInput: async () => ({ ...input, story: { ...input.story, serverVersion: 4 } } as StrategicWorldBrainInput),
			planner: { plan: async () => frame },
			buildPlan: () => ({
				storyThreads: [], storyThreadUpdates: [], storyEvents: [], npcEventLinks: [], patchProposals: [], warnings: [],
			} as unknown as PlotBrainReconciliationPlan),
			applyPlan: async () => ({
				retiredStoryThreads: 0, retiredStoryEvents: 0, reactivatedStoryEvents: 0, storyThreads: 0,
				storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: [],
			}),
			persistFrame: async ({ status, expectedPendingFrameId, replaceStalePendingFrameId, serverVersion }) => {
				calls.push(`${status}:${expectedPendingFrameId}:${replaceStalePendingFrameId}:${serverVersion}`);
			},
			enqueueStoryVaultSync: async () => 'job_sync',
		});

		expect(calls).toEqual(['applied:null:frame_stale:5']);
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
				return { retiredStoryThreads: 0, retiredStoryEvents: 0, reactivatedStoryEvents: 0, storyThreads: 0, storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: plan.warnings };
			},
			persistFrame: async ({ frame: persistedFrame, serverVersion, expectedPendingFrameId }) => {
				calls.push(`persist:${persistedFrame.id}:${serverVersion}:${String(expectedPendingFrameId)}`);
			},
			enqueueStoryVaultSync: async ({ serverVersion, payload }) => {
				calls.push(`sync:${serverVersion}:${String(payload.clean)}:${String(payload.index)}`);
				return 'job_plot_sync';
			},
		});

		expect(calls).toEqual(['apply:quiet board', 'persist:frame_alpha:2:null', 'sync:2:true:true']);
		expect(result).toEqual(expect.objectContaining({
			executed: true,
			applied: expect.objectContaining({ warnings: ['quiet board'] }),
			storyVaultSyncJobId: 'job_plot_sync',
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
				return { retiredStoryThreads: 0, retiredStoryEvents: 0, reactivatedStoryEvents: 0, storyThreads: 0, storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: [] };
			},
			persistFrame: async ({ status, serverVersion, expectedPendingFrameId }) => { calls.push(`persist:${status}:${serverVersion}:${expectedPendingFrameId}`); },
			enqueueStoryVaultSync: async ({ serverVersion, reason, payload }) => {
				calls.push(`sync:${serverVersion}:${reason}:${String(payload.frameId)}`);
				return 'job_plot_sync';
			},
		});

		expect(calls).toEqual([
			'draft:story_alpha:frame_alpha',
			'reconcile:12',
			'apply',
			'persist:applied:5:frame_alpha',
			'sync:5:plot-brain-apply:frame_alpha',
		]);
		expect(result).toEqual(expect.objectContaining({
			executed: true,
			pending: false,
			frameId: 'frame_alpha',
			currentTurn: 12,
			storyVaultSyncJobId: 'job_plot_sync',
		}));
	});

	it('does not enqueue projection work when the pending-frame CAS fails', async () => {
		const calls: string[] = [];

		await expect(runPlotBrainPlanCommand({ storyId: 'story_alpha', execute: true, frameId: 'frame_alpha' }, {
			loadDraft: async () => ({ frame, currentTurn: 12, baseServerVersion: 4, serverVersion: 4 }),
			buildPlan: () => ({
				storyThreads: [], storyThreadUpdates: [], storyEvents: [], npcEventLinks: [], patchProposals: [], warnings: [],
			} as unknown as PlotBrainReconciliationPlan),
			applyPlan: async () => {
				calls.push('apply');
				return { retiredStoryThreads: 0, retiredStoryEvents: 0, reactivatedStoryEvents: 0, storyThreads: 0, storyThreadUpdates: 0, storyEvents: 0, npcEventLinks: 0, patchProposals: 0, warnings: [] };
			},
			persistFrame: async () => {
				calls.push('persist');
				throw new Error('Story changed while the plot frame was being planned or applied. Draft again.');
			},
			enqueueStoryVaultSync: async () => {
				calls.push('sync');
				return 'job_should_not_exist';
			},
		})).rejects.toThrow('Story changed');

		expect(calls).toEqual(['apply', 'persist']);
	});

	it('persists a generated draft only when the database still has no competing pending frame', async () => {
		let updateCondition: unknown;
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{ metadata: {}, serverVersion: 4 }] }),
				}),
			}),
			update: () => ({
				set: () => ({
					where: (condition: unknown) => ({
						returning: async () => {
							updateCondition = condition;
							return [{ id: 'story_alpha' }];
						},
					}),
				}),
			}),
		};

		await persistStrategicPlotBrainFrame({
			storyId: 'story_alpha', frame, serverVersion: 4, baseServerVersion: 4,
			currentTurn: 12, now: '2026-08-31T00:00:00.000Z', status: 'pending',
		}, db as never);

		expect(sqlExpressionIncludes(updateCondition, 'pendingFrameId')).toBe(true);
		expect(sqlExpressionIncludes(updateCondition, 'jsonb_typeof')).toBe(true);
		expect(sqlExpressionIncludes(updateCondition, 'null')).toBe(true);
	});

	it('applies a stored draft only when the exact pending frame still exists', async () => {
		let updateCondition: unknown;
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{
						metadata: { plotBrain: { pendingFrameId: 'frame_alpha', pendingFrame: frame } },
						serverVersion: 4,
					}] }),
				}),
			}),
			update: () => ({
				set: () => ({
					where: (condition: unknown) => ({
						returning: async () => {
							updateCondition = condition;
							return [{ id: 'story_alpha' }];
						},
					}),
				}),
			}),
		};

		await persistStrategicPlotBrainFrame({
			storyId: 'story_alpha', frame, serverVersion: 5, baseServerVersion: 4,
			currentTurn: 12, now: '2026-08-31T00:00:00.000Z', status: 'applied',
			expectedPendingFrameId: 'frame_alpha',
		}, db as never);

		expect(sqlExpressionIncludes(updateCondition, 'pendingFrameId')).toBe(true);
		expect(sqlExpressionIncludes(updateCondition, 'pendingFrame')).toBe(true);
		expect(sqlExpressionIncludes(updateCondition, 'frame_alpha')).toBe(true);
	});

	it('atomically replaces only the exact stale pending draft', async () => {
		let updateCondition: unknown;
		const staleFrame = { ...frame, id: 'frame_stale' };
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{
						metadata: { plotBrain: { pendingFrameId: 'frame_stale', pendingFrame: staleFrame, pendingBaseServerVersion: 3 } },
						serverVersion: 4,
					}] }),
				}),
			}),
			update: () => ({
				set: () => ({
					where: (condition: unknown) => ({
						returning: async () => {
							updateCondition = condition;
							return [{ id: 'story_alpha' }];
						},
					}),
				}),
			}),
		};

		await persistStrategicPlotBrainFrame({
			storyId: 'story_alpha', frame, serverVersion: 4, baseServerVersion: 4,
			currentTurn: 12, now: '2026-08-31T00:00:00.000Z', status: 'pending',
			replaceStalePendingFrameId: 'frame_stale',
		}, db as never);

		expect(sqlExpressionIncludes(updateCondition, 'frame_stale')).toBe(true);
		expect(sqlExpressionIncludes(updateCondition, 'pendingFrameId')).toBe(true);
	});

	it('replaces a reviewed current draft only when its id and story version match', async () => {
		const freshFrame = { ...frame, id: 'frame_fresh' };
		let updateCondition: unknown;
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{
						metadata: { plotBrain: { pendingFrameId: 'frame_fresh', pendingFrame: freshFrame, pendingBaseServerVersion: 4 } },
						serverVersion: 4,
					}] }),
				}),
			}),
			update: () => ({ set: () => ({ where: (condition: unknown) => ({ returning: async () => {
				updateCondition = condition;
				return [{ id: 'story_alpha' }];
			} }) }) }),
		};

		await persistStrategicPlotBrainFrame({
			storyId: 'story_alpha', frame, serverVersion: 4, baseServerVersion: 4,
			currentTurn: 12, now: '2026-08-31T00:00:00.000Z', status: 'pending',
			replaceStalePendingFrameId: 'frame_fresh',
		}, db as never);
		expect(sqlExpressionIncludes(updateCondition, 'frame_fresh')).toBe(true);
	});
});
