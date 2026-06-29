#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const APP_URL = DEFAULT_URL.replace(/\/$/, '');
const SERVER_VERSION = '0.1.0';

export const tools = [
	{
		name: 'mtherios_status',
		description: 'Read the running Mtherios terminal process status.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_database_schema',
		description: 'Return the terminal world database and service schema.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_list_databases',
		description: 'List terminal world databases/stories in the running terminal process.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_create_database',
		description: 'Create an empty terminal world database/story shell.',
		inputSchema: {
			type: 'object',
			required: ['title'],
			properties: {
				title: { type: 'string' },
				description: { type: 'string' },
				genre: { type: 'string' },
				mode: { type: 'string', enum: ['adventure', 'creative-writing'] },
				headerPrompt: { type: 'string' },
				playerReputation: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_import_database',
		description: 'Import a terminal world database JSON bundle into Postgres through the running terminal process.',
		inputSchema: {
			type: 'object',
			required: ['filePath'],
			properties: {
				filePath: { type: 'string' },
				preserveIds: { type: 'boolean', default: true },
				replaceExisting: { type: 'boolean', default: false },
				syncWiki: { type: 'boolean', default: true },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_export_database',
		description: 'Export a terminal world database/story to a JSON file.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				outputPath: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_list_records',
		description: 'List canonical records from one terminal world database/story.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				type: { type: 'string', default: 'entities' },
				q: { type: 'string' },
				cursor: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_get_record',
		description: 'Read one canonical record with source evidence and patch refs when available.',
		inputSchema: {
			type: 'object',
			required: ['type', 'id'],
			properties: {
				type: { type: 'string' },
				id: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_patch_record',
		description: 'Safely edit one canonical record through the terminal patch/audit path.',
		inputSchema: {
			type: 'object',
			required: ['type', 'id', 'updates'],
			properties: {
				type: { type: 'string' },
				id: { type: 'string' },
				updates: { type: 'object' },
				reason: { type: 'string', default: 'Manual MCP edit.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_search',
		description: 'Search the terminal world database with keyword and optional semantic retrieval.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'q'],
			properties: {
				storyId: { type: 'string' },
				q: { type: 'string' },
				type: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
				includeSemantic: { type: 'boolean', default: true },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_run_turn',
		description: 'Run one terminal-owned story turn. Provider settings resolve on the terminal server, not in the MCP client.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'playerText'],
			properties: {
				storyId: { type: 'string' },
				playerText: { type: 'string' },
				clientTurnId: { type: 'string' },
				localVersion: { type: 'integer', minimum: 0, default: 0 },
				clientContext: {
					type: 'object',
					properties: {
						locationId: { type: ['string', 'null'] },
						sceneEntityIds: { type: 'array', items: { type: 'string' } },
						presentNpcIds: { type: 'array', items: { type: 'string' } },
						threadIds: { type: 'array', items: { type: 'string' } },
						currentFactionId: { type: ['string', 'null'] },
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_engine_command',
		description: 'Call the terminal-owned engine command envelope. Use for agent services that should share the gateway/control-surface backend.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'command'],
			properties: {
				storyId: { type: 'string' },
				command: { type: 'string' },
				args: { type: 'object' },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_draft_character_update',
		description: 'Draft a reviewable NPC/character state update from recent story context.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'recordId'],
			properties: {
				storyId: { type: 'string' },
				recordId: { type: 'string' },
				instructions: { type: 'string', default: 'Update this NPC from recent story context.' },
				recentLimit: { type: 'integer', minimum: 1, maximum: 80, default: 30 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_orchestrator_run',
		description: 'Run the terminal-owned AI orchestrator planner. It coordinates RPG agent roles and can execute existing backend services as engine tool calls.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'goal'],
			properties: {
				storyId: { type: 'string' },
				mode: { type: 'string', enum: ['turn', 'world_tick', 'audit', 'memory', 'custom'], default: 'turn' },
				goal: { type: 'string' },
				playerText: { type: 'string' },
				clientTurnId: { type: 'string' },
				context: { type: 'object' },
				roles: {
					type: 'array',
					items: {
						type: 'string',
						enum: ['dm_narrator', 'rules_referee', 'state_scribe', 'lorekeeper', 'faction_simulator', 'npc_memory', 'continuity_auditor'],
					},
				},
				execute: { type: 'boolean', default: false },
				maxToolCalls: { type: 'integer', minimum: 1, maximum: 20 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_timeline_brief',
		description: 'Query the GM timeline through the engine command envelope, including due, recent, scheduled, and NPC-linked events.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				presentNpcIds: { type: 'array', items: { type: 'string' } },
				sceneEntityIds: { type: 'array', items: { type: 'string' } },
				includeSecret: { type: 'boolean', default: false },
				currentTurn: { type: 'integer', minimum: 0 },
				dueLimit: { type: 'integer', minimum: 0, maximum: 200 },
				recentLimit: { type: 'integer', minimum: 0, maximum: 200 },
				scheduledLimit: { type: 'integer', minimum: 0, maximum: 200 },
				npcLimit: { type: 'integer', minimum: 0, maximum: 200 },
				npcEventLimit: { type: 'integer', minimum: 0, maximum: 200 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_timeline_schedule',
		description: 'Schedule a delayed in-world event with faction, NPC, location, and source tags through the engine command envelope.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'type', 'title', 'body'],
			properties: {
				storyId: { type: 'string' },
				type: { type: 'string' },
				title: { type: 'string' },
				body: { type: 'string' },
				delayTurns: { type: 'integer', minimum: 0, default: 0 },
				currentTurn: { type: 'integer', minimum: 0 },
				currentWorldTime: { type: ['string', 'null'] },
				worldTime: { type: ['string', 'null'] },
				actorEntityIds: { type: 'array', items: { type: 'string' } },
				targetEntityIds: { type: 'array', items: { type: 'string' } },
				actorNpcEntityIds: { type: 'array', items: { type: 'string' } },
				targetNpcEntityIds: { type: 'array', items: { type: 'string' } },
				locationId: { type: ['string', 'null'] },
				locationIds: { type: 'array', items: { type: 'string' } },
				factionIds: { type: 'array', items: { type: 'string' } },
				threadIds: { type: 'array', items: { type: 'string' } },
				visibility: { type: 'string' },
				memoryImpact: { type: 'object' },
				sourceEntryIds: { type: 'array', items: { type: 'string' } },
				sourcePatchIds: { type: 'array', items: { type: 'string' } },
				metadata: { type: 'object' },
				serverVersion: { type: 'integer', minimum: 1 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_inject_plot_direction',
		description: 'Inject narrator-facing plot direction by scheduling a secret or visible GM timeline event for an MCP/subagent plan.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'direction'],
			properties: {
				storyId: { type: 'string' },
				direction: { type: 'string' },
				title: { type: 'string' },
				narratorDirective: { type: 'string' },
				urgency: { type: 'string', enum: ['simmer', 'emerging', 'immediate'], default: 'emerging' },
				delayTurns: { type: 'integer', minimum: 0, default: 0 },
				currentTurn: { type: 'integer', minimum: 0 },
				currentWorldTime: { type: ['string', 'null'] },
				worldTime: { type: ['string', 'null'] },
				actorEntityIds: { type: 'array', items: { type: 'string' } },
				targetEntityIds: { type: 'array', items: { type: 'string' } },
				actorNpcEntityIds: { type: 'array', items: { type: 'string' } },
				targetNpcEntityIds: { type: 'array', items: { type: 'string' } },
				locationId: { type: ['string', 'null'] },
				locationIds: { type: 'array', items: { type: 'string' } },
				factionIds: { type: 'array', items: { type: 'string' } },
				threadIds: { type: 'array', items: { type: 'string' } },
				visibility: { type: 'string', enum: ['secret', 'player_known', 'public'], default: 'secret' },
				memoryImpact: { type: 'object' },
				metadata: { type: 'object' },
				serverVersion: { type: 'integer', minimum: 1 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_timeline_advance',
		description: 'Advance the campaign turn clock and promote due timeline events through the engine command envelope.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				delta: { type: 'integer', minimum: 0, default: 1 },
				presentNpcIds: { type: 'array', items: { type: 'string' } },
				sceneEntityIds: { type: 'array', items: { type: 'string' } },
				includeSecret: { type: 'boolean', default: false },
				dueLimit: { type: 'integer', minimum: 0, maximum: 200 },
				recentLimit: { type: 'integer', minimum: 0, maximum: 200 },
				scheduledLimit: { type: 'integer', minimum: 0, maximum: 200 },
				npcLimit: { type: 'integer', minimum: 0, maximum: 200 },
				npcEventLimit: { type: 'integer', minimum: 0, maximum: 200 },
				serverVersion: { type: 'integer', minimum: 1 },
				clientCommandId: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_read_campaign_page',
		description: 'Read one maintained campaign vault Markdown page from the terminal backend.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'kind'],
			properties: {
				storyId: { type: 'string' },
				kind: { type: 'string' },
				name: { type: 'string' },
				path: { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_write_campaign_page',
		description: 'Write one maintained campaign vault Markdown page through the terminal backend.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'kind', 'name', 'body'],
			properties: {
				storyId: { type: 'string' },
				kind: { type: 'string' },
				name: { type: 'string' },
				title: { type: ['string', 'null'] },
				body: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
				entityIds: { type: 'array', items: { type: 'string' } },
				factionIds: { type: 'array', items: { type: 'string' } },
				sourceEntryIds: { type: 'array', items: { type: 'string' } },
				sourceEventIds: { type: 'array', items: { type: 'string' } },
				sourcePatchIds: { type: 'array', items: { type: 'string' } },
				path: { type: 'string' },
				metadata: { type: 'object' },
				serverVersion: { type: 'integer', minimum: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_llm_settings',
		description: 'Read terminal-side LLM service settings and API key references.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_update_llm_settings',
		description: 'Update terminal-side LLM service settings through the same settings API used by the browser.',
		inputSchema: {
			type: 'object',
			required: ['settings'],
			properties: {
				settings: {
					type: 'array',
					items: {
						type: 'object',
						required: ['serviceId'],
						properties: {
							serviceId: { type: 'string' },
							providerType: { type: 'string' },
							baseUrl: { type: ['string', 'null'] },
							model: { type: ['string', 'null'] },
							temperature: { type: 'number' },
							maxTokens: { type: 'integer' },
							topP: { type: ['number', 'null'] },
							frequencyPenalty: { type: ['number', 'null'] },
							presencePenalty: { type: ['number', 'null'] },
							reasoningEffort: { type: ['string', 'null'] },
							contextBudget: { type: ['integer', 'null'] },
							enabled: { type: 'boolean' },
							systemPromptOverride: { type: ['string', 'null'] },
							apiKeyRef: { type: ['string', 'null'] },
							metadata: { type: 'object' },
						},
						additionalProperties: false,
					},
				},
				secrets: {
					type: 'array',
					items: {
						type: 'object',
						required: ['ref', 'value'],
						properties: {
							ref: { type: 'string' },
							value: { type: 'string' },
						},
						additionalProperties: false,
					},
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_api_call_logs',
		description: 'Read terminal engine API/provider call logs for timing and failures.',
		inputSchema: {
			type: 'object',
			properties: {
				storyId: { type: 'string' },
				status: { type: 'string', enum: ['success', 'error'] },
				serviceId: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_jobs',
		description: 'Read terminal backend job queue status.',
		inputSchema: {
			type: 'object',
			properties: {
				storyId: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 200, default: 80 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_reindex_story',
		description: 'Queue or run Qdrant/canonical search reindexing for one terminal world database.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				runNow: { type: 'boolean', default: false },
				recordTypes: { type: 'array', items: { type: 'string' } },
				recreate: { type: 'boolean', default: false },
				provider: { type: ['string', 'null'] },
				model: { type: ['string', 'null'] },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_sync_wiki',
		description: 'Regenerate the generated wiki projection, and optionally Qdrant/lint projections, from the terminal world database.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string' },
				index: { type: 'boolean', default: false },
				lint: { type: 'boolean', default: false },
				recreate: { type: 'boolean', default: false },
			},
			additionalProperties: false,
		},
	},
];

async function defaultRequestJson(requestPath, options = {}) {
	const response = await fetch(`${APP_URL}${requestPath}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.headers ?? {}),
		},
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 60_000)),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} ${requestPath}`);
	}
	return body;
}

function queryPath(requestPath, params = {}) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	const query = search.toString();
	return query ? `${requestPath}?${query}` : requestPath;
}

export async function callTool(name, args = {}, options = {}) {
	const requestJson = options.requestJson ?? defaultRequestJson;
	if (name === 'mtherios_status') return requestJson('/api/app/status', { timeoutMs: 15_000 });
	if (name === 'mtherios_database_schema') return requestJson('/api/database/schema', { timeoutMs: 15_000 });
	if (name === 'mtherios_list_databases') return requestJson('/api/stories', { timeoutMs: 30_000 });
	if (name === 'mtherios_create_database') {
		return requestJson('/api/stories', {
			method: 'POST',
			body: JSON.stringify({
				title: requiredString(args.title, 'title'),
				description: optionalString(args.description),
				genre: optionalString(args.genre),
				mode: optionalString(args.mode) || 'adventure',
				headerPrompt: optionalString(args.headerPrompt),
				playerReputation: optionalString(args.playerReputation),
			}),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_import_database') {
		const filePath = path.resolve(requiredString(args.filePath, 'filePath'));
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		const bundle = parsed && typeof parsed === 'object' && 'bundle' in parsed ? parsed.bundle : parsed;
		return requestJson('/api/database/import', {
			method: 'POST',
			body: JSON.stringify({
				bundle,
				options: {
					preserveIds: args.preserveIds !== false,
					replaceExisting: args.replaceExisting === true,
					syncWiki: args.syncWiki !== false,
					source: 'mcp',
				},
			}),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_export_database') {
		const storyId = requiredString(args.storyId, 'storyId');
		const payload = await requestJson(`/api/export/${encodeURIComponent(storyId)}`, { timeoutMs: 120_000 });
		const outputPath = path.resolve(optionalString(args.outputPath) || defaultExportName(payload));
		await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		return { ok: true, storyId, outputPath, exportedAt: new Date().toISOString() };
	}
	if (name === 'mtherios_list_records') {
		const storyId = requiredString(args.storyId, 'storyId');
		return requestJson(queryPath(`/api/stories/${encodeURIComponent(storyId)}/world`, {
			type: optionalString(args.type) || 'entities',
			q: optionalString(args.q),
			cursor: optionalString(args.cursor),
			limit: optionalInteger(args.limit, 50),
		}), { timeoutMs: 30_000 });
	}
	if (name === 'mtherios_get_record') {
		return requestJson(
			`/api/records/${encodeURIComponent(requiredString(args.type, 'type'))}/${encodeURIComponent(requiredString(args.id, 'id'))}`,
			{ timeoutMs: 30_000 },
		);
	}
	if (name === 'mtherios_patch_record') {
		return requestJson(
			`/api/records/${encodeURIComponent(requiredString(args.type, 'type'))}/${encodeURIComponent(requiredString(args.id, 'id'))}`,
			{
				method: 'PATCH',
				body: JSON.stringify({
					updates: requiredRecord(args.updates, 'updates'),
					reason: optionalString(args.reason) || 'Manual MCP edit.',
				}),
				timeoutMs: 60_000,
			},
		);
	}
	if (name === 'mtherios_search') {
		const storyId = requiredString(args.storyId, 'storyId');
		return requestJson(queryPath(`/api/stories/${encodeURIComponent(storyId)}/search`, {
			q: requiredString(args.q, 'q'),
			type: optionalString(args.type),
			limit: optionalInteger(args.limit, 12),
			semantic: args.includeSemantic === false ? 'false' : undefined,
		}), { timeoutMs: 60_000 });
	}
	if (name === 'mtherios_run_turn') {
		const storyId = requiredString(args.storyId, 'storyId');
		const clientTurnId = optionalString(args.clientTurnId) || `mcp_${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
		const turnArgs = {
			storyId,
			clientTurnId,
			playerText: requiredString(args.playerText, 'playerText'),
			localVersion: optionalInteger(args.localVersion, 0),
			clientContext: asRecord(args.clientContext),
		};
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify({
				storyId,
				command: 'turn.submit',
				clientCommandId: clientTurnId,
				args: turnArgs,
			}),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_engine_command') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify({
				storyId: requiredString(args.storyId, 'storyId'),
				command: requiredString(args.command, 'command'),
				clientCommandId: optionalString(args.clientCommandId),
				args: asRecord(args.args),
			}),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_draft_character_update') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.character.draftUpdate', {
				recordId: requiredString(args.recordId, 'recordId'),
				instructions: optionalString(args.instructions) || 'Update this NPC from recent story context.',
				recentLimit: optionalInteger(args.recentLimit, 30),
			})),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_orchestrator_run') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'orchestrator.run', {
				mode: optionalString(args.mode),
				goal: requiredString(args.goal, 'goal'),
				playerText: optionalString(args.playerText),
				clientTurnId: optionalString(args.clientTurnId),
				context: optionalRecord(args.context),
				roles: stringArray(args.roles),
				execute: typeof args.execute === 'boolean' ? args.execute : undefined,
				maxToolCalls: optionalPositiveInteger(args.maxToolCalls),
			})),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_timeline_brief') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'timeline.brief', {
				currentTurn: optionalNonnegativeInteger(args.currentTurn),
				presentNpcIds: stringArray(args.presentNpcIds),
				sceneEntityIds: stringArray(args.sceneEntityIds),
				includeSecret: args.includeSecret === true ? true : undefined,
				dueLimit: optionalNonnegativeInteger(args.dueLimit),
				recentLimit: optionalNonnegativeInteger(args.recentLimit),
				scheduledLimit: optionalNonnegativeInteger(args.scheduledLimit),
				npcLimit: optionalNonnegativeInteger(args.npcLimit),
				npcEventLimit: optionalNonnegativeInteger(args.npcEventLimit),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_timeline_schedule') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'timeline.schedule', {
				type: requiredString(args.type, 'type'),
				title: requiredString(args.title, 'title'),
				body: requiredString(args.body, 'body'),
				delayTurns: optionalNonnegativeInteger(args.delayTurns) ?? 0,
				currentTurn: optionalNonnegativeInteger(args.currentTurn),
				currentWorldTime: optionalNullableString(args.currentWorldTime),
				worldTime: optionalNullableString(args.worldTime),
				actorEntityIds: stringArray(args.actorEntityIds),
				targetEntityIds: stringArray(args.targetEntityIds),
				actorNpcEntityIds: stringArray(args.actorNpcEntityIds),
				targetNpcEntityIds: stringArray(args.targetNpcEntityIds),
				locationId: optionalNullableString(args.locationId),
				locationIds: stringArray(args.locationIds),
				factionIds: stringArray(args.factionIds),
				threadIds: stringArray(args.threadIds),
				visibility: optionalString(args.visibility),
				memoryImpact: optionalRecord(args.memoryImpact),
				sourceEntryIds: stringArray(args.sourceEntryIds),
				sourcePatchIds: stringArray(args.sourcePatchIds),
				metadata: optionalRecord(args.metadata),
				serverVersion: optionalPositiveInteger(args.serverVersion),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_inject_plot_direction') {
		const direction = requiredString(args.direction, 'direction');
		const urgency = optionalString(args.urgency) || 'emerging';
		const narratorDirective = optionalString(args.narratorDirective);
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'timeline.schedule', {
				type: 'scheme',
				title: optionalString(args.title) || 'MCP plot direction',
				body: [
					direction,
					narratorDirective ? `Narrator directive: ${narratorDirective}` : '',
					`Urgency: ${urgency}`,
				].filter(Boolean).join('\n'),
				delayTurns: optionalNonnegativeInteger(args.delayTurns) ?? 0,
				currentTurn: optionalNonnegativeInteger(args.currentTurn),
				currentWorldTime: optionalNullableString(args.currentWorldTime),
				worldTime: optionalNullableString(args.worldTime),
				actorEntityIds: stringArray(args.actorEntityIds),
				targetEntityIds: stringArray(args.targetEntityIds),
				actorNpcEntityIds: stringArray(args.actorNpcEntityIds),
				targetNpcEntityIds: stringArray(args.targetNpcEntityIds),
				locationId: optionalNullableString(args.locationId),
				locationIds: stringArray(args.locationIds),
				factionIds: stringArray(args.factionIds),
				threadIds: stringArray(args.threadIds),
				visibility: optionalString(args.visibility) || 'secret',
				memoryImpact: {
					...asRecord(args.memoryImpact),
					plotDirection: true,
					urgency,
				},
				metadata: {
					...asRecord(args.metadata),
					source: 'mcp_plot_direction',
					urgency,
					narratorDirective,
				},
				serverVersion: optionalPositiveInteger(args.serverVersion),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_timeline_advance') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'timeline.advance', {
				delta: optionalNonnegativeInteger(args.delta) ?? 1,
				presentNpcIds: stringArray(args.presentNpcIds),
				sceneEntityIds: stringArray(args.sceneEntityIds),
				includeSecret: args.includeSecret === true ? true : undefined,
				dueLimit: optionalNonnegativeInteger(args.dueLimit),
				recentLimit: optionalNonnegativeInteger(args.recentLimit),
				scheduledLimit: optionalNonnegativeInteger(args.scheduledLimit),
				npcLimit: optionalNonnegativeInteger(args.npcLimit),
				npcEventLimit: optionalNonnegativeInteger(args.npcEventLimit),
				serverVersion: optionalPositiveInteger(args.serverVersion),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_read_campaign_page') {
		const storyId = requiredString(args.storyId, 'storyId');
		return requestJson(queryPath(`/api/stories/${encodeURIComponent(storyId)}/vault/page`, {
			kind: requiredString(args.kind, 'kind'),
			name: optionalString(args.name),
			path: optionalString(args.path),
		}), { timeoutMs: 30_000 });
	}
	if (name === 'mtherios_write_campaign_page') {
		const storyId = requiredString(args.storyId, 'storyId');
		return requestJson(`/api/stories/${encodeURIComponent(storyId)}/vault/page`, {
			method: 'POST',
			body: JSON.stringify(compactRecord({
				kind: requiredString(args.kind, 'kind'),
				name: requiredString(args.name, 'name'),
				title: optionalNullableString(args.title),
				body: requiredString(args.body, 'body'),
				tags: stringArray(args.tags),
				entityIds: stringArray(args.entityIds),
				factionIds: stringArray(args.factionIds),
				sourceEntryIds: stringArray(args.sourceEntryIds),
				sourceEventIds: stringArray(args.sourceEventIds),
				sourcePatchIds: stringArray(args.sourcePatchIds),
				path: optionalString(args.path),
				metadata: optionalRecord(args.metadata),
				serverVersion: optionalPositiveInteger(args.serverVersion),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_llm_settings') return requestJson('/api/settings/llm', { timeoutMs: 15_000 });
	if (name === 'mtherios_update_llm_settings') {
		return requestJson('/api/settings/llm', {
			method: 'PATCH',
			body: JSON.stringify({
				settings: Array.isArray(args.settings) ? args.settings : [],
				secrets: Array.isArray(args.secrets) ? args.secrets : undefined,
			}),
			timeoutMs: 30_000,
		});
	}
	if (name === 'mtherios_api_call_logs') {
		return requestJson(queryPath('/api/api-call-logs', {
			storyId: optionalString(args.storyId),
			status: optionalString(args.status),
			serviceId: optionalString(args.serviceId),
			limit: optionalInteger(args.limit, 100),
		}), { timeoutMs: 30_000 });
	}
	if (name === 'mtherios_jobs') {
		return requestJson(queryPath('/api/jobs', {
			storyId: optionalString(args.storyId),
			limit: optionalInteger(args.limit, 80),
		}), { timeoutMs: 30_000 });
	}
	if (name === 'mtherios_reindex_story') {
		return requestJson('/api/jobs/reindex-story', {
			method: 'POST',
			body: JSON.stringify({
				storyId: requiredString(args.storyId, 'storyId'),
				runNow: args.runNow === true,
				recordTypes: Array.isArray(args.recordTypes) ? args.recordTypes.filter((item) => typeof item === 'string') : [],
				recreate: args.recreate === true,
				provider: optionalString(args.provider) ?? null,
				model: optionalString(args.model) ?? null,
			}),
			timeoutMs: 180_000,
		});
	}
	if (name === 'mtherios_sync_wiki') {
		const storyId = requiredString(args.storyId, 'storyId');
		return requestJson('/api/app/jobs/wiki', {
			method: 'POST',
			body: JSON.stringify({
				storyId,
				runNow: true,
				index: args.index === true,
				lint: args.lint === true,
				recreate: args.recreate === true,
			}),
			timeoutMs: 180_000,
		});
	}
	throw new Error(`Unknown tool: ${name}`);
}

function defaultExportName(payload) {
	const story = asRecord(payload.worldDatabase?.story ?? payload.story);
	const title = String(story.title || story.id || 'mtherios-world')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'mtherios-world';
	const date = new Date().toISOString().slice(0, 10);
	return `${title}-${date}.world-db.json`;
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function optionalRecord(value) {
	const record = asRecord(value);
	return Object.keys(record).length > 0 ? record : undefined;
}

function requiredRecord(value, name) {
	const record = asRecord(value);
	if (Object.keys(record).length === 0) throw new Error(`${name} is required.`);
	return record;
}

function optionalString(value) {
	if (value == null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

function optionalNullableString(value) {
	if (value === null) return null;
	return optionalString(value);
}

function optionalInteger(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNonnegativeInteger(value) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function requiredString(value, name) {
	const clean = optionalString(value);
	if (!clean) throw new Error(`${name} is required.`);
	return clean;
}

function stringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.map((item) => optionalString(item)).filter(Boolean);
}

function compactRecord(record) {
	const output = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
		output[key] = value;
	}
	return output;
}

function engineCommandPayload(args, command, commandArgs) {
	return compactRecord({
		storyId: requiredString(args.storyId, 'storyId'),
		command,
		clientCommandId: optionalString(args.clientCommandId),
		args: compactRecord(commandArgs),
	});
}

function textResult(value) {
	return {
		content: [
			{
				type: 'text',
				text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
			},
		],
	};
}

async function handleRequest(message) {
	const { id: requestId, method, params } = message;
	if (!requestId && requestId !== 0) return null;

	try {
		if (method === 'initialize') {
			return {
				jsonrpc: '2.0',
				id: requestId,
				result: {
					protocolVersion: params?.protocolVersion ?? '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: {
						name: 'mtherios-terminal-database',
						version: SERVER_VERSION,
					},
				},
			};
		}
		if (method === 'tools/list') {
			return {
				jsonrpc: '2.0',
				id: requestId,
				result: { tools },
			};
		}
		if (method === 'tools/call') {
			const result = await callTool(params?.name, params?.arguments ?? {});
			return {
				jsonrpc: '2.0',
				id: requestId,
				result: textResult(result),
			};
		}
		return {
			jsonrpc: '2.0',
			id: requestId,
			error: { code: -32601, message: `Method not found: ${method}` },
		};
	} catch (error) {
		return {
			jsonrpc: '2.0',
			id: requestId,
			error: {
				code: -32000,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function writeMessage(message) {
	if (!message) return;
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function startStdioServer() {
	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf('\n');
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				void Promise.resolve()
					.then(() => JSON.parse(line))
					.then(handleRequest)
					.then(writeMessage)
					.catch((error) => {
						writeMessage({
							jsonrpc: '2.0',
							id: null,
							error: {
								code: -32700,
								message: error instanceof Error ? error.message : String(error),
							},
						});
					});
			}
			newline = buffer.indexOf('\n');
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startStdioServer();
}
