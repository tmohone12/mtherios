import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_WORLD_DATABASE_SCHEMA } from '$lib/server/db/worldDatabaseSchema';

async function importScriptModule(filePath: string): Promise<unknown> {
	const source = await readFile(resolve(process.cwd(), filePath), 'utf8');
	const importableSource = source.replace(/^#![^\n]*(\r?\n)/, '').replaceAll("'./runtime-config.mjs'", JSON.stringify(pathToFileURL(resolve('scripts/runtime-config.mjs')).href));
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
	it('publishes MythEngine aliases that use the same legacy command handlers', async () => {
		for (const tool of mcp.tools.filter(tool => tool.name.startsWith('mtherios_'))) {
			expect(mcp.tools.find(alias => alias.name === tool.name.replace('mtherios_', 'mythengine_'))?.inputSchema).toEqual(tool.inputSchema);
		}
		const requests: string[] = [];
		const requestJson = async (path: string) => { requests.push(path); return { ok: true }; };
		await mcp.callTool('mythengine_status', {}, { requestJson });
		await mcp.callTool('mtherios_status', {}, { requestJson });
		expect(requests).toEqual(['/api/app/status', '/api/app/status']);
	});

	it('publishes bounded capability tools and preserves empty-list clears on the wire', async () => {
		const schema = mcp.tools.find(tool => tool.name === 'mtherios_update_player_capabilities')!.inputSchema as any;
		expect(schema.anyOf).toEqual([{ required: ['abilities'] }, { required: ['buffs'] }]);
		expect(schema.properties.buffs).toMatchObject({ maxItems: 12, items: { maxLength: 300 } });
		const requests: any[] = [];
		const result = await mcp.callTool('mtherios_update_player_capabilities', { storyId: 'story_alpha', characterId: 'player', buffs: [], expectedVersion: 7, reason: 'Ward ended', clientCommandId: 'capability_clear' }, {
			requestJson: async (path, options) => {
				requests.push({ path, body: JSON.parse(String(options?.body)) });
				return { status: 'succeeded', result: { record: { id: 'player', type: 'character', name: 'Mira', state: { playerCapabilities: { abilities: ['Keen senses'], buffs: [] } } }, serverVersion: 8, patchId: 'patch_ward' } };
			},
		});
		expect(requests).toEqual([{ path: '/api/engine/command', body: { storyId: 'story_alpha', command: 'world.record.patch', clientCommandId: 'capability_clear', args: { type: 'characters', recordId: 'player', expectedVersion: 7, updates: { playerCapabilities: { buffs: [] } }, reason: 'Ward ended' } } }]);
		expect(result).toMatchObject({ playerCapabilities: { abilities: ['Keen senses'], buffs: [] }, serverVersion: 8, patchId: 'patch_ward' });
	});

	it('reads capabilities with story scope and returns backend failures as tool errors', async () => {
		const args = { storyId: 'story_alpha', characterId: 'player' };
		const result = await mcp.callTool('mtherios_get_player_capabilities', args, {
			requestJson: async (_path, options) => {
				expect(JSON.parse(String(options?.body))).toMatchObject({ storyId: 'story_alpha', command: 'world.record.get', args: { type: 'characters', recordId: 'player' } });
				return { status: 'succeeded', result: { record: { id: 'player', type: 'character', name: 'Mira', state: { playerCapabilities: { abilities: [], buffs: [] } }, metadata: { playerCapabilities: { buffs: ['Old ward'] } }, server_version: 8 } } };
			},
		});
		expect(result).toMatchObject({ playerCapabilities: { abilities: [], buffs: [] }, serverVersion: 8 });
		await expect(mcp.callTool('mtherios_get_player_capabilities', args, { requestJson: async () => ({ status: 'failed', error: 'Record not found' }) })).rejects.toThrow('Record not found');
		await expect(mcp.callTool('mtherios_update_player_capabilities', args)).rejects.toThrow('Supply abilities or buffs');
	});

	it('keeps the published MCP manifest in sync with tools/list', () => {
		expect(TERMINAL_WORLD_DATABASE_SCHEMA.mcp.tools).toEqual(mcp.tools.map((tool) => tool.name));
	});

	it('exposes engine command, timeline, and campaign page tools for sub-agents', () => {
		const names = new Set(mcp.tools.map((tool) => tool.name));

		expect(names).toContain('mtherios_engine_command');
		expect(names).toContain('mtherios_orchestrator_run');
		expect(names).toContain('mtherios_timeline_brief');
		expect(names).toContain('mtherios_timeline_schedule');
		expect(names).toContain('mtherios_inject_plot_direction');
		expect(names).toContain('mtherios_timeline_advance');
		expect(names).toContain('mtherios_read_campaign_page');
		expect(names).toContain('mtherios_write_campaign_page');
		expect(names).toContain('mtherios_update_llm_settings');
		expect(names).toContain('mtherios_draft_character_update');
		expect(names).toContain('mtherios_actor_brief');
		expect(names).toContain('mtherios_affinity_read');
		expect(names).toContain('mtherios_scene_check');
		expect(names).toContain('mtherios_relationship_web');
		expect(names).toContain('mtherios_thread_board');
		expect(names).toContain('mtherios_draft_character_create');
	});

	it('advertises the same practical argument bounds as the focused GM engine commands', () => {
		const schema = (name: string) => mcp.tools.find((tool) => tool.name === name)?.inputSchema as {
			anyOf?: Array<{ required: string[] }>;
			properties: Record<string, Record<string, unknown>>;
		};
		const actor = schema('mtherios_actor_brief');
		const affinity = schema('mtherios_affinity_read');
		const scene = schema('mtherios_scene_check');
		const relationships = schema('mtherios_relationship_web');
		const threads = schema('mtherios_thread_board');
		const character = schema('mtherios_draft_character_create');

		expect(actor.anyOf).toEqual([{ required: ['actorId'] }, { required: ['name'] }]);
		expect(actor.properties.name).toMatchObject({ minLength: 1 });
		expect(affinity.anyOf).toEqual([{ required: ['actorIds'] }, { required: ['actorNames'] }]);
		expect(affinity.properties.actorIds).toMatchObject({ minItems: 1, maxItems: 20 });
		expect(affinity.properties.actorNames).toMatchObject({ minItems: 1, maxItems: 20 });
		expect(affinity.properties.historyLimit).toMatchObject({ minimum: 0, maximum: 12, default: 5 });
		expect(scene.properties.actorIds).toMatchObject({ maxItems: 20 });
		expect(scene.properties.proposedAction).toMatchObject({ maxLength: 1200 });
		expect(relationships.anyOf).toEqual([{ required: ['actorIds'] }, { required: ['actorNames'] }]);
		expect(relationships.properties.actorIds).toMatchObject({ minItems: 1, maxItems: 10 });
		expect(relationships.properties.actorNames).toMatchObject({ minItems: 1, maxItems: 10 });
		expect(threads.properties.query).toMatchObject({ maxLength: 600 });
		expect(threads.properties.actorIds).toMatchObject({ maxItems: 20 });
		expect(threads.properties.factionIds).toMatchObject({ maxItems: 20 });
		expect(character.properties.name).toMatchObject({ minLength: 1, maxLength: 120 });
		expect(character.properties.role).toMatchObject({ minLength: 1, maxLength: 300 });
		expect(character.properties.backstory).toMatchObject({ minLength: 1, maxLength: 1600 });
		expect(character.properties.narrativePurpose).toMatchObject({ minLength: 1, maxLength: 800 });
		expect(character.properties.desire).toMatchObject({ maxLength: 500 });
		expect(character.properties.faction).toMatchObject({ maxLength: 240 });
	});

	it('advertises the full turn client context contract', () => {
		const turn = mcp.tools.find((tool) => tool.name === 'mtherios_run_turn')?.inputSchema as {
			properties: Record<string, Record<string, unknown>>;
		};
		const context = turn.properties.clientContext as {
			properties: Record<string, Record<string, unknown>>;
			additionalProperties: boolean;
		};

		expect(context.additionalProperties).toBe(false);
		expect(context.properties.memoryTokenBudget).toMatchObject({ type: 'integer', minimum: 160, maximum: 2400 });
		expect(context.properties.contextBudget).toMatchObject({ type: 'integer', minimum: 0, maximum: 200000 });
		expect(context.properties.chapterThreshold).toMatchObject({ type: 'integer', minimum: 5, maximum: 200 });
		expect(context.properties.postChapterBuffer).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
		expect(context.properties.chaptersPerArc).toMatchObject({ type: 'integer', minimum: 2, maximum: 50 });
		expect(context.properties.deferStateExtraction).toEqual({ type: 'boolean' });
	});

	it('advertises the complete orchestrator modes, roles, context, and defaults', () => {
		const orchestrator = mcp.tools.find((tool) => tool.name === 'mtherios_orchestrator_run')?.inputSchema as {
			properties: Record<string, Record<string, unknown>>;
		};
		const context = orchestrator.properties.context as {
			properties: Record<string, Record<string, unknown>>;
			default: Record<string, unknown>;
			additionalProperties: boolean;
		};
		const roles = orchestrator.properties.roles as {
			items: { enum: string[] };
		};

		expect(orchestrator.properties.mode.enum).toEqual(['turn', 'world_tick', 'audit', 'memory', 'lore_curation', 'custom']);
		expect(roles.items.enum).toEqual([
			'dm_narrator',
			'rules_referee',
			'state_scribe',
			'lorekeeper',
			'lore_curator',
			'faction_simulator',
			'npc_memory',
			'continuity_auditor',
		]);
		expect(context.additionalProperties).toBe(false);
		expect(context.default).toEqual({
			sceneEntityIds: [],
			presentNpcIds: [],
			threadIds: [],
			includeSecret: false,
		});
		expect(context.properties.memoryTokenBudget).toMatchObject({ minimum: 0, maximum: 100000 });
		expect(context.properties.contextBudget).toMatchObject({ minimum: 1, maximum: 1000000 });
		expect(context.properties.entryLimit).toMatchObject({ minimum: 1, maximum: 200 });
		expect(orchestrator.properties.maxToolCalls).toMatchObject({ minimum: 1, maximum: 20, default: 8 });
	});

	it('advertises canonical timeline event and visibility values', () => {
		const timeline = mcp.tools.find((tool) => tool.name === 'mtherios_timeline_schedule')?.inputSchema as {
			properties: Record<string, Record<string, unknown>>;
		};

		expect(timeline.properties.type.enum).toEqual([
			'promise',
			'betrayal',
			'reveal',
			'faction_move',
			'faction_signal',
			'injury',
			'death',
			'relationship_shift',
			'agreement',
			'scene_transition',
			'clue_discovery',
			'correction',
			'imported_memory',
			'world_tick',
			'scheme',
			'rumor',
			'marriage',
			'alliance',
		]);
		expect(timeline.properties.title).toMatchObject({ minLength: 1 });
		expect(timeline.properties.body).toMatchObject({ minLength: 1 });
		expect(timeline.properties.visibility).toEqual({
			type: 'string',
			enum: ['public', 'player_known', 'secret'],
			default: 'player_known',
		});
	});

	it('advertises the LLM patch bounds enforced by the backend', () => {
		const update = mcp.tools.find((tool) => tool.name === 'mtherios_update_llm_settings')?.inputSchema as {
			properties: Record<string, Record<string, unknown>>;
		};
		const settings = update.properties.settings as {
			items: { properties: Record<string, Record<string, unknown>> };
		};
		const secrets = update.properties.secrets as {
			items: { properties: Record<string, Record<string, unknown>> };
		};
		const fields = settings.items.properties;

		expect(fields.serviceId).toMatchObject({ minLength: 1 });
		expect(fields.providerType).toMatchObject({ minLength: 1 });
		expect(fields.temperature).toMatchObject({ minimum: 0, maximum: 2 });
		expect(fields.maxTokens).toMatchObject({ minimum: 128, maximum: 65536 });
		expect(fields.topP).toMatchObject({ minimum: 0, maximum: 1 });
		expect(fields.frequencyPenalty).toMatchObject({ minimum: -2, maximum: 2 });
		expect(fields.presencePenalty).toMatchObject({ minimum: -2, maximum: 2 });
		expect(fields.contextBudget).toMatchObject({ minimum: 1 });
		expect(secrets.items.properties.ref).toMatchObject({ minLength: 1 });
		expect(secrets.items.properties.value).toMatchObject({ minLength: 1 });
	});

	it('rejects missing GM tool targets before calling the engine gateway', async () => {
		let requestCount = 0;
		const requestJson = async () => {
			requestCount += 1;
			return { status: 'succeeded' };
		};

		await expect(mcp.callTool('mtherios_actor_brief', {
			storyId: 'story_alpha',
			name: '   ',
		}, { requestJson })).rejects.toThrow('actorId or name is required.');
		await expect(mcp.callTool('mtherios_affinity_read', {
			storyId: 'story_alpha',
			actorIds: [],
			actorNames: ['   '],
		}, { requestJson })).rejects.toThrow('At least one actor is required.');
		await expect(mcp.callTool('mtherios_relationship_web', {
			storyId: 'story_alpha',
			actorIds: [],
			actorNames: ['   '],
		}, { requestJson })).rejects.toThrow('At least one actor is required.');
		expect(requestCount).toBe(0);
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

	it('bounds external canonical search payloads and directs callers to focused record reads', async () => {
		const rows = Array.from({ length: 50 }, (_, index) => ({
			source: 'keyword',
			score: 0.55,
			recordType: 'events',
			recordId: `event_${index}`,
			title: `Event ${index}`,
			record: {
				id: `event_${index}`,
				body: `Important event ${index}. ${'oversized private state '.repeat(1000)}`,
				metadata: { raw: 'x'.repeat(10_000) },
			},
		}));

		const result = await mcp.callTool('mtherios_search', {
			storyId: 'story_alpha',
			q: 'important event',
			limit: 50,
		}, {
			requestJson: async () => ({ storyId: 'story_alpha', query: 'important event', results: rows }),
		}) as any;

		expect(JSON.stringify(result).length).toBeLessThanOrEqual(24_000);
		expect(result.resultCount).toBe(50);
		expect(result.returnedResultCount).toBeLessThan(50);
		expect(result.omittedResultCount).toBeGreaterThan(0);
		expect(result.truncated).toBe(true);
		expect(result.results[0]).toEqual(expect.objectContaining({
			recordId: 'event_0',
			title: 'Event 0',
		}));
		expect(result.results[0]).not.toHaveProperty('record');
	});

	it('routes LLM setting writes to the terminal settings API', async () => {
		const requests: Array<{ path: string; method: unknown; body: unknown }> = [];
		await mcp.callTool('mtherios_update_llm_settings', {
			settings: [{
				serviceId: 'narrative',
				providerType: 'openrouter',
				model: 'anthropic/claude-sonnet-4',
			}],
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({
					path: requestPath,
					method: options.method,
					body: JSON.parse(String(options.body)),
				});
				return { settings: [] };
			},
		});

		expect(requests).toEqual([{
			path: '/api/settings/llm',
			method: 'PATCH',
			body: {
				settings: [{
					serviceId: 'narrative',
					providerType: 'openrouter',
					model: 'anthropic/claude-sonnet-4',
				}],
			},
		}]);
	});

	it('routes character draft updates through the shared engine command gateway', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_draft_character_update', {
			storyId: 'story_alpha',
			recordId: 'npc_mira',
			instructions: 'Refresh Mira from recent context.',
			recentLimit: 24,
			clientCommandId: 'cmd_mira_update',
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { proposalId: 'proposal_mira', status: 'pending' };
			},
		});

		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'world.character.draftUpdate',
				clientCommandId: 'cmd_mira_update',
				args: {
					recordId: 'npc_mira',
					instructions: 'Refresh Mira from recent context.',
					recentLimit: 24,
				},
			},
		}]);
	});

	it('routes the focused GM read tools through the shared engine command gateway', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		const requestJson = async (requestPath: string, options: Record<string, unknown> = {}) => {
			requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
			return { ok: true };
		};

		await mcp.callTool('mtherios_actor_brief', {
			storyId: 'story_alpha',
			name: 'Mira',
			eventLimit: 6,
		}, { requestJson });
		await mcp.callTool('mtherios_affinity_read', {
			storyId: 'story_alpha',
			actorNames: ['Mira'],
			historyLimit: 3,
		}, { requestJson });
		await mcp.callTool('mtherios_scene_check', {
			storyId: 'story_alpha',
			actorNames: ['Mira'],
			locationName: 'Harbor Court',
			availableMinutes: 30,
		}, { requestJson });
		await mcp.callTool('mtherios_relationship_web', {
			storyId: 'story_alpha',
			actorNames: ['Mira', 'Harbor Lord'],
			depth: 2,
		}, { requestJson });
		await mcp.callTool('mtherios_thread_board', {
			storyId: 'story_alpha',
			query: 'marriage',
			factionIds: ['faction_harbor'],
			limit: 8,
		}, { requestJson });

		expect(requests.map((request) => request.path)).toEqual(Array(5).fill('/api/engine/command'));
		expect(requests.map((request) => (request.body as { command: string }).command)).toEqual([
			'world.actor.brief',
			'world.affinity.read',
			'world.scene.check',
			'world.relationship.web',
			'plot.thread.board',
		]);
		expect(requests[1]?.body).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			args: {
				actorNames: ['Mira'],
				historyLimit: 3,
			},
		}));
		expect(requests[2]?.body).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			args: {
				actorNames: ['Mira'],
				locationName: 'Harbor Court',
				availableMinutes: 30,
			},
		}));
	});

	it('routes story-conditioned character creation as a reviewable draft', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_draft_character_create', {
			storyId: 'story_alpha',
			name: 'Tala Venn',
			role: 'harbor courier',
			backstory: 'Raised among the tide warehouses and knows every smuggler route.',
			narrativePurpose: 'Carry contradictory evidence between two rival houses.',
			desire: 'Buy her family out of debt.',
			faction: 'Harbor Guild',
			clientCommandId: 'cmd_create_tala',
		}, {
			requestJson: async (requestPath, options = {}) => {
				requests.push({ path: requestPath, body: JSON.parse(String(options.body)) });
				return { proposalId: 'proposal_tala', status: 'pending' };
			},
		});

		expect(requests).toEqual([{
			path: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'world.character.draftCreate',
				clientCommandId: 'cmd_create_tala',
				args: {
					name: 'Tala Venn',
					role: 'harbor courier',
					backstory: 'Raised among the tide warehouses and knows every smuggler route.',
					narrativePurpose: 'Carry contradictory evidence between two rival houses.',
					desire: 'Buy her family out of debt.',
					faction: 'Harbor Guild',
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

	it('routes MCP plot direction injection through the GM timeline', async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		await mcp.callTool('mtherios_inject_plot_direction', {
			storyId: 'story_alpha',
			title: 'The sealed letter reaches court',
			direction: 'Bring the blackmail letter into the next court scene.',
			narratorDirective: 'Reveal pressure through servants and glances, not exposition.',
			urgency: 'immediate',
			factionIds: ['faction_harbor'],
			clientCommandId: 'cmd_plot_direction',
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
				clientCommandId: 'cmd_plot_direction',
				args: {
					type: 'scheme',
					title: 'The sealed letter reaches court',
					body: 'Bring the blackmail letter into the next court scene.\nNarrator directive: Reveal pressure through servants and glances, not exposition.\nUrgency: immediate',
					delayTurns: 0,
					factionIds: ['faction_harbor'],
					visibility: 'secret',
					memoryImpact: {
						plotDirection: true,
						urgency: 'immediate',
					},
					metadata: {
						source: 'mcp_plot_direction',
						urgency: 'immediate',
						narratorDirective: 'Reveal pressure through servants and glances, not exposition.',
					},
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
