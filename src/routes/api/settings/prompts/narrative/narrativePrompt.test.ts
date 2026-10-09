import { beforeEach, describe, expect, it, vi } from 'vitest';
import { narrativePromptPreviewSchema } from '$lib/contracts/prompts';
import { buildServerNarrativeSystemPrompt } from '$lib/server/turn/promptPacket';
import { GET } from './+server';

const getDbMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db/client', () => ({ getDb: getDbMock }));

function readPrompt(query = '') {
	return GET({ url: new URL(`http://localhost/api/settings/prompts/narrative${query}`) } as Parameters<typeof GET>[0]);
}

describe('narrative built-in prompt preview', () => {
	beforeEach(() => {
		getDbMock.mockReset();
	});

	it('previews the default or selected genre without a database', async () => {
		const neutral = narrativePromptPreviewSchema.parse(await (await readPrompt()).json());
		const feudal = narrativePromptPreviewSchema.parse(await (await readPrompt('?promptPackId=feudal-dark-gritty-asoiaf')).json());

		expect(neutral.promptPackId).toBe('neutral-narrator');
		expect(neutral.storyId).toBeNull();
		expect(neutral.storyTitle).toBeNull();
		expect(neutral.builtInPrompt).not.toContain('Economy scale');
		expect(feudal.promptPackLabel).toBe('Feudal Dark Gritty');
		expect(feudal.builtInPrompt).toContain('ASOIAF-inspired');
		expect(feudal.builtInPrompt).toContain('Economy scale');
		expect(getDbMock).not.toHaveBeenCalled();
	});

	it('uses the canonical story preamble and selected genre with the live compiler', async () => {
		const story = {
			title: 'A court of dragons',
			genre: 'political fantasy',
			headerPrompt: 'The academy is closed for winter.',
			metadata: { activePromptPackId: 'anime-power-fantasy' },
			settings: {},
		};
		const limit = vi.fn().mockResolvedValue([story]);
		const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
		getDbMock.mockReturnValue({ select });

		const response = await readPrompt('?storyId=story_court');
		const result = narrativePromptPreviewSchema.parse(await response.json());

		expect(response.status).toBe(200);
		expect(result).toMatchObject({
			storyId: 'story_court',
			storyTitle: story.title,
			promptPackId: 'anime-power-fantasy',
			promptPackLabel: 'Anime Power Fantasy',
			builtInPrompt: buildServerNarrativeSystemPrompt(story),
		});
		expect(result.builtInPrompt).toContain(`Story-specific preamble:\n${story.headerPrompt}`);
		expect(select).toHaveBeenCalledTimes(1);
		expect(limit).toHaveBeenCalledWith(1);
	});

	it('rejects invalid selectors before querying the database', async () => {
		for (const query of [
			'?promptPackId=missing-pack',
			'?storyId=story_court&promptPackId=neutral-narrator',
			'?storyId=',
			'?unexpected=value',
		]) {
			expect((await readPrompt(query)).status).toBe(400);
		}
		expect(getDbMock).not.toHaveBeenCalled();
	});

	it('returns 404 when the selected canonical story is missing', async () => {
		getDbMock.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) });
		expect((await readPrompt('?storyId=missing_story')).status).toBe(404);
	});
});
