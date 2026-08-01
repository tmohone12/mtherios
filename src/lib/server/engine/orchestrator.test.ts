import { describe, expect, it } from 'vitest';
import {
	ORCHESTRATOR_AGENT_ROLES,
	buildEngineOrchestratorPlan,
	runEngineOrchestrator,
} from './orchestrator';

describe('engine AI orchestrator', () => {
	it('defines the backend RPG agent roles from the target architecture', () => {
		expect(ORCHESTRATOR_AGENT_ROLES.map((role) => role.id)).toEqual([
			'dm_narrator',
			'rules_referee',
			'state_scribe',
			'lorekeeper',
			'lore_curator',
			'faction_simulator',
			'npc_memory',
			'continuity_auditor',
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
			'dm_narrator',
			'rules_referee',
			'state_scribe',
			'lorekeeper',
			'lore_curator',
			'faction_simulator',
			'npc_memory',
			'continuity_auditor',
		]);
		expect(plan.toolCalls.map((call) => [call.agentRole, call.command])).toEqual([
			['lorekeeper', 'campaign.status'],
			['rules_referee', 'campaign.page.read'],
			['state_scribe', 'timeline.brief'],
			['faction_simulator', 'timeline.brief'],
			['npc_memory', 'memory.retrieve'],
			['dm_narrator', 'turn.prepare'],
			['continuity_auditor', 'campaign.cacheStatus'],
		]);
		expect(new Set(plan.toolCalls.map((call) => call.agentRole))).toEqual(new Set([
			'dm_narrator',
			'rules_referee',
			'state_scribe',
			'lorekeeper',
			'faction_simulator',
			'npc_memory',
			'continuity_auditor',
		]));
		expect(plan.toolCalls.find((call) => call.agentRole === 'rules_referee')?.args).toEqual({
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

		expect(plan.roles.map((role) => role.id)).toContain('lore_curator');
		expect(plan.toolCalls.map((call) => [call.agentRole, call.command])).toEqual([
			['lore_curator', 'wiki.brief'],
			['lore_curator', 'wiki.pages'],
			['lore_curator', 'wiki.lint'],
			['lorekeeper', 'campaign.status'],
			['npc_memory', 'memory.retrieve'],
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
			['lorekeeper', 'timeline.brief'],
			['faction_simulator', 'jobs.worldSim'],
			['continuity_auditor', 'campaign.status'],
		]);
		expect(plan.toolCalls.some((call) => call.command === 'plotBrain.plan')).toBe(false);
	});

	it('executes planned tool calls through the supplied backend command runner', async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
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
			'timeline.brief',
			'memory.retrieve',
			'turn.prepare',
			'campaign.cacheStatus',
		]);
		expect(result.executed).toBe(true);
		expect(result.toolResults).toHaveLength(7);
		expect(result.toolResults.every((toolResult) => toolResult.status === 'succeeded')).toBe(true);
	});
});
