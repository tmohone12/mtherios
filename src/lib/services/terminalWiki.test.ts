import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	briefTerminalWiki,
	contextTerminalWiki,
	searchTerminalWiki,
} from './terminalWiki';

const fetchMock = vi.fn();

function engineResponse(command: string, result: unknown, status: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: 'story_alpha',
		command,
		status,
		result,
		projectionChanges: {},
		error: status === 'failed' ? 'nope' : null,
		createdAt: '2026-06-07T00:00:00.000Z',
		updatedAt: '2026-06-07T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function postedCommand(): Promise<Record<string, unknown>> {
	expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
	}));
	const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('terminal wiki engine gateway client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('routes wiki search through the shared engine command gateway', async () => {
		fetchMock.mockResolvedValue(engineResponse('wiki.search', {
			query: 'Mira',
			results: [{ path: 'wiki/mira.md', title: 'Mira' }],
		}));

		const result = await searchTerminalWiki({ storyId: 'story_alpha', query: 'Mira', limit: 3 });

		expect(result.results).toEqual([{ path: 'wiki/mira.md', title: 'Mira' }]);
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.search',
			args: { storyId: 'story_alpha', query: 'Mira', limit: 3 },
		});
	});

	it('routes wiki context and brief through the shared engine command gateway', async () => {
		fetchMock
			.mockResolvedValueOnce(engineResponse('wiki.context', {
				query: 'current scene',
				generatedAt: '2026-06-07T00:00:00.000Z',
				seedCount: 1,
				pageCount: 1,
				seeds: [],
				pages: [],
				edges: [],
				citations: [],
				contextMarkdown: 'Context',
			}))
			.mockResolvedValueOnce(engineResponse('wiki.brief', {
				ok: true,
				task: 'scene',
				mode: 'brief',
				root: 'vault',
				generatedAt: '2026-06-07T00:00:00.000Z',
				search: { query: 'current scene', seedCount: 0, pageCount: 0, seeds: [] },
				lint: {
					ok: true,
					summary: {},
					missingCoreFiles: [],
					brokenLinks: [],
					orphanPages: [],
					thinPages: [],
					emptyPages: [],
					duplicateTitles: [],
				},
				corePages: [],
				inventory: {
					pageCount: 0,
					layers: {},
					types: {},
					hubs: [],
					recent: [],
					rawSources: [],
					derivedCandidates: [],
				},
				context: {
					query: 'current scene',
					generatedAt: '2026-06-07T00:00:00.000Z',
					seedCount: 0,
					pageCount: 0,
					seeds: [],
					pages: [],
					edges: [],
					citations: [],
					contextMarkdown: '',
				},
				runbook: [],
				nextCommands: [],
				briefMarkdown: 'Brief',
			}));

		await contextTerminalWiki({ storyId: 'story_alpha', query: 'current scene', maxChars: 1200 });
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.context',
			args: { storyId: 'story_alpha', query: 'current scene', maxChars: 1200 },
		});

		const brief = await briefTerminalWiki({ storyId: 'story_alpha', query: 'current scene', mode: 'scene' });
		expect(brief.briefMarkdown).toBe('Brief');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.brief',
			args: { storyId: 'story_alpha', query: 'current scene', mode: 'scene' },
		});
	});

	it('surfaces failed engine wiki commands as terminal wiki errors', async () => {
		fetchMock.mockResolvedValue(engineResponse('wiki.search', null, 'failed'));

		await expect(searchTerminalWiki({ storyId: 'story_alpha', query: 'Mira' }))
			.rejects.toThrow('nope');
	});
});
