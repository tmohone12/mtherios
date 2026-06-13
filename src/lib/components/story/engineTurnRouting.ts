import type { Story } from '$lib/types';

type EngineRoutableStory = Pick<Story, 'serverStoryId'>;

export function shouldUseTerminalEngineTurn(story: EngineRoutableStory | null | undefined): boolean {
	return Boolean(story?.serverStoryId?.trim());
}
