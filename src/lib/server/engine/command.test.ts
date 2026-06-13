import { describe, expect, it } from 'vitest';
import { executeEngineCommand } from './command';
import { resetEngineEventsForTest, subscribeEngineEvents } from './events';

describe('engine command envelope', () => {
	it('routes app status reads through the shared backend command surface', async () => {
		const statusCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'app.status',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_app_status',
			args: {},
		}, {
			loadAppStatus: async (input) => {
				statusCalls.push(input);
				return {
					ok: true,
					mode: 'terminal-process',
					scope: { storyId: input.storyId },
					services: {
						qdrant: { ok: true, status: 200 },
						ollama: { ok: false, status: 503 },
					},
					jobs: { total: 3 },
					wiki: { totalStories: 1 },
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			ok: true,
			mode: 'terminal-process',
			scope: { storyId: 'story_alpha' },
		}));
		expect(result.projectionChanges).toEqual({
			appStatus: {
				ok: true,
				mode: 'terminal-process',
				storyId: 'story_alpha',
				qdrantOk: true,
				ollamaOk: false,
			},
		});
		expect(statusCalls).toEqual([{ storyId: 'story_alpha' }]);
	});

	it('routes backend health reads through the shared backend command surface', async () => {
		const healthCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'app.health',
			storyId: '__app__',
			clientCommandId: 'cmd_app_health',
			args: {},
		}, {
			loadDatabaseHealth: async () => {
				healthCalls.push({ kind: 'health' });
				return {
					ok: true,
					configured: true,
					database: 'mtherios',
					table_count: 42,
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual({
			ok: true,
			configured: true,
			database: 'mtherios',
			table_count: 42,
		});
		expect(result.projectionChanges).toEqual({
			appHealth: {
				ok: true,
				configured: true,
				database: 'mtherios',
				tableCount: 42,
			},
		});
		expect(healthCalls).toEqual([{ kind: 'health' }]);
	});

	it('routes API-call log reads and writes through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const listed = await executeEngineCommand({
			command: 'apiCallLogs.list',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_api_logs',
			args: {
				status: 'error',
				serviceId: 'narrator',
				limit: 25,
			},
		}, {
			listApiCallLogs: async (options) => {
				const query = options ?? {};
				calls.push({ kind: 'list', options: query });
				return [
					{ id: 'log_1', storyId: query.storyId, status: query.status, serviceId: query.serviceId },
				];
			},
		});
		const recorded = await executeEngineCommand({
			command: 'apiCallLogs.record',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_api_log_record',
			args: {
				storyId: 'story_alpha',
				serviceId: 'narrator',
				operation: 'turn.generate',
				providerType: 'ollama',
				status: 'success',
				durationMs: 321,
				metadata: { clientTurnId: 'turn_1' },
			},
		}, {
			recordApiCallLog: async (input) => {
				calls.push({ kind: 'record', input });
				return { id: 'log_2', storyId: input.storyId, operation: input.operation };
			},
		});

		expect(listed.status).toBe('succeeded');
		expect(listed.result).toEqual({
			logs: [
				{ id: 'log_1', storyId: 'story_alpha', status: 'error', serviceId: 'narrator' },
			],
		});
		expect(listed.projectionChanges).toEqual({
			apiCallLogs: {
				storyId: 'story_alpha',
				logCount: 1,
				limit: 25,
			},
		});
		expect(recorded.status).toBe('succeeded');
		expect(recorded.result).toEqual({
			logged: true,
			log: { id: 'log_2', storyId: 'story_alpha', operation: 'turn.generate' },
		});
		expect(recorded.projectionChanges).toEqual({
			apiCallLogs: {
				logged: true,
				logId: 'log_2',
			},
		});
		expect(calls).toEqual([
			{
				kind: 'list',
				options: {
					storyId: 'story_alpha',
					status: 'error',
					serviceId: 'narrator',
					limit: 25,
				},
			},
			{
				kind: 'record',
				input: {
					storyId: 'story_alpha',
					serviceId: 'narrator',
					operation: 'turn.generate',
					providerType: 'ollama',
					status: 'success',
					durationMs: 321,
					metadata: { clientTurnId: 'turn_1' },
				},
			},
		]);
	});

	it('routes LLM settings reads and writes through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const setting = {
			serviceId: 'narrator',
			providerType: 'openai',
			baseUrl: null,
			model: 'gpt-4.1-mini',
			temperature: 0.8,
			maxTokens: 4096,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
			reasoningEffort: null,
			contextBudget: 16000,
			enabled: true,
			systemPromptOverride: null,
			apiKeyRef: 'env:OPENAI_API_KEY',
			metadata: {},
		};
		const listed = await executeEngineCommand({
			command: 'settings.llm.list',
			storyId: '__app__',
			clientCommandId: 'cmd_llm_list',
			args: {},
		}, {
			listLlmSettings: async () => {
				calls.push({ kind: 'list' });
				return [setting];
			},
		});
		const saved = await executeEngineCommand({
			command: 'settings.llm.save',
			storyId: '__app__',
			clientCommandId: 'cmd_llm_save',
			args: {
				settings: [setting],
				secrets: [{ ref: 'env:OPENAI_API_KEY', value: 'sk-test' }],
			},
		}, {
			saveLlmSettings: async (input) => {
				calls.push({ kind: 'save', input });
				return input.settings;
			},
		});

		expect(listed.status).toBe('succeeded');
		expect(listed.result).toEqual({ settings: [setting] });
		expect(listed.projectionChanges).toEqual({
			llmSettings: {
				settingCount: 1,
			},
		});
		expect(saved.status).toBe('succeeded');
		expect(saved.result).toEqual({ settings: [setting] });
		expect(saved.projectionChanges).toEqual({
			llmSettings: {
				settingCount: 1,
				secretRefCount: 1,
			},
		});
		expect(calls).toEqual([
			{ kind: 'list' },
			{
				kind: 'save',
				input: {
					settings: [setting],
					secrets: [{ ref: 'env:OPENAI_API_KEY', value: 'sk-test' }],
				},
			},
		]);
	});

	it('routes prompt packet diagnostics through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'debug.promptPacket',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_prompt_packet',
			args: {
				query: 'marriage',
				tokenBudget: 777,
			},
		}, {
			buildPromptPacketDebug: async (input) => {
				calls.push(input);
				return {
					storyId: input.storyId,
					query: input.query,
					retrieved: {
						tokenEstimate: input.tokenBudget,
						nodes: [{ id: 'mem_1' }],
					},
					prompt: {
						system: 'system',
						prompt: 'dynamic prompt',
						messages: [{ role: 'user', content: 'recent turn' }],
					},
					tokenEstimate: input.tokenBudget,
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual({
			storyId: 'story_alpha',
			query: 'marriage',
			retrieved: {
				tokenEstimate: 777,
				nodes: [{ id: 'mem_1' }],
			},
			prompt: {
				system: 'system',
				prompt: 'dynamic prompt',
				messages: [{ role: 'user', content: 'recent turn' }],
			},
			tokenEstimate: 777,
		});
		expect(result.projectionChanges).toEqual({
			promptPacket: {
				query: 'marriage',
				tokenEstimate: 777,
				memoryNodeCount: 1,
				systemChars: 6,
				promptChars: 14,
				messageCount: 1,
			},
		});
		expect(calls).toEqual([{
			storyId: 'story_alpha',
			query: 'marriage',
			tokenBudget: 777,
		}]);
	});

	it('routes campaign status commands through the shared backend command surface', async () => {
		const projectionCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.status',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_1',
			args: { entryLimit: 42 },
		}, {
			loadCampaignProjection: async (storyId, options) => {
				projectionCalls.push(options);
				return {
				mode: 'control_surface',
				story: { id: storyId, title: 'Long Campaign', serverVersion: 3 },
				entries: [],
				counts: { entries: 0, entities: 0, events: 0, memoryNodes: 0 },
				vault: { vaultPath: 'data/vaults/campaigns/story_alpha', fileCount: 0, lastIndexedVersion: 3 },
				cache: { storyId, entryCount: 0, hitCount: 0, missCount: 0, tokenEstimate: 0, byKind: [], segments: [] },
			};
			},
		});

		expect(result).toEqual(expect.objectContaining({
			commandId: 'cmd_1',
			command: 'campaign.status',
			status: 'succeeded',
			storyId: 'story_alpha',
		}));
		expect(result.result).toEqual(expect.objectContaining({
			mode: 'control_surface',
		}));
		expect(projectionCalls).toEqual([{ entryLimit: 42 }]);
	});

	it('routes campaign bootstrap through the shared backend command surface', async () => {
		const bootstrapCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.bootstrap',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_bootstrap',
			args: {
				entryLimit: 40,
				entityLimit: 60,
				memoryNodeLimit: 20,
				npcBeliefLimit: 10,
			},
		}, {
			loadBootstrap: async (storyId, options) => {
				bootstrapCalls.push({ storyId, options });
				return {
					story: { id: storyId, title: 'Long Campaign', serverVersion: 7 },
					serverVersion: 7,
					entries: [],
					entryCount: 10000,
					entities: [],
					relationships: [],
					factions: [],
					factionMemberships: [],
					factionResources: [],
					factionGoals: [],
					factionProjects: [],
					agreements: [],
					npcBeliefs: [],
					threads: [],
					chapters: [],
					arcs: [],
					sagas: [],
					recentEvents: [],
					recentPatches: [],
					memoryNodes: [],
					projection: {
						mode: 'control_surface',
						story: { id: storyId, title: 'Long Campaign', serverVersion: 7 },
						entries: [],
						counts: { entries: 10000, entities: 0, events: 0, memoryNodes: 0 },
						vault: { vaultPath: 'data/vaults/campaigns/story_alpha', fileCount: 4, lastIndexedVersion: 7 },
						cache: { storyId, entryCount: 2, hitCount: 1, missCount: 1, tokenEstimate: 120, byKind: [], segments: [] },
					},
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			serverVersion: 7,
			entryCount: 10000,
		}));
		expect(result.projectionChanges).toEqual(expect.objectContaining({
			mode: 'control_surface',
			counts: { entries: 10000, entities: 0, events: 0, memoryNodes: 0 },
			entryLimit: 40,
		}));
		expect(bootstrapCalls).toEqual([{
			storyId: 'story_alpha',
			options: {
				entryLimit: 40,
				entityLimit: 60,
				memoryNodeLimit: 20,
				npcBeliefLimit: 10,
			},
		}]);
	});

	it('routes paged transcript reads through the shared backend command surface', async () => {
		const transcriptCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.transcriptPage',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_transcript',
			args: {
				beforePosition: 120,
				limit: 40,
				branchId: 'main',
			},
		}, {
			loadTranscriptPage: async (storyId, options) => {
				transcriptCalls.push({ storyId, options });
				return {
					storyId,
					serverVersion: 8,
					entries: [{ id: 'entry_80', position: 80 }],
					entryCount: 10000,
					hasMore: true,
					nextBeforePosition: 80,
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			entryCount: 10000,
			hasMore: true,
		}));
		expect(result.projectionChanges).toEqual({
			transcript: {
				entryCount: 10000,
				pageSize: 1,
				hasMore: true,
				nextBeforePosition: 80,
				serverVersion: 8,
			},
		});
		expect(transcriptCalls).toEqual([{
			storyId: 'story_alpha',
			options: {
				beforePosition: 120,
				limit: 40,
				branchId: 'main',
			},
		}]);
	});

	it('routes entries-around reads through the shared backend command surface', async () => {
		const aroundCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.entriesAround',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_entries_around',
			args: {
				position: 120,
				radius: 12,
			},
		}, {
			loadEntriesAround: async (storyId, position, radius) => {
				aroundCalls.push({ storyId, position, radius });
				return {
					storyId,
					position,
					entries: [{ id: 'entry_120', position }],
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			position: 120,
			entries: [{ id: 'entry_120', position: 120 }],
		}));
		expect(result.projectionChanges).toEqual({
			entriesAround: {
				position: 120,
				radius: 12,
				entryCount: 1,
			},
		});
		expect(aroundCalls).toEqual([{ storyId: 'story_alpha', position: 120, radius: 12 }]);
	});

	it('routes world record listing and search through the shared backend command surface', async () => {
		const listCalls: unknown[] = [];
		const searchCalls: unknown[] = [];
		const records = await executeEngineCommand({
			command: 'world.records',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_world_records',
			args: {
				type: 'factions',
				q: 'harbor',
				cursor: '20',
				limit: 25,
			},
		}, {
			listWorldRecords: async (storyId, options) => {
				const pageOptions = options ?? {};
				listCalls.push({ storyId, options });
				return {
					types: ['entities', 'factions'],
					storyId,
					type: pageOptions.type ?? 'entities',
					records: [{ id: 'faction_harbor' }],
					nextCursor: '45',
					limit: pageOptions.limit ?? 50,
				};
			},
		});
		const search = await executeEngineCommand({
			command: 'world.search',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_world_search',
			args: {
				q: 'Mira',
				type: 'entities',
				limit: 5,
				includeSemantic: false,
			},
		}, {
			searchWorld: async (input) => {
				searchCalls.push(input);
				return {
					storyId: input.storyId,
					query: input.query,
					results: [{ recordType: 'entities', recordId: 'npc_mira' }],
				};
			},
		});

		expect(records.status).toBe('succeeded');
		expect(records.result).toEqual(expect.objectContaining({
			types: ['entities', 'factions'],
			records: [{ id: 'faction_harbor' }],
			nextCursor: '45',
		}));
		expect(records.projectionChanges).toEqual({
			worldRecords: {
				type: 'factions',
				recordCount: 1,
				nextCursor: '45',
			},
		});
		expect(search.status).toBe('succeeded');
		expect(search.result).toEqual(expect.objectContaining({
			query: 'Mira',
			results: [{ recordType: 'entities', recordId: 'npc_mira' }],
		}));
		expect(search.projectionChanges).toEqual({
			worldSearch: {
				query: 'Mira',
				resultCount: 1,
			},
		});
		expect(listCalls).toEqual([{
			storyId: 'story_alpha',
			options: {
				type: 'factions',
				q: 'harbor',
				cursor: '20',
				limit: 25,
			},
		}]);
		expect(searchCalls).toEqual([{
			storyId: 'story_alpha',
			query: 'Mira',
			type: 'entities',
			limit: 5,
			includeSemantic: false,
		}]);
	});

	it('routes world record detail reads and patches through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const read = await executeEngineCommand({
			command: 'world.record.get',
			storyId: '__app__',
			clientCommandId: 'cmd_world_record_get',
			args: {
				type: 'characters',
				recordId: 'npc_mira',
			},
		}, {
			getWorldRecord: async (type, recordId) => {
				calls.push({ kind: 'get', type, recordId });
				return {
					type,
					record: { id: recordId, story_id: 'story_alpha', name: 'Mira' },
					sourceEntries: [{ id: 'entry_1' }],
					sourceEvents: [],
					sourcePatches: [],
				};
			},
		});
		const patch = await executeEngineCommand({
			command: 'world.record.patch',
			storyId: '__app__',
			clientCommandId: 'cmd_world_record_patch',
			args: {
				type: 'characters',
				recordId: 'npc_mira',
				updates: { name: 'Mira of the Harbor' },
				reason: 'Manual explorer edit.',
			},
		}, {
			patchWorldRecord: async (type, recordId, request) => {
				calls.push({ kind: 'patch', type, recordId, request });
				return {
					storyId: 'story_alpha',
					type,
					record: { id: recordId, story_id: 'story_alpha', name: request.updates.name },
					patchId: 'manual_patch_1',
					serverVersion: 15,
				};
			},
		});

		expect(read.status).toBe('succeeded');
		expect(read.result).toEqual({
			type: 'characters',
			record: { id: 'npc_mira', story_id: 'story_alpha', name: 'Mira' },
			sourceEntries: [{ id: 'entry_1' }],
			sourceEvents: [],
			sourcePatches: [],
		});
		expect(read.projectionChanges).toEqual({
			worldRecord: {
				type: 'characters',
				recordId: 'npc_mira',
				storyId: 'story_alpha',
				sourceEntryCount: 1,
				sourceEventCount: 0,
				sourcePatchCount: 0,
			},
		});
		expect(patch.status).toBe('succeeded');
		expect(patch.result).toEqual({
			storyId: 'story_alpha',
			type: 'characters',
			record: { id: 'npc_mira', story_id: 'story_alpha', name: 'Mira of the Harbor' },
			patchId: 'manual_patch_1',
			serverVersion: 15,
		});
		expect(patch.projectionChanges).toEqual({
			worldRecord: {
				type: 'characters',
				recordId: 'npc_mira',
				storyId: 'story_alpha',
				patchId: 'manual_patch_1',
				serverVersion: 15,
			},
		});
		expect(calls).toEqual([
			{
				kind: 'get',
				type: 'characters',
				recordId: 'npc_mira',
			},
			{
				kind: 'patch',
				type: 'characters',
				recordId: 'npc_mira',
				request: {
					updates: { name: 'Mira of the Harbor' },
					reason: 'Manual explorer edit.',
				},
			},
		]);
	});

	it('routes orchestrator runs through the shared backend command surface', async () => {
		const orchestratorCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'orchestrator.run',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_orchestrator',
			args: {
				mode: 'turn',
				goal: 'Prepare the next text RPG response.',
				playerText: 'I ask who benefits from the marriage.',
				clientTurnId: 'turn_1',
				execute: false,
			},
		}, {
			runOrchestrator: async (input) => {
				orchestratorCalls.push(input);
				return {
					runId: 'orch_1',
					storyId: input.storyId,
					mode: 'turn',
					goal: 'Prepare the next text RPG response.',
					executed: false,
					roles: [{ id: 'dm_narrator', name: 'DM / Narrator Agent', responsibilities: [] }],
					toolCalls: [{ id: 'tool_1', agentRole: 'dm_narrator', command: 'turn.prepare', args: {}, reason: 'Prepare bounded turn context.' }],
					toolResults: [],
					warnings: [],
					createdAt: '2026-06-06T00:00:00.000Z',
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			runId: 'orch_1',
			executed: false,
		}));
		expect(result.projectionChanges).toEqual({
			orchestrator: {
				runId: 'orch_1',
				mode: 'turn',
				roleCount: 1,
				toolCallCount: 1,
				toolResultCount: 0,
				executed: false,
			},
		});
		expect(orchestratorCalls).toEqual([expect.objectContaining({
			storyId: 'story_alpha',
			mode: 'turn',
			goal: 'Prepare the next text RPG response.',
			playerText: 'I ask who benefits from the marriage.',
			clientTurnId: 'turn_1',
			execute: false,
		})]);
	});

	it('routes campaign vault page reads through the shared backend command surface', async () => {
		const pageCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.page.read',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_page_read',
			args: {
				kind: 'character_page',
				name: 'Mira of the Harbor',
			},
		}, {
			readCampaignPage: async (input) => {
				pageCalls.push(input);
				return {
					storyId: input.storyId,
					kind: input.kind,
					relativePath: 'characters/mira-of-the-harbor.md',
					content: '# Mira',
				contentHash: 'hash-mira',
				updatedAt: '2026-06-06T00:00:00.000Z',
				byteLength: 6,
				missing: false,
			};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			relativePath: 'characters/mira-of-the-harbor.md',
			content: '# Mira',
		}));
		expect(result.projectionChanges).toEqual({
			campaignPage: {
				kind: 'character_page',
				relativePath: 'characters/mira-of-the-harbor.md',
				contentHash: 'hash-mira',
				byteLength: 6,
				missing: false,
			},
		});
		expect(pageCalls).toEqual([{
			storyId: 'story_alpha',
			kind: 'character_page',
			name: 'Mira of the Harbor',
			relativePath: null,
			missingOk: false,
		}]);
	});

	it('routes campaign vault page writes through the shared backend command surface', async () => {
		const writeCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'campaign.page.write',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_page_write',
			args: {
				kind: 'character_page',
				name: 'Mira of the Harbor',
				title: 'Mira of the Harbor',
				body: '## Looks\nSalt-dark hair.\n\n## Personality\nCalculating.',
				entityIds: ['npc_mira'],
				sourceEventIds: ['event_alliance'],
			},
		}, {
			writeCampaignPage: async (input) => {
				writeCalls.push(input);
				return {
					files: [{
						absolutePath: 'E:/vault/characters/mira-of-the-harbor.md',
						relativePath: 'characters/mira-of-the-harbor.md',
						kind: 'character_page',
						contentHash: 'hash-mira',
						byteLength: 64,
					}],
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			files: [
				expect.objectContaining({
					relativePath: 'characters/mira-of-the-harbor.md',
					contentHash: 'hash-mira',
				}),
			],
		}));
		expect(result.projectionChanges).toEqual({
			campaignPage: {
				kind: 'character_page',
				relativePath: 'characters/mira-of-the-harbor.md',
				contentHash: 'hash-mira',
				byteLength: 64,
			},
		});
		expect(writeCalls).toEqual([{
			story: {
				id: 'story_alpha',
				title: 'story_alpha',
				serverVersion: undefined,
			},
			kind: 'character_page',
			name: 'Mira of the Harbor',
			title: 'Mira of the Harbor',
			body: '## Looks\nSalt-dark hair.\n\n## Personality\nCalculating.',
			tags: [],
			entityIds: ['npc_mira'],
			factionIds: [],
			sourceEntryIds: [],
			sourceEventIds: ['event_alliance'],
			sourcePatchIds: [],
			relativePath: null,
			metadata: {},
		}]);
	});

	it('routes control-surface world writes through the shared backend command surface', async () => {
		const calls: string[] = [];
		const entity = await executeEngineCommand({
			command: 'entity.upsert',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_entity',
			args: { entry: { id: 'npc_mira', name: 'Mira', type: 'character' } },
		}, {
			upsertEntity: async (storyId, entry) => {
				calls.push(`entity:${storyId}:${entry.id}`);
				return { storyId, serverVersion: 9, entity: { id: entry.id, name: entry.name } };
			},
		});
		const deleted = await executeEngineCommand({
			command: 'entity.delete',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_entity_delete',
			args: { entityId: 'npc_old' },
		}, {
			deleteEntity: async (storyId, entityId) => {
				calls.push(`delete:${storyId}:${entityId}`);
				return { storyId, serverVersion: 10, entityId, deleted: true };
			},
		});
		const chapter = await executeEngineCommand({
			command: 'chapter.upsert',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_chapter',
			args: { chapter: { id: 'chapter_1', title: 'The Gate' } },
		}, {
			upsertChapter: async (storyId, row) => {
				calls.push(`chapter:${storyId}:${row.id}`);
				return { storyId, serverVersion: 11, chapter: row };
			},
		});
		const arc = await executeEngineCommand({
			command: 'arc.upsert',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_arc',
			args: { arc: { id: 'arc_1', title: 'Silver Gates' } },
		}, {
			upsertArc: async (storyId, row) => {
				calls.push(`arc:${storyId}:${row.id}`);
				return { storyId, serverVersion: 12, arc: row };
			},
		});
		const saga = await executeEngineCommand({
			command: 'saga.upsert',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_saga',
			args: { saga: { id: 'saga_1', title: 'The Long Road' } },
		}, {
			upsertSaga: async (storyId, row) => {
				calls.push(`saga:${storyId}:${row.id}`);
				return { storyId, serverVersion: 13, saga: row };
			},
		});
		const memory = await executeEngineCommand({
			command: 'livingMemory.upsert',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_memory_write',
			args: {
				kind: 'worldEvent',
				records: [{ id: 'event_1', name: 'A compact omen' }],
			},
		}, {
			upsertLivingMemory: async (storyId, kind, records) => {
				calls.push(`living:${storyId}:${kind}:${records.length}`);
				return {
					storyId,
					serverVersion: 14,
					kind,
					recordIds: records.map((row) => String(row.id)),
					counts: { worldEvents: records.length },
				};
			},
		});

		expect(calls).toEqual([
			'entity:story_alpha:npc_mira',
			'delete:story_alpha:npc_old',
			'chapter:story_alpha:chapter_1',
			'arc:story_alpha:arc_1',
			'saga:story_alpha:saga_1',
			'living:story_alpha:worldEvent:1',
		]);
		expect(entity.projectionChanges).toEqual({
			entity: { id: 'npc_mira', name: 'Mira' },
			serverVersion: 9,
		});
		expect(deleted.projectionChanges).toEqual({
			entityId: 'npc_old',
			deleted: true,
			serverVersion: 10,
		});
		expect(chapter.projectionChanges).toEqual({
			chapter: { id: 'chapter_1', title: 'The Gate' },
			serverVersion: 11,
		});
		expect(arc.projectionChanges).toEqual({
			arc: { id: 'arc_1', title: 'Silver Gates' },
			serverVersion: 12,
		});
		expect(saga.projectionChanges).toEqual({
			saga: { id: 'saga_1', title: 'The Long Road' },
			serverVersion: 13,
		});
		expect(memory.projectionChanges).toEqual({
			livingMemory: {
				kind: 'worldEvent',
				recordIds: ['event_1'],
				counts: { worldEvents: 1 },
			},
			serverVersion: 14,
		});
	});

	it('routes canon repair controls through the shared backend command surface', async () => {
		const calls: string[] = [];
		const resolve = await executeEngineCommand({
			command: 'entity.resolve',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_resolve',
			args: {
				candidate: { type: 'character', name: 'Mira' },
				includeSemantic: false,
				maxCandidates: 24,
			},
		}, {
			previewEntityResolution: async (input) => {
				calls.push(`resolve:${input.storyId}:${input.candidate.name}`);
				return {
					storyId: input.storyId,
					candidate: input.candidate,
					resolution: {
						decision: 'update',
						confidence: 0.92,
						matchedEntityId: 'entity_mira',
						reason: 'Strong resolver match for Mira.',
					},
					candidates: [],
				};
			},
		});
		const alias = await executeEngineCommand({
			command: 'entity.alias.add',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_alias',
			args: {
				entityId: 'entity_mira',
				alias: 'Lady Mira',
			},
		}, {
			addEntityAlias: async (input) => {
				calls.push(`alias:${input.storyId}:${input.entityId}:${input.alias}`);
				return {
					storyId: input.storyId,
					serverVersion: 22,
					entityId: input.entityId,
					alias: input.alias,
					normalizedAlias: 'lady mira',
					aliases: ['Mira', 'Lady Mira'],
				};
			},
		});
		const merge = await executeEngineCommand({
			command: 'entity.merge',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_merge',
			args: {
				keepEntityId: 'entity_keep',
				mergeEntityId: 'entity_dup',
				reason: 'Duplicate found.',
			},
		}, {
			mergeEntities: async (input) => {
				calls.push(`merge:${input.storyId}:${input.keepEntityId}:${input.mergeEntityId}`);
				return {
					storyId: input.storyId,
					serverVersion: 23,
					keepEntityId: input.keepEntityId,
					mergeEntityId: input.mergeEntityId,
					mergedAliases: ['Mira', 'Lady Mira'],
				};
			},
		});
		const review = await executeEngineCommand({
			command: 'patchProposal.review',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_review',
			args: {
				proposalId: 'proposal_1',
				decision: 'approved',
				reviewer: 'human',
			},
		}, {
			reviewPatchProposal: async (input) => {
				calls.push(`review:${input.storyId}:${input.proposalId}:${input.decision}`);
				return {
					storyId: input.storyId,
					serverVersion: 24,
					proposalId: input.proposalId,
					status: input.decision,
					decision: input.decision,
				};
			},
		});
		const audit = await executeEngineCommand({
			command: 'continuity.audit',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_audit',
			args: { limit: 12 },
		}, {
			continuityAudit: async (input) => {
				calls.push(`audit:${input.storyId}:${input.limit}`);
				return {
					storyId: input.storyId,
					generatedAt: '2026-06-09T00:00:00.000Z',
					summary: { openWarnings: 2, pendingProposals: 1, inactiveEntities: 3 },
					openWarnings: [],
					pendingProposals: [],
					inactiveEntities: [],
				};
			},
		});

		expect(resolve.status).toBe('succeeded');
		expect(resolve.projectionChanges).toEqual({
			entityResolution: {
				storyId: 'story_alpha',
				decision: 'update',
				entityId: 'entity_mira',
				confidence: 0.92,
			},
		});
		expect(alias.projectionChanges).toEqual({
			entityAlias: {
				storyId: 'story_alpha',
				entityId: 'entity_mira',
				alias: 'Lady Mira',
			},
		});
		expect(merge.projectionChanges).toEqual({
			entityMerge: {
				storyId: 'story_alpha',
				keepEntityId: 'entity_keep',
				mergeEntityId: 'entity_dup',
				mergedAliasCount: 2,
			},
		});
		expect(review.projectionChanges).toEqual({
			patchProposal: {
				storyId: 'story_alpha',
				proposalId: 'proposal_1',
				status: 'approved',
				decision: 'approved',
			},
		});
		expect(audit.projectionChanges).toEqual({
			continuityAudit: {
				storyId: 'story_alpha',
				openWarnings: 2,
				pendingProposals: 1,
				inactiveEntities: 3,
			},
		});
		expect(calls).toEqual([
			'resolve:story_alpha:Mira',
			'alias:story_alpha:entity_mira:Lady Mira',
			'merge:story_alpha:entity_keep:entity_dup',
			'review:story_alpha:proposal_1:approved',
			'audit:story_alpha:12',
		]);
	});

	it('rejects unknown commands without touching campaign state', async () => {
		const result = await executeEngineCommand({
			command: 'unknown.command',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_2',
			args: {},
		}, {
			loadCampaignProjection: async () => {
				throw new Error('should not load projection');
			},
		});

		expect(result.status).toBe('failed');
		expect(result.error).toContain('Unknown engine command');
	});

	it('publishes command lifecycle events for the control-surface stream', async () => {
		resetEngineEventsForTest();
		const events: Array<{ type: string; data: Record<string, unknown> }> = [];
		const unsubscribe = subscribeEngineEvents('story_alpha', (event) => events.push({
			type: event.type,
			data: event.data,
		}));

		const result = await executeEngineCommand({
			command: 'campaign.cacheStatus',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_cache',
			args: {
				includeSegments: true,
				segmentLimit: 5,
				kind: 'rules_pack',
			},
		}, {
			loadCacheStatus: async (storyId, options) => ({
				storyId,
				entryCount: 1,
				hitCount: 2,
				missCount: 3,
				tokenEstimate: 4,
				byKind: [],
				segments: options?.includeSegments ? [{
					kind: options.kind ?? 'rules_pack',
					cacheKey: 'rules-cache',
					contentHash: 'content-hash',
					tokenEstimate: 4,
					hitCount: 2,
					missCount: 3,
					invalidatedCount: 0,
					dependencyHashes: ['dep-a'],
					metadata: {},
					lastHitAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}] : [],
			}),
		});
		unsubscribe();

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			segments: [
				expect.objectContaining({
					kind: 'rules_pack',
					cacheKey: 'rules-cache',
				}),
			],
		}));
		expect(events.map((event) => event.type)).toEqual([
			'command.received',
			'command.running',
			'cache.status',
			'command.succeeded',
		]);
		expect(events.at(-1)?.data).toEqual(expect.objectContaining({
			commandId: 'cmd_cache',
			command: 'campaign.cacheStatus',
			status: 'succeeded',
		}));
	});

	it('routes timeline brief queries through the shared command surface', async () => {
		resetEngineEventsForTest();
		const events: Array<{ type: string; data: Record<string, unknown> }> = [];
		const unsubscribe = subscribeEngineEvents('story_alpha', (event) => events.push({
			type: event.type,
			data: event.data,
		}));

		const result = await executeEngineCommand({
			command: 'timeline.brief',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_timeline_brief',
			args: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'location_hall'],
				includeSecret: true,
				dueLimit: 2,
			},
		}, {
			loadTimelineBrief: async (input) => ({
				storyId: input.storyId,
				currentTurn: input.currentTurn ?? 12,
				currentWorldTime: '296 AC, 8th moon',
				dueEvents: [],
				recentEvents: [],
				scheduledEvents: [],
				npcEvents: [],
			}),
		});
		unsubscribe();

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			currentTurn: 12,
		}));
		expect(events.map((event) => event.type)).toEqual([
			'command.received',
			'command.running',
			'timeline.brief',
			'command.succeeded',
		]);
		expect(events[2]?.data).toEqual(expect.objectContaining({
			commandId: 'cmd_timeline_brief',
			brief: expect.objectContaining({ storyId: 'story_alpha' }),
		}));
	});

	it('schedules delayed timeline events with NPC links through the command gateway', async () => {
		resetEngineEventsForTest();
		const events: Array<{ type: string; data: Record<string, unknown> }> = [];
		const scheduledInputs: unknown[] = [];
		const unsubscribe = subscribeEngineEvents('story_alpha', (event) => events.push({
			type: event.type,
			data: event.data,
		}));

		const result = await executeEngineCommand({
			command: 'timeline.schedule',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_timeline_schedule',
			args: {
				type: 'alliance',
				title: 'A marriage alliance is sealed',
				body: 'House Mira and the harbor faction bind themselves by marriage.',
				delayTurns: 2,
				factionIds: ['faction_harbor', 'faction_mira'],
				actorNpcEntityIds: ['npc_mira'],
				targetNpcEntityIds: ['npc_harbor_lord'],
				visibility: 'player_known',
			},
		}, {
			loadTimelineBrief: async (input) => ({
				storyId: input.storyId,
				currentTurn: 20,
				currentWorldTime: '296 AC, evening',
				dueEvents: [],
				recentEvents: [],
				scheduledEvents: [],
				npcEvents: [],
			}),
			scheduleTimelineEvent: async (input) => {
				scheduledInputs.push(input);
				return {
					id: 'event_marriage_alliance',
					storyId: input.storyId,
					type: input.type,
					status: 'scheduled',
					title: input.title,
					body: input.body,
					actorEntityIds: input.actorEntityIds ?? [],
					targetEntityIds: input.targetEntityIds ?? [],
					locationId: input.locationId ?? null,
					locationIds: input.locationIds ?? [],
					factionIds: input.factionIds ?? [],
					threadIds: input.threadIds ?? [],
					visibility: input.visibility ?? 'player_known',
					createdTurn: input.currentTurn,
					occurredTurn: null,
					scheduledTurn: input.currentTurn + input.delayTurns,
					worldTime: input.worldTime ?? input.currentWorldTime ?? null,
					memoryImpact: input.memoryImpact ?? {},
					sourceEntryIds: input.sourceEntryIds ?? [],
					sourcePatchIds: input.sourcePatchIds ?? [],
					metadata: input.metadata ?? {},
					serverVersion: input.serverVersion ?? 1,
					createdAt: input.now,
					updatedAt: input.now,
				};
			},
		});
		unsubscribe();

		expect(result.status).toBe('succeeded');
		expect(scheduledInputs).toEqual([
			expect.objectContaining({
				storyId: 'story_alpha',
				currentTurn: 20,
				currentWorldTime: '296 AC, evening',
				delayTurns: 2,
				factionIds: ['faction_harbor', 'faction_mira'],
				actorNpcEntityIds: ['npc_mira'],
				targetNpcEntityIds: ['npc_harbor_lord'],
			}),
		]);
		expect(result.result).toEqual(expect.objectContaining({
			id: 'event_marriage_alliance',
			status: 'scheduled',
			scheduledTurn: 22,
		}));
		expect(events.map((event) => event.type)).toEqual([
			'command.received',
			'command.running',
			'timeline.eventScheduled',
			'command.succeeded',
		]);
	});

	it('advances the story clock, promotes due timeline events, and emits the updated brief', async () => {
		resetEngineEventsForTest();
		const calls: string[] = [];
		const events: Array<{ type: string; data: Record<string, unknown> }> = [];
		const unsubscribe = subscribeEngineEvents('story_alpha', (event) => events.push({
			type: event.type,
			data: event.data,
		}));

		const result = await executeEngineCommand({
			command: 'timeline.advance',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_timeline_advance',
			args: {
				delta: 2,
				presentNpcIds: ['npc_mira'],
				serverVersion: 9,
			},
		}, {
			advanceStoryTurn: async (storyId, delta) => {
				calls.push(`advance:${storyId}:${delta}`);
				return 22;
			},
			promoteDueTimelineEvents: async (storyId, currentTurn, options) => {
				const version = options && typeof options === 'object' ? options.serverVersion : undefined;
				calls.push(`promote:${storyId}:${currentTurn}:${version}`);
				return [{
					id: 'event_marriage_alliance',
					storyId,
					type: 'alliance',
					status: 'due',
					title: 'A marriage alliance is sealed',
					body: 'The delayed alliance now reaches court.',
					actorEntityIds: [],
					targetEntityIds: [],
					locationId: null,
					locationIds: [],
					factionIds: ['faction_harbor', 'faction_mira'],
					threadIds: [],
					visibility: 'player_known',
					createdTurn: 20,
					occurredTurn: null,
					scheduledTurn: 22,
					worldTime: '296 AC, evening',
					memoryImpact: {},
					sourceEntryIds: [],
					sourcePatchIds: [],
					metadata: {},
					serverVersion: 9,
					createdAt: '2026-06-05T12:00:00.000Z',
					updatedAt: '2026-06-05T12:00:00.000Z',
				}];
			},
			loadTimelineBrief: async (input) => {
				calls.push(`brief:${input.storyId}:${input.currentTurn}:${input.presentNpcIds?.join(',')}`);
				return {
					storyId: input.storyId,
					currentTurn: input.currentTurn ?? 22,
					currentWorldTime: '296 AC, evening',
					dueEvents: [{
						id: 'event_marriage_alliance',
						type: 'alliance',
						status: 'due',
						title: 'A marriage alliance is sealed',
						body: 'The delayed alliance now reaches court.',
						turnsUntilDue: 0,
						worldTime: '296 AC, evening',
						npcEntityIds: ['npc_mira'],
						factionIds: ['faction_harbor', 'faction_mira'],
						locationIds: [],
						visibility: 'player_known',
					}],
					recentEvents: [],
					scheduledEvents: [],
					npcEvents: [],
				};
			},
		});
		unsubscribe();

		expect(result.status).toBe('succeeded');
		expect(calls).toEqual([
			'advance:story_alpha:2',
			'promote:story_alpha:22:9',
			'brief:story_alpha:22:npc_mira',
		]);
		expect(result.result).toEqual(expect.objectContaining({
			currentTurn: 22,
			promotedEvents: [expect.objectContaining({ id: 'event_marriage_alliance' })],
			brief: expect.objectContaining({ currentTurn: 22 }),
		}));
		expect(events.map((event) => event.type)).toEqual([
			'command.received',
			'command.running',
			'timeline.eventsDue',
			'timeline.brief',
			'command.succeeded',
		]);
		expect(events[2]?.data).toEqual(expect.objectContaining({
			currentTurn: 22,
			promotedEventIds: ['event_marriage_alliance'],
		}));
	});

	it('prepares turn context and prompt cache diagnostics without generating narration', async () => {
		const prepareCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'turn.prepare',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_prepare',
			args: {
				playerText: 'I ask who benefits from the marriage.',
				clientContext: {
					presentNpcIds: ['npc_mira'],
					sceneEntityIds: ['npc_mira', 'faction_harbor'],
					memoryTokenBudget: 640,
				},
			},
		}, {
			prepareTurn: async (input) => {
				prepareCalls.push(input);
				return {
					storyId: 'story_alpha',
					clientTurnId: 'cmd_prepare',
					playerEntryId: 'entry_cmd_prepare',
					preparedAt: '2026-06-06T00:00:00.000Z',
					contextCounts: {
						recentEntries: 12,
						entities: 14,
						factions: 3,
						gmDueEvents: 1,
					},
					prompt: {
						systemChars: 1000,
						systemDynamicChars: 2400,
						playerPromptChars: 52,
						messageCount: 8,
						messageChars: 3200,
						totalChars: 6652,
						tokenEstimate: 1663,
					},
					retrievedMemory: {
						nodeCount: 3,
						tokenEstimate: 512,
						nodeIds: ['mem_1', 'mem_2', 'mem_3'],
					},
					wikiContext: {
						pageCount: 2,
						seedCount: 1,
						charCount: 1200,
						citations: ['characters/mira.md'],
					},
					timeline: {
						currentTurn: 18,
						currentWorldTime: 'Moon 3',
						dueEventCount: 1,
						recentEventCount: 2,
						scheduledEventCount: 4,
						npcEventCount: 1,
					},
					cache: {
						hitCount: 2,
						missCount: 1,
						tokenEstimate: 2000,
						segments: [
							{
								kind: 'prompt_system',
								cacheKey: 'engine-cache:story_alpha:prompt_system:stable',
								contentHash: 'hash-system',
								hit: true,
								invalidated: false,
								tokenEstimate: 1000,
								hitCount: 5,
								missCount: 1,
								dependencyCount: 1,
							},
						],
					},
					warnings: [],
					timings: [
						{ phase: 'turn.context_assembly', durationMs: 18 },
					],
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			clientTurnId: 'cmd_prepare',
			prompt: expect.objectContaining({
				tokenEstimate: 1663,
				messageCount: 8,
			}),
			cache: expect.objectContaining({
				hitCount: 2,
				missCount: 1,
			}),
		}));
		expect(JSON.stringify(result.result)).not.toContain('Player action:');
		expect(result.projectionChanges).toEqual({
			turnPreparation: {
				clientTurnId: 'cmd_prepare',
				prompt: {
					tokenEstimate: 1663,
					totalChars: 6652,
					messageCount: 8,
				},
				contextCounts: {
					recentEntries: 12,
					entities: 14,
					factions: 3,
					gmDueEvents: 1,
				},
				cache: {
					hitCount: 2,
					missCount: 1,
					tokenEstimate: 2000,
				},
			},
		});
		expect(prepareCalls).toEqual([{
			storyId: 'story_alpha',
			clientTurnId: 'cmd_prepare',
			playerText: 'I ask who benefits from the marriage.',
			localVersion: 0,
			clientContext: {
				presentNpcIds: ['npc_mira'],
				sceneEntityIds: ['npc_mira', 'faction_harbor'],
				memoryTokenBudget: 640,
				threadIds: [],
			},
		}]);
	});

	it('surfaces turn vault evidence and bounded projection diagnostics through the shared command surface', async () => {
		const result = await executeEngineCommand({
			command: 'turn.submit',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_turn',
			args: {
				playerText: 'I ask who benefits from the marriage.',
				clientTurnId: 'turn_1',
			},
		}, {
			submitTurn: async () => ({
				narration: 'Mira names the harbor houses who profit from the alliance.',
				entries: [
					{ id: 'entry_turn_1', type: 'user_action', position: 100 },
					{ id: 'narration_turn_1', type: 'narration', position: 101 },
				],
				playerEntryId: 'entry_turn_1',
				assistantEntryId: 'narration_turn_1',
				statePatchIds: ['patch_turn_1'],
				eventIds: ['event_turn_1'],
				retrievedMemoryIds: ['mem_mira'],
				memoryNodeIds: ['mem_turn_1'],
				serverVersion: 12,
				syncChanges: [],
				warnings: [],
				generationTimings: [],
				performance: {
					preparedCacheHit: true,
					prompt: {
						tokenEstimate: 1663,
						totalChars: 6652,
						messageCount: 12,
					},
					cache: {
						hitCount: 4,
						missCount: 1,
						tokenEstimate: 6000,
						segmentCount: 4,
					},
					generation: {
						operationCount: 1,
						durationMs: 900,
						requestTokens: 1000,
						responseTokens: 120,
						totalTokens: 1120,
					},
					waterfall: {},
					topSpans: [],
					slowTimings: [
						{ operation: 'turn.context_assembly', durationMs: 410 },
					],
				},
				contextReceipt: null,
				campaignVault: {
					files: [{
						relativePath: 'raw/turns/000100-turn-1.md',
						kind: 'raw_turn',
						contentHash: 'hash-raw-turn',
						byteLength: 1234,
					}],
				},
				projection: {
					mode: 'control_surface',
					entryLimit: 80,
					counts: {
						entries: 10002,
						entities: 312,
						events: 44,
						memoryNodes: 91,
					},
					cache: {
						hitCount: 4,
						missCount: 1,
						tokenEstimate: 6000,
					},
				},
			}),
		});

		expect(result.status).toBe('succeeded');
		expect(result.projectionChanges).toEqual({
			entries: [
				{ id: 'entry_turn_1', type: 'user_action', position: 100 },
				{ id: 'narration_turn_1', type: 'narration', position: 101 },
			],
			serverVersion: 12,
			statePatchIds: ['patch_turn_1'],
			eventIds: ['event_turn_1'],
			cache: {
				hitCount: 4,
				missCount: 1,
				tokenEstimate: 6000,
			},
			contextReceipt: null,
			projection: {
				mode: 'control_surface',
				entryLimit: 80,
				counts: {
					entries: 10002,
					entities: 312,
					events: 44,
					memoryNodes: 91,
				},
			},
			vault: {
				files: [{
					relativePath: 'raw/turns/000100-turn-1.md',
					kind: 'raw_turn',
					contentHash: 'hash-raw-turn',
					byteLength: 1234,
				}],
			},
			performance: {
				preparedCacheHit: true,
				prompt: {
					tokenEstimate: 1663,
					totalChars: 6652,
					messageCount: 12,
				},
				cache: {
					hitCount: 4,
					missCount: 1,
					tokenEstimate: 6000,
					segmentCount: 4,
				},
				generation: {
					operationCount: 1,
					durationMs: 900,
					requestTokens: 1000,
					responseTokens: 120,
					totalTokens: 1120,
				},
				waterfall: {},
				topSpans: [],
				slowTimings: [
					{ operation: 'turn.context_assembly', durationMs: 410 },
				],
			},
		});
	});

	it('routes memory retrieval through the shared command surface', async () => {
		const result = await executeEngineCommand({
			command: 'memory.retrieve',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_memory',
			args: {
				query: 'silver gate',
				presentNpcIds: ['npc_mira'],
				tokenBudget: 420,
			},
		}, {
			retrieveMemory: async (input) => ({
				storyId: input.storyId,
				query: input.query,
				packet: 'Mira remembers the silver gate.',
				nodes: [],
				tokenEstimate: input.tokenBudget,
				retrievalDebug: ['engine-command'],
			}),
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual(expect.objectContaining({
			storyId: 'story_alpha',
			query: 'silver gate',
			tokenEstimate: 420,
		}));
		expect(result.projectionChanges).toEqual({
			memory: { nodeCount: 0, tokenEstimate: 420 },
		});
	});

	it('routes sync pull and push through the shared command surface', async () => {
		const change = { table: 'story_entries', id: 'entry_1', version: 12, op: 'upsert' as const, row: { id: 'entry_1' } };
		const pull = await executeEngineCommand({
			command: 'sync.pull',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_pull',
			args: { since: 9 },
		}, {
			pullSyncChanges: async (input) => ({
				storyId: input.storyId,
				serverVersion: 12,
				changes: [change],
			}),
		});

		const push = await executeEngineCommand({
			command: 'sync.push',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_push',
			args: {
				localVersion: 11,
				ops: [{
					id: 'op_1',
					storyId: 'story_alpha',
					type: 'delete_entry',
					payload: { entryId: 'entry_old' },
					clientVersion: 11,
					clientCreatedAt: '2026-06-05T12:00:00.000Z',
				}],
			},
		}, {
			pushSyncOperations: async (input) => ({
				storyId: input.storyId,
				serverVersion: 12,
				appliedOpIds: (input.ops ?? []).map((op) => op.id),
				rejected: [],
				repairItems: [],
				changes: [change],
			}),
		});

		expect(pull.status).toBe('succeeded');
		expect(pull.result).toEqual(expect.objectContaining({ serverVersion: 12, changes: [change] }));
		expect(push.status).toBe('succeeded');
		expect(push.result).toEqual(expect.objectContaining({ appliedOpIds: ['op_1'], changes: [change] }));
	});

	it('routes world-sim job control through the shared command surface', async () => {
		const result = await executeEngineCommand({
			command: 'jobs.worldSim',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_world_sim',
			args: {
				localVersion: 12,
				force: true,
				workerId: 'manual_worker',
			},
		}, {
			runWorldSimJob: async (input) => ({
				ok: true,
				storyId: input.storyId,
				workerId: input.workerId,
				jobId: 'job_1',
			}),
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			workerId: 'manual_worker',
			jobId: 'job_1',
		});
		expect(result.projectionChanges).toEqual({
			jobs: { worldSim: { ok: true, storyId: 'story_alpha', workerId: 'manual_worker', jobId: 'job_1' } },
		});
	});

	it('routes story export and delete through the shared backend command surface', async () => {
		const calls: string[] = [];
		const exported = await executeEngineCommand({
			command: 'story.export',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_story_export',
			args: {},
		}, {
			exportStory: async (storyId) => {
				calls.push(`export:${storyId}`);
				return {
					schemaVersion: 8,
					source: 'terminal_world_database',
					story: { id: storyId, title: 'Long Campaign' },
					storyEntries: [{ id: 'entry_1' }],
					backendCanon: { story: { id: storyId } },
				};
			},
		});
		const deleted = await executeEngineCommand({
			command: 'story.delete',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_story_delete',
			args: {},
		}, {
			deleteStory: async (storyId) => {
				calls.push(`delete:${storyId}`);
				return { ok: true, storyId, artifactCleanup: { filesDeleted: 2 } };
			},
		});

		expect(exported.status).toBe('succeeded');
		expect(exported.result).toEqual(expect.objectContaining({
			source: 'terminal_world_database',
			storyEntries: [{ id: 'entry_1' }],
		}));
		expect(exported.projectionChanges).toEqual({
			storyExport: {
				storyId: 'story_alpha',
				entryCount: 1,
				source: 'terminal_world_database',
			},
		});
		expect(deleted.status).toBe('succeeded');
		expect(deleted.result).toEqual({ ok: true, storyId: 'story_alpha', artifactCleanup: { filesDeleted: 2 } });
		expect(deleted.projectionChanges).toEqual({
			story: {
				storyId: 'story_alpha',
				deleted: true,
			},
		});
		expect(calls).toEqual(['export:story_alpha', 'delete:story_alpha']);
	});

	it('routes IndexedDB imports through the shared backend command surface', async () => {
		const importCalls: unknown[] = [];
		const result = await executeEngineCommand({
			command: 'story.importIndexedDb',
			storyId: 'story_import',
			clientCommandId: 'cmd_import',
			args: {
				bundle: {
					story: { id: 'story_import', title: 'Imported Campaign' },
					storyEntries: [{ id: 'entry_1', content: 'Arrival.' }],
				},
				options: {
					preserveIds: true,
					rebuildMemoryNodes: false,
				},
			},
		}, {
			importIndexedDbBundle: async (input) => {
				importCalls.push(input);
				return {
					storyId: 'story_import',
					serverVersion: 3,
					counts: { stories: 1, entries: 1 },
					skipped: [],
					merged: [],
				};
			},
		});

		expect(result.status).toBe('succeeded');
		expect(result.result).toEqual({
			storyId: 'story_import',
			serverVersion: 3,
			counts: { stories: 1, entries: 1 },
			skipped: [],
			merged: [],
		});
		expect(result.projectionChanges).toEqual({
			storyImport: {
				storyId: 'story_import',
				serverVersion: 3,
				counts: { stories: 1, entries: 1 },
				skippedCount: 0,
				mergedCount: 0,
			},
		});
		expect(importCalls).toEqual([{
			bundle: {
				story: { id: 'story_import', title: 'Imported Campaign' },
				storyEntries: [{ id: 'entry_1', content: 'Arrival.' }],
			},
			options: {
				preserveIds: true,
				rebuildMemoryNodes: false,
			},
		}]);
	});

	it('routes story catalog list and create through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const listed = await executeEngineCommand({
			command: 'story.list',
			storyId: '__app__',
			clientCommandId: 'cmd_story_list',
			args: {},
		}, {
			listStories: async () => {
				calls.push({ kind: 'list' });
				return [
					{ id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 },
					{ id: 'story_beta', title: 'Second Campaign', serverVersion: 2 },
				];
			},
		});
		const created = await executeEngineCommand({
			command: 'story.create',
			storyId: '__app__',
			clientCommandId: 'cmd_story_create',
			args: {
				title: 'New Campaign',
				description: 'A small beginning.',
				genre: 'fantasy',
				mode: 'adventure',
				clientStoryId: 'local_1',
			},
		}, {
			createStory: async (input) => {
				calls.push({ kind: 'create', input });
				return {
					storyId: 'story_new',
					serverVersion: 1,
					createdAt: '2026-06-06T00:00:00.000Z',
				};
			},
		});

		expect(listed.status).toBe('succeeded');
		expect(listed.result).toEqual({
			stories: [
				{ id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 },
				{ id: 'story_beta', title: 'Second Campaign', serverVersion: 2 },
			],
		});
		expect(listed.projectionChanges).toEqual({
			storyCatalog: {
				count: 2,
			},
		});
		expect(created.status).toBe('succeeded');
		expect(created.result).toEqual({
			storyId: 'story_new',
			serverVersion: 1,
			createdAt: '2026-06-06T00:00:00.000Z',
		});
		expect(created.projectionChanges).toEqual({
			story: {
				storyId: 'story_new',
				serverVersion: 1,
				created: true,
			},
		});
		expect(calls).toEqual([
			{ kind: 'list' },
			{
				kind: 'create',
				input: {
					title: 'New Campaign',
					description: 'A small beginning.',
					genre: 'fantasy',
					mode: 'adventure',
					clientStoryId: 'local_1',
				},
			},
		]);
	});

	it('routes manual job controls through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const reindex = await executeEngineCommand({
			command: 'jobs.reindexStory',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_reindex',
			args: {
				runNow: true,
				recordTypes: ['entities', 'events'],
				recreate: true,
				provider: 'ollama',
				model: 'nomic-embed-text',
			},
		}, {
			runReindexStoryJob: async (input) => {
				const request = input as { storyId: string };
				calls.push({ kind: 'reindex', input });
				return {
					ok: true,
					storyId: request.storyId,
					jobId: 'job_reindex',
					job: { jobId: 'job_reindex', completed: true },
				};
			},
		});
		const status = await executeEngineCommand({
			command: 'jobs.status',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_jobs_status',
			args: {
				limit: 25,
			},
		}, {
			listJobs: async (input) => {
				calls.push({ kind: 'listJobs', input });
				return {
					stats: { total: 3, ready: 1 },
					jobs: [
						{ id: 'job_1', storyId: input.storyId, status: 'ready', updatedAt: '2026-06-06T00:00:00.000Z' },
						{ id: 'job_2', storyId: input.storyId, status: 'completed', updatedAt: '2026-06-06T00:01:00.000Z' },
					],
				};
			},
		});
		const due = await executeEngineCommand({
			command: 'jobs.runDue',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_run_due',
			args: {
				workerId: 'manual_worker',
				limit: 7,
			},
		}, {
			runDueJobs: async (input) => {
				calls.push({ kind: 'runDue', input });
				return {
					ok: true,
					storyId: input.storyId,
					workerId: input.workerId,
					limit: input.limit,
					before: { total: 3 },
					after: { total: 1 },
					claimed: 2,
					completed: 2,
					failed: [],
					timings: [],
				};
			},
		});

		expect(reindex.status).toBe('succeeded');
		expect(reindex.result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			jobId: 'job_reindex',
			job: { jobId: 'job_reindex', completed: true },
		});
		expect(reindex.projectionChanges).toEqual({
			jobs: {
				reindexStory: {
					ok: true,
					storyId: 'story_alpha',
					jobId: 'job_reindex',
					completed: true,
				},
			},
		});
		expect(status.status).toBe('succeeded');
		expect(status.result).toEqual({
			stats: { total: 3, ready: 1 },
			jobs: [
				{ id: 'job_1', storyId: 'story_alpha', status: 'ready', updatedAt: '2026-06-06T00:00:00.000Z' },
				{ id: 'job_2', storyId: 'story_alpha', status: 'completed', updatedAt: '2026-06-06T00:01:00.000Z' },
			],
		});
		expect(status.projectionChanges).toEqual({
			jobs: {
				status: {
					storyId: 'story_alpha',
					limit: 25,
					jobCount: 2,
					total: 3,
				},
			},
		});
		expect(due.status).toBe('succeeded');
		expect(due.projectionChanges).toEqual({
			jobs: {
				runDue: {
					ok: true,
					storyId: 'story_alpha',
					workerId: 'manual_worker',
					limit: 7,
					claimed: 2,
					completed: 2,
					failedCount: 0,
				},
			},
		});
		expect(calls).toEqual([
			{
				kind: 'reindex',
				input: {
					storyId: 'story_alpha',
					runNow: true,
					recordTypes: ['entities', 'events'],
					recreate: true,
					provider: 'ollama',
					model: 'nomic-embed-text',
				},
			},
			{
				kind: 'listJobs',
				input: {
					storyId: 'story_alpha',
					limit: 25,
					allStories: false,
				},
			},
			{
				kind: 'runDue',
				input: {
					storyId: 'story_alpha',
					workerId: 'manual_worker',
					limit: 7,
					allStories: false,
				},
			},
		]);
	});

	it('routes story vault sync jobs through the shared backend command surface', async () => {
		const calls: unknown[] = [];
		const storyScoped = await executeEngineCommand({
			command: 'jobs.storyVaultSync',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_wiki_story',
			args: {
				workerId: 'manual_wiki',
				runNow: false,
				index: true,
				lint: true,
				thinChars: 12000,
				provider: 'ollama',
				model: 'nomic-embed-text',
			},
		}, {
			runStoryVaultSyncJob: async (input) => {
				calls.push({ kind: 'storyVaultSync', input });
				return {
					ok: true,
					storyId: input.storyId,
					jobId: 'job_wiki_story',
					workerId: input.workerId,
					before: { total: 1 },
					after: { total: 2 },
					job: null,
				};
			},
		});
		const bulk = await executeEngineCommand({
			command: 'jobs.storyVaultSync',
			storyId: '__all_stories__',
			clientCommandId: 'cmd_wiki_bulk',
			args: {
				allStories: true,
				workerId: 'manual_wiki_bulk',
				runNow: true,
				includeFresh: true,
				index: true,
				limit: 5,
			},
		}, {
			runStoryVaultSyncJob: async (input) => {
				calls.push({ kind: 'storyVaultSync', input });
				return {
					ok: true,
					mode: 'bulk',
					workerId: input.workerId,
					selected: 2,
					queued: 2,
					runNow: true,
					before: { total: 3 },
					after: { total: 5 },
					jobs: [
						{ storyId: 'story_alpha', jobId: 'job_wiki_1' },
						{ storyId: 'story_beta', jobId: 'job_wiki_2' },
					],
				};
			},
		});

		expect(storyScoped.status).toBe('succeeded');
		expect(storyScoped.result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			jobId: 'job_wiki_story',
			workerId: 'manual_wiki',
			before: { total: 1 },
			after: { total: 2 },
			job: null,
		});
		expect(storyScoped.projectionChanges).toEqual({
			jobs: {
				storyVaultSync: {
					ok: true,
					mode: 'story',
					storyId: 'story_alpha',
					workerId: 'manual_wiki',
					jobId: 'job_wiki_story',
					queued: 1,
					selected: 1,
					runNow: false,
					completed: true,
				},
			},
		});
		expect(bulk.status).toBe('succeeded');
		expect(bulk.projectionChanges).toEqual({
			jobs: {
				storyVaultSync: {
					ok: true,
					mode: 'bulk',
					storyId: null,
					workerId: 'manual_wiki_bulk',
					jobId: null,
					queued: 2,
					selected: 2,
					runNow: true,
					completed: true,
				},
			},
		});
		expect(calls).toEqual([
			{
				kind: 'storyVaultSync',
				input: {
					storyId: 'story_alpha',
					allStories: false,
					workerId: 'manual_wiki',
					runNow: false,
					includeFresh: false,
					index: true,
					recreate: false,
					dryRun: false,
					clean: true,
					lint: true,
					thinChars: 12000,
					orphanLayer: 'derived',
					provider: 'ollama',
					model: 'nomic-embed-text',
					limit: 500,
				},
			},
			{
				kind: 'storyVaultSync',
				input: {
					storyId: null,
					allStories: true,
					workerId: 'manual_wiki_bulk',
					runNow: true,
					includeFresh: true,
					index: true,
					recreate: false,
					dryRun: false,
					clean: true,
					lint: false,
					thinChars: null,
					orphanLayer: 'derived',
					provider: null,
					model: null,
					limit: 5,
				},
			},
		]);
	});

	it('runs wiki core actions through engine commands', async () => {
		const calls: unknown[] = [];
		const search = await executeEngineCommand({
			command: 'wiki.search',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_wiki_search',
			args: { storyId: 'story_alpha', q: 'Mira', limit: 4 },
		}, {
			runWikiAction: async (action, input) => {
				calls.push({ action, input });
				return { ok: true, action, input };
			},
		});
		const write = await executeEngineCommand({
			command: 'wiki.write',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_wiki_write',
			args: {
				storyId: 'story_alpha',
				path: 'characters/mira.md',
				content: 'Mira',
				mode: 'replace',
			},
		}, {
			runWikiAction: async (action, input) => {
				calls.push({ action, input });
				return { ok: true, action, input };
			},
		});

		expect(search.status).toBe('succeeded');
		expect(search.result).toEqual({
			ok: true,
			action: 'search',
			input: { storyId: 'story_alpha', q: 'Mira', limit: 4 },
		});
		expect(search.projectionChanges).toEqual({
			wiki: {
				action: 'search',
				storyId: 'story_alpha',
				ok: true,
			},
		});
		expect(write.status).toBe('succeeded');
		expect(write.projectionChanges).toEqual({
			wiki: {
				action: 'write',
				storyId: 'story_alpha',
				ok: true,
			},
		});
		expect(calls).toEqual([
			{
				action: 'search',
				input: { storyId: 'story_alpha', q: 'Mira', limit: 4 },
			},
			{
				action: 'write',
				input: {
					storyId: 'story_alpha',
					path: 'characters/mira.md',
					content: 'Mira',
					mode: 'replace',
				},
			},
		]);
	});

	it('runs wiki runtime status through engine commands', async () => {
		const status = await executeEngineCommand({
			command: 'wiki.status',
			storyId: '__wiki__',
			clientCommandId: 'cmd_wiki_status',
			args: {},
		}, {
			getWikiRuntimeStatus: async () => ({
				ok: true,
				defaultVaultExists: true,
				defaultVaultInitialized: true,
				qdrantCollection: 'mtherios_wiki',
			}),
		});

		expect(status.status).toBe('succeeded');
		expect(status.result).toEqual({
			ok: true,
			defaultVaultExists: true,
			defaultVaultInitialized: true,
			qdrantCollection: 'mtherios_wiki',
		});
		expect(status.projectionChanges).toEqual({
			wiki: {
				action: 'status',
				storyId: null,
				ok: true,
				defaultVaultInitialized: true,
			},
		});
	});

	it('runs story vault materialize and status through engine commands', async () => {
		const calls: unknown[] = [];
		const materialize = await executeEngineCommand({
			command: 'wiki.storyVault.materialize',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_vault_materialize',
			args: {
				storyId: 'story_alpha',
				clean: false,
				index: true,
				recreate: true,
				dryRun: true,
				provider: 'ollama',
				model: 'nomic-embed-text',
			},
		}, {
			materializeWikiStoryVault: async (input) => {
				calls.push({ kind: 'materialize', input });
				return {
					ok: true,
					storyId: input.storyId,
					indexed: { ok: true, output: 'dry-run' },
					status: { storyId: input.storyId, serverVersion: 7 },
				};
			},
		});
		const status = await executeEngineCommand({
			command: 'wiki.storyVault.status',
			storyId: 'story_alpha',
			clientCommandId: 'cmd_vault_status',
			args: { storyId: 'story_alpha' },
		}, {
			getWikiStoryVaultStatus: async (storyId) => {
				calls.push({ kind: 'status', storyId });
				return { ok: true, storyId, serverVersion: 7 };
			},
		});

		expect(materialize.status).toBe('succeeded');
		expect(materialize.result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			indexed: { ok: true, output: 'dry-run' },
			status: { storyId: 'story_alpha', serverVersion: 7 },
		});
		expect(materialize.projectionChanges).toEqual({
			wiki: {
				action: 'storyVault.materialize',
				storyId: 'story_alpha',
				ok: true,
			},
		});
		expect(status.status).toBe('succeeded');
		expect(status.result).toEqual({ ok: true, storyId: 'story_alpha', serverVersion: 7 });
		expect(status.projectionChanges).toEqual({
			wiki: {
				action: 'storyVault.status',
				storyId: 'story_alpha',
				ok: true,
			},
		});
		expect(calls).toEqual([
			{
				kind: 'materialize',
				input: {
					storyId: 'story_alpha',
					clean: false,
					index: true,
					recreate: true,
					dryRun: true,
					provider: 'ollama',
					model: 'nomic-embed-text',
				},
			},
			{ kind: 'status', storyId: 'story_alpha' },
		]);
	});

	it('runs world database schema and import through engine commands', async () => {
		const importRequest = {
			bundle: {
				schemaVersion: 2,
				exportedAt: '2026-06-06T00:00:00.000Z',
				source: 'terminal_world_database',
				worldDatabase: {
					story: { id: 'story_alpha', title: 'Alpha' },
				},
			},
			options: {
				preserveIds: true,
				replaceExisting: false,
				syncWiki: true,
			},
		};
		const schema = await executeEngineCommand({
			command: 'database.schema.get',
			storyId: '__app__',
			clientCommandId: 'cmd_db_schema',
			args: {},
		}, {
			getWorldDatabaseSchema: async () => ({
				schemaVersion: 2,
				name: 'Mtherios Terminal World Database',
			}),
		});
		const imported = await executeEngineCommand({
			command: 'database.importWorldBundle',
			storyId: '__app__',
			clientCommandId: 'cmd_db_import',
			args: importRequest,
		}, {
			importWorldDatabaseBundle: async (input) => ({
				ok: true,
				storyId: 'story_alpha',
				imported: input.bundle.worldDatabase?.story?.title,
				counts: { entries: 0 },
			}),
		});

		expect(schema.status).toBe('succeeded');
		expect(schema.result).toEqual({
			schemaVersion: 2,
			name: 'Mtherios Terminal World Database',
		});
		expect(schema.projectionChanges).toEqual({
			database: {
				schemaVersion: 2,
				name: 'Mtherios Terminal World Database',
			},
		});
		expect(imported.status).toBe('succeeded');
		expect(imported.result).toEqual({
			ok: true,
			storyId: 'story_alpha',
			imported: 'Alpha',
			counts: { entries: 0 },
		});
		expect(imported.projectionChanges).toEqual({
			databaseImport: {
				ok: true,
				storyId: 'story_alpha',
				counts: { entries: 0 },
			},
		});
	});

	it('runs Google Agent Platform model discovery through engine commands', async () => {
		const models = await executeEngineCommand({
			command: 'googleAgent.models',
			storyId: '__app__',
			clientCommandId: 'cmd_google_models',
			args: {},
		}, {
			listGoogleAgentModels: async () => ({
				object: 'list',
				data: [
					{ id: 'google/gemini-2.5-flash', object: 'model', owned_by: 'google' },
					{ id: 'google/gemini-2.5-pro', object: 'model', owned_by: 'google' },
				],
			}),
		});

		expect(models.status).toBe('succeeded');
		expect(models.result).toEqual({
			object: 'list',
			data: [
				{ id: 'google/gemini-2.5-flash', object: 'model', owned_by: 'google' },
				{ id: 'google/gemini-2.5-pro', object: 'model', owned_by: 'google' },
			],
		});
		expect(models.projectionChanges).toEqual({
			googleAgentPlatform: {
				modelCount: 2,
			},
		});
	});
});
