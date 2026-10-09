#!/usr/bin/env node
// @ts-nocheck

import { resolveAppUrl } from './runtime-config.mjs';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = resolveAppUrl();
const APP_URL = DEFAULT_URL.replace(/\/$/, '');
const SERVER_VERSION = '0.2.1';
const MAX_SEARCH_RESULT_CHARS = 24_000;

const legacyTools = [
	{
		name: 'mtherios_status',
		description: 'Read the running MythEngine terminal process status.',
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
		description: 'Edit a canonical record using the revision from get_record. Stale writes fail. Objects merge unless jsonMode is replace; arrays replace.',
		inputSchema: {
			type: 'object',
			required: ['type', 'id', 'updates'],
			anyOf: [{ required: ['expectedVersion'] }, { required: ['expectedUpdatedAt'] }],
			properties: {
				type: { type: 'string' },
				id: { type: 'string' },
				updates: { type: 'object' },
				expectedVersion: { type: 'integer', minimum: 0 },
				expectedUpdatedAt: { type: 'string' },
				jsonMode: { type: 'string', enum: ['merge', 'replace'] },
				reason: { type: 'string', default: 'Manual MCP edit.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_get_player_capabilities',
		description: 'Read saved player buffs and abilities from the same canonical data shown in the Character tab. Use the exact player character ID.',
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: 'object', required: ['storyId', 'characterId'], additionalProperties: false,
			properties: { storyId: { type: 'string', minLength: 1 }, characterId: { type: 'string', minLength: 1 } },
		},
	},
	{
		name: 'mtherios_update_player_capabilities',
		description: 'Save established player ability and active-buff notes. Each supplied list replaces that list; [] clears it; omitted lists are preserved. Keeps numeric stats and other character data intact. Buff durations are notes, not automatic timers or numeric roll bonuses.',
		annotations: { readOnlyHint: false, destructiveHint: false },
		inputSchema: {
			type: 'object', additionalProperties: false,
			anyOf: [{ required: ['abilities'] }, { required: ['buffs'] }],
			required: ['storyId', 'characterId', 'expectedVersion'],
			properties: {
				storyId: { type: 'string', minLength: 1 }, characterId: { type: 'string', minLength: 1 },
				expectedVersion: { type: 'integer', minimum: 0 },
				abilities: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 300 } },
				buffs: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 300 } },
				reason: { type: 'string' }, clientCommandId: { type: 'string', minLength: 1 },
			},
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
						memoryTokenBudget: { type: 'integer', minimum: 160, maximum: 2400 },
						contextBudget: { type: 'integer', minimum: 0, maximum: 200000 },
						chapterThreshold: { type: 'integer', minimum: 5, maximum: 200 },
						postChapterBuffer: { type: 'integer', minimum: 0, maximum: 100 },
						chaptersPerArc: { type: 'integer', minimum: 2, maximum: 50 },
						deferStateExtraction: { type: 'boolean' },
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
		name: 'mtherios_actor_brief',
		description: 'Read an evidence-linked GM brief for one actor, including current state, beliefs, relationships, faction pressure, and recent events.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			anyOf: [
				{ required: ['actorId'] },
				{ required: ['name'] },
			],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				actorId: { type: 'string', minLength: 1 },
				name: { type: 'string', minLength: 1 },
				eventLimit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_affinity_read',
		description: 'Read established NPC-to-player affinity, disposition, and recent evidence. Missing affinity is returned as null, never guessed as neutral.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			anyOf: [
				{ required: ['actorIds'] },
				{ required: ['actorNames'] },
			],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				actorIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
				actorNames: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
				historyLimit: { type: 'integer', minimum: 0, maximum: 12, default: 5 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_scene_check',
		description: 'Check whether actors, locations, travel, and timing make a proposed scene possible without inventing missing facts.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				actorIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
				actorNames: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
				locationId: { type: 'string', minLength: 1 },
				locationName: { type: 'string', minLength: 1 },
				proposedTime: { type: 'string', minLength: 1 },
				proposedAction: { type: 'string', maxLength: 1200 },
				availableMinutes: { type: 'integer', minimum: 0 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_relationship_web',
		description: 'Read a bounded evidence-linked relationship graph for selected actors and their faction memberships.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			anyOf: [
				{ required: ['actorIds'] },
				{ required: ['actorNames'] },
			],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				actorIds: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1 } },
				actorNames: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1 } },
				depth: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_thread_board',
		description: 'Read the developing plot board: active threads, faction projects, recent movement, Plot Director pressure, and likely collisions.',
		inputSchema: {
			type: 'object',
			required: ['storyId'],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				query: { type: 'string', maxLength: 600 },
				actorIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
				factionIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
				locationId: { type: 'string', minLength: 1 },
				limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_draft_character_create',
		description: 'Draft a story-conditioned NPC for review. It does not enter canon until an existing proposal approval action accepts it.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'name', 'role', 'backstory', 'narrativePurpose'],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				name: { type: 'string', minLength: 1, maxLength: 120 },
				role: { type: 'string', minLength: 1, maxLength: 300 },
				backstory: { type: 'string', minLength: 1, maxLength: 1600 },
				narrativePurpose: { type: 'string', minLength: 1, maxLength: 800 },
				desire: { type: 'string', maxLength: 500 },
				fear: { type: 'string', maxLength: 500 },
				faction: { type: 'string', maxLength: 240 },
				location: { type: 'string', maxLength: 240 },
				clientCommandId: { type: 'string', minLength: 1 },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mtherios_orchestrator_run',
		description: 'Run the terminal-owned staged GM planner. Turn runs use situation, dialogue, location, and plot steps; independent tools within a step execute in parallel.',
		inputSchema: {
			type: 'object',
			required: ['storyId', 'goal'],
			properties: {
				storyId: { type: 'string', minLength: 1 },
				mode: { type: 'string', enum: ['turn', 'world_tick', 'audit', 'memory', 'lore_curation', 'custom'], default: 'turn' },
				goal: { type: 'string', minLength: 1 },
				playerText: { type: 'string', minLength: 1 },
				clientTurnId: { type: 'string', minLength: 1 },
				context: {
					type: 'object',
					properties: {
						locationId: { type: ['string', 'null'] },
						sceneEntityIds: { type: 'array', items: { type: 'string' } },
						presentNpcIds: { type: 'array', items: { type: 'string' } },
						threadIds: { type: 'array', items: { type: 'string' } },
						currentFactionId: { type: ['string', 'null'] },
						memoryTokenBudget: { type: 'integer', minimum: 0, maximum: 100000 },
						contextBudget: { type: 'integer', minimum: 1, maximum: 1000000 },
						includeSecret: { type: 'boolean', default: false },
						currentTurn: { type: 'integer', minimum: 0 },
						currentWorldTime: { type: ['string', 'null'] },
						entryLimit: { type: 'integer', minimum: 1, maximum: 200 },
					},
					additionalProperties: false,
					default: {
						sceneEntityIds: [],
						presentNpcIds: [],
						threadIds: [],
						includeSecret: false,
					},
				},
				roles: {
					type: 'array',
					items: {
						type: 'string',
						enum: ['dm_narrator', 'rules_referee', 'state_scribe', 'lorekeeper', 'lore_curator', 'faction_simulator', 'npc_memory', 'continuity_auditor'],
					},
				},
				execute: { type: 'boolean', default: false },
				maxToolCalls: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
				clientCommandId: { type: 'string', minLength: 1 },
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
				storyId: { type: 'string', minLength: 1 },
				type: {
					type: 'string',
					enum: [
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
					],
				},
				title: { type: 'string', minLength: 1 },
				body: { type: 'string', minLength: 1 },
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
				visibility: { type: 'string', enum: ['public', 'player_known', 'secret'], default: 'player_known' },
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
							serviceId: { type: 'string', minLength: 1 },
							providerType: { type: 'string', minLength: 1 },
							baseUrl: { type: ['string', 'null'] },
							model: { type: ['string', 'null'] },
							temperature: { type: 'number', minimum: 0, maximum: 2 },
							maxTokens: { type: 'integer', minimum: 128, maximum: 65536 },
							topP: { type: ['number', 'null'], minimum: 0, maximum: 1 },
							frequencyPenalty: { type: ['number', 'null'], minimum: -2, maximum: 2 },
							presencePenalty: { type: ['number', 'null'], minimum: -2, maximum: 2 },
							reasoningEffort: { type: ['string', 'null'] },
							contextBudget: { type: ['integer', 'null'], minimum: 1 },
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
							ref: { type: 'string', minLength: 1 },
							value: { type: 'string', minLength: 1 },
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

export const tools = legacyTools.flatMap(tool => [{ ...tool, name: tool.name.replace(/^mtherios_/, 'mythengine_') }, tool]);

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
	name = name.replace(/^mythengine_/, 'mtherios_');
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
					expectedVersion: args.expectedVersion,
					expectedUpdatedAt: args.expectedUpdatedAt,
					jsonMode: args.jsonMode,
					reason: optionalString(args.reason) || 'Manual MCP edit.',
				}),
				timeoutMs: 60_000,
			},
		);
	}
	if (name === 'mtherios_get_player_capabilities' || name === 'mtherios_update_player_capabilities') {
		if (args.storyId === '__app__') throw new Error('A concrete story ID is required for player capabilities.');
		const update = name === 'mtherios_update_player_capabilities';
		const changes = {};
		for (const field of ['abilities', 'buffs']) {
			if (Object.hasOwn(args, field)) changes[field] = args[field];
		}
		if (update && Object.keys(changes).length === 0) throw new Error('Supply abilities or buffs; [] clears that list.');
		const response = asRecord(await requestJson('/api/engine/command', {
			method: 'POST', timeoutMs: 60_000,
			body: JSON.stringify(engineCommandPayload(args, update ? 'world.record.patch' : 'world.record.get', {
				type: 'characters', recordId: requiredString(args.characterId, 'characterId'),
				...(update ? { expectedVersion: args.expectedVersion, updates: { playerCapabilities: changes }, reason: optionalString(args.reason) || 'MCP player buffs and abilities update.' } : {}),
			})),
		}));
		if (response.status !== 'succeeded') throw new Error(response.error || 'Player capability request failed.');
		const result = asRecord(response.result);
		const record = asRecord(result.record);
		if (record.type !== 'character') throw new Error('The requested record is not a character.');
		const metadata = { ...asRecord(asRecord(record.metadata).originalMetadata), ...asRecord(record.metadata) };
		const capabilities = asRecord(asRecord(record.state).playerCapabilities ?? metadata.playerCapabilities);
		return { storyId: args.storyId, characterId: record.id, name: record.name,
			playerCapabilities: { abilities: capabilities.abilities ?? [], buffs: capabilities.buffs ?? [] },
			serverVersion: result.serverVersion ?? record.server_version ?? record.serverVersion,
			...(result.patchId ? { patchId: result.patchId } : {}),
		};
	}
	if (name === 'mtherios_search') {
		const storyId = requiredString(args.storyId, 'storyId');
		return boundSearchPayload(await requestJson(queryPath(`/api/stories/${encodeURIComponent(storyId)}/search`, {
			q: requiredString(args.q, 'q'),
			type: optionalString(args.type),
			limit: optionalInteger(args.limit, 12),
			semantic: args.includeSemantic === false ? 'false' : undefined,
		}), { timeoutMs: 60_000 }));
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
		const command = requiredString(args.command, 'command');
		const response = await requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify({
				storyId: requiredString(args.storyId, 'storyId'),
				command,
				clientCommandId: optionalString(args.clientCommandId),
				args: asRecord(args.args),
			}),
			timeoutMs: 180_000,
		});
		return command === 'world.search' ? boundSearchPayload(response) : response;
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
	if (name === 'mtherios_actor_brief') {
		const actorId = optionalString(args.actorId);
		const actorName = optionalString(args.name);
		if (!actorId && !actorName) throw new Error('actorId or name is required.');
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.actor.brief', {
				actorId,
				name: actorName,
				eventLimit: optionalPositiveInteger(args.eventLimit),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_affinity_read') {
		const actorIds = stringArray(args.actorIds);
		const actorNames = stringArray(args.actorNames);
		if (actorIds.length === 0 && actorNames.length === 0) throw new Error('At least one actor is required.');
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.affinity.read', {
				actorIds,
				actorNames,
				historyLimit: optionalNonnegativeInteger(args.historyLimit),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_scene_check') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.scene.check', {
				actorIds: stringArray(args.actorIds),
				actorNames: stringArray(args.actorNames),
				locationId: optionalString(args.locationId),
				locationName: optionalString(args.locationName),
				proposedTime: optionalString(args.proposedTime),
				proposedAction: optionalString(args.proposedAction),
				availableMinutes: optionalNonnegativeInteger(args.availableMinutes),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_relationship_web') {
		const actorIds = stringArray(args.actorIds);
		const actorNames = stringArray(args.actorNames);
		if (actorIds.length === 0 && actorNames.length === 0) throw new Error('At least one actor is required.');
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.relationship.web', {
				actorIds,
				actorNames,
				depth: optionalPositiveInteger(args.depth),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_thread_board') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'plot.thread.board', {
				query: optionalString(args.query),
				actorIds: stringArray(args.actorIds),
				factionIds: stringArray(args.factionIds),
				locationId: optionalString(args.locationId),
				limit: optionalPositiveInteger(args.limit),
			})),
			timeoutMs: 60_000,
		});
	}
	if (name === 'mtherios_draft_character_create') {
		return requestJson('/api/engine/command', {
			method: 'POST',
			body: JSON.stringify(engineCommandPayload(args, 'world.character.draftCreate', {
				name: requiredString(args.name, 'name'),
				role: requiredString(args.role, 'role'),
				backstory: requiredString(args.backstory, 'backstory'),
				narrativePurpose: requiredString(args.narrativePurpose, 'narrativePurpose'),
				desire: optionalString(args.desire),
				fear: optionalString(args.fear),
				faction: optionalString(args.faction),
				location: optionalString(args.location),
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

function clippedText(value, maxChars) {
	if (typeof value !== 'string') return undefined;
	const clean = value.replace(/\s+/g, ' ').trim();
	if (!clean) return undefined;
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3).trimEnd()}...`;
}

function boundSearchPage(value, maxChars = MAX_SEARCH_RESULT_CHARS) {
	const page = asRecord(value);
	const rows = Array.isArray(page.results) ? page.results : [];
	const resultCount = typeof page.resultCount === 'number' ? page.resultCount : rows.length;
	const output = {
		storyId: clippedText(page.storyId, 240),
		query: clippedText(page.query, 500),
		warnings: Array.isArray(page.warnings)
			? page.warnings.map((warning) => clippedText(warning, 500)).filter(Boolean).slice(0, 10)
			: [],
		resultCount,
		returnedResultCount: 0,
		omittedResultCount: resultCount,
		truncated: false,
		results: [],
	};
	for (const value of rows) {
		const row = asRecord(value);
		const detail = Object.keys(asRecord(row.payload)).length > 0 ? asRecord(row.payload) : asRecord(row.record);
		const snippet = clippedText(
			detail.text ?? detail.content ?? detail.body ?? detail.summary ?? detail.description ?? row.snippet,
			1200,
		);
		const summary = compactRecord({
			source: optionalString(row.source),
			score: typeof row.score === 'number' ? row.score : undefined,
			recordType: optionalString(row.recordType ?? detail.recordType ?? detail.type),
			recordId: optionalString(row.recordId ?? detail.recordId ?? detail.id),
			title: clippedText(row.title ?? detail.title ?? detail.name, 300),
			status: optionalString(detail.status),
			visibility: optionalString(detail.visibility),
			snippet,
		});
		output.results.push(summary);
		output.returnedResultCount = output.results.length;
		output.omittedResultCount = Math.max(0, resultCount - output.returnedResultCount);
		if (JSON.stringify(output).length > maxChars) {
			output.results.pop();
			output.returnedResultCount = output.results.length;
			output.omittedResultCount = Math.max(0, resultCount - output.returnedResultCount);
			output.truncated = true;
			break;
		}
	}
	output.truncated ||= output.omittedResultCount > 0;
	return output;
}

function boundSearchPayload(value) {
	const envelope = asRecord(value);
	if (Array.isArray(envelope.results)) return boundSearchPage(envelope);
	const result = asRecord(envelope.result);
	return Array.isArray(result.results) ? { ...envelope, result: boundSearchPage(result) } : value;
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
						name: 'mythengine-terminal-database',
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

export function startStdioServer() {
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
