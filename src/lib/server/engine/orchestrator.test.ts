import { describe, expect, it } from 'vitest';
import {
	ORCHESTRATOR_AGENT_ROLES,
	buildEngineOrchestratorPlan,
	runEngineOrchestrator,
} from './orchestrator';

describe('engine AI orchestrator', () => {
	it('defines GameMaster and its bounded helpers', () => {
		expect(ORCHESTRATOR_AGENT_ROLES.map((role) => role.id)).toEqual([
			'game_master',
			'memory_context',
			'player_guidance',
		]);
	});

	it('builds a turn orchestration plan from existing backend service tools', () => {
		const plan = buildEngineOrchestratorPlan({
			storyId: 'story_alpha',
			mode: 'turn',
			goal: 'Prepare the next text RPG response.',
			playerText: 'I ask who benefits from the marriage.',
			clientTurnId: 'turn_1',
			context: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'faction_harbor'],
				memoryTokenBudget: 640,
				contextBudget: 8000,
			},
		});

		expect(plan.roles.map((role) => role.id)).toEqual([
			'game_master',
			'memory_context',
			'player_guidance',
		]);
			expect(plan.steps.map((step) => [step.id, step.toolCallIds.length])).toEqual([
			['situation', 3],
			['dialogue', 1],
			['location', 1],
			['plot', 2],
			['narrate', 1],
		]);
		expect(plan.toolCalls.map((call) => [call.agentRole, call.command])).toEqual([
			['memory_context', 'campaign.status'],
			['game_master', 'campaign.page.read'],
			['game_master', 'timeline.brief'],
			['game_master', 'timeline.brief'],
			['memory_context', 'memory.retrieve'],
			['game_master', 'turn.prepare'],
			['game_master', 'campaign.cacheStatus'],
			['game_master', 'turn.submit'],
		]);
		expect(new Set(plan.toolCalls.map((call) => call.agentRole))).toEqual(new Set([
			'game_master',
			'memory_context',
		]));
		expect(plan.toolCalls.find((call) => call.command === 'campaign.page.read')?.args).toEqual({
			kind: 'rules_page',
			path: 'rules/default.md',
			missingOk: true,
		});
		expect(plan.toolCalls.find((call) => call.command === 'turn.prepare')?.args).toEqual({
			playerText: 'I ask who benefits from the marriage.',
			clientTurnId: 'turn_1',
			clientContext: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'faction_harbor'],
				memoryTokenBudget: 640,
				contextBudget: 8000,
			},
		});
	});

	it('plans a lore curation pass over the linked markdown wiki before proposing edits', () => {
		const plan = buildEngineOrchestratorPlan({
			storyId: 'story_alpha',
			mode: 'lore_curation',
			goal: 'Connect the harbor marriage pact pages to House Balaerys and NPC memory.',
			context: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'faction_harbor'],
				memoryTokenBudget: 640,
				contextBudget: 18000,
			},
		});

		expect(plan.roles.map((role) => role.id)).toContain('memory_context');
		expect(plan.toolCalls.map((call) => [call.agentRole, call.command])).toEqual([
			['memory_context', 'wiki.brief'],
			['memory_context', 'wiki.pages'],
			['memory_context', 'campaign.status'],
			['memory_context', 'memory.retrieve'],
		]);
		expect(plan.toolCalls[0].args).toEqual(expect.objectContaining({
			query: 'Connect the harbor marriage pact pages to House Balaerys and NPC memory.',
			followDepth: 2,
			maxChars: 18000,
		}));
		expect(plan.toolCalls.find((call) => call.command === 'wiki.pages')?.args).toEqual({
			orphans: true,
			limit: 80,
			sort: 'title',
		});
	});

	it('uses the active strategic frame during world ticks without regenerating it', () => {
		const plan = buildEngineOrchestratorPlan({
			storyId: 'story_alpha',
			mode: 'world_tick',
			goal: 'Advance off-screen pressure.',
			context: {
				currentTurn: 12,
				currentWorldTime: 'Dusk of the Glass Moon',
				includeSecret: true,
				contextBudget: 12000,
			},
		});

		expect(plan.toolCalls.map((call) => [call.agentRole, call.command])).toEqual([
			['memory_context', 'timeline.brief'],
			['game_master', 'jobs.worldSim'],
			['game_master', 'campaign.status'],
		]);
		expect(plan.toolCalls.some((call) => call.command === 'plotBrain.plan')).toBe(false);
	});

	it('executes planned tool calls through the supplied backend command runner', async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await runEngineOrchestrator({
			storyId: 'story_alpha',
			mode: 'turn',
			goal: 'Prepare the next text RPG response.',
			playerText: 'I ask who benefits from the marriage.',
			clientTurnId: 'turn_1',
			execute: true,
		}, {
			runTool: async (call) => {
				calls.push({ command: call.command, args: call.args });
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;
				return {
					commandId: `cmd_${call.id}`,
					clientCommandId: null,
					storyId: 'story_alpha',
					command: call.command,
					status: 'succeeded',
					result: { ok: true, command: call.command },
					projectionChanges: {},
					error: null,
					createdAt: '2026-06-06T00:00:00.000Z',
					updatedAt: '2026-06-06T00:00:00.000Z',
				};
			},
		});

		expect(calls.map((call) => call.command)).toEqual([
			'campaign.status',
			'campaign.page.read',
			'timeline.brief',
			'memory.retrieve',
			'turn.prepare',
			'timeline.brief',
			'campaign.cacheStatus',
			'turn.submit',
		]);
		expect(maxInFlight).toBe(3);
		expect(result.executed).toBe(true);
		expect(result.toolResults).toHaveLength(8);
		expect(result.toolResults.every((toolResult) => toolResult.status === 'succeeded')).toBe(true);
	});

	it('reserves turn.submit when a legacy caller sets a low tool-call cap', async () => {
		const calls: string[] = [];
		const result = await runEngineOrchestrator({
			storyId: 'story_alpha',
			mode: 'turn',
			goal: 'Continue the scene.',
			playerText: 'I open the sealed letter.',
			maxToolCalls: 1,
			execute: true,
		}, {
			runTool: async (call) => {
				calls.push(call.command);
				return {
					commandId: `cmd_${call.id}`,
					clientCommandId: null,
					storyId: 'story_alpha',
					command: call.command,
					status: 'succeeded',
					result: { ok: true },
					projectionChanges: {},
					error: null,
					createdAt: '2026-06-06T00:00:00.000Z',
					updatedAt: '2026-06-06T00:00:00.000Z',
				};
			},
		});

		expect(calls).toEqual(['turn.submit']);
		expect(result.steps.map((step) => step.id)).toEqual(['narrate']);
		expect(result.executed).toBe(true);
	});
});
