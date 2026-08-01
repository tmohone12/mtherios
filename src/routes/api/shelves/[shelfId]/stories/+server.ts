import { json, type RequestHandler } from '@sveltejs/kit';
import { createStoryRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

function shelfIdFromParams(params: Partial<Record<string, string>>): string {
	const shelfId = params.shelfId?.trim() ?? '';
	if (!shelfId) throw new Error('shelfId is required.');
	return shelfId;
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const shelfId = shelfIdFromParams(params);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'story.list',
			args: { shelfId },
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const shelfId = shelfIdFromParams(event.params);
		const request = await readJson(event, createStoryRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'story.create',
			args: { ...request, shelfId },
		}));
	} catch (error) {
		return apiError(error);
	}
};
