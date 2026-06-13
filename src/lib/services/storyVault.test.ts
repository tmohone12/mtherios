import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStoryVaultStatus, runStoryVaultJob, type StoryVaultStatus } from './storyVault';

const fetchMock = vi.fn();

const status: StoryVaultStatus = {
	storyId: 'story_alpha',
	storyTitle: 'Long Campaign',
	vaultPath: 'data/wiki/story_alpha',
	collection: 'story_alpha_wiki',
	serverVersion: 7,
	exists: true,
	vaultFresh: true,
	indexFresh: false,
	manifestVersion: 7,
	indexedVersion: 6,
	manifest: null,
	lint: {
		exists: true,
		fresh: true,
		ok: true,
		issueCount: 0,
		lintedAt: '2026-06-07T00:00:00.000Z',
		path: 'data/wiki/story_alpha/.mtherios/wiki-lint.json',
		summary: {},
	},
};

function engineResponse(command: string, result: unknown, statusValue: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: 'story_alpha',
		command,
		status: statusValue,
		result,
		projectionChanges: {},
		error: statusValue === 'failed' ? 'vault failed' : null,
		createdAt: '2026-06-07T00:00:00.000Z',
		updatedAt: '2026-06-07T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function postedPayloads(): Array<Record<string, unknown>> {
	return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
}

describe('story vault engine gateway client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('fetches story vault status through the shared engine command gateway', async () => {
		fetchMock.mockResolvedValue(engineResponse('wiki.storyVault.status', status));

		await expect(fetchStoryVaultStatus('story_alpha')).resolves.toEqual(status);

		expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		}));
		expect(postedPayloads()).toEqual([{
			storyId: 'story_alpha',
			command: 'wiki.storyVault.status',
			args: { storyId: 'story_alpha' },
		}]);
	});

	it('runs story vault sync jobs and refreshes status through the shared engine command gateway', async () => {
		const job = {
			ok: true,
			storyId: 'story_alpha',
			jobId: 'job_wiki_1',
			workerId: 'manual_wiki',
		};
		fetchMock
			.mockResolvedValueOnce(engineResponse('jobs.storyVaultSync', job))
			.mockResolvedValueOnce(engineResponse('wiki.storyVault.status', status));

		const result = await runStoryVaultJob({
			storyId: 'story_alpha',
			index: true,
			recreate: true,
			clean: false,
			lint: true,
			thinChars: 12000,
			orphanLayer: 'all',
			runNow: true,
		});

		expect(result).toEqual({ job, status });
		expect(postedPayloads()).toEqual([
			{
				storyId: 'story_alpha',
				command: 'jobs.storyVaultSync',
				args: {
					storyId: 'story_alpha',
					index: true,
					recreate: true,
					clean: false,
					lint: true,
					thinChars: 12000,
					orphanLayer: 'all',
					runNow: true,
				},
			},
			{
				storyId: 'story_alpha',
				command: 'wiki.storyVault.status',
				args: { storyId: 'story_alpha' },
			},
		]);
	});

	it('surfaces failed story vault engine commands', async () => {
		fetchMock.mockResolvedValue(engineResponse('wiki.storyVault.status', null, 'failed'));

		await expect(fetchStoryVaultStatus('story_alpha')).rejects.toThrow('vault failed');
	});
});
