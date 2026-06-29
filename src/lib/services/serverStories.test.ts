import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStory, deleteStory, getAllStories, getStory, updateStory } from '$lib/services/database';
import {
	createBackendStoryShell,
	createContextCheckpoint,
	cacheBackendStoryFromBootstrap,
	createBackendArc,
	createBackendChapter,
	createBackendLorebookEntry,
	createBackendSaga,
	deleteBackendArc,
	deleteBackendChapter,
	deleteBackendLorebookEntry,
	deleteStoryEverywhere,
	fetchBackendStoryBootstrap,
	fetchBackendStoryEntriesPage,
	fetchBackendStoryProjection,
	fetchEngineCacheStatus,
	listBackendStories,
	refreshStoryCatalog,
	listContextCheckpoints,
	resolveBackendStoryBootstrap,
	revertToContextCheckpoint,
	upsertBackendArc,
	upsertBackendChapter,
	upsertBackendLivingMemory,
	upsertBackendLorebookEntry,
	upsertBackendSaga,
} from './serverStories';
import type { CampaignProjection, EngineCacheStatus } from '$lib/contracts/engine';
import type { BootstrapResponse, StoryEntriesPageResponse } from '$lib/contracts/memory';
import type { Story } from '$lib/types';

vi.mock('$lib/services/database', () => ({
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getAllStories: vi.fn(async () => []),
	getStory: vi.fn(async () => null),
	updateStory: vi.fn(),
}));

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function engineResponse(command: string, storyId: string, result: unknown) {
	return {
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId,
		command,
		status: 'succeeded',
		result,
		projectionChanges: {},
		error: null,
		createdAt: '2026-06-05T12:00:00.000Z',
		updatedAt: '2026-06-05T12:00:00.000Z',
	};
}

const projection: CampaignProjection = {
	mode: 'control_surface',
	story: { id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 },
	entries: [{ id: 'entry_1', position: 1 }],
	chapters: [],
	arcs: [],
	sagas: [],
	counts: { entries: 10000, entities: 12, events: 3, memoryNodes: 30, chapters: 0, arcs: 0, sagas: 0 },
	vault: { vaultPath: 'data/vaults/campaigns/story_alpha', fileCount: 6, lastIndexedVersion: 7 },
	cache: { storyId: 'story_alpha', entryCount: 4, hitCount: 3, missCount: 1, tokenEstimate: 640, byKind: [], segments: [] },
};

const bootstrap: BootstrapResponse = {
	story: { id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 },
	serverVersion: 7,
	entries: projection.entries,
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
	projection,
};

const transcriptPage: StoryEntriesPageResponse = {
	storyId: 'story_alpha',
	serverVersion: 8,
	entries: [{ id: 'entry_80', position: 80 }],
	entryCount: 10000,
	hasMore: true,
	nextBeforePosition: 80,
};

describe('server story control-surface client', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('lists creates and deletes backend stories through the engine command gateway', async () => {
		const stories = [{ id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 }];
		const created = {
			storyId: 'story_new',
			serverVersion: 1,
			createdAt: '2026-06-07T00:00:00.000Z',
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse(engineResponse('story.list', '__app__', { stories })))
			.mockResolvedValueOnce(jsonResponse(engineResponse('story.create', '__app__', created)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('story.delete', 'story_alpha', {
				ok: true,
				storyId: 'story_alpha',
			})));

		await expect(listBackendStories()).resolves.toEqual(stories);
		await expect(createBackendStoryShell({
			title: 'New Campaign',
			description: 'A beginning.',
			genre: 'fantasy',
			mode: 'adventure',
			clientStoryId: 'local_1',
		})).resolves.toEqual(created);
		await expect(deleteStoryEverywhere({
			id: 'local_1',
			serverStoryId: 'story_alpha',
		} as Story, { mode: 'purge', exportBeforeDelete: true })).resolves.toEqual(expect.objectContaining({
			ok: true,
			storyId: 'story_alpha',
			mode: 'purge',
		}));

		const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
		expect(payloads).toEqual([
			{
				storyId: '__app__',
				command: 'story.list',
				args: {},
			},
			{
				storyId: '__app__',
				command: 'story.create',
				args: {
					title: 'New Campaign',
					description: 'A beginning.',
					genre: 'fantasy',
					mode: 'adventure',
					clientStoryId: 'local_1',
				},
			},
			{
				storyId: 'story_alpha',
				command: 'story.delete',
				args: { mode: 'purge', exportBeforeDelete: true },
			},
		]);
		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({ method: 'POST' }));
		expect(vi.mocked(deleteStory)).toHaveBeenCalledWith('local_1');
	});

	it('fetches backend story bootstrap through the engine command gateway', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(
			engineResponse('campaign.bootstrap', 'story_alpha', bootstrap),
		));

		const result = await fetchBackendStoryBootstrap('story_alpha');

		expect(result).toEqual(bootstrap);
		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({ method: 'POST' }));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.bootstrap',
			args: {
				entryLimit: 80,
				entityLimit: 120,
				relationshipLimit: 200,
				factionLimit: 80,
				factionMembershipLimit: 160,
				factionResourceLimit: 160,
				factionGoalLimit: 160,
				factionProjectLimit: 160,
				agreementLimit: 80,
				npcBeliefLimit: 80,
				threadLimit: 80,
				chapterLimit: 80,
				arcLimit: 80,
				sagaLimit: 40,
				eventLimit: 80,
				patchLimit: 80,
				memoryNodeLimit: 80,
			},
		});
	});

	it('recovers a cached story when its backend story id is stale', async () => {
		const recoveredBootstrap: BootstrapResponse = {
			...bootstrap,
			story: { ...bootstrap.story, id: 'story_recovered' },
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({
				...engineResponse('campaign.bootstrap', 'story_missing', null),
				status: 'failed',
				error: 'Story not found',
			}))
			.mockResolvedValueOnce(jsonResponse({
				...engineResponse('campaign.bootstrap', 'local_story', null),
				status: 'failed',
				error: 'Story not found',
			}))
			.mockResolvedValueOnce(jsonResponse(engineResponse('story.list', '__app__', {
				stories: [{ id: 'story_recovered', clientStoryId: 'local_story', title: 'Long Campaign', serverVersion: 7 }],
			})))
			.mockResolvedValueOnce(jsonResponse(engineResponse('campaign.bootstrap', 'story_recovered', recoveredBootstrap)));

		await expect(resolveBackendStoryBootstrap({
			id: 'local_story',
			serverStoryId: 'story_missing',
			title: 'Long Campaign',
		} as Story)).resolves.toEqual(recoveredBootstrap);

		expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).storyId)).toEqual([
			'story_missing',
			'local_story',
			'__app__',
			'story_recovered',
		]);
	});

	it('keeps the existing browser story id when rebinding a detached backend story', async () => {
		vi.mocked(getStory).mockResolvedValueOnce({
			id: 'local_detached_story',
			title: 'Detached Local Story',
			serverStoryId: 'story_missing',
		} as Story);

		const result = await cacheBackendStoryFromBootstrap(bootstrap, 'local_detached_story');

		expect(result.id).toBe('local_detached_story');
		expect(vi.mocked(createStory)).not.toHaveBeenCalled();
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith('local_detached_story', expect.objectContaining({
			serverStoryId: 'story_alpha',
			serverVersion: 7,
			syncStatus: 'synced',
		}));
	});

	it('hides stale backend-bound local stories missing from the terminal catalog', async () => {
		const localStories = [
			{ id: 'local_only', title: 'Local Draft', serverStoryId: null, updatedAt: 1000 },
			{ id: 'local_volantis', title: 'Volantis: Black Walls Intrigue', serverStoryId: 'story_missing', updatedAt: 3000 },
			{ id: 'local_detached', title: 'Detached stale story', serverStoryId: null, syncStatus: 'local-only', updatedAt: 2500 },
			{ id: 'local_alpha', title: 'Long Campaign', serverStoryId: 'story_alpha', updatedAt: 2000 },
		] as Story[];
		vi.mocked(getAllStories).mockResolvedValueOnce(localStories);
		vi.mocked(getStory).mockImplementation(async (id) => localStories.find((story) => story.id === id));
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(engineResponse('story.list', '__app__', {
			stories: [{ id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 }],
		})));

		const catalog = await refreshStoryCatalog();

		expect(catalog.map((story) => story.id)).toEqual(['local_alpha', 'local_only']);
		expect(catalog.map((story) => story.title)).not.toContain('Volantis: Black Walls Intrigue');
		expect(catalog.map((story) => story.title)).not.toContain('Detached stale story');
	});

	it('fetches bounded projections through the engine command gateway', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(
			engineResponse('campaign.status', 'story_alpha', projection),
		));

		const result = await fetchBackendStoryProjection('story_alpha', 120);

		expect(result).toEqual(projection);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.status',
			args: { entryLimit: 120 },
		});
	});

	it('fetches paged transcript rows through the engine command gateway', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(
			engineResponse('campaign.transcriptPage', 'story_alpha', transcriptPage),
		));

		const result = await fetchBackendStoryEntriesPage('story_alpha', {
			beforePosition: 120,
			limit: 40,
			branchId: 'main',
		});

		expect(result).toEqual(transcriptPage);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.transcriptPage',
			args: {
				beforePosition: 120,
				limit: 40,
				branchId: 'main',
			},
		});
	});

	it('fetches story-scoped cache status through the engine command gateway', async () => {
		const cache: EngineCacheStatus = projection.cache;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(
			engineResponse('campaign.cacheStatus', 'story_alpha', cache),
		));

		const result = await fetchEngineCacheStatus('story_alpha');

		expect(result).toEqual(cache);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.cacheStatus',
			args: {},
		});
	});

	it('requests story-scoped cache segment diagnostics through the engine command gateway', async () => {
		const cache: EngineCacheStatus = {
			...projection.cache,
			segments: [{
				kind: 'rules_pack',
				cacheKey: 'rules-cache',
				contentHash: 'hash-a',
				tokenEstimate: 640,
				hitCount: 3,
				missCount: 1,
				invalidatedCount: 0,
				dependencyHashes: ['dep-a'],
				metadata: {},
				lastHitAt: null,
				createdAt: '2026-06-05T12:00:00.000Z',
				updatedAt: '2026-06-05T12:00:00.000Z',
			}],
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(
			engineResponse('campaign.cacheStatus', 'story_alpha', cache),
		));

		const result = await fetchEngineCacheStatus('story_alpha', {
			includeSegments: true,
			segmentLimit: 5,
			kind: 'rules_pack',
		});

		expect(result).toEqual(cache);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.cacheStatus',
			args: {
				includeSegments: true,
				segmentLimit: 5,
				kind: 'rules_pack',
			},
		});
	});

	it('writes lore entities through the engine command gateway', async () => {
		const entityResult = { storyId: 'story_alpha', serverVersion: 9, entity: { id: 'npc_mira', name: 'Mira' } };
		const deleteResult = { storyId: 'story_alpha', serverVersion: 10, entityId: 'npc_old', deleted: true };
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse(engineResponse('entity.upsert', 'story_alpha', entityResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('entity.create', 'story_alpha', entityResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('entity.delete', 'story_alpha', deleteResult)));

		await expect(upsertBackendLorebookEntry('story_alpha', { id: 'npc_mira', name: 'Mira', type: 'character' } as never)).resolves.toEqual(entityResult);
		await expect(createBackendLorebookEntry('story_alpha', { id: 'npc_mira', name: 'Mira', type: 'character' } as never)).resolves.toEqual(entityResult);
		await expect(deleteBackendLorebookEntry('story_alpha', 'npc_old')).resolves.toEqual(deleteResult);

		const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
		expect(payloads).toEqual([
			{
				storyId: 'story_alpha',
				command: 'entity.upsert',
				args: { entry: { id: 'npc_mira', name: 'Mira', type: 'character' } },
			},
			{
				storyId: 'story_alpha',
				command: 'entity.create',
				args: { entry: { id: 'npc_mira', name: 'Mira', type: 'character' } },
			},
			{
				storyId: 'story_alpha',
				command: 'entity.delete',
				args: { entityId: 'npc_old' },
			},
		]);
	});

	it('writes chapter arc saga and living-memory rows through the engine command gateway', async () => {
		const chapterResult = { storyId: 'story_alpha', serverVersion: 11, chapter: { id: 'chapter_1' } };
		const arcResult = { storyId: 'story_alpha', serverVersion: 12, arc: { id: 'arc_1' } };
		const sagaResult = { storyId: 'story_alpha', serverVersion: 13, saga: { id: 'saga_1' } };
		const livingResult = { storyId: 'story_alpha', serverVersion: 14, kind: 'worldEvent', recordIds: ['event_1'], counts: { worldEvents: 1 } };
		const chapterDeleteResult = {
			storyId: 'story_alpha',
			serverVersion: 15,
			chapterId: 'chapter_1',
			deleted: true,
			unwrappedArcIds: ['arc_1'],
			unwrappedArcs: [{ id: 'arc_1', chapterIds: ['chapter_2'] }],
		};
		const arcDeleteResult = { storyId: 'story_alpha', serverVersion: 16, arcId: 'arc_1', deleted: true };
		const checkpointResult = { storyId: 'story_alpha', serverVersion: 17, checkpoint: { id: 'checkpoint_1' } };
		const checkpointListResult = { storyId: 'story_alpha', checkpoints: [{ id: 'checkpoint_1' }] };
		const checkpointRevertResult = { storyId: 'story_alpha', serverVersion: 18, checkpoint: { id: 'checkpoint_1' }, restoredCounts: { storyEntries: 2 } };
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse(engineResponse('chapter.upsert', 'story_alpha', chapterResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('chapter.create', 'story_alpha', chapterResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('arc.upsert', 'story_alpha', arcResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('arc.create', 'story_alpha', arcResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('saga.upsert', 'story_alpha', sagaResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('saga.create', 'story_alpha', sagaResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('livingMemory.upsert', 'story_alpha', livingResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('chapter.delete', 'story_alpha', chapterDeleteResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('arc.delete', 'story_alpha', arcDeleteResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('context.checkpoint.create', 'story_alpha', checkpointResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('context.checkpoint.list', 'story_alpha', checkpointListResult)))
			.mockResolvedValueOnce(jsonResponse(engineResponse('context.checkpoint.revert', 'story_alpha', checkpointRevertResult)));

		await expect(upsertBackendChapter('story_alpha', { id: 'chapter_1' } as never)).resolves.toEqual(chapterResult);
		await expect(createBackendChapter('story_alpha', { id: 'chapter_1' } as never)).resolves.toEqual(chapterResult);
		await expect(upsertBackendArc('story_alpha', { id: 'arc_1' } as never)).resolves.toEqual(arcResult);
		await expect(createBackendArc('story_alpha', { id: 'arc_1' } as never)).resolves.toEqual(arcResult);
		await expect(upsertBackendSaga('story_alpha', { id: 'saga_1' } as never)).resolves.toEqual(sagaResult);
		await expect(createBackendSaga('story_alpha', { id: 'saga_1' } as never)).resolves.toEqual(sagaResult);
		await expect(upsertBackendLivingMemory('story_alpha', 'worldEvent', [{ id: 'event_1' }])).resolves.toEqual(livingResult);
		await expect(deleteBackendChapter('story_alpha', 'chapter_1')).resolves.toEqual(chapterDeleteResult);
		await expect(deleteBackendArc('story_alpha', 'arc_1')).resolves.toEqual(arcDeleteResult);
		await expect(createContextCheckpoint('story_alpha', { label: 'Before poison' })).resolves.toEqual(checkpointResult);
		await expect(listContextCheckpoints('story_alpha', 5)).resolves.toEqual(checkpointListResult);
		await expect(revertToContextCheckpoint('story_alpha', 'checkpoint_1', 'bad turn')).resolves.toEqual(checkpointRevertResult);

		const commands = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).command);
		expect(commands).toEqual([
			'chapter.upsert',
			'chapter.create',
			'arc.upsert',
			'arc.create',
			'saga.upsert',
			'saga.create',
			'livingMemory.upsert',
			'chapter.delete',
			'arc.delete',
			'context.checkpoint.create',
			'context.checkpoint.list',
			'context.checkpoint.revert',
		]);
	});
});
