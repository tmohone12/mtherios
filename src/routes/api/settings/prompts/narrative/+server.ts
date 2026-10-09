import { eq } from 'drizzle-orm';
import { json, type RequestHandler } from '@sveltejs/kit';
import { NEUTRAL_PROMPT_PACK_ID } from '$lib/components/wizard/storyPromptPacks';
import { narrativePromptQuerySchema, narrativePromptPreviewSchema } from '$lib/contracts/prompts';
import { getDb } from '$lib/server/db/client';
import { stories } from '$lib/server/db/schema';
import { apiError } from '$lib/server/memory/http';
import { buildServerNarrativeSystemPrompt, resolveServerStoryPromptPack } from '$lib/server/turn/promptPacket';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const query = narrativePromptQuerySchema.parse(Object.fromEntries(url.searchParams));
		let story: Parameters<typeof buildServerNarrativeSystemPrompt>[0] = {
			headerPrompt: null,
			metadata: {},
			settings: { promptPackId: query.promptPackId ?? NEUTRAL_PROMPT_PACK_ID },
			genre: null,
			title: '',
		};
		if (query.storyId) {
			const [row] = await getDb().select({
				headerPrompt: stories.headerPrompt,
				metadata: stories.metadata,
				settings: stories.settings,
				genre: stories.genre,
				title: stories.title,
			}).from(stories).where(eq(stories.id, query.storyId)).limit(1);
			if (!row) throw new Error(`Story not found: ${query.storyId}`);
			story = row;
		}
		const promptPack = resolveServerStoryPromptPack(story);
		return json(narrativePromptPreviewSchema.parse({
			builtInPrompt: buildServerNarrativeSystemPrompt(story),
			promptPackId: promptPack.id,
			promptPackLabel: promptPack.label,
			storyId: query.storyId ?? null,
			storyTitle: query.storyId ? story.title : null,
		}));
	} catch (error) {
		return apiError(error);
	}
};
