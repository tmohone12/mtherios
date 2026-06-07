import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateStory } from '$lib/services/database';
import { importStoryBundleToBackend } from './backendImport';

const fetchMock = vi.fn();

vi.mock('$lib/services/database', () => ({
	updateStory: vi.fn(),
}));

function engineResponse(command: string, result: unknown, status: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: 'story_import',
		command,
		status,
		result,
		projectionChanges: {},
		error: status === 'failed' ? 'import failed' : null,
		createdAt: '2026-06-07T00:00:00.000Z',
		updatedAt: '2026-06-07T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('backend import engine gateway client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('imports IndexedDB story bundles through the shared engine command gateway', async () => {
		const bundle = {
			story: { id: 'story_import', title: 'Imported Campaign' },
			storyEntries: [{ id: 'entry_1', content: 'Arrival.' }],
		};
		fetchMock.mockResolvedValue(engineResponse('story.importIndexedDb', {
			storyId: 'story_import',
			serverVersion: 3,
			counts: { stories: 1, entries: 1 },
			skipped: [],
			merged: [],
		}));

		const result = await importStoryBundleToBackend(bundle, 'local_story');

		expect(result).toEqual({
			serverStoryId: 'story_import',
			serverVersion: 3,
			counts: { stories: 1, entries: 1 },
		});
		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		}));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			storyId: 'story_import',
			command: 'story.importIndexedDb',
			args: {
				bundle,
				options: { preserveIds: true, rebuildMemoryNodes: true },
			},
		});
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith('local_story', {
			serverStoryId: 'story_import',
			serverVersion: 3,
			syncStatus: 'synced',
		});
	});

	it('surfaces failed engine imports', async () => {
		fetchMock.mockResolvedValue(engineResponse('story.importIndexedDb', null, 'failed'));

		await expect(importStoryBundleToBackend({ story: { id: 'story_import' } }, 'local_story'))
			.rejects.toThrow('import failed');
	});
});
