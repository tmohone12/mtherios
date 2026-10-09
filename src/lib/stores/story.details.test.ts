import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Story } from '$lib/types';

const mocks = vi.hoisted(() => ({ updateStory: vi.fn() }));
vi.mock('$lib/services/database', async original => ({
	...await original<typeof import('$lib/services/database')>(), updateStory: mocks.updateStory,
}));
import { story } from './story.svelte';

const original = { id: 'local_a', serverStoryId: 'canon_a', title: 'Original', headerPrompt: 'Old rules', description: 'Old setting', serverVersion: 1 } as Story;
const details = { title: ' Updated ', headerPrompt: ' New rules ', description: ' New setting ' };

describe('story controls persistence', () => {
	beforeEach(() => { story.clear(); story.currentStory = { ...original }; mocks.updateStory.mockResolvedValue(undefined); });
	afterEach(() => { story.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

	it('saves title, preamble and setting in one canonical update before updating the cache', async () => {
		const fetch = vi.fn(async (_url: string, _options: { body: string }) => {
			expect(mocks.updateStory).not.toHaveBeenCalled();
			return Response.json({ serverVersion: 2 });
		});
		vi.stubGlobal('fetch', fetch);
		await story.updateStoryDetails(details);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][0]).toBe('/api/records/stories/canon_a');
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ updates: { title: 'Updated', headerPrompt: 'New rules', description: 'New setting' } });
		expect(story.currentStory).toMatchObject({ title: 'Updated', headerPrompt: 'New rules', description: 'New setting', serverVersion: 2 });
	});

	it('retains original fields when canon rejects a save so the draft can be retried', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Runtime unavailable' }, { status: 503 })));
		await expect(story.updateStoryDetails(details)).rejects.toThrow('Runtime unavailable');
		expect(story.currentStory).toMatchObject({ title: 'Original', headerPrompt: 'Old rules', description: 'Old setting' });
		expect(mocks.updateStory).not.toHaveBeenCalledWith('local_a', expect.objectContaining({ title: 'Updated' }));
	});

	it.each([true, false])('does not replace another active story after a late save (success=%s)', async success => {
		let complete!: (response: Response) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
		const saving = story.updateStoryDetails(details).catch(() => {});
		story.currentStory = { id: 'local_b', title: 'Other story' } as Story;
		complete(Response.json(success ? { serverVersion: 2 } : { error: 'Late failure' }, { status: success ? 200 : 503 }));
		await saving;
		expect(story.currentStory).toEqual({ id: 'local_b', title: 'Other story' });
		expect(mocks.updateStory.mock.calls.every(call => call[0] === 'local_a')).toBe(true);
	});

	it('keeps a blank title and explicitly clears the optional fields', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ serverVersion: 2 })));
		await story.updateStoryDetails({ title: ' ', headerPrompt: ' ', description: '' });
		expect(story.currentStory).toMatchObject({ title: 'Original', headerPrompt: null, description: null });
	});
});
