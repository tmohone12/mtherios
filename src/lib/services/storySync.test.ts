import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStory, deleteStory, updateStory } from '$lib/services/database';
import { downloadStoryAsJson, exportStory, importStoryFromJson, type StoryExportData } from './storySync';

const fetchMock = vi.fn();

vi.mock('$lib/services/database', () => ({
	getStory: vi.fn(async () => ({
		id: 'local_story',
		title: 'Long Campaign',
		serverStoryId: 'story_alpha',
	})),
	getStoryEntries: vi.fn(async () => []),
	getCharacters: vi.fn(async () => []),
	getLocations: vi.fn(async () => []),
	getItems: vi.fn(async () => []),
	getStoryBeats: vi.fn(async () => []),
	getChapters: vi.fn(async () => []),
	getLorebookEntries: vi.fn(async () => []),
	getArcs: vi.fn(async () => []),
	getSagas: vi.fn(async () => []),
	getEntryRelationships: vi.fn(async () => []),
	getConversationMemory: vi.fn(async () => []),
	getWorldEvents: vi.fn(async () => []),
	getAgreements: vi.fn(async () => []),
	getFactionActions: vi.fn(async () => []),
	getRumors: vi.fn(async () => []),
	getSchemes: vi.fn(async () => []),
	getStoryThreads: vi.fn(async () => []),
	getSetting: vi.fn(async () => null),
	setSetting: vi.fn(),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	updateStory: vi.fn(),
	createStoryEntry: vi.fn(),
	putCharacter: vi.fn(),
	putLocation: vi.fn(),
	putItem: vi.fn(),
	createStoryBeat: vi.fn(),
	putChapter: vi.fn(),
	putLorebookEntry: vi.fn(),
	putArc: vi.fn(),
	putSaga: vi.fn(),
}));

const legacyStory: StoryExportData = {
	version: 1,
	exportedAt: 1,
	source: 'backend_canon',
	story: {
		id: 'story_alpha',
		title: 'Long Campaign',
	} as StoryExportData['story'],
	storyEntries: [],
	characters: [],
	locations: [],
	items: [],
	storyBeats: [],
	chapters: [],
	lorebookEntries: [],
	arcs: [],
};

const exportedStory = {
	...legacyStory,
	version: 3,
	schemaVersion: 3,
	source: 'terminal_world_database',
	worldDatabase: {
		story: { id: 'story_alpha', title: 'Long Campaign', serverVersion: 7 },
		entries: [],
		entities: [{ id: 'character_a', name: 'A', state: { knowledge: ['A secret'] } }],
		sourceRefs: [{ id: 'ref_a', sourceEntryId: 'entry_a', metadata: { evidence: 'Keep this' } }],
		futureTable: [{ custom: 'preserved' }],
	},
};

function engineResponse(command: string, result: unknown, status: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: 'story_alpha',
		command,
		status,
		result,
		projectionChanges: {},
		error: status === 'failed' ? 'export failed' : null,
		createdAt: '2026-06-07T00:00:00.000Z',
		updatedAt: '2026-06-07T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('story sync engine gateway client', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('exports backend-owned stories through the shared engine command gateway', async () => {
		fetchMock.mockResolvedValue(engineResponse('story.export', exportedStory));

		await expect(exportStory('local_story')).resolves.toEqual(exportedStory);

		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		}));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_alpha',
			command: 'story.export',
			args: {},
		});
	});

	it('surfaces failed backend story exports', async () => {
		fetchMock.mockResolvedValue(engineResponse('story.export', null, 'failed'));

		await expect(exportStory('local_story')).rejects.toThrow('export failed');
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('still accepts explicitly supported legacy exports', async () => {
		fetchMock.mockResolvedValue(engineResponse('story.export', legacyStory));
		await expect(exportStory('local_story')).resolves.toEqual(legacyStory);
	});

	it('downloads the complete current canonical payload and releases the object URL', async () => {
		fetchMock.mockResolvedValue(engineResponse('story.export', exportedStory));
		const anchor = { href: '', download: '', click: vi.fn() };
		const body = { appendChild: vi.fn(), removeChild: vi.fn() };
		vi.stubGlobal('document', { createElement: () => anchor, body });
		const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
		const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		await downloadStoryAsJson('local_story');
		const blob = createUrl.mock.calls[0][0] as Blob;
		expect(JSON.parse(await blob.text())).toEqual(exportedStory);
		expect(anchor.download).toMatch(/^long-campaign-.*\.mythengine\.json$/);
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(body.removeChild).toHaveBeenCalledExactlyOnceWith(anchor);
		expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:fixture');
	});

	it('imports current bundles through the full-database gateway and then marks the new local story synced', async () => {
		fetchMock.mockResolvedValue(engineResponse('database.importWorldBundle', { ok: true, storyId: 'server_copy', serverVersion: 7, counts: { entities: 1 }, jobIds: [], importedAt: '2026-09-05T00:00:00Z' }));
		const localId = await importStoryFromJson(new File([JSON.stringify(exportedStory)], 'current.json'));
		const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(request.command).toBe('database.importWorldBundle');
		expect(request.args.bundle.worldDatabase).toEqual(exportedStory.worldDatabase);
		expect(request.args.options.preserveIds).toBe(false);
		expect(updateStory).toHaveBeenCalledWith(localId, { serverStoryId: 'server_copy', serverVersion: 7, syncStatus: 'synced' });
	});

	it.each([
		[{ ...exportedStory, version: 99 }, 'Unsupported export version: 99'],
		[{ ...exportedStory, schemaVersion: 99 }, 'schemaVersion'],
		[{ ...exportedStory, worldDatabase: { ...exportedStory.worldDatabase, entries: 'lost' } }, 'entries'],
		[{ ...exportedStory, story: { id: 'story_alpha' } }, 'title'],
	])('rejects invalid backend bundles without downloading them', async (bundle, message) => {
		fetchMock.mockResolvedValue(engineResponse('story.export', bundle));
		await expect(exportStory('local_story')).rejects.toThrow(message);
	});

	it('rejects unsupported file versions before creating a local import', async () => {
		const file = new File([JSON.stringify({ ...exportedStory, version: 99 })], 'future.json');
		await expect(importStoryFromJson(file)).rejects.toThrow('Unsupported export version: 99');
		expect(createStory).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces a rejected legacy import and removes only its new local placeholder', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: 'Legacy import contains 20001 entries; limit is 20000.' })));
		const file = new File([JSON.stringify(legacyStory)], 'legacy.json');
		await expect(importStoryFromJson(file)).rejects.toThrow('Legacy import contains 20001 entries');
		const created = vi.mocked(createStory).mock.calls[0][0];
		expect(created.id).not.toBe(legacyStory.story.id);
		expect(deleteStory).toHaveBeenCalledExactlyOnceWith(created.id);
		expect(updateStory).not.toHaveBeenCalled();
	});

	it('retains the legacy local import compatibility path when the network is unavailable', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		const file = new File([JSON.stringify(legacyStory)], 'legacy.json');
		const importedId = await importStoryFromJson(file);
		expect(updateStory).toHaveBeenCalledWith(importedId, { syncStatus: 'offline' });
		expect(deleteStory).not.toHaveBeenCalled();
	});

	it('does not silently create a partial offline story when a world database import fails', async () => {
		fetchMock.mockResolvedValue(new Response('', { status: 413 }));
		const file = new File([JSON.stringify({
			version: 3,
			schemaVersion: 3,
			exportedAt: 1,
			story: { id: 'story_seed', title: 'World Seed' },
			storyEntries: [],
			characters: [],
			locations: [],
			items: [],
			storyBeats: [],
			chapters: [],
			lorebookEntries: [],
			arcs: [],
			worldDatabase: { story: { id: 'story_seed', title: 'World Seed' }, entries: [] },
		})], 'seed.world-db.json', { type: 'application/json' });

		await expect(importStoryFromJson(file)).rejects.toThrow('World database import failed: Terminal request failed: 413');
		expect(vi.mocked(createStory)).toHaveBeenCalledOnce();
		expect(vi.mocked(deleteStory)).toHaveBeenCalledOnce();
	});
});
