import { json, type RequestHandler } from '@sveltejs/kit';
import { createStoryRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'story.list',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, createStoryRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'story.create',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
