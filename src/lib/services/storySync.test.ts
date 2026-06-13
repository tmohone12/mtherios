import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportStory, type StoryExportData } from './storySync';

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

const exportedStory: StoryExportData = {
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
});
