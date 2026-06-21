import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineCommandRequest, EngineCommandResponse } from '$lib/contracts/engine';

const commandCalls: EngineCommandRequest[] = [];
const googleProxyCalls: Array<{ body: string; headers: Record<string, string> }> = [];

function succeeded(command: EngineCommandRequest, result: unknown = { ok: true }): EngineCommandResponse {
	return {
		commandId: command.clientCommandId ?? `test_${command.command}`,
		clientCommandId: command.clientCommandId ?? null,
		storyId: command.storyId,
		command: command.command,
		status: 'succeeded',
		result,
		projectionChanges: {},
		error: null,
		createdAt: '2026-06-06T00:00:00.000Z',
		updatedAt: '2026-06-06T00:00:00.000Z',
	};
}

vi.mock('$lib/server/engine/command', () => ({
	executeEngineCommand: vi.fn(async (command: EngineCommandRequest) => {
		commandCalls.push(command);
		if (command.command === 'googleAgent.models') {
			return succeeded(command, {
				object: 'list',
				data: [{ id: 'google/gemini-2.5-flash', object: 'model', owned_by: 'google' }],
			});
		}
		return succeeded(command, { routedThroughGateway: true });
	}),
}));

vi.mock('$lib/server/engine/googleAgentProxy', () => ({
	proxyGoogleAgentChatCompletion: vi.fn(async (request: Request) => {
		googleProxyCalls.push({
			body: await request.text(),
			headers: Object.fromEntries(request.headers.entries()),
		});
		return new Response('{"proxied":true}', {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}),
}));

vi.mock('$lib/server/engine/serviceCommands', () => ({
	runMemoryRetrieveCommand: vi.fn(() => {
		throw new Error('legacy memory retrieve path should not run');
	}),
	runSyncPullCommand: vi.fn(() => {
		throw new Error('legacy sync pull path should not run');
	}),
	runSyncPushCommand: vi.fn(() => {
		throw new Error('legacy sync push path should not run');
	}),
	runWorldSimJobCommand: vi.fn(() => {
		throw new Error('legacy world sim path should not run');
	}),
}));

vi.mock('$lib/server/memory/canonical', () => ({
	createBackendStory: vi.fn(() => {
		throw new Error('legacy story create path should not run');
	}),
	listBackendStories: vi.fn(() => {
		throw new Error('legacy story list path should not run');
	}),
	upsertBackendEntityFromEntry: vi.fn(() => {
		throw new Error('legacy entity upsert path should not run');
	}),
	deleteBackendEntity: vi.fn(() => {
		throw new Error('legacy entity delete path should not run');
	}),
	upsertBackendChapterFromLocal: vi.fn(() => {
		throw new Error('legacy chapter path should not run');
	}),
	upsertBackendArcFromLocal: vi.fn(() => {
		throw new Error('legacy arc path should not run');
	}),
	upsertBackendSagaFromLocal: vi.fn(() => {
		throw new Error('legacy saga path should not run');
	}),
	upsertBackendLivingMemoryFromLocal: vi.fn(() => {
		throw new Error('legacy living memory path should not run');
	}),
	importIndexedDbBundle: vi.fn(() => {
		throw new Error('legacy indexeddb import path should not run');
	}),
	exportBackendStory: vi.fn(() => {
		throw new Error('legacy story export path should not run');
	}),
	deleteBackendStory: vi.fn(() => {
		throw new Error('legacy story delete path should not run');
	}),
	getBootstrap: vi.fn(() => {
		throw new Error('legacy bootstrap path should not run');
	}),
	getStoryEntriesPage: vi.fn(() => {
		throw new Error('legacy transcript path should not run');
	}),
}));

vi.mock('$lib/server/engine/projections', () => ({
	getCampaignProjection: vi.fn(() => {
		throw new Error('legacy projection path should not run');
	}),
}));

vi.mock('$lib/server/engine/campaignVault', () => ({
	readCampaignPage: vi.fn(() => {
		throw new Error('legacy campaign page read path should not run');
	}),
	writeCampaignPage: vi.fn(() => {
		throw new Error('legacy campaign page write path should not run');
	}),
}));

vi.mock('$lib/server/engine/worldRecords', () => ({
	listWorldRecordTypes: vi.fn(() => {
		throw new Error('legacy world record type path should not run');
	}),
	listWorldRecords: vi.fn(() => {
		throw new Error('legacy world record list path should not run');
	}),
	getWorldRecord: vi.fn(() => {
		throw new Error('legacy world record detail path should not run');
	}),
	patchWorldRecord: vi.fn(() => {
		throw new Error('legacy world record patch path should not run');
	}),
	getStoryEntriesAround: vi.fn(() => {
		throw new Error('legacy entries-around path should not run');
	}),
}));

vi.mock('$lib/server/engine/canonicalSearch', () => ({
	searchCanonicalWorld: vi.fn(() => {
		throw new Error('legacy canonical search path should not run');
	}),
}));

vi.mock('$lib/server/engine/apiCallLogs', () => ({
	listApiCallLogs: vi.fn(() => {
		throw new Error('legacy api-call log list path should not run');
	}),
	recordApiCallLog: vi.fn(() => {
		throw new Error('legacy api-call log record path should not run');
	}),
}));

vi.mock('$lib/server/engine/llmSettings', () => ({
	listLlmServiceSettings: vi.fn(() => {
		throw new Error('legacy llm settings list path should not run');
	}),
	saveLocalApiKeyRefs: vi.fn(() => {
		throw new Error('legacy llm settings secret path should not run');
	}),
	upsertLlmServiceSettings: vi.fn(() => {
		throw new Error('legacy llm settings save path should not run');
	}),
}));

vi.mock('$lib/server/memory/retrieval', () => ({
	retrieveMemoryPacket: vi.fn(() => {
		throw new Error('legacy prompt memory retrieval path should not run');
	}),
}));

vi.mock('$lib/server/turn/context', () => ({
	loadTurnContext: vi.fn(() => {
		throw new Error('legacy prompt context path should not run');
	}),
}));

vi.mock('$lib/server/turn/promptPacket', () => ({
	buildServerTurnPrompt: vi.fn(() => {
		throw new Error('legacy prompt packet path should not run');
	}),
	buildStateExtractionPrompt: vi.fn(() => {
		throw new Error('legacy state extraction prompt path should not run');
	}),
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: vi.fn(() => {
		throw new Error('legacy job enqueue path should not run');
	}),
}));

vi.mock('$lib/server/jobs/processor', () => ({
	getBackendJobStats: vi.fn(() => {
		throw new Error('legacy job stats path should not run');
	}),
	runBackendJobNow: vi.fn(() => {
		throw new Error('legacy job run-now path should not run');
	}),
	runDueBackendJobs: vi.fn(() => {
		throw new Error('legacy due-job path should not run');
	}),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: vi.fn(() => {
		throw new Error('legacy backend job database path should not run');
	}),
	isBackendDatabaseConfigured: vi.fn(() => {
		throw new Error('legacy backend health database path should not run');
	}),
}));

vi.mock('$lib/server/db/worldDatabaseImport', () => ({
	importWorldDatabaseBundle: vi.fn(() => {
		throw new Error('legacy world database import path should not run');
	}),
}));

vi.mock('$lib/server/ai/googleAgentPlatform', () => ({
	GOOGLE_AGENT_PLATFORM_MODELS: ['legacy-model'],
	getGoogleAgentPlatformAccessToken: vi.fn(() => {
		throw new Error('legacy google agent token path should not run');
	}),
	getGoogleAgentPlatformBaseUrl: vi.fn(() => {
		throw new Error('legacy google agent base path should not run');
	}),
	getGoogleAgentPlatformEndpoint: vi.fn(() => {
		throw new Error('legacy google agent endpoint path should not run');
	}),
	getGoogleAgentPlatformHeaders: vi.fn(() => {
		throw new Error('legacy google agent headers path should not run');
	}),
	googleAgentPlatformJsonError: vi.fn(() => {
		throw new Error('legacy google agent error helper should not run');
	}),
}));

vi.mock('$lib/server/wiki/storyVault', () => ({
	listStoryVaultFreshnessItems: vi.fn(() => {
		throw new Error('legacy wiki freshness path should not run');
	}),
	getStoryVaultStatus: vi.fn(() => {
		throw new Error('legacy story vault status path should not run');
	}),
	materializeStoryVault: vi.fn(() => {
		throw new Error('legacy story vault materialize path should not run');
	}),
	archiveStoryVault: vi.fn(() => {
		throw new Error('legacy story vault archive path should not run');
	}),
}));

vi.mock('$lib/server/wiki/wikiCore', () => ({
	searchWiki: vi.fn(() => {
		throw new Error('legacy wiki search path should not run');
	}),
	contextWiki: vi.fn(() => {
		throw new Error('legacy wiki context path should not run');
	}),
	briefWiki: vi.fn(() => {
		throw new Error('legacy wiki brief path should not run');
	}),
	lintWiki: vi.fn(() => {
		throw new Error('legacy wiki lint path should not run');
	}),
	followWiki: vi.fn(() => {
		throw new Error('legacy wiki follow path should not run');
	}),
	pageWiki: vi.fn(() => {
		throw new Error('legacy wiki page path should not run');
	}),
	pagesWiki: vi.fn(() => {
		throw new Error('legacy wiki pages path should not run');
	}),
	writeWiki: vi.fn(() => {
		throw new Error('legacy wiki write path should not run');
	}),
	ingestWiki: vi.fn(() => {
		throw new Error('legacy wiki ingest path should not run');
	}),
	initWiki: vi.fn(() => {
		throw new Error('legacy wiki init path should not run');
	}),
	indexWiki: vi.fn(() => {
		throw new Error('legacy wiki index path should not run');
	}),
}));

vi.mock('$lib/server/app/config', () => ({
	getMtheriosAppConfig: vi.fn(() => {
		throw new Error('legacy app config path should not run');
	}),
	ensureServerDataDirs: vi.fn(() => {
		throw new Error('legacy app directory path should not run');
	}),
}));

vi.mock('$lib/server/env', () => ({
	BackendNotConfiguredError: class BackendNotConfiguredError extends Error {},
	getServerMemoryConfig: vi.fn(() => {
		throw new Error('legacy server memory config path should not run');
	}),
}));

function jsonRequest(body: unknown): Request {
	return new Request('http://localhost/api/test', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

describe('legacy API route gateway compatibility', () => {
	beforeEach(() => {
		commandCalls.length = 0;
		googleProxyCalls.length = 0;
	});

	it('wraps sync pull in the engine command envelope', async () => {
		const { GET } = await import('./sync/pull/+server');

		const response = await GET({
			url: new URL('http://localhost/api/sync/pull?storyId=story_alpha&since=7'),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'sync.pull',
			args: { since: 7 },
		}]);
	});

	it('wraps sync push in the engine command envelope', async () => {
		const { POST } = await import('./sync/push/+server');
		const body = {
			storyId: 'story_alpha',
			localVersion: 7,
			ops: [],
		};

		const response = await POST({
			request: jsonRequest(body),
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'sync.push',
			args: {
				localVersion: 7,
				ops: [],
			},
		}]);
	});

	it('wraps memory retrieval in the engine command envelope', async () => {
		const { POST } = await import('./memory/retrieve/+server');
		const body = {
			storyId: 'story_alpha',
			query: 'Who remembers the treaty?',
			tokenBudget: 400,
		};

		const response = await POST({
			request: jsonRequest(body),
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'memory.retrieve',
			args: {
				query: 'Who remembers the treaty?',
				sceneEntityIds: [],
				threadIds: [],
				presentNpcIds: [],
				includeSecret: false,
				tokenBudget: 400,
			},
		}]);
	});

	it('wraps manual world-sim jobs in the engine command envelope', async () => {
		const { POST } = await import('./app/jobs/world-sim/+server');
		const body = {
			storyId: 'story_alpha',
			localVersion: 12,
			force: true,
		};

		const response = await POST({
			request: jsonRequest(body),
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'jobs.worldSim',
			args: {
				localVersion: 12,
				force: true,
			},
		}]);
	});

	it('wraps story entity creates, patches, and deletes in the engine command envelope', async () => {
		const entityList = await import('./stories/[id]/entities/+server');
		const entityDetail = await import('./stories/[id]/entities/[entityId]/+server');

		const createResponse = await entityList.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({ entry: { id: 'npc_mira', name: 'Mira' } }),
		} as Parameters<typeof entityList.POST>[0]);
		const patchResponse = await entityDetail.PATCH({
			params: { id: 'story_alpha', entityId: 'npc_mira' },
			request: jsonRequest({ entry: { name: 'Mira of the Harbor' } }),
		} as Parameters<typeof entityDetail.PATCH>[0]);
		const deleteResponse = await entityDetail.DELETE({
			params: { id: 'story_alpha', entityId: 'npc_old' },
		} as Parameters<typeof entityDetail.DELETE>[0]);

		expect(createResponse.status).toBe(200);
		expect(patchResponse.status).toBe(200);
		expect(deleteResponse.status).toBe(200);
		expect(await readJson(createResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(patchResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(deleteResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'entity.upsert',
				args: { entry: { id: 'npc_mira', name: 'Mira' } },
			},
			{
				storyId: 'story_alpha',
				command: 'entity.upsert',
				args: { entry: { name: 'Mira of the Harbor', id: 'npc_mira' } },
			},
			{
				storyId: 'story_alpha',
				command: 'entity.delete',
				args: { entityId: 'npc_old' },
			},
		]);
	});

	it('wraps chapter, arc, and saga writes in the engine command envelope', async () => {
		const chapters = await import('./stories/[id]/chapters/+server');
		const arcs = await import('./stories/[id]/arcs/+server');
		const sagas = await import('./stories/[id]/sagas/+server');

		const chapterResponse = await chapters.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({ chapter: { id: 'chapter_1', title: 'The Gate' } }),
		} as Parameters<typeof chapters.POST>[0]);
		const arcResponse = await arcs.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({ arc: { id: 'arc_1', title: 'Silver Gates' } }),
		} as Parameters<typeof arcs.POST>[0]);
		const sagaResponse = await sagas.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({ saga: { id: 'saga_1', title: 'The Long Road' } }),
		} as Parameters<typeof sagas.POST>[0]);

		expect(chapterResponse.status).toBe(200);
		expect(arcResponse.status).toBe(200);
		expect(sagaResponse.status).toBe(200);
		expect(await readJson(chapterResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(arcResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(sagaResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'chapter.upsert',
				args: { chapter: { id: 'chapter_1', title: 'The Gate' } },
			},
			{
				storyId: 'story_alpha',
				command: 'arc.upsert',
				args: { arc: { id: 'arc_1', title: 'Silver Gates' } },
			},
			{
				storyId: 'story_alpha',
				command: 'saga.upsert',
				args: { saga: { id: 'saga_1', title: 'The Long Road' } },
			},
		]);
	});

	it('wraps living-memory writes in the engine command envelope', async () => {
		const livingMemory = await import('./stories/[id]/living-memory/+server');

		const response = await livingMemory.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({
				kind: 'worldEvent',
				record: { id: 'event_1', title: 'Rumor reaches court' },
				records: [{ id: 'event_2', title: 'A faction delays tribute' }],
			}),
		} as Parameters<typeof livingMemory.POST>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'livingMemory.upsert',
			args: {
				kind: 'worldEvent',
				record: { id: 'event_1', title: 'Rumor reaches court' },
				records: [{ id: 'event_2', title: 'A faction delays tribute' }],
			},
		}]);
	});

	it('wraps story bootstrap and projection reads in the engine command envelope', async () => {
		const bootstrap = await import('./stories/[id]/bootstrap/+server');
		const projection = await import('./stories/[id]/projection/+server');

		const bootstrapResponse = await bootstrap.GET({
			params: { id: 'story_alpha' },
		} as Parameters<typeof bootstrap.GET>[0]);
		const projectionResponse = await projection.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/projection?limit=33'),
		} as Parameters<typeof projection.GET>[0]);

		expect(bootstrapResponse.status).toBe(200);
		expect(projectionResponse.status).toBe(200);
		expect(await readJson(bootstrapResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(projectionResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'campaign.bootstrap',
				args: {},
			},
			{
				storyId: 'story_alpha',
				command: 'campaign.status',
				args: { entryLimit: 33 },
			},
		]);
	});

	it('wraps transcript page reads in the engine command envelope', async () => {
		const transcript = await import('./stories/[id]/transcript/+server');

		const response = await transcript.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/transcript?beforePosition=99&limit=20&branchId=main'),
		} as Parameters<typeof transcript.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'campaign.transcriptPage',
			args: {
				beforePosition: 99,
				limit: 20,
				branchId: 'main',
			},
		}]);
	});

	it('wraps campaign vault page reads and writes in the engine command envelope', async () => {
		const vaultPage = await import('./stories/[id]/vault/page/+server');

		const readResponse = await vaultPage.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/vault/page?kind=character_page&name=Mira'),
		} as Parameters<typeof vaultPage.GET>[0]);
		const writeResponse = await vaultPage.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({
				kind: 'character_page',
				name: 'Mira',
				title: 'Mira',
				body: '## Looks\nSalt-dark hair.\n\n## Personality\nCareful.',
				entityIds: ['npc_mira'],
				serverVersion: 7,
			}),
		} as Parameters<typeof vaultPage.POST>[0]);

		expect(readResponse.status).toBe(200);
		expect(writeResponse.status).toBe(200);
		expect(await readJson(readResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(writeResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'campaign.page.read',
				args: {
					kind: 'character_page',
					name: 'Mira',
					path: null,
				},
			},
			{
				storyId: 'story_alpha',
				command: 'campaign.page.write',
				args: {
					kind: 'character_page',
					name: 'Mira',
					title: 'Mira',
					body: '## Looks\nSalt-dark hair.\n\n## Personality\nCareful.',
					tags: [],
					entityIds: ['npc_mira'],
					factionIds: [],
					sourceEntryIds: [],
					sourceEventIds: [],
					sourcePatchIds: [],
					path: null,
					metadata: {},
					serverVersion: 7,
				},
			},
		]);
	});

	it('wraps legacy entries page reads in the transcript command envelope', async () => {
		const entries = await import('./stories/[id]/entries/+server');

		const response = await entries.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/entries?cursor=88&limit=25&branchId=main'),
		} as Parameters<typeof entries.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'campaign.transcriptPage',
			args: {
				beforePosition: 88,
				limit: 25,
				branchId: 'main',
			},
		}]);
	});

	it('wraps chapter, arc, and saga detail patches in the engine command envelope', async () => {
		const chapter = await import('./stories/[id]/chapters/[chapterId]/+server');
		const arc = await import('./stories/[id]/arcs/[arcId]/+server');
		const saga = await import('./stories/[id]/sagas/[sagaId]/+server');

		const chapterResponse = await chapter.PATCH({
			params: { id: 'story_alpha', chapterId: 'chapter_2' },
			request: jsonRequest({ chapter: { title: 'A Changed Gate' } }),
		} as Parameters<typeof chapter.PATCH>[0]);
		const arcResponse = await arc.PATCH({
			params: { id: 'story_alpha', arcId: 'arc_2' },
			request: jsonRequest({ arc: { title: 'A Changed Arc' } }),
		} as Parameters<typeof arc.PATCH>[0]);
		const sagaResponse = await saga.PATCH({
			params: { id: 'story_alpha', sagaId: 'saga_2' },
			request: jsonRequest({ saga: { title: 'A Changed Saga' } }),
		} as Parameters<typeof saga.PATCH>[0]);

		expect(chapterResponse.status).toBe(200);
		expect(arcResponse.status).toBe(200);
		expect(sagaResponse.status).toBe(200);
		expect(await readJson(chapterResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(arcResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(sagaResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'chapter.upsert',
				args: { chapter: { title: 'A Changed Gate', id: 'chapter_2' } },
			},
			{
				storyId: 'story_alpha',
				command: 'arc.upsert',
				args: { arc: { title: 'A Changed Arc', id: 'arc_2' } },
			},
			{
				storyId: 'story_alpha',
				command: 'saga.upsert',
				args: { saga: { title: 'A Changed Saga', id: 'saga_2' } },
			},
		]);
	});

	it('wraps chapter arc deletes and context checkpoint routes in the engine command envelope', async () => {
		const chapter = await import('./stories/[id]/chapters/[chapterId]/+server');
		const arc = await import('./stories/[id]/arcs/[arcId]/+server');
		const checkpoints = await import('./stories/[id]/context-checkpoints/+server');
		const checkpointRevert = await import('./stories/[id]/context-checkpoints/[checkpointId]/revert/+server');

		const chapterResponse = await chapter.DELETE({
			params: { id: 'story_alpha', chapterId: 'chapter_2' },
		} as Parameters<typeof chapter.DELETE>[0]);
		const arcResponse = await arc.DELETE({
			params: { id: 'story_alpha', arcId: 'arc_2' },
		} as Parameters<typeof arc.DELETE>[0]);
		const checkpointListResponse = await checkpoints.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/context-checkpoints?limit=9'),
		} as Parameters<typeof checkpoints.GET>[0]);
		const checkpointCreateResponse = await checkpoints.POST({
			params: { id: 'story_alpha' },
			request: jsonRequest({ label: 'Before poison' }),
		} as Parameters<typeof checkpoints.POST>[0]);
		const checkpointRevertResponse = await checkpointRevert.POST({
			params: { id: 'story_alpha', checkpointId: 'checkpoint_1' },
			request: jsonRequest({ reason: 'Bad context' }),
		} as Parameters<typeof checkpointRevert.POST>[0]);

		expect(chapterResponse.status).toBe(200);
		expect(arcResponse.status).toBe(200);
		expect(checkpointListResponse.status).toBe(200);
		expect(checkpointCreateResponse.status).toBe(200);
		expect(checkpointRevertResponse.status).toBe(200);
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'chapter.delete',
				args: { chapterId: 'chapter_2' },
			},
			{
				storyId: 'story_alpha',
				command: 'arc.delete',
				args: { arcId: 'arc_2' },
			},
			{
				storyId: 'story_alpha',
				command: 'context.checkpoint.list',
				args: { limit: 9 },
			},
			{
				storyId: 'story_alpha',
				command: 'context.checkpoint.create',
				args: { label: 'Before poison' },
			},
			{
				storyId: 'story_alpha',
				command: 'context.checkpoint.revert',
				args: { reason: 'Bad context', checkpointId: 'checkpoint_1' },
			},
		]);
	});

	it('wraps entries-around reads in the engine command envelope', async () => {
		const around = await import('./stories/[id]/entries/around/[position]/+server');

		const response = await around.GET({
			params: { id: 'story_alpha', position: '144' },
			url: new URL('http://localhost/api/stories/story_alpha/entries/around/144?radius=9'),
		} as Parameters<typeof around.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'campaign.entriesAround',
			args: {
				position: 144,
				radius: 9,
			},
		}]);
	});

	it('wraps world record list and search reads in the engine command envelope', async () => {
		const world = await import('./stories/[id]/world/+server');
		const search = await import('./stories/[id]/search/+server');

		const worldResponse = await world.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/world?type=factions&q=harbor&cursor=20&limit=25'),
		} as Parameters<typeof world.GET>[0]);
		const searchResponse = await search.GET({
			params: { id: 'story_alpha' },
			url: new URL('http://localhost/api/stories/story_alpha/search?q=Mira&type=entities&limit=5&semantic=false'),
		} as Parameters<typeof search.GET>[0]);

		expect(worldResponse.status).toBe(200);
		expect(searchResponse.status).toBe(200);
		expect(await readJson(worldResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(searchResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'world.records',
				args: {
					type: 'factions',
					q: 'harbor',
					cursor: '20',
					limit: 25,
				},
			},
			{
				storyId: 'story_alpha',
				command: 'world.search',
				args: {
					q: 'Mira',
					type: 'entities',
					limit: 5,
					includeSemantic: false,
				},
			},
		]);
	});

	it('wraps world record detail reads and patches in the engine command envelope', async () => {
		const recordRoute = await import('./records/[type]/[id]/+server');

		const readResponse = await recordRoute.GET({
			params: { type: 'characters', id: 'npc_mira' },
		} as Parameters<typeof recordRoute.GET>[0]);
		const patchResponse = await recordRoute.PATCH({
			params: { type: 'characters', id: 'npc_mira' },
			request: jsonRequest({
				updates: { name: 'Mira of the Harbor' },
				reason: 'Manual explorer edit.',
			}),
		} as Parameters<typeof recordRoute.PATCH>[0]);

		expect(readResponse.status).toBe(200);
		expect(patchResponse.status).toBe(200);
		expect(await readJson(readResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(patchResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__app__',
				command: 'world.record.get',
				args: {
					type: 'characters',
					recordId: 'npc_mira',
				},
			},
			{
				storyId: '__app__',
				command: 'world.record.patch',
				args: {
					type: 'characters',
					recordId: 'npc_mira',
					updates: { name: 'Mira of the Harbor' },
					reason: 'Manual explorer edit.',
				},
			},
		]);
	});

	it('wraps story export, import, and delete in the engine command envelope', async () => {
		const exportRoute = await import('./export/[storyId]/+server');
		const importRoute = await import('./import/indexeddb/+server');
		const deleteRoute = await import('./stories/[id]/+server');
		const importBody = {
			bundle: {
				story: { id: 'story_alpha', title: 'Imported Campaign' },
				storyEntries: [{ id: 'entry_1', content: 'Arrival.' }],
			},
			options: {
				preserveIds: true,
				rebuildMemoryNodes: false,
			},
		};

		const exportResponse = await exportRoute.GET({
			params: { storyId: 'story_alpha' },
		} as Parameters<typeof exportRoute.GET>[0]);
		const importResponse = await importRoute.POST({
			request: jsonRequest(importBody),
		} as Parameters<typeof importRoute.POST>[0]);
		const deleteResponse = await deleteRoute.DELETE({
			params: { id: 'story_alpha' },
		} as Parameters<typeof deleteRoute.DELETE>[0]);

		expect(exportResponse.status).toBe(200);
		expect(importResponse.status).toBe(200);
		expect(deleteResponse.status).toBe(200);
		expect(await readJson(exportResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(importResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(deleteResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'story.export',
				args: {},
			},
			{
				storyId: 'story_alpha',
				command: 'story.importIndexedDb',
				args: importBody,
			},
			{
				storyId: 'story_alpha',
				command: 'story.delete',
				args: {},
			},
		]);
	});

	it('wraps manual job controls in the engine command envelope', async () => {
		const jobsRoute = await import('./jobs/+server');
		const reindexRoute = await import('./jobs/reindex-story/+server');
		const runDueRoute = await import('./app/jobs/run/+server');
		const reindexBody = {
			storyId: 'story_alpha',
			runNow: true,
			recordTypes: ['entities', 'events'],
			recreate: true,
			provider: 'ollama',
			model: 'nomic-embed-text',
		};

		const reindexResponse = await reindexRoute.POST({
			request: jsonRequest(reindexBody),
		} as Parameters<typeof reindexRoute.POST>[0]);
		const statusResponse = await jobsRoute.GET({
			url: new URL('http://localhost/api/jobs?storyId=story_alpha&limit=25'),
		} as Parameters<typeof jobsRoute.GET>[0]);
		const runDueResponse = await runDueRoute.POST({
			request: jsonRequest({
				storyId: 'story_alpha',
				workerId: 'manual_worker',
				limit: 7,
			}),
			url: new URL('http://localhost/api/app/jobs/run'),
		} as Parameters<typeof runDueRoute.POST>[0]);

		expect(reindexResponse.status).toBe(200);
		expect(statusResponse.status).toBe(200);
		expect(runDueResponse.status).toBe(200);
		expect(await readJson(reindexResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(statusResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(runDueResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'jobs.reindexStory',
				args: reindexBody,
			},
			{
				storyId: 'story_alpha',
				command: 'jobs.status',
				args: {
					limit: 25,
					allStories: false,
				},
			},
			{
				storyId: 'story_alpha',
				command: 'jobs.runDue',
				args: {
					workerId: 'manual_worker',
					limit: 7,
					allStories: false,
				},
			},
		]);
	});

	it('wraps story vault wiki jobs in the engine command envelope', async () => {
		const wikiRoute = await import('./app/jobs/wiki/+server');

		const storyResponse = await wikiRoute.POST({
			request: jsonRequest({
				storyId: 'story_alpha',
				workerId: 'manual_wiki',
				runNow: false,
				index: true,
				lint: true,
				thinChars: 12000,
				provider: 'ollama',
				model: 'nomic-embed-text',
			}),
		} as Parameters<typeof wikiRoute.POST>[0]);
		const bulkResponse = await wikiRoute.POST({
			request: jsonRequest({
				storyId: '*',
				workerId: 'manual_wiki_bulk',
				runNow: true,
				includeFresh: true,
				index: true,
				limit: 5,
			}),
		} as Parameters<typeof wikiRoute.POST>[0]);

		expect(storyResponse.status).toBe(200);
		expect(bulkResponse.status).toBe(200);
		expect(await readJson(storyResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(bulkResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'jobs.storyVaultSync',
				args: {
					workerId: 'manual_wiki',
					runNow: false,
					index: true,
					lint: true,
					thinChars: 12000,
					provider: 'ollama',
					model: 'nomic-embed-text',
					allStories: false,
				},
			},
			{
				storyId: '__all_stories__',
				command: 'jobs.storyVaultSync',
				args: {
					workerId: 'manual_wiki_bulk',
					runNow: true,
					includeFresh: true,
					index: true,
					limit: 5,
					allStories: true,
				},
			},
		]);
	});

	it('wraps wiki core actions in the engine command envelope', async () => {
		const searchRoute = await import('./wiki/search/+server');
		const contextRoute = await import('./wiki/context/+server');
		const writeRoute = await import('./wiki/write/+server');
		const initRoute = await import('./wiki/init/+server');

		const searchBody = { storyId: 'story_alpha', q: 'Mira', limit: 4 };
		const contextBody = { storyId: 'story_alpha', query: 'current scene', maxChars: 1200 };
		const writeBody = { storyId: 'story_alpha', path: 'characters/mira.md', content: 'Mira', mode: 'replace' };

		const searchResponse = await searchRoute.POST({
			request: jsonRequest(searchBody),
		} as Parameters<typeof searchRoute.POST>[0]);
		const contextResponse = await contextRoute.POST({
			request: jsonRequest(contextBody),
		} as Parameters<typeof contextRoute.POST>[0]);
		const writeResponse = await writeRoute.POST({
			request: jsonRequest(writeBody),
		} as Parameters<typeof writeRoute.POST>[0]);
		const initResponse = await initRoute.POST({
			request: jsonRequest({ storyId: 'story_alpha' }),
		} as Parameters<typeof initRoute.POST>[0]);

		expect(searchResponse.status).toBe(200);
		expect(contextResponse.status).toBe(200);
		expect(writeResponse.status).toBe(200);
		expect(initResponse.status).toBe(200);
		expect(await readJson(searchResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(contextResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(writeResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(initResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'wiki.search',
				args: searchBody,
			},
			{
				storyId: 'story_alpha',
				command: 'wiki.context',
				args: contextBody,
			},
			{
				storyId: 'story_alpha',
				command: 'wiki.write',
				args: writeBody,
			},
			{
				storyId: 'story_alpha',
				command: 'wiki.init',
				args: { storyId: 'story_alpha' },
			},
		]);
	});

	it('wraps wiki runtime status in the engine command envelope', async () => {
		const statusRoute = await import('./wiki/status/+server');

		const response = await statusRoute.GET({} as Parameters<typeof statusRoute.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__wiki__',
				command: 'wiki.status',
				args: {},
			},
		]);
	});

	it('wraps story vault materialize and status in the engine command envelope', async () => {
		const storyVaultRoute = await import('./wiki/story-vault/+server');
		const statusRoute = await import('./wiki/story-vault/status/+server');
		const body = {
			storyId: 'story_alpha',
			clean: false,
			index: true,
			recreate: true,
			dryRun: true,
			provider: 'ollama',
			model: 'nomic-embed-text',
		};

		const materializeResponse = await storyVaultRoute.POST({
			request: jsonRequest(body),
		} as Parameters<typeof storyVaultRoute.POST>[0]);
		const statusResponse = await statusRoute.GET({
			url: new URL('http://localhost/api/wiki/story-vault/status?storyId=story_alpha'),
		} as Parameters<typeof statusRoute.GET>[0]);

		expect(materializeResponse.status).toBe(200);
		expect(statusResponse.status).toBe(200);
		expect(await readJson(materializeResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(statusResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'wiki.storyVault.materialize',
				args: body,
			},
			{
				storyId: 'story_alpha',
				command: 'wiki.storyVault.status',
				args: { storyId: 'story_alpha' },
			},
		]);
	});

	it('wraps world database schema and import in the engine command envelope', async () => {
		const schemaRoute = await import('./database/schema/+server');
		const importRoute = await import('./database/import/+server');
		const importBody = {
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

		const schemaResponse = await schemaRoute.GET({} as Parameters<typeof schemaRoute.GET>[0]);
		const importResponse = await importRoute.POST({
			request: jsonRequest(importBody),
		} as Parameters<typeof importRoute.POST>[0]);

		expect(schemaResponse.status).toBe(200);
		expect(importResponse.status).toBe(200);
		expect(await readJson(schemaResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(importResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__app__',
				command: 'database.schema.get',
				args: {},
			},
			{
				storyId: '__app__',
				command: 'database.importWorldBundle',
				args: importBody,
			},
		]);
	});

	it('wraps Google Agent Platform model discovery and chat proxy in the engine surface', async () => {
		const modelsRoute = await import('./google-agent-platform/openai/models/+server');
		const chatRoute = await import('./google-agent-platform/openai/chat/completions/+server');
		const chatBody = {
			model: 'google/gemini-2.5-flash',
			messages: [{ role: 'user', content: 'hello' }],
		};

		const modelsResponse = await modelsRoute.GET({} as Parameters<typeof modelsRoute.GET>[0]);
		const chatResponse = await chatRoute.POST({
			request: jsonRequest(chatBody),
		} as Parameters<typeof chatRoute.POST>[0]);

		expect(modelsResponse.status).toBe(200);
		expect(chatResponse.status).toBe(200);
		expect(await readJson(modelsResponse)).toEqual({
			object: 'list',
			data: [{ id: 'google/gemini-2.5-flash', object: 'model', owned_by: 'google' }],
		});
		expect(await readJson(chatResponse)).toEqual({ proxied: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__app__',
				command: 'googleAgent.models',
				args: {},
			},
		]);
		expect(googleProxyCalls).toEqual([{
			body: JSON.stringify(chatBody),
			headers: { 'content-type': 'application/json' },
		}]);
	});

	it('wraps story catalog list and create in the engine command envelope', async () => {
		const stories = await import('./stories/+server');
		const createBody = {
			title: 'New Campaign',
			description: 'A small beginning.',
			genre: 'fantasy',
			mode: 'adventure',
			clientStoryId: 'local_1',
		};

		const listResponse = await stories.GET({} as Parameters<typeof stories.GET>[0]);
		const createResponse = await stories.POST({
			request: jsonRequest(createBody),
		} as Parameters<typeof stories.POST>[0]);

		expect(listResponse.status).toBe(200);
		expect(createResponse.status).toBe(200);
		expect(await readJson(listResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(createResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__app__',
				command: 'story.list',
				args: {},
			},
			{
				storyId: '__app__',
				command: 'story.create',
				args: createBody,
			},
		]);
	});

	it('wraps app status reads in the engine command envelope', async () => {
		const status = await import('./app/status/+server');

		const response = await status.GET({
			url: new URL('http://localhost/api/app/status?storyId=story_alpha'),
		} as Parameters<typeof status.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'app.status',
			args: {},
		}]);
	});

	it('wraps backend health reads in the engine command envelope', async () => {
		const health = await import('./health/+server');

		const response = await health.GET({} as Parameters<typeof health.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: '__app__',
			command: 'app.health',
			args: {},
		}]);
	});

	it('wraps API-call log reads and writes in the engine command envelope', async () => {
		const logs = await import('./api-call-logs/+server');
		const logBody = {
			storyId: 'story_alpha',
			serviceId: 'narrator',
			operation: 'turn.generate',
			providerType: 'ollama',
			model: 'llama3.1',
			endpoint: 'http://localhost:11434/api/generate?token=secret',
			status: 'success',
			durationMs: 321,
			requestTokens: 100,
			responseTokens: 50,
			totalTokens: 150,
			metadata: { clientTurnId: 'turn_1' },
		};

		const listResponse = await logs.GET({
			url: new URL('http://localhost/api/api-call-logs?storyId=story_alpha&status=error&serviceId=narrator&limit=25'),
		} as Parameters<typeof logs.GET>[0]);
		const recordResponse = await logs.POST({
			request: jsonRequest(logBody),
		} as Parameters<typeof logs.POST>[0]);

		expect(listResponse.status).toBe(200);
		expect(recordResponse.status).toBe(200);
		expect(await readJson(listResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(recordResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: 'story_alpha',
				command: 'apiCallLogs.list',
				args: {
					status: 'error',
					serviceId: 'narrator',
					limit: 25,
				},
			},
			{
				storyId: 'story_alpha',
				command: 'apiCallLogs.record',
				args: logBody,
			},
		]);
	});

	it('wraps prompt packet diagnostics in the engine command envelope', async () => {
		const promptPacket = await import('./debug/prompt-packet/[storyId]/+server');

		const response = await promptPacket.GET({
			params: { storyId: 'story_alpha' },
			url: new URL('http://localhost/api/debug/prompt-packet/story_alpha?q=marriage&tokenBudget=777'),
		} as Parameters<typeof promptPacket.GET>[0]);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([{
			storyId: 'story_alpha',
			command: 'debug.promptPacket',
			args: {
				query: 'marriage',
				tokenBudget: 777,
			},
		}]);
	});

	it('wraps LLM settings reads and writes in the engine command envelope', async () => {
		const settings = await import('./settings/llm/+server');
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
		const patchBody = {
			settings: [setting],
			secrets: [{ ref: 'env:OPENAI_API_KEY', value: 'sk-test' }],
		};

		const listResponse = await settings.GET({} as Parameters<typeof settings.GET>[0]);
		const saveResponse = await settings.PATCH({
			request: jsonRequest(patchBody),
		} as Parameters<typeof settings.PATCH>[0]);

		expect(listResponse.status).toBe(200);
		expect(saveResponse.status).toBe(200);
		expect(await readJson(listResponse)).toEqual({ routedThroughGateway: true });
		expect(await readJson(saveResponse)).toEqual({ routedThroughGateway: true });
		expect(commandCalls).toEqual([
			{
				storyId: '__app__',
				command: 'settings.llm.list',
				args: {},
			},
			{
				storyId: '__app__',
				command: 'settings.llm.save',
				args: patchBody,
			},
		]);
	});
});
