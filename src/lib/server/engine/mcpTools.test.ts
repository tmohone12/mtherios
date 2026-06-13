import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function importScriptModule(filePath: string): Promise<unknown> {
	const source = await readFile(resolve(process.cwd(), filePath), 'utf8');
	const importableSource = source.replace(/^#![^\n]*(\r?\n)/, '');
	return import(`data:text/javascript;base64,${Buffer.from(importableSource).toString('base64')}`);
}

// @ts-ignore The MCP server is a plain ESM script module exercised through Vitest.
const mcp = (await importScriptModule('scripts/mtherios-mcp.mjs')) as {
	tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
	callTool: (
		name: string,
		args: Record<string, unknown>,
		options?: {
			requestJson?: (requestPath: string, options?: Record<string, unknown>) => Promise<unknown>;
		},
	) => Promise<unknown>;
};

describe('mtherios MCP engine tools', () => {
	it('exposes engine command, timeline, and campaign page tools for sub-agents', () => {
		const names = new Set(mcp.tools.map((tool) => tool.name));

		expect(names).toContain('mtherios_engine_command');
		expect(names).toContain('mtherios_orchestrator_run');
		expect(names).toContain('mtherios_timeline_brief');
		expect(names).toContain('mtherios_timeline_schedule');
		expect(names).toContain('mtherios_timeline_advance');
		expect(names).toContain('mtherios_read_campaign_page');
		expect(names).toContain('mtherios_write_campaign_page');
	});

	it('routes generic engine commands to the backend command envelope', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		const result = await mcp.callTool('mtherios_engine_command', {
			storyId: 'story_alpha',
			command: 'timeline.brief',
			clientCommandId: 'cmd_agent_brief',
			args: {
				dueLimit: 2,
				includeSecret: true,
			},
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({
					path: requestPath,
					body: JSON.parse(String(options.body)),
				});
				return { ok: true, status: 'succeeded' };
			},
		});

		expect(result).toEqual({ ok: true, status: 'succeeded' });
		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'timeline.brief',
				clientCommandId: 'cmd_agent_brief',
				args: {
					dueLimit: 2,
					includeSecret: true,
				},
			},
		}]);
	});

	it('routes orchestrator tool calls through the shared engine command gateway', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_orchestrator_run', {
			storyId: 'story_alpha',
			mode: 'turn',
			goal: 'Prepare the next text RPG response.',
			playerText: 'I ask who benefits from the marriage.',
			clientTurnId: 'turn_agent_1',
			execute: false,
			context: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'faction_harbor'],
				memoryTokenBudget: 640,
				contextBudget: 8000,
			},
			clientCommandId: 'cmd_orchestrator',
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { ok: true };
			},
		});

		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'orchestrator.run',
				clientCommandId: 'cmd_orchestrator',
				args: {
					mode: 'turn',
					goal: 'Prepare the next text RPG response.',
					playerText: 'I ask who benefits from the marriage.',
					clientTurnId: 'turn_agent_1',
					execute: false,
					context: {
						presentNpcIds: ['npc_mira'],
						sceneEntityIds: ['npc_mira', 'faction_harbor'],
						memoryTokenBudget: 640,
						contextBudget: 8000,
					},
				},
			},
		}]);
	});

	it('routes legacy run-turn tool calls through the shared engine command gateway', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_run_turn', {
			storyId: 'story_alpha',
			clientTurnId: 'turn_mcp_1',
			playerText: 'I ask the harbor queen what she remembers.',
			localVersion: 8,
			clientContext: {
				presentNpcIds: ['npc_harbor_queen'],
				sceneEntityIds: ['npc_harbor_queen', 'location_docks'],
				threadIds: ['thread_alliance'],
			},
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { ok: true };
			},
		});

		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'turn.submit',
				clientCommandId: 'turn_mcp_1',
				args: {
					storyId: 'story_alpha',
					clientTurnId: 'turn_mcp_1',
					playerText: 'I ask the harbor queen what she remembers.',
					localVersion: 8,
					clientContext: {
						presentNpcIds: ['npc_harbor_queen'],
						sceneEntityIds: ['npc_harbor_queen', 'location_docks'],
						threadIds: ['thread_alliance'],
					},
				},
			},
		}]);
	});

	it('builds timeline schedule tool calls with delayed faction and NPC tags', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_timeline_schedule', {
			storyId: 'story_alpha',
			type: 'alliance',
			title: 'Marriage alliance',
			body: 'Two factions bind themselves by marriage.',
			delayTurns: 2,
			factionIds: ['faction_harbor', 'faction_mira'],
			actorNpcEntityIds: ['npc_mira'],
			targetNpcEntityIds: ['npc_harbor_lord'],
			clientCommandId: 'cmd_agent_schedule',
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { ok: true };
			},
		});

		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'timeline.schedule',
				clientCommandId: 'cmd_agent_schedule',
				args: {
					type: 'alliance',
					title: 'Marriage alliance',
					body: 'Two factions bind themselves by marriage.',
					delayTurns: 2,
					factionIds: ['faction_harbor', 'faction_mira'],
					actorNpcEntityIds: ['npc_mira'],
					targetNpcEntityIds: ['npc_harbor_lord'],
				},
			},
		}]);
	});

	it('routes campaign page writes through the vault page API', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_write_campaign_page', {
			storyId: 'story_alpha',
			kind: 'character_page',
			name: 'Mira of the Harbor',
			body: '## Looks\nSalt-dark hair.\n\n## Personality\nCalculating.',
			entityIds: ['npc_mira'],
			sourceEventIds: ['event_alliance'],
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { ok: true };
			},
		});

		expect(requests).toEqual([{
			path: '/api/stories/story_alpha/vault/page',
			body: {
				kind: 'character_page',
				name: 'Mira of the Harbor',
				body: '## Looks\nSalt-dark hair.\n\n## Personality\nCalculating.',
				entityIds: ['npc_mira'],
				sourceEventIds: ['event_alliance'],
			},
		}]);
	});
});
