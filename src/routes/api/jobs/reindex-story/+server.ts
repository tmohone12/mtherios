import { json, type RequestHandler } from '@sveltejs/kit';
import { reindexStoryRequestSchema } from '$lib/contracts/engine';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, reindexStoryRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: request.storyId,
			command: 'jobs.reindexStory',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
